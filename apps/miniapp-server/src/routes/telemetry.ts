import { asyncRouter } from "../asyncRouter.js";
import { db, schema } from "@landscape/core";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { appendUiLog } from "../uiLogFile.js";

/**
 * Журнал дій у застосунку. ТИМЧАСОВЕ, на час обкатки.
 *
 * Кожне сьогоднішнє розслідування впиралось в одне: що людина насправді
 * натиснула. Незданий день живе тільки в телефоні, сервер бачить хіба
 * підсумок — тож послідовності дій не було ніде. Тут вона є.
 */
export const telemetryRouter = asyncRouter();

/** Довгий підпис кнопки нічого не додає до розуміння, а рядок роздуває. */
const trim = (v: unknown, max = 200) => String(v ?? "").slice(0, max);

/**
 * POST /api/telemetry — пачка подій з телефона.
 *
 * Хто це — беремо ВИКЛЮЧНО з перевіреного initData, ніколи з тіла запиту:
 * інакше журнал, у який зазирають, щоб зрозуміти чиюсь помилку, можна було б
 * підписати чужим імʼям.
 *
 * Відповідає 200 навіть коли не зміг записати: клієнт шле це фоном, і невдала
 * телеметрія не має права ані сповільнити роботу, ані показати помилку.
 */
telemetryRouter.post("/", async (req, res) => {
  const body = (req.body ?? {}) as { events?: Array<Record<string, unknown>> };
  const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
  if (!events.length) {
    res.json({ ok: true, saved: 0 });
    return;
  }

  const tgId = BigInt(req.user!.tgId);
  const pib = trim(req.user!.pib, 120);
  const role = req.user!.role;

  const rows = events
    .map((e) => {
      const ts = new Date(String(e.ts ?? ""));
      return {
        id: trim(e.id, 64) || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
        tgId,
        pib,
        role,
        screen: trim(e.screen, 40),
        step: trim(e.step, 40),
        kind: trim(e.kind, 20),
        label: trim(e.label, 200),
        detail: e.detail === undefined || e.detail === null ? null : trim(e.detail, 1000),
      };
    })
    .filter((r) => r.kind);

  // Файл на волюмі — головний спосіб читати журнал: рядок на подію, grep і
  // tail. Дублюємо в логи Railway, щоб проблему можна було розбирати
  // віддалено, і в таблицю, якщо колись знадобиться вибірка запитом.
  // Файл і лог заповнюються ДО вставки: якщо впала саме база, слід має
  // лишитись — бо в журнал дивляться рівно тоді.
  appendUiLog(
    rows.map((r) => ({
      ts: r.ts,
      who: r.pib || String(r.tgId),
      screen: r.screen,
      step: r.step,
      kind: r.kind,
      label: r.label,
      detail: r.detail,
    })),
  );
  for (const r of rows) {
    console.log(
      `[UI] ${r.ts.toISOString()} | ${r.pib || r.tgId} | ${r.screen}${r.step ? ` · ${r.step}` : ""} | ${r.kind} | ${r.label}${r.detail ? ` | ${r.detail}` : ""}`,
    );
  }

  try {
    if (rows.length) await db.insert(schema.uiActions).values(rows).onConflictDoNothing();
    res.json({ ok: true, saved: rows.length });
  } catch (e) {
    console.error(`[telemetry] insert failed: ${(e as Error).message}`);
    res.json({ ok: true, saved: 0 });
  }
});

/**
 * GET /api/telemetry?date=&tgId=&limit= — читання журналу, тільки адмін.
 *
 * Найновіші зверху: коли щось щойно пішло не так, дивляться саме в хвіст.
 */
telemetryRouter.get("/", async (req, res) => {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Тільки для адміністратора" });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
  const date = String(req.query.date ?? "").trim();
  const tgId = String(req.query.tgId ?? "").trim();

  const conditions = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // Межі дня за Києвом: у базі час у UTC, а питають завжди про календарний
    // день, який людина прожила.
    conditions.push(gte(schema.uiActions.ts, new Date(`${date}T00:00:00+03:00`)));
    conditions.push(lte(schema.uiActions.ts, new Date(`${date}T23:59:59+03:00`)));
  }
  if (/^\d+$/.test(tgId)) conditions.push(eq(schema.uiActions.tgId, BigInt(tgId)));

  const rows = await db
    .select()
    .from(schema.uiActions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.uiActions.ts))
    .limit(limit);

  res.json({ ok: true, rows });
});

/** GET /api/telemetry/users — хто взагалі є в журналі, для фільтра. */
telemetryRouter.get("/users", async (req, res) => {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Тільки для адміністратора" });
    return;
  }
  const rows = await db.selectDistinct({ tgId: schema.uiActions.tgId, pib: schema.uiActions.pib }).from(schema.uiActions);
  res.json({ ok: true, users: rows.sort((a, b) => a.pib.localeCompare(b.pib)) });
});
