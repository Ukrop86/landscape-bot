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

  const brigadierIds = new Set(
    [
      ...(Array.isArray(payload.brigadierEmployeeIds)
        ? payload.brigadierEmployeeIds
        : []),
      payload.brigadierEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );
  const seniorIds = new Set(
    [
      ...(Array.isArray(payload.seniorEmployeeIds)
        ? payload.seniorEmployeeIds
        : []),
      payload.seniorEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );

  const byObjectEmployee = new Map<string, any[]>();
  const workTotals = new Map<
    string,
    {
      objectId: string;
      workId: string;
      workName: string;
      unit: string;
      qty: number;
      amount: number;
    }
  >();

  for (const row of workMoneyRows) {
    const objectId = String(row.objectId ?? "").trim();
    const employeeId = String(row.employeeId ?? "").trim();
    const workId = String(row.workId ?? "").trim();
    const workName = String(row.workName ?? row.workId ?? "").trim();
    if (!employeeId || !workName) continue;

    const key = `${objectId}||${employeeId}`;
    const rows = byObjectEmployee.get(key) ?? [];
    rows.push(row);
    byObjectEmployee.set(key, rows);

    const workKey = `${objectId}||${workId || workName}`;
    const current =
      workTotals.get(workKey) ?? {
        objectId,
        workId,
        workName,
        unit: String(row.unit ?? "").trim(),
        qty: 0,
        amount: 0,
      };

    current.qty += Number(row.qty ?? 0);
    current.amount += Number(row.amount ?? 0);
    workTotals.set(workKey, current);
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

    const objectTotal = Number(pack?.objectTotal ?? 0);
    const packRows = Array.isArray(pack?.rows) ? pack.rows : [];
    const hasBrigadier = packRows.some((r: any) =>
      brigadierIds.has(String(r.employeeId ?? "").trim()),
    );
    const hasSenior = packRows.some((r: any) =>
      seniorIds.has(String(r.employeeId ?? "").trim()),
    );
    const workersPool = money(objectTotal * (hasBrigadier ? 0.7 : 0.9));
    const workerSalaryRows = packRows.filter((r: any) => {
      const id = String(r.employeeId ?? "").trim();
      if (!id) return false;
      if (hasBrigadier && brigadierIds.has(id)) return false;
      if (hasSenior && seniorIds.has(id)) return false;
      return byObjectEmployee.has(`${objectId}||${id}`);
    });
    const employeesCount = workerSalaryRows.length;
    if (!employeesCount || workersPool <= 0) continue;

    const perEmployeeAmount = money(workersPool / employeesCount);
    const objectWorks = [...workTotals.values()].filter(
      (w) => String(w.objectId) === objectId && Number(w.amount ?? 0) > 0,
    );
    const workTotalForObject = objectWorks.reduce(
      (a, w) => a + Number(w.amount ?? 0),
      0,
    );

    for (const salaryRow of workerSalaryRows) {
      const employeeId = String(salaryRow?.employeeId ?? "").trim();
      const employeeName = String(salaryRow?.employeeName ?? employeeId).trim();
      if (!employeeId) continue;

      const workRows = byObjectEmployee.get(`${objectId}||${employeeId}`) ?? [];
      if (!workRows.length) continue;

      const workKeys = [
        ...new Set(
          workRows.map((row) => {
            const workId = String(row.workId ?? "").trim();
            return `${objectId}||${workId || String(row.workName ?? "")}`;
          }),
        ),
      ];

      for (const workKey of workKeys) {
        const totalWork = workTotals.get(workKey);
        if (!totalWork) continue;

        const workTotal = Number(totalWork.amount ?? 0);
        const share =
          workTotalForObject > 0
            ? workTotal / workTotalForObject
            : 1 / Math.max(1, workKeys.length);
        const amount = money(perEmployeeAmount * share);

        if (amount <= 0) continue;

        const qty = Number(totalWork.qty ?? 0);
        const unit = String(totalWork.unit ?? "").trim();
        const formattedQty = volumeText({ qty, unit });

        out.push({
          employeeName,
          objectName,
          workName: totalWork.workName || totalWork.workId || "—",
          volume: formattedQty,
          amount,
          note: [
            `date=${ev.date}`,
            `foremanTgId=${ev.foremanTgId}`,
            `eventId=${ev.eventId}`,
            `objectId=${objectId}`,
            `employeeId=${employeeId}`,
            `workId=${totalWork.workId}`,
          ].join("; "),
        });

        console.log(
          [
            "[accounting] row",
            `workTotal=${money(workTotal)}`,
            `workersPool=${workersPool}`,
            `employeesCount=${employeesCount}`,
            `perEmployeeAmount=${perEmployeeAmount}`,
            `qty=${money(qty)}`,
            `unit=${unit}`,
            `formattedQty=${formattedQty}`,
          ].join(" "),
        );
      }
    }
  }

  const totalRowsAmount = money(out.reduce((a, row) => a + Number(row.amount ?? 0), 0));
  console.log(`[accounting] totalRowsAmount=${totalRowsAmount}`);

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
