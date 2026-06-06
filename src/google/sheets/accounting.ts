import { config } from "../../config.js";
import { getSheetsClient } from "../client.js";
import { appendRows, loadSheet } from "./core.js";
import { sheetRef } from "./utils.js";

const ACCOUNTING_SHEET = "БУХЗВІТ";
const ACCOUNTING_HEADERS = [
  "№",
  "Працівник",
  "Об'єкт",
  "Роботи",
  "Обсяг робіт",
  "Нарахування",
  "Примітки",
] as const;

type RoadEventLike = {
  eventId: string;
  date: string;
  foremanTgId: number;
  payload?: string;
};

type AccountingRow = {
  employeeName: string;
  objectName: string;
  workName: string;
  volume: string;
  amount: number;
  note: string;
};

async function ensureAccountingSheet() {
  const sheets = getSheetsClient();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.sheetId,
    fields: "sheets.properties.title",
  });

  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === ACCOUNTING_SHEET,
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: ACCOUNTING_SHEET } } }],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(ACCOUNTING_SHEET)}!A1:G1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[...ACCOUNTING_HEADERS]] },
    });

    console.log(`[accounting] created sheet ${ACCOUNTING_SHEET}`);
  }
}

async function loadAccountingSheet() {
  await ensureAccountingSheet();
  return loadSheet(ACCOUNTING_SHEET, "A:G");
}

export async function hasAccountingRowsForEvent(eventId: string) {
  const sh = await loadAccountingSheet();
  const marker = `eventId=${eventId}`;

  return sh.all.some((row) =>
    String(row?.[6] ?? "").includes(marker),
  );
}

function money(n: number) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function volumeText(row: any) {
  const qty = Number(row.qty ?? 0);
  const unit = String(row.unit ?? "").trim();
  const qtyText = Number.isFinite(qty) ? String(Math.round(qty * 100) / 100) : "";
  return [qtyText, unit].filter(Boolean).join(" ");
}

function parsePayload(ev: RoadEventLike) {
  try {
    return ev.payload ? JSON.parse(String(ev.payload)) : {};
  } catch {
    return {};
  }
}

export function buildAccountingRowsFromApprovedRoadEvent(ev: RoadEventLike): AccountingRow[] {
  const payload = parsePayload(ev);
  const workMoneyRows = Array.isArray(payload.workMoneyRows)
    ? payload.workMoneyRows
    : [];
  const salaryPacks = Array.isArray(payload.salaryPacks)
    ? payload.salaryPacks
    : [];
  const objectsDetailed = Array.isArray(payload.objectsDetailed)
    ? payload.objectsDetailed
    : [];

  const objectNameById = new Map<string, string>();
  for (const o of objectsDetailed) {
    const id = String(o?.objectId ?? "").trim();
    const name = String(o?.objectName ?? "").trim();
    if (id && name) objectNameById.set(id, name);
  }

  const fallbackObjects = objectsDetailed
    .map((o: any) => String(o?.objectName ?? "").trim())
    .filter(Boolean)
    .join(", ");

  const byObjectEmployee = new Map<string, any[]>();
  for (const row of workMoneyRows) {
    const objectId = String(row.objectId ?? "").trim();
    const employeeId = String(row.employeeId ?? "").trim();
    const workName = String(row.workName ?? row.workId ?? "").trim();
    if (!employeeId || !workName) continue;

    const key = `${objectId}||${employeeId}`;
    const rows = byObjectEmployee.get(key) ?? [];
    rows.push(row);
    byObjectEmployee.set(key, rows);
  }

  const out: AccountingRow[] = [];

  for (const pack of salaryPacks) {
    const objectId = String(pack?.objectId ?? "").trim();
    const objectName =
      String(pack?.objectName ?? "").trim() ||
      objectNameById.get(objectId) ||
      fallbackObjects ||
      objectId ||
      "—";

    for (const salaryRow of pack?.rows ?? []) {
      const employeeId = String(salaryRow?.employeeId ?? "").trim();
      const employeeName = String(salaryRow?.employeeName ?? employeeId).trim();
      const employeePay = Number(salaryRow?.pay ?? 0);
      if (!employeeId || employeePay <= 0) continue;

      const workRows = byObjectEmployee.get(`${objectId}||${employeeId}`) ?? [];
      if (!workRows.length) continue;

      const baseTotal = workRows.reduce(
        (a, row) => a + Math.max(0, Number(row.amount ?? 0)),
        0,
      );

      for (const row of workRows) {
        const base = Math.max(0, Number(row.amount ?? 0));
        const share =
          baseTotal > 0 ? base / baseTotal : 1 / Math.max(1, workRows.length);
        const amount = money(employeePay * share);

        if (amount <= 0) continue;

        out.push({
          employeeName,
          objectName,
          workName: String(row.workName ?? row.workId ?? "—"),
          volume: volumeText(row),
          amount,
          note: [
            `date=${ev.date}`,
            `foremanTgId=${ev.foremanTgId}`,
            `eventId=${ev.eventId}`,
            `objectId=${objectId}`,
            `employeeId=${employeeId}`,
            `workId=${String(row.workId ?? "").trim()}`,
          ].join("; "),
        });
      }
    }
  }

  return out;
}

export async function appendAccountingReportRows(rows: AccountingRow[]) {
  if (!rows.length) return;

  const sh = await loadAccountingSheet();
  const hasHeader =
    String(sh.all?.[0]?.[0] ?? "").trim() === ACCOUNTING_HEADERS[0] &&
    String(sh.all?.[0]?.[1] ?? "").trim() === ACCOUNTING_HEADERS[1];
  const existingDataRows = hasHeader ? Math.max(0, sh.all.length - 1) : sh.all.length;
  let nextNo = existingDataRows + 1;

  await appendRows(
    ACCOUNTING_SHEET,
    rows.map((row) => [
      nextNo++,
      row.employeeName,
      row.objectName,
      row.workName,
      row.volume,
      row.amount,
      row.note,
    ]),
    "USER_ENTERED",
  );
}

export async function appendAccountingReportForApprovedRoadEvent(ev: RoadEventLike) {
  if (await hasAccountingRowsForEvent(ev.eventId)) {
    console.log(`[accounting] skip duplicate eventId=${ev.eventId}`);
    return { skipped: true, rows: 0 };
  }

  const rows = buildAccountingRowsFromApprovedRoadEvent(ev);
  console.log(`[accounting] prepared rows=${rows.length} eventId=${ev.eventId}`);

  if (!rows.length) {
    console.log(`[accounting] nothing to append eventId=${ev.eventId}`);
    return { skipped: false, rows: 0 };
  }

  await appendAccountingReportRows(rows);
  console.log(`[accounting] appended rows=${rows.length} eventId=${ev.eventId}`);
  return { skipped: false, rows: rows.length };
}
