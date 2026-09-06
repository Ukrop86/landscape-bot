import { schema } from "../db.js";
import { upsertBatch } from "./upsert.js";
import * as sheets from "./mappers.js";

/**
 * One full sync cycle: Sheets -> DB, dictionaries only. Google Sheets is the
 * source of truth for everything a human fills in by hand -- people, objects,
 * works, cars, materials, settings -- and this mirrors it into Postgres for
 * fast reads from the mini-app.
 *
 * Один-єдиний запис назад в аркуш: рядку, у якого є назва й немає ID, синк
 * видає ID і дописує його в комірку (`autoId.ts`). Це не робочі дані, а
 * ключ, без якого рядок не існує -- і саме його ручне проставляння вже
 * коштувало довіднику РОБОТИ зсунутих ставок.
 */
export async function runSyncCycle() {
  const startedAt = Date.now();

  await upsertBatch(schema.users, await sheets.readUsers(), schema.users.tgId, [
    "username",
    "pib",
    "role",
    "active",
    "comment",
  ]);

  await upsertBatch(schema.employees, await sheets.readEmployees(), schema.employees.id, [
    "name",
    "brigadeId",
    "position",
    "active",
  ]);

  await upsertBatch(schema.objects, await sheets.readObjects(), schema.objects.id, [
    "name",
    "address",
    "active",
  ]);

  await upsertBatch(schema.works, await sheets.readWorks(), schema.works.id, [
    "name",
    "category",
    "subcategory",
    "unit",
    "tariff",
    "active",
  ]);

  await upsertBatch(schema.cars, await sheets.readCars(), schema.cars.id, ["name", "plate", "active"]);

  await upsertBatch(
    schema.logisticDirections,
    await sheets.readLogisticDirections(),
    schema.logisticDirections.id,
    ["name", "tariff", "discountsByQty", "active"],
  );

  await upsertBatch(schema.materials, await sheets.readMaterials(), schema.materials.id, [
    "name",
    "unit",
    "active",
    "category",
    "comment",
  ]);

  await upsertBatch(schema.tools, await sheets.readTools(), schema.tools.id, [
    "name",
    "active",
    "category",
    "comment",
  ]);

  await upsertBatch(schema.settings, await sheets.readSettings(), schema.settings.key, ["value", "comment"]);

  // Working data (events, odometer, allowances, day statuses, material and
  // tool moves) is NOT read back from Sheets any more: the app is the only
  // thing that produces it and it now lives in Postgres alone. Reading those
  // tabs here was also what made a cleared sheet reappear ~45s later.

  const ms = Date.now() - startedAt;
  console.log(`[SYNC] cycle complete in ${ms}ms`);
}

let running = false;

export function startSyncLoop(intervalMs: number) {
  const tick = async () => {
    if (running) return; // skip overlapping runs if a cycle is slow
    running = true;
    try {
      await runSyncCycle();
    } catch (err) {
      console.error("[SYNC] cycle failed", err);
    } finally {
      running = false;
    }
  };

  tick(); // run once immediately on startup
  return setInterval(tick, intervalMs);
}
