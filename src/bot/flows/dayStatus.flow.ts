// src/bot/flows/dayStatus.flow.ts
import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";
import { Buffer } from "node:buffer";


import type { FlowModule, Flow, FlowBaseState } from "../core/flowTypes.js";
import { getFlowState, setFlowState, todayISO, upsertInline } from "../core/helpers.js";
import { CB } from "../core/cb.js";

import { fetchObjects, getFixedAllowances  } from "../../google/sheets/dictionaries.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";
import { setDayStatus, refreshDayChecklist } from "../../google/sheets/working.js";
import { computeFundByObject, splitFund_20_5_workers } from "../../google/sheets/payroll.js";
import { loadSheet, getCell, requireHeaders } from "../../google/sheets/core.js";
import { TIMESHEET_HEADERS, ALLOWANCES_HEADERS, EVENTS_HEADERS, ODOMETER_HEADERS } from "../../google/sheets/headers.js";
import { parseNumber } from "../../google/sheets/utils.js";
import { SHEET_NAMES } from "../../google/sheets/names.js";


type Step = "PICK_OBJECT" | "VIEW";

type State = FlowBaseState & {
  step: Step;
  objectId?: string;
  date?: string;

  // важливо: зберігаємо хто саме бригадир (tg user id),
  // бо chatId може бути не тим самим (групи/канали)
  foremanTgId?: number;
};

const FLOW: Flow = "DAY_STATUS";
const CBP = "dayStatus:" as const;

const cb = {
  PICK: `${CBP}pick`,
  OBJ: `${CBP}obj:`, // + objectId
  REFRESH: `${CBP}refresh`,
  SUBMIT: `${CBP}submit`,
};

function money(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return `${Math.round(v * 100) / 100} грн`;
}

function normEmployeeId(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // прибираємо лапки
  s = s.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");

  // якщо прилетіло як ["EMP_001"] — дістанемо перший
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.replace(/[\[\]]/g, "").trim();
    // split по комі, беремо перший
    s = s.split(",")[0]?.trim() ?? "";
    s = s.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  }

  return s;
}

async function fetchLogisticsPerPerson(date: string, objectId: string, foremanTgId: number) {
  const sh = await loadSheet(SHEET_NAMES.events);

  requireHeaders(
    sh.map,
    [
      EVENTS_HEADERS.date,
      EVENTS_HEADERS.objectId,
      EVENTS_HEADERS.foremanTgId,
      EVENTS_HEADERS.type,
      EVENTS_HEADERS.status,
      EVENTS_HEADERS.ts,
      EVENTS_HEADERS.employeeIds,
      EVENTS_HEADERS.amount, // ✅ "СУМА"
      EVENTS_HEADERS.price,  // ✅ "ЦІНА" (fallback)
    ],
    SHEET_NAMES.events
  );

  let bestTs = "";
  let bestRow: any | null = null;

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, EVENTS_HEADERS.date) ?? "").trim();
    const o = String(getCell(r, sh.map, EVENTS_HEADERS.objectId) ?? "").trim();
    const f = parseNumber(getCell(r, sh.map, EVENTS_HEADERS.foremanTgId));
    const type = String(getCell(r, sh.map, EVENTS_HEADERS.type) ?? "").trim();
    const st = String(getCell(r, sh.map, EVENTS_HEADERS.status) ?? "").trim();

    if (d !== date || o !== objectId || Number(f) !== Number(foremanTgId)) continue;
    if (type !== "ЛОГІСТИКА") continue;        // <-- якщо в тебе інша назва, заміниш тут
    if (st && st !== "АКТИВНА") continue;

    const ts = String(getCell(r, sh.map, EVENTS_HEADERS.ts) ?? "").trim();
    if (ts >= bestTs) { bestTs = ts; bestRow = r; }
  }

  if (!bestRow) return { total: 0, perPerson: 0, people: [] as string[] };

  const idsCsv = String(getCell(bestRow, sh.map, EVENTS_HEADERS.employeeIds) ?? "").trim();
  const people = idsCsv.split(",").map(x => x.trim()).filter(Boolean);

  const amount =
    parseNumber(getCell(bestRow, sh.map, EVENTS_HEADERS.amount)) ||
    parseNumber(getCell(bestRow, sh.map, EVENTS_HEADERS.price)) ||
    0;

  const total = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const perPerson = people.length ? Math.round((total / people.length) * 100) / 100 : 0;

  return { total, perPerson, people };
}




