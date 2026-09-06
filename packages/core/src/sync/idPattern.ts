/**
 * Як виглядають ID у конкретному аркуші довідника, і який наступний вільний.
 *
 * Окремо від autoId.ts і без жодного імпорту навмисно: тут єдина частина
 * видачі ID, де тиха помилка коштує дорого. Два рядки з одним ID -- це дві
 * роботи з однією ставкою й одиницею, тобто неправильні гроші в звіті, який
 * виглядає нормально. Тож ця логіка чиста, і на неї є тест.
 */
export type IdPattern = { prefix: string; width: number; next: number };

/**
 * Впізнає формат за тим, що вже є в аркуші: `WT_036` -> префікс `WT_`,
 * ширина 3, наступний 37. Формат не задається в коді -- аркуш веде людина, і
 * нав'язувати їй свою нумерацію означало б колись розійтися з нею мовчки.
 */
export function readIdPattern(ids: Iterable<string>, fallbackPrefix: string): IdPattern {
  const byPrefix = new Map<string, { count: number; max: number; width: number }>();

  for (const id of ids) {
    const m = id.match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const [, prefix, digits] = m;
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const cur = byPrefix.get(prefix) ?? { count: 0, max: -1, width: digits.length };
    cur.count += 1;
    if (value > cur.max) {
      cur.max = value;
      cur.width = digits.length;
    }
    byPrefix.set(prefix, cur);
  }

  if (!byPrefix.size) return { prefix: fallbackPrefix, width: 3, next: 1 };

  // Найпоширеніший префікс, а не найбільший номер: один рядок з чужим
  // форматом не повинен переписувати нумерацію всього аркуша.
  const [prefix, stats] = [...byPrefix.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].max - a[1].max,
  )[0];

  return { prefix, width: stats.width, next: stats.max + 1 };
}

export function formatId(pattern: IdPattern, value: number) {
  return `${pattern.prefix}${String(value).padStart(pattern.width, "0")}`;
}

/**
 * Стільки нових ID, скільки просять, і жодного, що вже зайнятий.
 *
 * `taken` -- УСІ ID аркуша, а не тільки ті, що збіглися з форматом: ID мусить
 * бути унікальним по аркушу, а не по нумерації, яку ми впізнали.
 */
export function nextFreeIds(taken: Set<string>, count: number, fallbackPrefix: string): string[] {
  const pattern = readIdPattern(taken, fallbackPrefix);
  const used = new Set(taken);
  const out: string[] = [];
  let n = pattern.next;

  for (let i = 0; i < count; i++) {
    let id = formatId(pattern, n);
    while (used.has(id)) id = formatId(pattern, ++n);
    used.add(id);
    out.push(id);
    n += 1;
  }
  return out;
}
