// Money tests. The payroll split is the one part of this project where a
// silent mistake shows up as a wrong number in someone's pay, so the
// invariants from CLAUDE.md are pinned here rather than re-derived by hand
// after every change.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalaryPacksWithRoles, MIN_PAID_HOURS } from "../src/payroll.ts";

type Row = { employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number };
const row = (id: string, hours: number): Row => ({ employeeId: id, employeeName: id, hours, disciplineCoef: 1, productivityCoef: 1 });

function pack(opts: {
  total: number;
  rows: Row[];
  brigadier?: string;
  seniors?: string[];
  works?: Array<{ workId: string; value: number; employeeIds?: string[] }>;
}) {
  const [p] = buildSalaryPacksWithRoles({
    objects: [{ objectId: "o", objectName: "o", objectTotal: opts.total, works: opts.works, rows: opts.rows }],
    brigadierEmployeeId: opts.brigadier ?? "",
    seniorEmployeeIds: opts.seniors ?? [],
  });
  return p;
}

const payOf = (p: ReturnType<typeof pack>, id: string) => p.rows.find((r) => r.employeeId === id)?.pay ?? 0;
/** Every pot together must equal the object's fund -- money may never vanish. */
const distributed = (p: ReturnType<typeof pack>) =>
  Math.round((p.rows.reduce((a, r) => a + r.pay, 0) + p.companyPay) * 100) / 100;

test("фонд об'єкта завжди розподіляється повністю", () => {
  const cases = [
    pack({ total: 1000, rows: [row("b", 0), row("w1", 8), row("w2", 4)], brigadier: "b" }),
    pack({ total: 1000, rows: [row("b", 8), row("s", 6), row("w1", 2)], brigadier: "b", seniors: ["s"] }),
    pack({ total: 1000, rows: [row("w1", 5), row("w2", 5)] }),
    pack({ total: 225, rows: [row("b", 0), row("w1", 3), row("w2", 3)], brigadier: "b" }),
    pack({
      total: 1000,
      rows: [row("b", 0), row("w1", 6), row("w2", 2)],
      brigadier: "b",
      works: [{ workId: "a", value: 700 }, { workId: "b", value: 300, employeeIds: ["w2"] }],
    }),
  ];
  for (const p of cases) assert.equal(distributed(p), p.objectTotal);
});

test("бригадир отримує 20% навіть з нульовими годинами", () => {
  const p = pack({ total: 1000, rows: [row("b", 0), row("w1", 8)], brigadier: "b" });
  assert.equal(payOf(p, "b"), 200);
});

test("бригадир, який працював, отримує 20% ПЛЮС свою частку за години", () => {
  const p = pack({ total: 1000, rows: [row("b", 8), row("w1", 8)], brigadier: "b" });
  // 70% = 700 навпіл = 350; бригадиру ще 200
  assert.equal(payOf(p, "b"), 550);
  assert.equal(payOf(p, "w1"), 350);
});

test("робітнича частка ділиться пропорційно годинам, а не порівну", () => {
  const p = pack({ total: 1000, rows: [row("b", 0), row("w1", 8), row("w2", 4)], brigadier: "b" });
  assert.equal(payOf(p, "w1"), 466.67);
  assert.equal(payOf(p, "w2"), 233.33);
  // Вдвічі більше годин -- вдвічі більше грошей.
  assert.ok(Math.abs(payOf(p, "w1") / payOf(p, "w2") - 2) < 0.001);
});

test("старші ділять 10% між собою, фірмі тоді нічого", () => {
  const p = pack({ total: 1000, rows: [row("b", 0), row("s1", 0), row("s2", 0), row("w1", 8)], brigadier: "b", seniors: ["s1", "s2"] });
  assert.equal(payOf(p, "s1"), 50);
  assert.equal(payOf(p, "s2"), 50);
  assert.equal(p.companyPay, 0);
});

test("без старшого його 10% лишаються фірмі", () => {
  const p = pack({ total: 1000, rows: [row("b", 0), row("w1", 8)], brigadier: "b" });
  assert.equal(p.companyPay, 100);
});

test("без бригадира робітники ділять 90%", () => {
  const p = pack({ total: 1000, rows: [row("w1", 6), row("w2", 2)] });
  assert.equal(payOf(p, "w1"), 675);
  assert.equal(payOf(p, "w2"), 225);
  assert.equal(p.companyPay, 100);
});

test("робітник з нульовими годинами не отримує нічого і не потрапляє в рядки", () => {
  const p = pack({ total: 1000, rows: [row("b", 0), row("w1", 8), row("w2", 0)], brigadier: "b" });
  assert.equal(payOf(p, "w2"), 0);
  assert.equal(p.rows.some((r) => r.employeeId === "w2"), false);
});