function getSubmitBlockers(row: any): string[] {
  const missing: string[] = [];

if (!row?.hasTimesheet) missing.push(TEXTS.dayStatusFlow.checklist.timesheet);

if (!row?.hasReports) missing.push(TEXTS.dayStatusFlow.checklist.works);
if (row?.hasReports && row?.hasReportsVolumeOk === false) missing.push(TEXTS.dayStatusFlow.checklist.worksVolumeOk);

if (!row?.hasOdoStart) missing.push(TEXTS.dayStatusFlow.checklist.odoStart);
if (!row?.hasOdoStartPhoto) missing.push(TEXTS.dayStatusFlow.checklist.odoStartPhoto);

if (!row?.hasOdoEnd) missing.push(TEXTS.dayStatusFlow.checklist.odoEnd);
if (!row?.hasOdoEndPhoto) missing.push(TEXTS.dayStatusFlow.checklist.odoEndPhoto);

if (row?.hasRoad === false) missing.push(TEXTS.dayStatusFlow.checklist.road + " (збережи/заверши)");

  return missing;
}

function isDaySubmittable(row: any): boolean {
  return getSubmitBlockers(row).length === 0;
}


async function fetchTimesheetForObject(date: string, objectId: string) {
  const sh = await loadSheet(SHEET_NAMES.timesheet);

  requireHeaders(
    sh.map,
    [
      TIMESHEET_HEADERS.date,
      TIMESHEET_HEADERS.objectId,
      TIMESHEET_HEADERS.employeeId,
      TIMESHEET_HEADERS.employeeName,
      TIMESHEET_HEADERS.hours,
      TIMESHEET_HEADERS.disciplineCoef,
      TIMESHEET_HEADERS.productivityCoef,
    ],
    SHEET_NAMES.timesheet
  );

const rows: Array<{
  employeeId: string;
  employeeName: string;
  hours: number;
  coefDiscipline: number;
  coefProductivity: number;
  roleCoef: number; // ✅ завжди є (поки 1)
}> = [];

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, TIMESHEET_HEADERS.date) ?? "").trim();
    const o = String(getCell(r, sh.map, TIMESHEET_HEADERS.objectId) ?? "").trim();
    if (d !== date || o !== objectId) continue;

    const employeeId = normEmployeeId(getCell(r, sh.map, TIMESHEET_HEADERS.employeeId));
    if (!employeeId) continue;

    const employeeName = String(getCell(r, sh.map, TIMESHEET_HEADERS.employeeName) ?? "").trim() || employeeId;

    const hours = parseNumber(getCell(r, sh.map, TIMESHEET_HEADERS.hours));
    const coefDiscipline = parseNumber(getCell(r, sh.map, TIMESHEET_HEADERS.disciplineCoef));
    const coefProductivity = parseNumber(getCell(r, sh.map, TIMESHEET_HEADERS.productivityCoef));

rows.push({
  employeeId,
  employeeName,
  hours: Number.isFinite(hours) && hours > 0 ? hours : 0,
  coefDiscipline: Number.isFinite(coefDiscipline) && coefDiscipline > 0 ? coefDiscipline : 1,
  coefProductivity: Number.isFinite(coefProductivity) && coefProductivity > 0 ? coefProductivity : 1,
  roleCoef: 1,
});

  }

  return rows;
}

