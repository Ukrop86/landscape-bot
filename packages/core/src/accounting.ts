import { ensureSheet, loadSheet, appendRows, sheetExists } from "./google/sheets.js";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

// Same tab names/headers the legacy bot writes into (apps/bot/src/google/sheets/accounting.ts)
// so an approval from either the bot or the mini-app lands in the ONE report the
// accountant actually opens -- there must never be two separate "БУХЗВІТ"s.
export const ACCOUNTING_SHEET = "БУХЗВІТ";
/**
 * The idempotency keys moved to Postgres (schema.accountingExports) -- they
 * were never anything a human opened, and a technical tab sitting next to the
 * accountant's report only invited someone to delete it. The name stays for
 * the one-time import below and so maintenance can still clear a leftover tab.
 */
export const ACCOUNTING_META_SHEET = "БУХЗВІТ_META";
const ACCOUNTING_HEADERS = ["№", "Дата", "Працівник", "Об'єкт", "Роботи", "Обсяг робіт", "Нарахування", "Примітки"] as const;

function money(n: number) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Splits `total` (money) across `shares` (proportions, need not sum to 1) so
 * the results sum EXACTLY to money(total) in kopecks -- largest-remainder
 * apportionment, not independent per-item rounding. Independently rounding
 * each share (money(total * share)) can over- or under-shoot the true total
 * once several shares round in the same direction, and letting "the last
 * item absorb the rest" breaks the moment that drift goes negative (the
 * last item would need a negative amount, which gets silently dropped
 * instead of subtracted -- the earlier, already-pushed rows then sum to
 * MORE than `total`). This never produces a negative remainder: every
 * item's cents are >= its floor, and only whole leftover cents (which by
 * construction can't exceed the number of items) get redistributed.
 */
function splitMoneyByShares(total: number, shares: number[]): number[] {
  const totalCents = Math.round(total * 100);
  if (!shares.length || totalCents <= 0) return shares.map(() => 0);
  const shareSum = shares.reduce((a, s) => a + s, 0);
  const raw = shares.map((s) => (shareSum > 0 ? (totalCents * s) / shareSum : totalCents / shares.length));
  const floors = raw.map((c) => Math.floor(c));
  let leftover = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((c, i) => ({ i, frac: c - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const cents = [...floors];
  for (let k = 0; k < order.length && leftover > 0; k++, leftover--) {
    cents[order[k].i] += 1;
  }
  return cents.map((c) => c / 100);
}

export type AccountingWork = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
export type AccountingObject = { objectId: string; objectName: string; works: AccountingWork[] };
export type AccountingSalaryRow = { employeeId: string; employeeName: string; pay: number };
export type AccountingSalaryPack = { objectId: string; objectName: string; rows: AccountingSalaryRow[] };
export type AccountingRow = {
  date: string;
  employeeName: string;
  objectName: string;
  workName: string;
  volume: string;
  amount: number;
  foremanName: string;
};

/**
 * Splits each employee's already-computed per-object pay (role/coefficient
 * aware -- see buildSalaryPacksWithRoles) across the specific works they're
 * tagged on at that object (WorkInput.employeeIds), weighted by each work's
 * own money value (volume * tariff). Falls back to splitting across every
 * work at the object if the employee isn't tagged on any specific one, so
 * nobody's pay silently disappears from the report. Uses largest-remainder
 * apportionment (splitMoneyByShares) so a person's rows always sum to
 * EXACTLY the pay figure they're shown in the app -- a bookkeeping report
 * that doesn't tie out to the kopeck isn't fit to hand to an accountant.
 */
export function buildAccountingRows(params: {
  date: string;
  // Whoever submitted/filled this report -- written into the "Примітки"
  // column so the accountant knows which brigadier's numbers each row is.
  foremanName: string;
  objects: AccountingObject[];
  salaryPacks: AccountingSalaryPack[];
  roadAllowancePerPerson: number;
  unionEmployeeIds: string[];
  employeeNameById: Map<string, string>;
  tariffByWorkId: Map<string, number>;
  unitByWorkId: Map<string, string>;
}): AccountingRow[] {
  const { date, foremanName, objects, salaryPacks, roadAllowancePerPerson, unionEmployeeIds, employeeNameById, tariffByWorkId, unitByWorkId } = params;
  const objectsById = new Map(objects.map((o) => [o.objectId, o]));
  const out: AccountingRow[] = [];

  const workValue = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const tariff = tariffByWorkId.get(w.workId) ?? 0;
    return (Number.isFinite(vol) ? vol : 0) * tariff;
  };
  const formatVolume = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const unit = unitByWorkId.get(w.workId) ?? "";
    return [Number.isFinite(vol) ? vol : w.volume, unit].filter((x) => x !== undefined && x !== "").join(" ");
  };

  for (const pack of salaryPacks) {
    const obj = objectsById.get(pack.objectId);
    const works = obj?.works ?? [];
    if (!works.length) continue;

    for (const row of pack.rows) {
      if (!(row.pay > 0)) continue;

      const tagged = works.filter((w) => (w.employeeIds ?? []).includes(row.employeeId));
      const pool = tagged.length ? tagged : works;
      const values = pool.map(workValue);
      const totalValue = values.reduce((a, v) => a + v, 0);
      const shares = totalValue > 0 ? values : pool.map(() => 1);
      const amounts = splitMoneyByShares(row.pay, shares);

      pool.forEach((w, i) => {
        const amount = amounts[i];
        if (amount <= 0) return;
        out.push({
          date,
          employeeName: row.employeeName,
          objectName: pack.objectName,
          workName: w.workName,
          volume: formatVolume(w),
          amount,
          foremanName,
        });
      });
    }
  }

  if (roadAllowancePerPerson > 0) {
    for (const empId of unionEmployeeIds) {
      out.push({
        date,
        employeeName: employeeNameById.get(empId) ?? empId,
        objectName: "—",
        workName: "Доплата за виїзд",
        volume: "",
        amount: money(roadAllowancePerPerson),
        foremanName,
      });
    }
  }

  return out;
}

async function loadAccountingSheet() {
  await ensureSheet(ACCOUNTING_SHEET, ACCOUNTING_HEADERS);
  return loadSheet(ACCOUNTING_SHEET, "A:H");
}

async function hasAccountingRowsForKey(key: string) {
  const [row] = await db.select().from(schema.accountingExports).where(eq(schema.accountingExports.key, key)).limit(1);
  return !!row;
}

/**
 * One-time carry-over of the keys that are still sitting in the old
 * БУХЗВІТ_META tab. Runs at startup and stops for good once the table has
 * anything in it, so it costs one metadata call on an empty database and
 * nothing afterwards.
 *
 * Deliberately checks whether the tab EXISTS instead of ensuring it: once the
 * owner deletes it there is nothing to import, and recreating it to read zero
 * rows would undo exactly what this change is for.
 */
export async function importAccountingKeysFromSheet(): Promise<{ imported: number }> {
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.accountingExports);
  if (Number(count) > 0) return { imported: 0 };

  if (!(await sheetExists(ACCOUNTING_META_SHEET))) return { imported: 0 };

  const sh = await loadSheet(ACCOUNTING_META_SHEET, "A:C");
  const rows = sh.data
    .map((row) => ({
      key: String(row?.[0] ?? "").trim(),
      createdAt: String(row?.[1] ?? "").trim(),
      rowsCount: Number(row?.[2] ?? 0),
    }))
    .filter((r) => r.key)
    .map((r) => {
      // MINIAPP|<date>|<foremanTgId>|<eventIds>
      const parts = r.key.split("|");
      const parsed = new Date(r.createdAt);
      let foremanTgId: bigint | null = null;
      try {
        if (parts[2]) foremanTgId = BigInt(parts[2]);
      } catch {
        // a key from the legacy bot has its own shape -- the key itself is
        // what matters, the columns beside it are only for human eyes
      }
      return {
        key: r.key,
        date: parts[1] ?? "",
        foremanTgId,
        rowsCount: Number.isFinite(r.rowsCount) ? r.rowsCount : 0,
        createdAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
      };
    });
  if (!rows.length) return { imported: 0 };

  await db.insert(schema.accountingExports).values(rows).onConflictDoNothing();
  console.log(`[accounting] imported ${rows.length} export key(s) from ${ACCOUNTING_META_SHEET}`);
  return { imported: rows.length };
}

