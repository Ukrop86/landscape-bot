// src/bot/flows/roadTimesheet.compute.ts
import { fetchEvents } from "../../google/sheets/working.js";

export type WorkMoneyRow = {
  objectId: string;
  employeeId: string;
  workId: string;
  workName: string;
  unit: string;
  rate: number;
  qty: number;
  amount: number;
  sec: number; // в цій функції лишається 0 (як у тебе)
};

export async function computeWorkMoneyFromRts(args: { date: string; foremanTgId: number }) {
  const { date, foremanTgId } = args;

  const filter: any = {
    date,
    foremanTgId,
    types: ["RTS_PAYROLL_INPUT"], // ✅ тільки обсяги по об'єкту
    status: "АКТИВНА",
  };

  const events = (await fetchEvents(filter)) as any[];
  events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  const out: WorkMoneyRow[] = [];

  for (const e of events) {
    const objId = String(e.objectId ?? "");
    let payload: any = {};
    try {
      payload = e.payload ? JSON.parse(String(e.payload)) : {};
    } catch {}

    const employeeIds: string[] = (payload.employeeIds ?? [])
      .map((x: any) => String(x).trim())
      .filter(Boolean);

    const n = employeeIds.length || 0;
    if (!objId || n === 0) continue;

    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const it of items) {
      const workId = String(it.workId ?? "").trim();
      if (!workId) continue;

      const qtyTotal = Number(it.qty ?? 0);
      const rate = Number(it.rate ?? 0);
      const amountTotal = (Number.isFinite(qtyTotal) ? qtyTotal : 0) * (Number.isFinite(rate) ? rate : 0);

      // ✅ рівний розподіл
      const qtyPer = qtyTotal / n;
      const amountPer = amountTotal / n;

      for (const empId of employeeIds) {
        out.push({
          objectId: objId,
          employeeId: empId,
          workId,
          workName: String(it.workName ?? workId),
          unit: String(it.unit ?? "од."),
          rate: Number.isFinite(rate) ? rate : 0,
          qty: Math.round(qtyPer * 100) / 100,
          amount: Math.round(amountPer * 100) / 100,
          sec: 0,
        });
      }
    }
  }

  return out;
}