async function fetchAllowancesForObject(date: string, objectId: string, foremanTgId: number) {
  const sh = await loadSheet(SHEET_NAMES.allowances);

  requireHeaders(
    sh.map,
    [
      ALLOWANCES_HEADERS.date,
      ALLOWANCES_HEADERS.foremanTgId,
      ALLOWANCES_HEADERS.objectId,
      ALLOWANCES_HEADERS.employeeId,
      ALLOWANCES_HEADERS.employeeName,
      ALLOWANCES_HEADERS.type,
      ALLOWANCES_HEADERS.amount,
    ],
    SHEET_NAMES.allowances
  );

  const rows: Array<{
    employeeId: string;
    employeeName: string;
    type: string;
    amount: number;
    objectId: string;
  }> = [];

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, ALLOWANCES_HEADERS.date) ?? "").trim();
    if (d !== date) continue;

    const f = parseNumber(getCell(r, sh.map, ALLOWANCES_HEADERS.foremanTgId));
    if (Number(f) !== Number(foremanTgId)) continue;

    const oid = String(getCell(r, sh.map, ALLOWANCES_HEADERS.objectId) ?? "").trim();
    // беремо доплати або для цього обʼєкта, або “загальні” (objectId пустий)
    if (oid && oid !== objectId) continue;

    const employeeId = normEmployeeId(getCell(r, sh.map, ALLOWANCES_HEADERS.employeeId));
    if (!employeeId) continue;

    const employeeName = String(getCell(r, sh.map, ALLOWANCES_HEADERS.employeeName) ?? "").trim() || employeeId;
    const type = String(getCell(r, sh.map, ALLOWANCES_HEADERS.type) ?? "").trim();
    const amount = parseNumber(getCell(r, sh.map, ALLOWANCES_HEADERS.amount));

    if (!Number.isFinite(amount) || amount === 0) continue;

    rows.push({
      employeeId,
      employeeName,
      type,
      amount,
      objectId: oid,
    });
  }

  return rows;
}


async function fetchBrigadierEmployeeIdFromRoadEnd(date: string, foremanTgId: number) {
  const ev = await loadSheet(SHEET_NAMES.events);
  requireHeaders(
    ev.map,
    [EVENTS_HEADERS.date, EVENTS_HEADERS.foremanTgId, EVENTS_HEADERS.type, EVENTS_HEADERS.objectId, EVENTS_HEADERS.payload, EVENTS_HEADERS.ts, EVENTS_HEADERS.status],
    SHEET_NAMES.events
  );

  let bestTs = "";
  let bestPayload: any = null;

  for (const r of ev.data) {
    const d = String(getCell(r, ev.map, EVENTS_HEADERS.date) ?? "").trim();
    const f = parseNumber(getCell(r, ev.map, EVENTS_HEADERS.foremanTgId));
    if (d !== date || Number(f) !== Number(foremanTgId)) continue;

    const st = String(getCell(r, ev.map, EVENTS_HEADERS.status) ?? "").trim();
    if (st && st !== "АКТИВНА") continue;

    const type = String(getCell(r, ev.map, EVENTS_HEADERS.type) ?? "").trim();
    if (type !== "ROAD_END") continue;

    const objectId = String(getCell(r, ev.map, EVENTS_HEADERS.objectId) ?? "").trim();
    if (objectId !== "") continue; // timeline

    const ts = String(getCell(r, ev.map, EVENTS_HEADERS.ts) ?? "").trim();
    const payloadStr = String(getCell(r, ev.map, EVENTS_HEADERS.payload) ?? "").trim();

    if (ts >= bestTs) {
      bestTs = ts;
      try { bestPayload = payloadStr ? JSON.parse(payloadStr) : null; } catch { bestPayload = null; }
    }
  }

  const id = String(bestPayload?.brigadierEmployeeId ?? "").trim();
  return id;
}