async function appendAccountingReportRows(rows: AccountingRow[]) {
  if (!rows.length) return;
  const sh = await loadAccountingSheet();
  const hasHeader = String(sh.all?.[0]?.[0] ?? "").trim() === ACCOUNTING_HEADERS[0];
  const existingDataRows = hasHeader ? Math.max(0, sh.all.length - 1) : sh.all.length;
  let nextNo = existingDataRows + 1;

  await appendRows(
    ACCOUNTING_SHEET,
    rows.map((row) => [nextNo++, row.date, row.employeeName, row.objectName, row.workName, row.volume, row.amount, row.foremanName]),
  );
}

/**
 * Writes one day's approved payroll into the shared БУХЗВІТ report -- called
 * once a foreman's whole day is approved via the mini-app's "Затвердження"
 * screen (mirrors what the legacy bot does on its own approval flow, since
 * that only fires for reports approved through the bot, never through the
 * mini-app).
 *
 * `key` must uniquely identify THIS state of the day's submission, not just
 * the date+foreman -- a day can be approved, returned for correction,
 * resubmitted, then approved again, and the corrected numbers must reach the
 * accountant, not get silently skipped as "already exported". The caller
 * should fold in something that changes across a resubmission (e.g. the
 * trip events' own eventIds), the same way the bot's own export keys off the
 * approved event's eventId rather than off date+foreman alone.
 */
export async function writeAccountingReportForDay(params: { key: string; rows: AccountingRow[] }) {
  const { key, rows } = params;
  if (await hasAccountingRowsForKey(key)) {
    return { skipped: true, rows: 0 };
  }
  if (!rows.length) {
    return { skipped: false, rows: 0 };
  }

  await appendAccountingReportRows(rows);
  // Only after the rows are actually in the sheet: a key written first would
  // mark a failed export as done and the day would never reach the accountant.
  await db
    .insert(schema.accountingExports)
    .values({
      key,
      date: key.split("|")[1] ?? "",
      foremanTgId: (() => {
        try {
          return BigInt(key.split("|")[2] ?? "");
        } catch {
          return null;
        }
      })(),
      rowsCount: rows.length,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return { skipped: false, rows: rows.length };
}
