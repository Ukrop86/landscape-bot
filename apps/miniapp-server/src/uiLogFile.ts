import fs from "node:fs";
import path from "node:path";

/**
 * Журнал дій у файл. ТИМЧАСОВЕ, на час обкатки.
 *
 * Один рядок на кожне натискання, окремий файл на кожен день:
 *   /data/ui-2026-09-03.log
 *
 * Файл лежить на Railway-волюмі, тому переживає деплої — без волюма диск
 * контейнера чиститься при кожному, а деплоїв у нас по кілька на день.
 * Читати: вкладка Console сервісу, `tail -f`, `grep`, `cat`.
 *
 * Дописування асинхронне і мовчазне. Журнал, який гальмує застосунок або
 * показує бригадиру помилку, гірший за відсутній: втрачений рядок — це
 * прогалина в розслідуванні, ніколи не помилка в дні.
 */

const DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.UI_LOG_DIR || "/data";
const KEEP_DAYS = 30;

let ready: boolean | null = null;

/** Чи є куди писати. Раз перевірили — далі не перевіряємо на кожен рядок. */
function ensureDir(): boolean {
  if (ready !== null) return ready;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    ready = true;
    console.log(`[uiLog] пишу у ${DIR}`);
  } catch (e) {
    // Немає волюма — не привід падати: рядки й далі йдуть у логи Railway.
    ready = false;
    console.error(`[uiLog] ${DIR} недоступний, файловий журнал вимкнено: ${(e as Error).message}`);
  }
  return ready;
}

/** Київський день і час: журнал читає людина, якій UTC нічого не каже. */
function kyivParts(ts: Date) {
  const full = ts.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" });
  return { date: full.slice(0, 10), time: full.slice(11, 19) };
}

export type UiLogRow = {
  ts: Date;
  who: string;
  screen: string;
  step: string;
  kind: string;
  label: string;
  detail: string | null;
};

/**
 * Один рядок на подію, поля через " | ". Формат навмисно плоский, а не JSON:
 * його читають очима в консолі й шукають через grep, а не парсять.
 */
export function appendUiLog(rows: UiLogRow[]) {
  if (!rows.length || !ensureDir()) return;

  // Події однієї пачки майже завжди з одного дня, але опівночі можуть
  // розʼїхатись -- тому групуємо, а не беремо дату з першого рядка.
  const byDay = new Map<string, string[]>();
  for (const r of rows) {
    const { date, time } = kyivParts(r.ts);
    const line = [time, r.who, r.screen + (r.step ? `/${r.step}` : ""), r.kind, r.label, r.detail ?? ""].join(" | ");
    const list = byDay.get(date) ?? [];
    list.push(line);
    byDay.set(date, list);
  }

  for (const [date, lines] of byDay) {
    fs.appendFile(path.join(DIR, `ui-${date}.log`), lines.join("\n") + "\n", (err) => {
      if (err) console.error(`[uiLog] запис не вдався: ${err.message}`);
    });
  }
}

/** Старі файли прибираємо при старті, щоб волюм не заповнився мовчки. */
export function pruneUiLogs() {
  if (!ensureDir()) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (!name.startsWith("ui-") || !name.endsWith(".log")) continue;
      const file = path.join(DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        console.log(`[uiLog] прибрано старий файл ${name}`);
      }
    }
  } catch (e) {
    console.error(`[uiLog] прибирання не вдалось: ${(e as Error).message}`);
  }
}