async function fetchTripAllowancePerPerson(date: string, foremanTgId: number) {
  // 1) fixed тарифы виїзду (S/M/L/XL) з settings (в тебе вже є в dictionaries)
  const { road } = await getFixedAllowances();

  // 2) беремо kmDay + tripClass з ODOMETER_DAY (краще max kmDay)
  const odo = await loadSheet(SHEET_NAMES.odometerDay);
  requireHeaders(
    odo.map,
    [ODOMETER_HEADERS.date, ODOMETER_HEADERS.foremanTgId, ODOMETER_HEADERS.kmDay, ODOMETER_HEADERS.tripClass],
    SHEET_NAMES.odometerDay
  );

  let best: { kmDay: number; tripClass: string } | null = null;
  for (const r of odo.data) {
    const d = String(getCell(r, odo.map, ODOMETER_HEADERS.date) ?? "").trim();
    const f = parseNumber(getCell(r, odo.map, ODOMETER_HEADERS.foremanTgId));
    if (d !== date || Number(f) !== Number(foremanTgId)) continue;

    const kmDay = parseNumber(getCell(r, odo.map, ODOMETER_HEADERS.kmDay));
    const tripClass = String(getCell(r, odo.map, ODOMETER_HEADERS.tripClass) ?? "").trim();
    if (!tripClass || !Number.isFinite(kmDay)) continue;

    if (!best || kmDay > best.kmDay) best = { kmDay, tripClass };
  }

  if (!best) return { total: 0, perPerson: 0, people: [] as string[] };

  // 3) беремо людей з ROAD_END (timeline objectId="")
  const ev = await loadSheet(SHEET_NAMES.events);
  requireHeaders(
    ev.map,
    [EVENTS_HEADERS.date, EVENTS_HEADERS.foremanTgId, EVENTS_HEADERS.type, EVENTS_HEADERS.objectId, EVENTS_HEADERS.employeeIds, EVENTS_HEADERS.ts, EVENTS_HEADERS.status],
    SHEET_NAMES.events
  );

  let bestTs = "";
  let people: string[] = [];
  for (const r of ev.data) {
    const d = String(getCell(r, ev.map, EVENTS_HEADERS.date) ?? "").trim();
    const f = parseNumber(getCell(r, ev.map, EVENTS_HEADERS.foremanTgId));
    if (d !== date || Number(f) !== Number(foremanTgId)) continue;

    const st = String(getCell(r, ev.map, EVENTS_HEADERS.status) ?? "").trim();
    if (st && st !== "АКТИВНА") continue;

    const type = String(getCell(r, ev.map, EVENTS_HEADERS.type) ?? "").trim();
    if (type !== "ROAD_END") continue;

        const objectId2 = String(getCell(r, ev.map, EVENTS_HEADERS.objectId) ?? "").trim();
    if (objectId2 !== "") continue; // саме timeline

    const ts = String(getCell(r, ev.map, EVENTS_HEADERS.ts) ?? "").trim();
    const idsCsv = String(getCell(r, ev.map, EVENTS_HEADERS.employeeIds) ?? "").trim();
    if (!idsCsv) continue;

    if (ts >= bestTs) {
      bestTs = ts;
      people = idsCsv.split(",").map(x => x.trim()).filter(Boolean);
    }
  }

  const total = Math.max(0, Number((road as any)[best.tripClass]) || 0);
  const perPerson = people.length ? Math.round((total / people.length) * 100) / 100 : 0;

  return { total, perPerson, people };
}



function kb(rows: TelegramBot.InlineKeyboardButton[][]): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

function yn(v: boolean) {
  return v ? "✅" : "❌";
}

function safeText(v?: string) {
  const s = String(v ?? "").trim();
return s.length ? s : TEXTS.ui.symbols.emptyDash;
}

function isReturned(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ПОВЕРНУТО";
}

function returnReasonBlock(row: any) {
  if (!isReturned(row?.status)) return "";
  const reason = safeText(row?.returnReason);
  return `\n\n${TEXTS.dayStatusFlow.view.returnedTitle}\n${TEXTS.dayStatusFlow.view.returnedReason} ${reason}`;

}

function isLocked(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}

function lockedText(status?: string) {
return TEXTS.dayStatusFlow.submit.locked.replace("{status}", String(status ?? ""));
}

