import { loadSheet, updateCells, type LoadedSheet } from "../google/sheets.js";
import { norm } from "../google/utils.js";
import { withLock } from "../lock.js";
import { nextFreeIds } from "./idPattern.js";

/**
 * Видача ID новим рядкам довідників.
 *
 * ID у довіднику -- це КЛЮЧ: зданий звіт зберігає лише `workId`, а назву,
 * одиницю й ставку підтягує з довідника по ньому щоразу, включно з моментом
 * затвердження. Тому ID мусить бути унікальним і незмінним назавжди.
 *
 * Раніше його вписувала людина, і вересень 2026 показав ціну цього: рядок
 * вставили посеред аркуша РОБОТИ, колонку ID протягнули вниз -- і кожна
 * робота нижче поїхала на сусідній ID. У вже зданих днях чужими стали
 * одиниці виміру, а разом з ними й СТАВКИ, за якими рахується фонд об'єкта.
 *
 * Тепер ID можна не писати взагалі: лишаєте комірку порожньою, синк бачить
 * рядок з назвою без ID, видає наступний вільний номер і **дописує його
 * назад у комірку**. Це єдине місце, де програма пише в аркуш довідника, і
 * пише вона рівно одну комірку рівно один раз за життя рядка.
 */

/**
 * Скільки нових ID за цикл -- це ще додавання, а не аварія.
 *
 * Порожня колонка ID (випадково видалили, очистили, зсунули) виглядає звідси
 * точнісінько як «додали 500 робіт». Видати їм усім нові номери означало б
 * відірвати кожен зданий звіт від його робіт -- рівно та біда, від якої це
 * все й будується. Тому за межею не «видати перші 25», а не видавати нічого
 * й кричати в лог: людина розбереться швидше, ніж відновлюватиме довідник.
 */
const MAX_NEW_IDS_PER_CYCLE = 25;

/**
 * Читає аркуш довідника і дорогою видає ID рядкам, у яких є назва, але немає
 * ID. Повертає той самий `LoadedSheet`, що й `loadSheet`, але вже з
 * проставленими ID -- тож доданий людиною рядок потрапляє в базу цим самим
 * циклом, а не наступним.
 *
 * Помилка запису тут не валить синк: рядок без ID просто відфільтрується, як
 * і досі, а спроба повториться за 45 секунд. Найгірше, що може статися, --
 * нова робота з'явиться в застосунку на хвилину пізніше.
 */
export async function loadDictionarySheet(opts: {
  sheetName: string;
  idHeader: string;
  nameHeader: string;
  fallbackPrefix: string;
}): Promise<LoadedSheet> {
  const sheet = await loadSheet(opts.sheetName);
  const idIdx = sheet.map[norm(opts.idHeader)];
  const nameIdx = sheet.map[norm(opts.nameHeader)];
  // Немає колонки ID або назви -- заголовок перейменували чи зіпсували.
  // Читаємо, як читали: вигадувати ID в аркуші, якого не розуміємо,
  // небезпечніше, ніж не побачити новий рядок.
  if (idIdx === undefined || nameIdx === undefined) return sheet;

  const cell = (row: any[], idx: number) => String(row[idx] ?? "").trim();

  const taken = new Set<string>();
  const needy: number[] = []; // індекси в sheet.all
  for (let i = 1; i < sheet.all.length; i++) {
    const row = sheet.all[i] ?? [];
    const id = cell(row, idIdx);
    if (id) {
      taken.add(id);
      continue;
    }
    if (cell(row, nameIdx)) needy.push(i);
  }
  if (!needy.length) return sheet;

  if (needy.length > MAX_NEW_IDS_PER_CYCLE) {
    console.error(
      `[SYNC][ID] ${opts.sheetName}: ${needy.length} рядків без ID -- це не схоже на додавання, ` +
        "схоже на зіпсовану колонку ID. Жодного ID не видано.",
    );
    return sheet;
  }

  try {
    // Лок, а не просто послідовність: синк може крутитися і в другому
    // інстансі, і поруч із ручним /internal/sync-now. Два цикли, що читають
    // аркуш одночасно, побачили б однаковий «наступний вільний» номер і
    // видали б його двом різним роботам.
    await withLock(`sheet-ids:${opts.sheetName}`, async () => {
      const ids = nextFreeIds(taken, needy.length, opts.fallbackPrefix);
      // all[0] -- заголовок, тож all[i] сидить на рядку i + 1 аркуша.
      const cells = needy.map((i, k) => ({ row1Based: i + 1, col0Based: idIdx, value: ids[k] }));

      await updateCells(opts.sheetName, cells);

      // Тільки після успішного запису. Рядки в пам'яті -- ті самі масиви, що
      // і в `data`, тож цей цикл уже побачить нові ID і збереже роботу.
      needy.forEach((i, k) => {
        const row = sheet.all[i];
        if (row) row[idIdx] = ids[k];
      });
      console.log(`[SYNC][ID] ${opts.sheetName}: видано ${ids.length} ID (${ids.join(", ")})`);
    });
  } catch (e) {
    console.error(`[SYNC][ID] ${opts.sheetName}: не вдалося видати ID`, e);
  }

  return sheet;
}
