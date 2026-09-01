import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { sql } from "drizzle-orm";
import {
  startSyncLoop,
  runSyncCycle,
  runMigrations,
  config,
  db,
  schema,
  sheetsClient,
  sheetNames,
  ACCOUNTING_SHEET,
  ACCOUNTING_META_SHEET,
} from "@landscape/core";
import { requireTelegramAuth } from "./authMiddleware.js";
import { registerTelegramWebhook, setupTelegramWebhook } from "./telegramWebhook.js";
import { dictionariesRouter } from "./routes/dictionaries.js";
import { logisticsRouter } from "./routes/logistics.js";
import { materialsRouter } from "./routes/materials.js";
import { statsRouter } from "./routes/stats.js";
import { roadTimesheetRouter } from "./routes/roadTimesheet.js";
import { tripPlansRouter } from "./routes/tripPlans.js";

// Telegram IDs are stored as bigint; make them JSON-serializable as strings.
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Guard for /internal/* endpoints. The caller is one of our own processes
// (or an operator), not a Telegram Mini App session, so there's no initData
// to validate -- authenticate with the shared BOT_TOKEN instead.
function requireBotToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.botToken || req.header("x-bot-token") !== config.botToken) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

// Lets the legacy bot (apps/bot) trigger an immediate Sheets -> Postgres
// sync right after approving/rejecting a user registration, instead of the
// new user hitting "Access denied" in the Mini App for up to
// SYNC_INTERVAL_MS until the next scheduled background sync picks it up.
app.post("/internal/sync-now", requireBotToken, async (_req, res) => {
  try {
    await runSyncCycle();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Wipes the Postgres copy of the odometer readings, so a fresh test run
// starts with blank speedometers next to every car in PICK_CAR (those come
// from GET /api/road-timesheet/cars-last-odometer, which reads this table).
//
// Needed because runSyncCycle only ever upserts and never deletes: emptying
// the ОДОМЕТР_ДЕНЬ sheet by hand leaves the old rows sitting in Postgres
// forever. Clear the sheet first (it stays the source of truth), then call
// this -- otherwise the next sync cycle just mirrors the readings back in.
app.post("/internal/reset-odometer", requireBotToken, async (_req, res) => {
  try {
    const deleted = await db.delete(schema.odometerDays).returning({ id: schema.odometerDays.id });
    console.log(`[maintenance] odometer_days cleared: ${deleted.length} rows`);
    res.json({ ok: true, deleted: deleted.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Everything the app PRODUCES while it's used, as opposed to the dictionaries
// the office maintains in Google Sheets (users, employees, objects, works,
// cars, logistic_directions, materials, tools, settings) -- those are never
// touched here, and wiping `users` in particular would lock everyone out of
// the Mini App, since roles are read from it.
//
// closures and sync_cursors are in the list for completeness: both are
// declared in the schema but nothing reads or writes them today.
const WORKING_DATA_TABLES = [
  "events",
  "reports",
  "timesheet_entries",
  "odometer_days",
  "allowances",
  "day_statuses",
  "closures",
  "material_moves",
  "tool_moves",
  "sync_cursors",
  // Plans are working data too -- the accountant never sees them, and a wiped
  // plan costs five minutes of re-picking (see schema.ts:tripPlans).
  "trip_plans",
] as const;

/**
 * The tabs the PROGRAM writes, as opposed to the dictionaries a human keeps.
 *
 * Order matters when wiping: six of these are read back by runSyncCycle, so
 * Postgres must be cleared AFTER the sheets or the next cycle (~45s) puts them
 * straight back. БУХЗВІТ_META holds the export's idempotency keys -- leaving it
 * behind would make a re-approved day silently skip its export.
 */
const WORKING_DATA_SHEETS = [
  sheetNames.SHEET_NAMES.events,
  sheetNames.SHEET_NAMES.reports,
  sheetNames.SHEET_NAMES.timesheet,
  sheetNames.SHEET_NAMES.odometerDay,
  sheetNames.SHEET_NAMES.allowances,
  sheetNames.SHEET_NAMES.dayStatus,
  sheetNames.SHEET_NAMES.closures,
  sheetNames.SHEET_NAMES.materialsMove,
  sheetNames.SHEET_NAMES.toolsMove,
  ACCOUNTING_SHEET,
  ACCOUNTING_META_SHEET,
] as const;