function missingActionsFromRow(row: any) {
  return {
    timesheet: !row?.hasTimesheet,
    works: !row?.hasReports || (row?.hasReports && row?.hasReportsVolumeOk === false),
    roadOrOdo:
      row?.hasRoad === false ||
      !row?.hasOdoStart ||
      (row?.hasOdoStart && row?.hasOdoStartPhoto === false) ||
      !row?.hasOdoEnd ||
      (row?.hasOdoEnd && row?.hasOdoEndPhoto === false),
    logistics: row?.hasLogistics === false,
    materials: row?.hasMaterials === false,
  };
}

function buildFixButtons(m: ReturnType<typeof missingActionsFromRow>): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  // ✅ точне значення: AddWorkFlow => "ADD_WORK"
  if (m.works) {
rows.push([{ text: TEXTS.dayStatusFlow.fixButtons.works, callback_data: `${CB.OPEN_FLOW}ADD_WORK` }]);
  }

  // ✅ точне значення: RoadFlow => "ROAD"
  if (m.roadOrOdo) {
rows.push([{ text: TEXTS.dayStatusFlow.fixButtons.roadOdo, callback_data: `${CB.OPEN_FLOW}ROAD` }]);
  }

  // ⚠️ ТУТ треба точний FLOW з peopleTimesheet.flow.ts
  if (m.timesheet) {
rows.push([{ text: TEXTS.dayStatusFlow.fixButtons.timesheet, callback_data: `${CB.OPEN_FLOW}PEOPLE_TIMESHEET` }]);
  }

  // ⚠️ ТУТ треба точний FLOW з logistics.flow.ts
  if (m.logistics) {
rows.push([{ text: TEXTS.dayStatusFlow.fixButtons.logistics, callback_data: `${CB.OPEN_FLOW}LOGISTICS` }]);
  }

  // ⚠️ ТУТ треба точний FLOW з materials.flow.ts
  if (m.materials) {
rows.push([{ text: TEXTS.dayStatusFlow.fixButtons.materials, callback_data: `${CB.OPEN_FLOW}MATERIALS` }]);
  }

  return rows;
}



export const DayStatusFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.dayStatus,
  cbPrefix: CBP,

  async start(bot, chatId, s) {
    const st: State = { step: "PICK_OBJECT" };
    setFlowState(s, FLOW, st);

    s.mode = "FLOW";
    s.flow = FLOW;

    await this.render(bot, chatId, s);
  },

  async render(bot, chatId, s) {
    const st = (getFlowState(s, FLOW) as State) || { step: "PICK_OBJECT" };

    // 1) PICK OBJECT
    if (st.step === "PICK_OBJECT") {
      const objects = await fetchObjects();
      const slice = objects.slice(0, 20);

      // головне: кнопки обʼєктів
      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o) => [
        {
          text: `${o.name} (${o.id})`,
          callback_data: `${cb.OBJ}${o.id}`,
        },
      ]);

      // меню
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

const text =
  `${TEXTS.dayStatusFlow.title}\n` +
  `${TEXTS.dayStatusFlow.pickObject.choose}\n\n` +
  `${TEXTS.dayStatusFlow.pickObject.showingPrefix} ${slice.length} ${TEXTS.dayStatusFlow.pickObject.showingBetween} ${objects.length}.`;


      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    // 2) VIEW
    const date = st.date || todayISO();
    const objectId = st.objectId;
    const foremanTgId = st.foremanTgId;

    // якщо state битий — повертаємо на PICK
    if (!objectId) {
      setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
      await this.render(bot, chatId, s);
      return;
    }

    // якщо foreman не відомий (на всяк) — теж не падаємо
    if (!foremanTgId) {
  // якщо чомусь state без foreman — беремо з поточного чату в приваті
  // або просто повертаємо на PICK
  setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
  await this.render(bot, chatId, s);
  return;
}
const row = await getDayStatusRow(date, objectId, foremanTgId);

    const status = row?.status || "ЧЕРНЕТКА";

    const blockers = getSubmitBlockers(row);
const blockersBlock = blockers.length
  ? `\n\n${TEXTS.dayStatusFlow.view.notReadyTitle}\n` + blockers.map((x) => `• ${x}`).join("\n")
  : `\n\n${TEXTS.dayStatusFlow.view.readyOk}`;


