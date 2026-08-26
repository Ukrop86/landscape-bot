// Ukrainian counts take three forms, and templates like `${n} робіт` only ever
// got the third one right: "1 робіт" and "2 робіт" instead of "1 робота" and
// "2 роботи".
//
//   plural(n, "робота", "роботи", "робіт")
//
// one  -- 1, 21, 31 … (but not 11)
// few  -- 2-4, 22-24 … (but not 12-14)
// many -- everything else
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** The count and its noun together: `counted(2, …)` -> "2 роботи". */
export function counted(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

export const works = (n: number) => counted(n, "робота", "роботи", "робіт");
export const people = (n: number) => counted(n, "людина", "людини", "людей");
export const objects = (n: number) => counted(n, "обʼєкт", "обʼєкти", "обʼєктів");
