import { nowISO } from "./google/utils.js";
import { db, schema } from "./db.js";
import { upsertBatch } from "./sync/upsert.js";

type Executor = Pick<typeof db, "insert">;

/**
 * Writers used by the mini-app server. Everything here lands in Postgres
 * and nowhere else.
 *
 * These rows used to be written to Google Sheets first (as the source of
 * truth) and mirrored into Postgres afterwards. That cost five to seven
 * Google API round-trips inside the advisory lock on every submitted day,
 * made the foreman wait for them, and meant any Google outage took the
 * report down with it. The sheets involved -- ЖУРНАЛ_ПОДІЙ, ЗВІТИ, ТАБЕЛЬ,
 * ОДОМЕТР_ДЕНЬ, ДОПЛАТИ, СТАТУС_ДНЯ, МАТЕРІАЛИ_РУХ -- were raw working data
 * nobody read by hand, so Postgres now holds them alone. Sheets keeps what
 * humans actually touch: the dictionaries they fill in, and БУХЗВІТ, which
 * accounting.ts still writes on approval.
 */

export function makeEventId(prefix = "POD") {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rnd}`;
}

export type EventInput = {
  eventId: string;
  status: string;
  refEventId?: string;
  chatId?: number | null;
  ts?: string;
  date: string;
  foremanTgId: number;
  type: string;
  objectId?: string;
  carId?: string;
  employeeIds?: string; // JSON array
  payload?: string; // JSON
  msgId?: number;
};

export async function writeEvent(e: EventInput, tx?: Executor) {
  const ts = e.ts ?? nowISO();
  const updatedAt = nowISO();

  await upsertBatch(
    schema.events,
    [
      {
        eventId: e.eventId,
        status: e.status,
        refEventId: e.refEventId ?? null,
        chatId: e.chatId ? BigInt(e.chatId) : null,
        ts: new Date(ts),
        date: e.date,
        foremanTgId: BigInt(e.foremanTgId),
        type: e.type,
        objectId: e.objectId ?? null,
        carId: e.carId ?? null,
        employeeIds: e.employeeIds ?? null,
        payload: e.payload ?? null,
        msgId: e.msgId ?? null,
      },
    ],
    schema.events.eventId,
    ["status", "refEventId", "chatId", "ts", "date", "foremanTgId", "type", "objectId", "carId", "employeeIds", "payload", "msgId"],
    tx,
  );
}

export type OdometerDayInput = {
  date: string;
  carId: string;
  foremanTgId: number;
  startValue?: number;
  startPhoto?: string;
  endValue?: number;
  endPhoto?: string;
};

function classifyTripByKm(km: number): "S" | "M" | "L" | "XL" {
  if (!Number.isFinite(km) || km <= 0) return "S";
  if (km <= 20) return "S";
  if (km <= 50) return "M";
  if (km <= 100) return "L";
  return "XL";
}

export async function writeOdometerDay(row: OdometerDayInput, tx?: Executor) {
  const updatedAt = nowISO();
  const km =
    typeof row.startValue === "number" && typeof row.endValue === "number"
      ? row.endValue - row.startValue
      : undefined;
  const tripClass = typeof km === "number" ? classifyTripByKm(km) : undefined;

  await upsertBatch(
    schema.odometerDays,
    [
      {
        date: row.date,
        carId: row.carId,
        foremanTgId: BigInt(row.foremanTgId),
        startValue: row.startValue ?? null,
        startPhoto: row.startPhoto ?? null,
        endValue: row.endValue ?? null,
        endPhoto: row.endPhoto ?? null,
        kmDay: typeof km === "number" ? km : null,
        tripClass: tripClass ?? null,
      },
    ],
    [schema.odometerDays.date, schema.odometerDays.carId],
    ["foremanTgId", "startValue", "startPhoto", "endValue", "endPhoto", "kmDay", "tripClass"],
    tx,
  );

  return { km, tripClass };
}

export type TimesheetRowInput = {
  date: string;
  objectId: string;
  employeeId: string;
  employeeName: string;
  hours: number;
  source: string;
};

export async function writeTimesheetRows(rows: TimesheetRowInput[], tx?: Executor) {
  await upsertBatch(
    schema.timesheetEntries,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      hours: row.hours,
      source: row.source,
    })),
    [schema.timesheetEntries.date, schema.timesheetEntries.objectId, schema.timesheetEntries.employeeId],
    ["employeeName", "hours", "source"],
    tx,
  );
}

export type ReportRowInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  workId: string;
  workName: string;
  volume?: string | number;
  volumeStatus: "НЕ_ЗАПОВНЕНО" | "ЗАПОВНЕНО";
  dayStatus: string;
};

export async function writeReports(rows: ReportRowInput[], tx?: Executor) {
  // Keyed by date+objectId+workId+foremanTgId (not just date+objectId+workId):
  // two different brigades can legitimately both report volumes for the same
  // work on the same object on the same day, and must not silently overwrite
  // each other's numbers.
  await upsertBatch(
    schema.reports,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId,
      foremanTgId: BigInt(row.foremanTgId),
      workId: row.workId,
      workName: row.workName,
      volume: row.volume === undefined ? null : String(row.volume),
      volumeStatus: row.volumeStatus,
      dayStatus: row.dayStatus,
    })),
    [schema.reports.date, schema.reports.objectId, schema.reports.workId, schema.reports.foremanTgId],
    ["workName", "volume", "volumeStatus", "dayStatus"],
    tx,
  );
}

export type DayStatusInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  status: string;
  hasTimesheet?: boolean;
  hasReports?: boolean;
  hasReportsVolumeOk?: boolean;
  hasRoad?: boolean;
  hasOdoStart?: boolean;
  hasOdoEnd?: boolean;
  hasLogistics?: boolean;
  hasMaterials?: boolean;
};

export async function writeDayStatus(row: DayStatusInput, tx?: Executor) {
  const yn = (b?: boolean) => (b ? "так" : "ні");

  await upsertBatch(
    schema.dayStatuses,
    [
      {
        date: row.date,
        objectId: row.objectId,
        foremanTgId: BigInt(row.foremanTgId),
        status: row.status,
        hasTimesheet: !!row.hasTimesheet,
        hasReports: !!row.hasReports,
        hasReportsVolumeOk: !!row.hasReportsVolumeOk,
        hasRoad: !!row.hasRoad,
        hasOdoStart: !!row.hasOdoStart,
        hasOdoEnd: !!row.hasOdoEnd,
        hasLogistics: !!row.hasLogistics,
        hasMaterials: !!row.hasMaterials,
      },
    ],
    [schema.dayStatuses.date, schema.dayStatuses.objectId, schema.dayStatuses.foremanTgId],
    [
      "status",
      "hasTimesheet",
      "hasReports",
      "hasReportsVolumeOk",
      "hasRoad",
      "hasOdoStart",
      "hasOdoEnd",
      "hasLogistics",
      "hasMaterials",
    ],
    tx,
  );
}

export type AllowanceInput = {
  date: string;
  objectId?: string; // "" for trip-level allowances like ROAD_TRIP, matches the bot exactly
  foremanTgId: number;
  type: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  meta?: string;
  dayStatus?: string;
};

/** Keyed by date+foremanTgId+type+employeeId+objectId. */
export async function writeAllowanceRows(rows: AllowanceInput[], tx?: Executor) {
  await upsertBatch(
    schema.allowances,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId ?? "",
      foremanTgId: BigInt(row.foremanTgId),
      type: row.type,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      amount: row.amount,
      meta: row.meta ?? null,
      dayStatus: row.dayStatus ?? "ЧЕРНЕТКА",
    })),
    [schema.allowances.date, schema.allowances.foremanTgId, schema.allowances.type, schema.allowances.employeeId, schema.allowances.objectId],
    ["employeeName", "amount", "meta", "dayStatus"],
    tx,
  );
}

export type MaterialMoveInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  materialId: string;
  materialName: string;
  qty: number;
  unit: string;
  moveType: "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
  purpose?: string;
};

export async function writeMaterialMoves(rows: MaterialMoveInput[]) {
  if (!rows.length) return;
  const now = nowISO();

  const moves = rows.map((r) => {
    const moveId = `MMV_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      moveId,
      time: now,
      date: r.date,
      objectId: r.objectId,
      foremanTgId: r.foremanTgId,
      materialId: r.materialId,
      materialName: r.materialName,
      qty: r.qty,
      unit: r.unit,
      moveType: r.moveType,
      purpose: r.purpose ?? "",
    };
  });

  await upsertBatch(
    schema.materialMoves,
    moves.map((r) => ({
      moveId: r.moveId,
      time: r.time,
      date: r.date,
      objectId: r.objectId,
      foremanTgId: BigInt(r.foremanTgId),
      materialId: r.materialId,
      materialName: r.materialName,
      qty: r.qty,
      unit: r.unit,
      moveType: r.moveType,
      purpose: r.purpose,
      dayStatus: "ЧЕРНЕТКА",
    })),
    schema.materialMoves.moveId,
    ["time", "date", "objectId", "foremanTgId", "materialId", "materialName", "qty", "unit", "moveType", "purpose", "dayStatus"],
  );

  return moves;
}