const isApproved = String(status).toUpperCase() === "ЗАТВЕРДЖЕНО";

let financeBlock =
  `\n\n${TEXTS.dayStatusFlow.finance.title}\n` +
  TEXTS.dayStatusFlow.finance.afterApprovedOnly;

if (isApproved) {
  try {
    const fund = await computeFundByObject(date, objectId);

    const people = await fetchTimesheetForObject(date, objectId);

    // якщо табель пустий — покажемо тільки фонд
    if (!people.length) {
financeBlock =
  `\n\n${TEXTS.dayStatusFlow.finance.title}\n` +
  `${TEXTS.dayStatusFlow.finance.fundByWorks} ${money(fund)}\n` +
  TEXTS.dayStatusFlow.finance.noPeopleWarn;

    } else {
const brigadierEmployeeId =
  (await fetchBrigadierEmployeeIdFromRoadEnd(date, foremanTgId)) ||
  ""; // якщо нема ROAD_END — буде як звичайний розподіл без “бригадирського” правила

const split = splitFund_20_5_workers(fund, people, {
  brigadierEmployeeId,
});


      // доплати (allowances)
      const allowances = await fetchAllowancesForObject(date, objectId, foremanTgId);
      const addByEmp = new Map<string, number>();
      for (const a of allowances) {
        addByEmp.set(a.employeeId, (addByEmp.get(a.employeeId) ?? 0) + a.amount);
      }

      const allowancesTotal = allowances.reduce((s, a) => s + a.amount, 0);

      // ✅ Виїзд
const trip = await fetchTripAllowancePerPerson(date, foremanTgId);
const tripSet = new Set(trip.people);

// ✅ Логістика
const logi = await fetchLogisticsPerPerson(date, objectId, foremanTgId);
const logSet = new Set(logi.people);


      const lines = split.people.map((p, i) => {
        const add = addByEmp.get(p.employeeId) ?? 0;
        const tripAdd = trip.perPerson > 0 && tripSet.has(p.employeeId) ? trip.perPerson : 0;
const logAdd = logi.perPerson > 0 && logSet.has(p.employeeId) ? logi.perPerson : 0;

const total = (p.amount ?? 0) + add + tripAdd + logAdd;


        return (
          `${i + 1}) ${p.employeeName}\n` +
`   ${TEXTS.dayStatusFlow.person.hoursLine
  .replace("{hours}", String(p.hours))
  .replace("{d}", String(p.coefDiscipline))
  .replace("{p}", String(p.coefProductivity))}\n` +
`   ${TEXTS.dayStatusFlow.person.shareLine.replace("{share}", (p.share * 100).toFixed(1))}\n` +
`   ${TEXTS.dayStatusFlow.person.byFundLine.replace("{amount}", money(p.amount))}\n` +
`   ${TEXTS.dayStatusFlow.person.allowancesLine.replace("{amount}", money(add))}\n` +
`   ${TEXTS.dayStatusFlow.person.tripLine.replace("{amount}", money(tripAdd))}\n` +
`   ${TEXTS.dayStatusFlow.person.logisticsLine.replace("{amount}", money(logAdd))}\n` +
`   ${TEXTS.dayStatusFlow.person.totalLine.replace("{amount}", money(total))}`

        );
      });

financeBlock =
  `\n\n${TEXTS.dayStatusFlow.finance.title}\n` +
  `${TEXTS.dayStatusFlow.finance.fundByWorks} ${money(split.meta.fund)}\n` +
  `${TEXTS.dayStatusFlow.finance.pointsSum} ${split.meta.totalWorkersPoints}\n` +
  `${TEXTS.dayStatusFlow.finance.allowancesTotal} ${money(allowancesTotal)}\n\n` +
  lines.join("\n\n");
    }
  } catch (e: any) {
financeBlock =
  `\n\n${TEXTS.dayStatusFlow.finance.title}\n` +
  TEXTS.dayStatusFlow.finance.calcError.replace("{err}", String(e?.message ?? e));
  }
}


