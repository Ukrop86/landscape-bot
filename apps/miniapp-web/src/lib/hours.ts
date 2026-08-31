// Hours are money now -- the crew share of an object is split in proportion to
// them -- so the way they are printed has to be honest about small ones.
//
// The report used to print a raw 2-decimal number, which turned a session of a
// few seconds into "0 год" while payroll still paid that person a slice of the
// crew pot. The number said "took part in nothing", the amount said otherwise,
// and the only way to tell which was true was to reverse-engineer the split.
export function fmtHours(hours: number): string {
  const h = Number(hours) || 0;
  if (h <= 0) return "0 год";
  if (h >= 1) return `${Math.round(h * 100) / 100} год`;
  const minutes = h * 60;
  if (minutes >= 1) return `${Math.round(minutes)} хв`;
  return "<1 хв";
}