// Full reset of a test run's accumulated data, so real-world testing can
// start from a clean slate without hand-writing SQL each time.
//
// Clear the matching Google Sheets tabs FIRST -- ЖУРНАЛ_ПОДІЙ, ОДОМЕТР_ДЕНЬ,
// ДОПЛАТИ, СТАТУС_ДНЯ, МАТЕРІАЛИ_РУХ and ІНСТРУМЕНТ_РУХ are all read back by
// runSyncCycle, so clearing Postgres alone would just have the next sync
// cycle (~45s later) put those six straight back. ЗВІТИ and ТАБЕЛЬ aren't
// synced, so those two stay cleared either way.
app.post("/internal/reset-working-data", requireBotToken, async (_req, res) => {
  try {
    const countQuery = WORKING_DATA_TABLES.map((t) => `SELECT '${t}' AS "table", count(*)::int AS rows FROM ${t}`).join(" UNION ALL ");
    const before = await db.execute(sql.raw(countQuery));
    // TRUNCATE rather than DELETE: it also resets the serial id sequences, so
    // a cleared database starts numbering from 1 like a fresh one. No table
    // here is referenced by a foreign key, so no CASCADE is needed.
    await db.execute(sql.raw(`TRUNCATE TABLE ${WORKING_DATA_TABLES.join(", ")} RESTART IDENTITY`));
    console.log(`[maintenance] working data cleared: ${JSON.stringify(before)}`);
    res.json({ ok: true, cleared: before });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * POST /internal/reset-all — wipes an entire test run: the sheets the program
 * writes, then the Postgres tables behind them.
 *
 * Dictionaries are NOT touched: КОРИСТУВАЧІ, ПРАЦІВНИКИ, ОБЄКТИ, РОБОТИ, АВТО,
 * ЛОГІСТИКА, МАТЕРІАЛИ, ІНСТРУМЕНТИ, НАЛАШТУВАННЯ are maintained by hand and
 * are the input, not the output.
 *
 * Sheets go first and Postgres only if every one of them succeeded. Half a
 * wipe is worse than none: clearing Postgres alone lets the sync restore it,
 * and clearing some sheets while the database still holds the day leaves the
 * two disagreeing about what happened.
 */
app.post("/internal/reset-all", requireBotToken, async (_req, res) => {
  const sheetsCleared: Record<string, number> = {};
  try {
    for (const name of WORKING_DATA_SHEETS) {
      sheetsCleared[name] = await sheetsClient.clearSheetData(name);
    }
  } catch (e) {
    console.error("[maintenance] sheet clearing failed, Postgres left untouched", e);
    res.status(502).json({
      error: `Не вдалося очистити аркуші: ${(e as Error).message}. Базу не чіпали — спробуйте ще раз.`,
      sheetsCleared,
    });
    return;
  }

  try {
    const countQuery = WORKING_DATA_TABLES.map((t) => `SELECT '${t}' AS "table", count(*)::int AS rows FROM ${t}`).join(" UNION ALL ");
    const before = await db.execute(sql.raw(countQuery));
    await db.execute(sql.raw(`TRUNCATE TABLE ${WORKING_DATA_TABLES.join(", ")} RESTART IDENTITY`));
    console.log(`[maintenance] full reset: sheets=${JSON.stringify(sheetsCleared)} tables=${JSON.stringify(before)}`);
    res.json({ ok: true, sheetsCleared, tablesCleared: before });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, sheetsCleared });
  }
});

// /start self-registration + admin approve/reject, via Telegram webhook --
// must be registered before the static catch-all below, which would
// otherwise swallow POST /telegram/webhook into index.html.
registerTelegramWebhook(app);

const apiRouter = express.Router();
apiRouter.use(requireTelegramAuth);
apiRouter.get("/me", (req, res) => res.json(req.user));
apiRouter.use("/dictionaries", dictionariesRouter);
apiRouter.use("/logistics", logisticsRouter);
apiRouter.use("/materials", materialsRouter);
apiRouter.use("/stats", statsRouter);
apiRouter.use("/road-timesheet", roadTimesheetRouter);
apiRouter.use("/trip-plans", tripPlansRouter);
app.use("/api", apiRouter);

// Serve the built mini-app frontend (apps/miniapp-web/dist) from the same
// service, so the whole mini-app is one Railway service with one HTTPS URL
// to register in @BotFather. Falls back gracefully if it hasn't been built.
const webDist = path.resolve(__dirname, "../../miniapp-web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
} else {
  console.warn(`[miniapp-server] no built frontend found at ${webDist} (run "npm run build -w apps/miniapp-web")`);
}

// Express 4 hands a rejected promise from an async route to nobody, and Node
// then treats the unhandled rejection as a fatal error. That is how one failed
// Google Drive upload took the whole mini-app offline for every foreman. These
// two nets keep a single bad request a single bad request.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[miniapp-server] unhandled route error", err);
  if (!res.headersSent) res.status(500).json({ error: "Внутрішня помилка сервера" });
});

process.on("unhandledRejection", (reason) => {
  // Deliberately does NOT exit: the request that caused it is already lost,
  // but the day every other brigade is running does not have to be.
  console.error("[miniapp-server] unhandled rejection", reason);
});

async function main() {
  await runMigrations();

  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`[miniapp-server] listening on :${port}`);
  });

  startSyncLoop(config.syncIntervalMs);
  await setupTelegramWebhook();
}

main().catch((err) => {
  console.error("[miniapp-server] fatal startup error", err);
  process.exit(1);
});