const text =
  `${TEXTS.dayStatusFlow.title}\n` +
  `${TEXTS.dayStatusFlow.view.date} ${date}\n` +
  `${TEXTS.dayStatusFlow.view.object} ${objectId}\n` +
  `${TEXTS.dayStatusFlow.view.status} ${status}\n\n` +
  `${TEXTS.dayStatusFlow.view.checklistTitle}\n` +
`${TEXTS.dayStatusFlow.checklist.timesheet}: ${yn(!!row?.hasTimesheet)}\n` +
`${TEXTS.dayStatusFlow.checklist.works}: ${yn(!!row?.hasReports)}\n` +
(row?.hasReports ? `${TEXTS.dayStatusFlow.checklist.worksVolumeOk}: ${yn(row?.hasReportsVolumeOk !== false)}\n` : ``) +
`${TEXTS.dayStatusFlow.checklist.road}: ${yn(!!row?.hasRoad)}\n` +
`${TEXTS.dayStatusFlow.checklist.odoStart}: ${yn(!!row?.hasOdoStart)}\n` +
`${TEXTS.dayStatusFlow.checklist.odoStartPhoto}: ${yn(!!row?.hasOdoStartPhoto)}\n` +
`${TEXTS.dayStatusFlow.checklist.odoEnd}: ${yn(!!row?.hasOdoEnd)}\n` +
`${TEXTS.dayStatusFlow.checklist.odoEndPhoto}: ${yn(!!row?.hasOdoEndPhoto)}\n` +
`${TEXTS.dayStatusFlow.checklist.logistics}: ${yn(!!row?.hasLogistics)}\n` +
`${TEXTS.dayStatusFlow.checklist.materials}: ${yn(!!row?.hasMaterials)}\n\n` +

blockersBlock +
returnReasonBlock(row) +
`\n\n` +
`${TEXTS.dayStatusFlow.view.approvedBy} ${safeText(row?.approvedBy)}\n` +
`${TEXTS.dayStatusFlow.view.approvedAt} ${safeText(row?.approvedAt)}\n` +
`${TEXTS.dayStatusFlow.view.updatedAt} ${safeText(row?.updatedAt)}` +
financeBlock;


const rows: TelegramBot.InlineKeyboardButton[][] = [
[{ text: TEXTS.dayStatusFlow.buttons.refresh, callback_data: cb.REFRESH }],
];

// ✅ NEW: якщо є missing — показуємо кнопки “перейти виправити”
const miss = missingActionsFromRow(row);
const fixRows = buildFixButtons(miss);
if (fixRows.length) rows.push(...fixRows);

if (!isLocked(status)) {
  rows.push([{
text: isReturned(status) ? TEXTS.dayStatusFlow.buttons.resubmit : TEXTS.dayStatusFlow.buttons.submit,
    callback_data: cb.SUBMIT
  }]);
} else {
  rows.push([{ text: `🔒 ${status}`, callback_data: cb.REFRESH }]);
}


rows.push([{ text: TEXTS.ui.buttons.back, callback_data: cb.PICK }]);
rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

