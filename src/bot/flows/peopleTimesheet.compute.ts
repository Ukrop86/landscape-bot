// src/bot/flows/peopleTimesheet.compute.ts
import { fetchEvents } from "../../google/sheets/working.js";
import { uniq } from "../core/helpers.js";
import type { Ts2Row } from "./peopleTimesheet.types.js";

function csvToIds(csv: string): string[] {
  return String(csv ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function computeFromTs2(args: { date: string; foremanTgId: number; objectId?: string }) {
  const { date, foremanTgId, objectId } = args;

  const filter: any = {
    date,
    foremanTgId,
    types: [
      "TS2_OBJ_START",
      "TS2_OBJ_STOP",
      "TS2_WORK_ADD",
      "TS2_WORK_REMOVE",
      "TS2_ASSIGN",
      "TS2_UNASSIGN",
      "TS2_WORK_START",
      "TS2_WORK_STOP",
      "TS2_EMP_MOVE",
      "TS2_COEF_SET",
    ],
    status: "АКТИВНА",
    ...(objectId ? { objectId } : {}),
  };

  const events = (await fetchEvents(filter)) as any[];

  const openWork = new Map<string, string>(); // emp||work||obj -> startedAt
  const openObj = new Map<string, { startedAt: string; roster: string[] }>(); // objId -> startedAt + roster

  const secByEmpObj = new Map<string, number>(); // emp||obj -> sec
  const discByEmpObj = new Map<string, number>(); // emp||obj -> discipline
  const prodByEmpObj = new Map<string, number>(); // emp||obj -> productivity

  const addSec = (employeeId: string, objId: string, sec: number) => {
    const key = `${employeeId}||${objId}`;
    secByEmpObj.set(key, (secByEmpObj.get(key) ?? 0) + sec);
  };

  const setCoef = (kind: "discipline" | "productivity", employeeId: string, objId: string, v: number) => {
    const key = `${employeeId}||${objId}`;
    if (kind === "discipline") discByEmpObj.set(key, v);
    else prodByEmpObj.set(key, v);
  };

  events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  for (const e of events) {
    const t = String(e.type ?? "");
    const objId = String(e.objectId ?? "");
    const ts = String(e.ts ?? "");
    const employeeIds = csvToIds(String(e.employeeIds ?? ""));

    let payload: any = {};
    try {
      payload = e.payload ? JSON.parse(String(e.payload)) : {};
    } catch {
      payload = {};
    }

    if (t === "TS2_COEF_SET") {
      const employeeId = String(payload.employeeId ?? "");
      const v = Number(payload.value);
      const kind: "discipline" | "productivity" =
        payload.kind === "discipline" ? "discipline" : "productivity";
      if (employeeId && Number.isFinite(v)) setCoef(kind, employeeId, objId, v);
      continue;
    }

    if (t === "TS2_OBJ_START") {
      const startedAt = String(payload.startedAt ?? ts);
      const roster = (payload.employeeIds ? csvToIds(payload.employeeIds) : employeeIds) ?? employeeIds;
      if (!openObj.has(objId)) openObj.set(objId, { startedAt, roster: uniq(roster) });
      continue;
    }

    if (t === "TS2_OBJ_STOP") {
      const end = Date.parse(ts);
      const o = openObj.get(objId);
      if (o) {
        const start = Date.parse(o.startedAt);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          const dur = Math.floor((end - start) / 1000);
          for (const empId of o.roster) addSec(empId, objId, dur);
        }
        openObj.delete(objId);
      }

      for (const [k, startedAt] of [...openWork.entries()]) {
        const parts = k.split("||");
        if (parts.length < 3) {
          openWork.delete(k);
          continue;
        }
        const empId = parts[0]!;
        const oId = parts[2]!;
        if (oId !== objId) continue;

        const start = Date.parse(startedAt);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          addSec(empId, objId, Math.floor((end - start) / 1000));
        }
        openWork.delete(k);
      }
      continue;
    }

    if (t === "TS2_WORK_START") {
      const employeeId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const workId = String(payload.workId ?? "");
      if (!employeeId || !workId) continue;
      const key = `${employeeId}||${workId}||${objId}`;
      if (!openWork.has(key)) openWork.set(key, ts);
      continue;
    }

    if (t === "TS2_WORK_STOP") {
      const employeeId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const workId = String(payload.workId ?? "");
      if (!employeeId || !workId) continue;
      const key = `${employeeId}||${workId}||${objId}`;
      const a = openWork.get(key);
      if (!a) continue;

      const start = Date.parse(a);
      const end = Date.parse(ts);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        openWork.delete(key);
        continue;
      }
      addSec(employeeId, objId, Math.floor((end - start) / 1000));
      openWork.delete(key);
      continue;
    }
  }

  const now = Date.now();

  for (const [objId, o] of [...openObj.entries()]) {
    const start = Date.parse(o.startedAt);
    if (Number.isFinite(start) && now >= start) {
      const dur = Math.floor((now - start) / 1000);
      for (const empId of o.roster) addSec(empId, objId, dur);
    }
  }

  for (const [k, startedAt] of [...openWork.entries()]) {
    const parts = k.split("||");
    if (parts.length < 3) continue;
    const empId = parts[0]!;
    const objId = parts[2]!;
    const start = Date.parse(startedAt);
    if (Number.isFinite(start) && now >= start) addSec(empId, objId, Math.floor((now - start) / 1000));
  }

  const out: Ts2Row[] = [];
  for (const [k, sec] of secByEmpObj.entries()) {
    const parts = k.split("||");
    if (parts.length < 2) continue;
    const employeeId = parts[0]!;
    const objId = parts[1]!;
    if (!employeeId || !objId) continue;

    out.push({
      objectId: objId,
      employeeId,
      sec,
      disciplineCoef: discByEmpObj.get(k) ?? 1.0,
      productivityCoef: prodByEmpObj.get(k) ?? 1.0,
    });
  }

  out.sort((a, b) => `${a.objectId}:${a.employeeId}`.localeCompare(`${b.objectId}:${b.employeeId}`));
  return out;
}