import { getSheetsClient } from "../client.js";
import { config } from "../../config.js";
import { norm, normalizeHeader, sheetRef, colToA1 } from "./utils.js";
import type { HeaderName } from "./headers.js";

export function resolveHeaderIndex(map: Record<string, number>, header: HeaderName): number | undefined {
  const variants = Array.isArray(header) ? header : [header];
  for (const v of variants) {
    const key = norm(v);
    if (key in map) return map[key];
  }
  return undefined;
}

export function requireHeaders(map: Record<string, number>, required: HeaderName[], sheetName: string) {
  const missing: string[] = [];

  for (const r of required) {
    const idx = resolveHeaderIndex(map, r);
    if (idx === undefined) {
      missing.push(Array.isArray(r) ? r.join(" | ") : r);
    }
  }

  if (missing.length) {
    throw new Error(`❌ У вкладці "${sheetName}" не знайдено колонки: ${missing.join(", ")}`);
  }
}

export function getCell(row: any[], map: Record<string, number>, headerName: HeaderName) {
  const idx = resolveHeaderIndex(map, headerName);
  if (idx === undefined) return "";
  return String(row[idx] ?? "").trim();
}

export function buildRowByHeaders(headers: string[], map: Record<string, number>, patch: Record<string, any>) {
  const row = new Array(headers.length).fill("");

  for (const [hRaw, v] of Object.entries(patch)) {
    const idx = map[norm(hRaw)];
    if (idx === undefined) continue;
    row[idx] = v ?? "";
  }

  return row;
}

export async function getHeaderMap(sheetName: string) {
  const sheets = getSheetsClient();
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${sheetRef(sheetName)}!1:1`,
  });

  const rawHeaders: string[] = (head.data.values?.[0] || []).map((x) => String(x ?? ""));
  const headers = rawHeaders.map(normalizeHeader);

  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = norm(h);
    if (key) map[key] = i;
  });

  return { headers, map };
}

export async function loadSheet(sheetName: string, range = "A:Z") {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${sheetRef(sheetName)}!${range}`,
  });

  const rows = res.data.values || [];

  if (rows.length === 0) {
    return { header: [] as string[], map: {} as Record<string, number>, data: [] as any[][], all: rows };
  }

  const header = (rows[0] || []).map(normalizeHeader);
  const map: Record<string, number> = {};
  header.forEach((h: string, i: number) => {
    const key = norm(h);
    if (key) map[key] = i;
  });

  const data = rows
    .slice(1)
    .filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));

  return { header, map, data, all: rows };
}

export async function appendRows(
  sheetName: string,
  rows: any[][],
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED"
) {
  if (!rows.length) return;
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${sheetRef(sheetName)}!A:Z`,
    valueInputOption,
    requestBody: { values: rows },
  });
}

export async function updateRow(sheetName: string, rowNumber1Based: number, values: any[]) {
  const sheets = getSheetsClient();
  const endCol = colToA1(values.length - 1);
  const range = `${sheetRef(sheetName)}!A${rowNumber1Based}:${endCol}${rowNumber1Based}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

function rowMatchesKeys(row: any[], map: Record<string, number>, keys: Record<string, any>) {
  for (const [headerName, expected] of Object.entries(keys)) {
    const idx = map[norm(headerName)];
    if (idx === undefined) return false;
    const cell = String(row[idx] ?? "").trim();
    const exp = String(expected ?? "").trim();
    if (cell !== exp) return false;
  }
  return true;
}

/**
 * Upsert: знайти рядок по keys → update, або append якщо нема
 * (для MVP читає весь лист A:Z)
 */
export async function upsertRowByKeys(sheetName: string, keys: Record<string, any>, patch: Record<string, any>) {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${sheetRef(sheetName)}!A:Z`,
  });

  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`❌ Лист "${sheetName}" порожній або не має заголовків`);

  const headers = (rows[0] || []).map(normalizeHeader);
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (h) map[norm(h)] = i;
  });

  // всі key headers мають існувати
  requireHeaders(map, Object.keys(keys), sheetName);
  // і всі patch headers теж мають існувати
  requireHeaders(map, Object.keys(patch), sheetName);

  // знайти рядок
  let foundIndex0Based = -1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    if (rowMatchesKeys(r, map, keys)) {
      foundIndex0Based = i;
      break;
    }
  }

  if (foundIndex0Based !== -1) {
    const existing = rows[foundIndex0Based] || [];
    const full = new Array(headers.length).fill("");
    for (let i = 0; i < headers.length; i++) full[i] = existing[i] ?? "";

    // накласти patch
    for (const [h, v] of Object.entries(patch)) {
      const idx = map[norm(h)];
      if (idx === undefined) continue;
      full[idx] = v ?? "";
    }

    await updateRow(sheetName, foundIndex0Based + 1, full);
    return { action: "updated" as const, rowNumber: foundIndex0Based + 1 };
  }

  const mergedPatch = { ...keys, ...patch };
  const newRow = buildRowByHeaders(headers, map, mergedPatch);
  await appendRows(sheetName, [newRow], "USER_ENTERED");
  return { action: "appended" as const };
}
