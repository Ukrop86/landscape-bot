import { sheetsClient } from "@landscape/core";

/**
 * Журнал дій у Google-таблиці, окремою вкладкою ЖУРНАЛ_UI.
 * ТИМЧАСОВЕ, на час обкатки — прибрати перед продакшном.
 *
 * Власник читає журнал саме там: таблиця вже відкрита цілий день, шукається і
 * фільтрується, видно з телефона. Логи Railway для цього незручні, а файл на
 * контейнері зникає при кожному деплої.
 *
 * Головне тут — НЕ повторити те, через що робочі дані звідти прибрали. Тоді
 * кожен зданий день коштував 5-7 звернень до Google під локом, і 403 від
 * Google клав звіт. Тому:
 *
 * - у Sheets ідемо не частіше ніж раз на 30 секунд, і одним запитом на пачку,
 *   а не рядком на подію;
 * - буфер обмежений: телефон, що заливає події швидше, ніж ми встигаємо
 *   писати, має втратити найстаріше, а не зʼїсти памʼять сервера;
 * - жодна помилка звідси не піднімається вище: журнал, який ламає роботу,
 *   гірший за відсутній.
 */

const SHEET = "ЖУРНАЛ_UI";
const HEADERS = ["ЧАС", "ХТО", "ЕКРАН", "КРОК", "ТИП", "ДІЯ", "ДЕТАЛІ"] as const;
const FLUSH_MS = 30_000;
const MAX_BUFFER = 2000;

type Row = { ts: Date; who: string; screen: string; step: string; kind: string; label: string; detail: string | null };

let buffer: Row[] = [];
let timer: NodeJS.Timeout | null = null;
let ensured = false;

/** Київський час: журнал читає людина, якій UTC нічого не каже. */
function kyiv(ts: Date) {
  return ts.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function queueUiLogRows(rows: Row[]) {
  if (!rows.length) return;
  buffer.push(...rows);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  if (!timer) timer = setTimeout(flushUiLog, FLUSH_MS);
}

export async function flushUiLog() {
  timer = null;
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];

  try {
    if (!ensured) {
      await sheetsClient.ensureSheet(SHEET, HEADERS);
      ensured = true;
    }
    await sheetsClient.appendRows(
      SHEET,
      batch.map((r) => [kyiv(r.ts), r.who, r.screen, r.step, r.kind, r.label, r.detail ?? ""]),
    );
  } catch (e) {
    // Не повертаємо пачку в буфер: якщо Google лежить, наступні спроби лише
    // накопичуватимуть те саме. Журнал діагностичний — прогалина в ньому
    // прийнятна, застрягла черга й нескінченні повтори до Google ні.
    console.error(`[uiLog] append failed, ${batch.length} row(s) dropped: ${(e as Error).message}`);
    ensured = false;
  }

  if (buffer.length && !timer) timer = setTimeout(flushUiLog, FLUSH_MS);
}
