// Тести видачі ID новим рядкам довідників.
//
// Друге після зарплати місце, де тиха помилка стає неправильними грошима:
// два рядки з одним ID -- це дві роботи, що ділять одну ставку й одиницю, і
// звіт при цьому виглядає нормально.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readIdPattern, nextFreeIds } from "../src/sync/idPattern.ts";

test("формат читається з аркуша, а не задається в коді", () => {
  assert.deepEqual(readIdPattern(["WT_034", "WT_035", "WT_036"], "XX_"), {
    prefix: "WT_",
    width: 3,
    next: 37,
  });
  assert.deepEqual(readIdPattern(["EMP-7", "EMP-8"], "XX_"), { prefix: "EMP-", width: 1, next: 9 });
});

test("порожній аркуш падає на запасний префікс", () => {
  assert.deepEqual(readIdPattern([], "WT_"), { prefix: "WT_", width: 3, next: 1 });
  assert.equal(nextFreeIds(new Set(), 1, "WT_")[0], "WT_001");
});

test("один рядок з чужим форматом не переписує нумерацію аркуша", () => {
  const ids = ["WT_001", "WT_002", "WT_003", "ТИМЧАСОВО_9000"];
  assert.equal(readIdPattern(ids, "XX_").prefix, "WT_");
  assert.deepEqual(nextFreeIds(new Set(ids), 1, "XX_"), ["WT_004"]);
});

test("ширина береться з найбільшого ID -- нумерація не звужується", () => {
  // 99 -> 100 переходить у три знаки і більше не повертається до двох.
  assert.deepEqual(nextFreeIds(new Set(["WT_98", "WT_99", "WT_100"]), 2, "XX_"), ["WT_101", "WT_102"]);
});

test("зайнятий номер пропускається, навіть якщо він поза нумерацією", () => {
  // Діра в середині не переюзається: WT_007 живий десь у старих звітах.
  const taken = new Set(["WT_005", "WT_007"]);
  assert.deepEqual(nextFreeIds(taken, 3, "XX_"), ["WT_008", "WT_009", "WT_010"]);
});

test("кілька рядків за раз отримують РІЗНІ ID", () => {
  const ids = nextFreeIds(new Set(["WT_010"]), 5, "XX_");
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(ids, ["WT_011", "WT_012", "WT_013", "WT_014", "WT_015"]);
});

test("унікальність рахується по ВСЬОМУ аркушу, а не лише по впізнаній нумерації", () => {
  // Рядок з ID, що не схожий на нумерацію, все одно займає своє значення.
  const taken = new Set(["WT_001", "WT_002", "WT_003"]);
  const [id] = nextFreeIds(taken, 1, "XX_");
  assert.equal(taken.has(id), false);
});
