import { fetchEvents } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";

type AnyEvent = any;

type CarDayStat = {
  carId: string;
  objectIds: string[];
  employeeIds: string[];
  odoStartKm?: number;
  odoEndKm?: number;
  roadSec: number;
  statusNow: string;
  whereNowObjectId?: string;
};

type EmployeeDayStat = {
  employeeId: string;
  objectIds: string[];
  carIds: string[];
  secByObject: Record<string, number>;
  statusNow: string;
  whereNowObjectId?: string;
  whereNowCarId?: string;
};

type ObjectDayStat = {
  objectId: string;
  employeeIds: string[];
  carIds: string[];
  secByEmployee: Record<string, number>;
  statusDay: string;
  statusNow: string;
};

type LogisticsDayStat = {
  logisticId: string;
  logisticName: string;
  qty: number;
  employeeIds: string[];
  approvedAmount: number;
  statusCounts: Record<string, number>;
};

export type RoadDayStats = {
  events: AnyEvent[];
  cars: Record<string, CarDayStat>;
  employees: Record<string, EmployeeDayStat>;
  objects: Record<string, ObjectDayStat>;
  logistics: Record<string, LogisticsDayStat>;
};

function parsePayload(raw: any) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

function csvToIds(v: string): string[] {
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqPush(arr: string[], value?: string) {
  const v = String(value ?? "").trim();
  if (!v) return;
  if (!arr.includes(v)) arr.push(v);
}

function getEventTsMs(e: any): number {
  const ms = Date.parse(String(e?.ts ?? e?.updatedAt ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeDayStatus(raw?: string) {
  return String(raw ?? "").trim().toUpperCase();
}

function detectNowStatusFromType(type: string): string {
  const t = String(type ?? "").trim().toUpperCase();

  if (t === "RTS_ODO_START") return "В ДОРОЗІ";
  if (t === "RTS_DROP_OFF") return "НА ОБʼЄКТІ";
  if (t === "RTS_OBJ_WORK_START") return "ПРАЦЮЄ";
  if (t === "RTS_OBJ_WORK_STOP") return "ЗАВЕРШИВ РОБОТУ";
  if (t === "RTS_PICK_UP") return "ЗАБРАЛИ З ОБʼЄКТА";
  if (t === "RTS_ODO_END") return "ДЕНЬ ЗАВЕРШЕНО";
  if (t === "ROAD_END") return "ДЕНЬ ЗАВЕРШЕНО";
  if (t === "ЛОГІСТИКА") return "ЛОГІСТИКА";
  return "—";
}

export async function buildRoadDayStats(args: {
  date: string;
  foremanTgId: number;
}) : Promise<RoadDayStats> {
  const { date, foremanTgId } = args;

  const events = await fetchEvents({ date, foremanTgId });
  const rows = [...(events ?? [])].sort((a, b) => getEventTsMs(a) - getEventTsMs(b));

  const cars: Record<string, CarDayStat> = {};
  const employees: Record<string, EmployeeDayStat> = {};
  const objects: Record<string, ObjectDayStat> = {};
  const logistics: Record<string, LogisticsDayStat> = {};

  const openWork = new Map<string, number>(); // emp||obj||work -> startMs

  const ensureCar = (carId: string): CarDayStat => {
    if (!cars[carId]) {
      cars[carId] = {
        carId,
        objectIds: [],
        employeeIds: [],
        roadSec: 0,
        statusNow: "—",
      };
    }
    return cars[carId];
  };

  const ensureEmployee = (employeeId: string): EmployeeDayStat => {
    if (!employees[employeeId]) {
      employees[employeeId] = {
        employeeId,
        objectIds: [],
        carIds: [],
        secByObject: {},
        statusNow: "—",
      };
    }
    return employees[employeeId];
  };

  const ensureObject = (objectId: string): ObjectDayStat => {
    if (!objects[objectId]) {
      objects[objectId] = {
        objectId,
        employeeIds: [],
        carIds: [],
        secByEmployee: {},
        statusDay: "",
        statusNow: "—",
      };
    }
    return objects[objectId];
  };

  for (const e of rows) {
    const type = String(e.type ?? "");
    const objectId = String(e.objectId ?? "").trim();
    const carId = String(e.carId ?? "").trim();
    const payload = parsePayload(e.payload);
    const employeeIds = [
      ...new Set([
        ...csvToIds(String(e.employeeIds ?? "")),
        ...(
          Array.isArray(payload.employeeIds)
            ? payload.employeeIds.map((x: any) => String(x ?? "").trim()).filter(Boolean)
            : []
        ),
      ]),
    ];

    if (carId) {
      const car = ensureCar(carId);
      if (objectId) uniqPush(car.objectIds, objectId);
      for (const empId of employeeIds) uniqPush(car.employeeIds, empId);
      car.statusNow = detectNowStatusFromType(type);
      if (objectId && (type === "RTS_DROP_OFF" || type === "RTS_OBJ_WORK_START")) {
        car.whereNowObjectId = objectId;
      }
      if (type === "RTS_ODO_START" && Number.isFinite(Number(payload?.odoStartKm))) {
        car.odoStartKm = Number(payload.odoStartKm);
      }
      if (type === "RTS_ODO_END" && Number.isFinite(Number(payload?.odoEndKm))) {
        car.odoEndKm = Number(payload.odoEndKm);
      }
    }

    if (objectId) {
      const obj = ensureObject(objectId);
      if (carId) uniqPush(obj.carIds, carId);
      for (const empId of employeeIds) uniqPush(obj.employeeIds, empId);
      obj.statusNow = detectNowStatusFromType(type);
    }

    for (const empId of employeeIds) {
      const emp = ensureEmployee(empId);
      if (objectId) uniqPush(emp.objectIds, objectId);
      if (carId) uniqPush(emp.carIds, carId);

      emp.statusNow = detectNowStatusFromType(type);
      if (objectId && (type === "RTS_DROP_OFF" || type === "RTS_OBJ_WORK_START")) {
        emp.whereNowObjectId = objectId;
        if (carId) {
  emp.whereNowCarId = carId;
}
      }
      if (carId && type === "RTS_ODO_START") {
        emp.whereNowCarId = carId;
      }
    }

    if (type === "RTS_OBJ_WORK_START") {
      const workId = String(payload.workId ?? "");
      const targetEmpId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const ms = getEventTsMs(e);
      if (targetEmpId && objectId && workId && ms > 0) {
        openWork.set(`${targetEmpId}||${objectId}||${workId}`, ms);
      }
      continue;
    }

    if (type === "RTS_OBJ_WORK_STOP") {
      const workId = String(payload.workId ?? "");
      const targetEmpId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const endMs = getEventTsMs(e);
      const key = `${targetEmpId}||${objectId}||${workId}`;
      const startMs = openWork.get(key);

      if (targetEmpId && objectId && startMs && endMs >= startMs) {
        const sec = Math.floor((endMs - startMs) / 1000);

        const emp = ensureEmployee(targetEmpId);
        emp.secByObject[objectId] = (emp.secByObject[objectId] ?? 0) + sec;

        const obj = ensureObject(objectId);
        obj.secByEmployee[targetEmpId] = (obj.secByEmployee[targetEmpId] ?? 0) + sec;

        if (carId) {
          const car = ensureCar(carId);
          if (type === "RTS_OBJ_WORK_STOP") {
            car.whereNowObjectId = objectId;
          }
        }
      }

      openWork.delete(key);
      continue;
    }

    if (type === "ROAD_END") {
      if (carId) {
        const car = ensureCar(carId);
        if (Number.isFinite(Number(payload?.roadSec))) {
          car.roadSec += Number(payload.roadSec);
        }
      }
    }

    if (type === "ЛОГІСТИКА") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const it of items) {
        const logisticId = String(it.logisticId ?? "").trim();
        if (!logisticId) continue;

        if (!logistics[logisticId]) {
          logistics[logisticId] = {
            logisticId,
            logisticName: String(it.logisticName ?? logisticId),
            qty: 0,
            employeeIds: [],
            approvedAmount: 0,
            statusCounts: {},
          };
        }

        const row = logistics[logisticId];
        row.qty += Number(it.qty ?? 0);
        row.logisticName = String(it.logisticName ?? row.logisticName);

        const eventStatus = String(e.status ?? "").trim() || "—";
        row.statusCounts[eventStatus] = (row.statusCounts[eventStatus] ?? 0) + 1;

        const itEmpIds = Array.isArray(it.employeeIds) ? it.employeeIds : [];
        for (const empId of itEmpIds) uniqPush(row.employeeIds, String(empId));

        if (eventStatus.toUpperCase() === "ЗАТВЕРДЖЕНО") {
          row.approvedAmount += Number(it.qty ?? 0) * Number(it.tariff ?? 0);
        }
      }
    }
  }

  const nowMs = Date.now();
  for (const [key, startMs] of openWork.entries()) {
    const [employeeId, objectId] = key.split("||");
    if (!employeeId || !objectId) continue;
    if (!Number.isFinite(startMs) || nowMs < startMs) continue;

    const sec = Math.floor((nowMs - startMs) / 1000);

    const emp = ensureEmployee(employeeId);
    emp.secByObject[objectId] = (emp.secByObject[objectId] ?? 0) + sec;

    const obj = ensureObject(objectId);
    obj.secByEmployee[employeeId] = (obj.secByEmployee[employeeId] ?? 0) + sec;
  }

  await Promise.all(
    Object.keys(objects).map(async (objectId) => {
      try {
        const ds = await getDayStatusRow(date, objectId, foremanTgId);
        objects[objectId]!.statusDay = normalizeDayStatus(ds?.status);
      } catch {
        objects[objectId]!.statusDay = "";
      }
    })
  );

  return { events: rows, cars, employees, objects, logistics };
}