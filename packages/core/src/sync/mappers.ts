import { getCell, loadSheet } from "../google/sheets.js";
import { loadDictionarySheet } from "./autoId.js";
import { toBool, parseNumber } from "../google/utils.js";
import {
  SHEET_NAMES,
  USERS_HEADERS,
  EMP_HEADERS,
  OBJECTS_HEADERS,
  WORKS_HEADERS,
  CARS_HEADERS,
  LOGISTIC_HEADERS,
  MATERIALS_HEADERS,
  TOOLS_HEADERS,
  SETTINGS_HEADERS,
} from "../google/names.js";

function toBigIntOrNull(v: string): bigint | null {
  if (!v) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function toDateOrNull(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function readUsers() {
  const { data, map } = await loadSheet(SHEET_NAMES.users);
  return data
    .map((row) => ({
      tgId: toBigIntOrNull(getCell(row, map, USERS_HEADERS.tgId)),
      username: getCell(row, map, USERS_HEADERS.username) || null,
      pib: getCell(row, map, USERS_HEADERS.pib),
      role: getCell(row, map, USERS_HEADERS.role),
      active: toBool(getCell(row, map, USERS_HEADERS.active)),
      comment: getCell(row, map, USERS_HEADERS.comment) || null,
    }))
    .filter((r) => r.tgId !== null) as any[];
}

export async function readEmployees() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.employees,
    idHeader: EMP_HEADERS.id,
    nameHeader: EMP_HEADERS.name,
    fallbackPrefix: "EMP_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, EMP_HEADERS.id),
      name: getCell(row, map, EMP_HEADERS.name),
      brigadeId: getCell(row, map, EMP_HEADERS.brigadeId) || null,
      position: getCell(row, map, EMP_HEADERS.position) || null,
      active: toBool(getCell(row, map, EMP_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readObjects() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.objects,
    idHeader: OBJECTS_HEADERS.id,
    nameHeader: OBJECTS_HEADERS.name,
    fallbackPrefix: "OBJ_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, OBJECTS_HEADERS.id),
      name: getCell(row, map, OBJECTS_HEADERS.name),
      address: getCell(row, map, OBJECTS_HEADERS.address) || null,
      active: toBool(getCell(row, map, OBJECTS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readWorks() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.works,
    idHeader: WORKS_HEADERS.id,
    nameHeader: WORKS_HEADERS.name,
    fallbackPrefix: "WT_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, WORKS_HEADERS.id),
      name: getCell(row, map, WORKS_HEADERS.name),
      category: getCell(row, map, WORKS_HEADERS.category) || null,
      subcategory: getCell(row, map, WORKS_HEADERS.subcategory) || null,
      unit: getCell(row, map, WORKS_HEADERS.unit) || null,
      tariff: parseNumber(getCell(row, map, WORKS_HEADERS.tariff)) ?? 0,
      active: toBool(getCell(row, map, WORKS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readCars() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.cars,
    idHeader: CARS_HEADERS.id,
    nameHeader: CARS_HEADERS.name,
    fallbackPrefix: "CAR_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, CARS_HEADERS.id),
      name: getCell(row, map, CARS_HEADERS.name),
      plate: getCell(row, map, CARS_HEADERS.plate) || null,
      active: toBool(getCell(row, map, CARS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

function parseDiscountsCell(raw: unknown): Record<number, number> {
  const s = String(raw ?? "").trim();
  if (!s) return {};

  const out: Record<number, number> = {};
  const parts = s.split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean);

  for (const p of parts) {
    const m = p.match(/^(\d+)\s*[:=]\s*(\d+(?:[.,]\d+)?)$/);
    if (!m) continue;
    const qty = Number(m[1]);
    const disc = Number(String(m[2]).replace(",", "."));
    if (Number.isFinite(qty) && qty >= 2 && Number.isFinite(disc) && disc >= 0) {
      out[qty] = disc;
    }
  }

  return out;
}

export async function readLogisticDirections() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.logistic,
    idHeader: LOGISTIC_HEADERS.id,
    nameHeader: LOGISTIC_HEADERS.name,
    fallbackPrefix: "LG_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, LOGISTIC_HEADERS.id),
      name: getCell(row, map, LOGISTIC_HEADERS.name),
      tariff: parseNumber(getCell(row, map, LOGISTIC_HEADERS.tariff)) ?? 0,
      discountsByQty: JSON.stringify(parseDiscountsCell(getCell(row, map, LOGISTIC_HEADERS.discount))),
      active: toBool(getCell(row, map, LOGISTIC_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readMaterials() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.materials,
    idHeader: MATERIALS_HEADERS.id,
    nameHeader: MATERIALS_HEADERS.name,
    fallbackPrefix: "MAT_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, MATERIALS_HEADERS.id),
      name: getCell(row, map, MATERIALS_HEADERS.name),
      unit: getCell(row, map, MATERIALS_HEADERS.unit),
      active: toBool(getCell(row, map, MATERIALS_HEADERS.active)),
      category: getCell(row, map, MATERIALS_HEADERS.category) || null,
      comment: getCell(row, map, MATERIALS_HEADERS.comment) || null,
    }))
    .filter((r) => r.id);
}

export async function readTools() {
  const { data, map } = await loadDictionarySheet({
    sheetName: SHEET_NAMES.tools,
    idHeader: TOOLS_HEADERS.id,
    nameHeader: TOOLS_HEADERS.name,
    fallbackPrefix: "TL_",
  });
  return data
    .map((row) => ({
      id: getCell(row, map, TOOLS_HEADERS.id),
      name: getCell(row, map, TOOLS_HEADERS.name),
      active: toBool(getCell(row, map, TOOLS_HEADERS.active)),
      category: getCell(row, map, TOOLS_HEADERS.category) || null,
      comment: getCell(row, map, TOOLS_HEADERS.comment) || null,
    }))
    .filter((r) => r.id);
}

export async function readSettings() {
  const { data, map } = await loadSheet(SHEET_NAMES.settings);
  return data
    .map((row) => ({
      key: getCell(row, map, SETTINGS_HEADERS.key),
      value: getCell(row, map, SETTINGS_HEADERS.value),
      comment: getCell(row, map, SETTINGS_HEADERS.comment) || null,
    }))
    .filter((r) => r.key);
}