// ✅ DEBUG: перевіряємо всі callback_data перед відправкою
for (const r of rows) {
  for (const b of r) {
    if (!b.callback_data) continue;
    const cd = String(b.callback_data);
    const bytes = Buffer.byteLength(cd, "utf8");

if (!cd.length) console.log("❌ callback_data empty");
if (bytes > 64) console.log("❌ callback_data too long:", bytes, cd);
if (cd.includes("\n")) console.log("❌ callback_data has newline:", cd);
if (cd.includes("undefined") || cd.includes("[object")) console.log("❌ callback_data invalid:", cd);

  }
}

    await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
  },

  async onCallback(bot, q, s, data) {
    if (!data.startsWith(CBP)) return false;

    const chatId = q.message?.chat?.id;
    if (typeof chatId !== "number") return true;

    const foremanTgId = q.from.id;

    const st = (getFlowState(s, FLOW) as State) || { step: "PICK_OBJECT" };

    // завжди зберігаємо foremanTgId
    setFlowState(s, FLOW, { ...st, foremanTgId } as State);

    // Назад до вибору обʼєкта
    if (data === cb.PICK) {
      setFlowState(s, FLOW, { step: "PICK_OBJECT", foremanTgId } as State);
      await this.render(bot, chatId, s);
      return true;
    }

    // Вибір обʼєкта
    if (data.startsWith(cb.OBJ)) {
      const objectId = data.slice(cb.OBJ.length);
      const date = todayISO();

      setFlowState(s, FLOW, { step: "VIEW", objectId, date, foremanTgId } as State);

      // одразу оновимо чекліст, щоб прапорці зʼявились
      await refreshDayChecklist(date, objectId, foremanTgId);

      await this.render(bot, chatId, s);
      return true;
    }

    // Refresh checklist
    if (data === cb.REFRESH) {
      const cur = (getFlowState(s, FLOW) as State) || st;

      if (!cur.objectId) {
        setFlowState(s, FLOW, { step: "PICK_OBJECT", foremanTgId } as State);
        await this.render(bot, chatId, s);
        return true;
      }

      const date = cur.date || todayISO();
      await refreshDayChecklist(date, cur.objectId, foremanTgId);

      await this.render(bot, chatId, s);
      return true;
    }

    // Submit day
    if (data === cb.SUBMIT) {
      const cur = (getFlowState(s, FLOW) as State) || st;

      if (!cur.objectId) {
        setFlowState(s, FLOW, { step: "PICK_OBJECT", foremanTgId } as State);
        await this.render(bot, chatId, s);
        return true;
      }

      const date = cur.date || todayISO();

      // 1) оновлюємо чекліст
      await refreshDayChecklist(date, cur.objectId, foremanTgId);

      // 2) читаємо статусний рядок і мінімально валідимо
      const row = await getDayStatusRow(date, cur.objectId, foremanTgId);

// ✅ якщо день уже здано/затверджено — блокуємо
if (isLocked(row?.status)) {
  await upsertInline(
    bot,
    chatId,
    s,
    FLOW,
    lockedText(row?.status),
    kb([
[{ text: TEXTS.ui.buttons.back, callback_data: cb.PICK }],
      [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
    ])
  );
  return true;
}

const missing = getSubmitBlockers(row);

if (missing.length) {
  const text =
`${TEXTS.dayStatusFlow.view.notReadyTitle}\n\n` +
    missing.map((x) => `• ${x}`).join("\n") +
`\n\n${TEXTS.dayStatusFlow.submit.refreshHint}`;

  const miss = missingActionsFromRow(row);
  const fixRows = buildFixButtons(miss);

  const kbRows: TelegramBot.InlineKeyboardButton[][] = [
    ...fixRows,
[{ text: TEXTS.dayStatusFlow.buttons.refresh, callback_data: cb.REFRESH }],
    [{ text: TEXTS.ui.buttons.back, callback_data: cb.PICK }],
    [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
  ];

  // ✅ DEBUG: перевіряємо всі callback_data перед відправкою
  for (const r of kbRows) {
    for (const b of r) {
      if (!b.callback_data) continue;
      const cd = String(b.callback_data);
      const bytes = Buffer.byteLength(cd, "utf8");

      if (bytes > 64) console.log("❌ callback_data too long:", bytes, cd);
      if (cd.includes("undefined") || cd.includes("[object")) console.log("❌ callback_data invalid:", cd);
    }
  }

  await upsertInline(bot, chatId, s, FLOW, text, kb(kbRows));
  return true;
}


      // 3) ставимо статус "ЗДАНО"
      await setDayStatus({
        date,
        objectId: cur.objectId,
        foremanTgId,
        status: "ЗДАНО",
      });

      // 4) перемальовуємо екран
      await this.render(bot, chatId, s);
      return true;
    }

    // якщо щось незрозуміле — просто перемалюємо
    await this.render(bot, chatId, s);
    return true;
  },
};