test("закріплена робота платить лише призначеним, і вони виходять зі спільного кошика", () => {
  const p = pack({
    total: 1000,
    rows: [row("b", 0), row("w1", 6), row("w2", 2)],
    brigadier: "b",
    works: [{ workId: "a", value: 700 }, { workId: "b", value: 300, employeeIds: ["w2"] }],
  });
  assert.equal(payOf(p, "w1"), 490); // 700 * 0.7 -- сам у спільному кошику
  assert.equal(payOf(p, "w2"), 210); // 300 * 0.7 -- лише своя робота
});

test("закріплена робота теж ділиться за годинами між призначеними", () => {
  const p = pack({
    total: 1000,
    rows: [row("w1", 9), row("w2", 3), row("w3", 1)],
    works: [{ workId: "a", value: 600 }, { workId: "b", value: 400, employeeIds: ["w1", "w2"] }],
  });
  // 400 * 0.9 = 360 на двох у пропорції 9:3 -> 270 / 90
  // 600 * 0.9 = 540 лишається w3 одному
  assert.equal(payOf(p, "w1"), 270);
  assert.equal(payOf(p, "w2"), 90);
  assert.equal(payOf(p, "w3"), 540);
});

test("призначення на того, кого не було на об'єкті, не з'їдає гроші", () => {
  const p = pack({
    total: 1000,
    rows: [row("w1", 4)],
    works: [{ workId: "a", value: 1000, employeeIds: ["ghost"] }],
  });
  assert.equal(payOf(p, "w1"), 900);
  assert.equal(distributed(p), 1000);
});

test("коли в усіх присутніх є закріплені роботи, спільний залишок не зникає", () => {
  const p = pack({
    total: 1000,
    rows: [row("w1", 5), row("w2", 5)],
    works: [
      { workId: "a", value: 400, employeeIds: ["w1"] },
      { workId: "b", value: 400, employeeIds: ["w2"] },
    ],
  });
  // Лишається 200 нерозписаних -- діляться між обома, бо інакше згоріли б.
  assert.equal(distributed(p), 1000);
  assert.equal(payOf(p, "w1"), payOf(p, "w2"));
});

test("сесія в кілька секунд видима у звіті, але не оплачується", () => {
  // 1 секунда = 0.000278 год. Округлення до 2 знаків раніше показувало "0 год"
  // поруч із виплатою з бригадного кошика; тепер години видно, а поріг
  // MIN_PAID_HOURS не пускає таку сесію в поділ.
  const p = pack({ total: 687.5, rows: [row("b", 1 / 3600), row("w1", 4)], brigadier: "b" });
  const b = p.rows.find((r) => r.employeeId === "b")!;
  assert.ok(b.hours > 0, "години бригадира мають лишитись видимими");
  assert.equal(b.pay, Math.round(687.5 * 0.2 * 100) / 100, "лише 20% за ведення дня, без частки бригади");
  assert.equal(distributed(p), 687.5);
});

test(`години менші за ${MIN_PAID_HOURS} не потрапляють у поділ`, () => {
  const p = pack({ total: 1000, rows: [row("w1", 8), row("w2", MIN_PAID_HOURS - 0.001)] });
  assert.equal(payOf(p, "w2"), 0);
  assert.equal(payOf(p, "w1"), 900);
  assert.equal(distributed(p), 1000);
});

test(`рівно ${MIN_PAID_HOURS} години вже оплачуються`, () => {
  const p = pack({ total: 1000, rows: [row("w1", MIN_PAID_HOURS), row("w2", MIN_PAID_HOURS)] });
  assert.equal(payOf(p, "w1"), 450);
  assert.equal(payOf(p, "w2"), 450);
});

test("людина з надто короткою сесією лишається у звіті з нулем — помилку видно", () => {
  const p = pack({ total: 1000, rows: [row("w1", 8), row("w2", 0.01)] });
  const short = p.rows.find((r) => r.employeeId === "w2");
  assert.ok(short, "рядок має лишитись, інакше забуті години зникли б мовчки");
  assert.equal(short!.pay, 0);
  assert.equal(short!.hours, 0.01);
});

test("коефіцієнти не рухають гроші", () => {
  const base = pack({ total: 1000, rows: [row("b", 0), row("w1", 8), row("w2", 4)], brigadier: "b" });
  const withCoefs = pack({
    total: 1000,
    rows: [
      { ...row("b", 0), disciplineCoef: 0.5, productivityCoef: 1.5 },
      { ...row("w1", 8), disciplineCoef: 1.5, productivityCoef: 0.5 },
      { ...row("w2", 4), disciplineCoef: 2, productivityCoef: 2 },
    ],
    brigadier: "b",
  });
  for (const id of ["b", "w1", "w2"]) assert.equal(payOf(withCoefs, id), payOf(base, id));
});
