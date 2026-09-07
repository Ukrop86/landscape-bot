import type { Employee } from "./api";

/**
 * "бригадир" and "старший" are the two roles the money split cares about, so
 * they stay fixed strings the code can compare against. Everything else is the
 * person's ACTUAL job title from the КОРИСТУВАЧІ sheet -- "Керівник ландшафту"
 * has to read as itself, not be flattened into "робітник".
 */
export type EmployeeRole = "бригадир" | "старший" | (string & {});

/** Positions that mean "an ordinary worker" -- the tag for these stays hidden. */
const PLAIN_WORKER = new Set(["", "робітник", "робочий", "работник", "рабочий"]);

export function employeeRole(emp: Employee): EmployeeRole {
  const pos = (emp.position ?? "").trim();
  const lower = pos.toLowerCase();
  if (lower.includes("бригадир")) return "бригадир";
  if (lower.includes("старш")) return "старший";
  // Anything else is shown exactly as written in the sheet. An empty cell or a
  // plain "Робітник" collapses to the default, which the UI keeps quiet.
  return PLAIN_WORKER.has(lower) ? "робітник" : pos;
}

/** Ranks a role for sorting; anything that is not a lead sorts last. */
export function roleRank(role: EmployeeRole): number {
  if (role === "бригадир") return 0;
  if (role === "старший") return 1;
  return 2;
}

// First letters of the first two words (e.g. "Агромаков Денис" -> "АД") for
// a quick-glance contact-list-style avatar instead of a generic person icon.
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// People are told apart by surname, but a full "Левченко Роман Михайлович"
// spends a third of a narrow row on the patronymic. Lists shorten it; the
// day's summary and the report keep the full name.
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return full;
  return `${parts[0]} ${parts[1]} ${parts[2][0]}.`;
}

// Even shorter, for the "held by another brigade" badge, where the point is
// only which foreman to call -- a full name there wraps the row it sits on.
export function surnameInitial(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return full;
  return `${parts[0]} ${parts[1][0]}.`;
}

// The role tag beside a name: "робітник" is the default and stays quiet,
// while the two roles that change how an object's money splits get their own
// colour, so a brigadier is findable in a list of ten.
export function roleTagClass(role: EmployeeRole): string {
  if (role === "бригадир") return "role-tag lead";
  if (role === "старший") return "role-tag senior";
  return "role-tag";
}

export function roleAccent(role: EmployeeRole): string {
  if (role === "бригадир") return "accent-orange";
  if (role === "старший") return "accent-purple";
  return "accent-blue";
}

// A brigade's display name is derived from a member whose position contains
// "бригадир" (there's no separate brigade-name column in the source data).
// `roster` must be the COMPLETE employee list, not the (often filtered) list
// being grouped: a picker that hides people already on the trip would
// otherwise hide that brigade's leader too, leaving the brigade labelled by
// its raw id (e.g. "BR_002") in that picker but by its real name elsewhere.
function brigadeTitleMap(roster: Employee[]): Map<string, string> {
  const titleById = new Map<string, string>();
  for (const e of roster) {
    const id = e.brigadeId?.trim();
    if (!id || titleById.has(id)) continue;
    if (employeeRole(e) === "бригадир" && e.position) {
      titleById.set(id, e.position.replace(/^бригадир\s*/i, "").trim() || e.position);
    }
  }
  // A brigade with no brigadier in the roster used to fall back to its raw id
  // ("BR_002" as a section heading). Any member's job title beats that.
  for (const e of roster) {
    const id = e.brigadeId?.trim();
    if (!id || titleById.has(id)) continue;
    const pos = (e.position ?? "").trim();
    if (pos) titleById.set(id, pos);
  }
  return titleById;
}

// Inside a brigade, rank matters more than the alphabet: the brigadier leads
// the trip (and earns their 20% per object only if they are on it), the senior
// gardener comes next, and everyone else follows by name. Alphabetical order
// buried the two people a foreman looks for first somewhere in the middle.
function byRoleThenName(a: Employee, b: Employee) {
  const rank = roleRank(employeeRole(a)) - roleRank(employeeRole(b));
  return rank !== 0 ? rank : a.name.localeCompare(b.name);
}

export function groupByBrigade(employees: Employee[], roster: Employee[] = employees) {
  const NO_BRIGADE = "__NO_BRIGADE__";
  const titleById = brigadeTitleMap(roster);
  const map = new Map<string, Employee[]>();
  const titleByKey = new Map<string, string>();
  for (const e of employees) {
    const brigadeId = e.brigadeId?.trim();
    let key: string;
    let title: string;
    if (brigadeId) {
      key = brigadeId;
      title = titleById.get(brigadeId) ?? brigadeId;
    } else {
      // Someone outside every brigade is not simply "unassigned" -- a Керівник
      // ландшафту has a job title, and that title is the only heading that
      // says anything. Each such position becomes its own section; only people
      // with no position at all are left under "Без бригади".
      const pos = (e.position ?? "").trim();
      key = pos ? `${NO_BRIGADE}:${pos}` : NO_BRIGADE;
      title = pos || "Без бригади";
    }
    titleByKey.set(key, title);
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  const isLoose = (id: string) => id.startsWith(NO_BRIGADE);
  return [...map.entries()]
    .map(([id, members]) => ({ id, title: titleByKey.get(id) ?? id, members: [...members].sort(byRoleThenName) }))
    .sort((a, b) => {
      // Brigades first, then the standalone roles, then the nameless leftovers.
      if (isLoose(a.id) !== isLoose(b.id)) return isLoose(a.id) ? 1 : -1;
      if (a.id === NO_BRIGADE) return 1;
      if (b.id === NO_BRIGADE) return -1;
      return a.title.localeCompare(b.title);
    });
}

/**
 * Зіставлення ПІБ бригадира (аркуш КОРИСТУВАЧІ) з рядком у ПРАЦІВНИКИ.
 *
 * Спільного id між цими двома довідниками немає, тож єдиний ключ -- ім'я.
 * Дзеркало `normalizeName` із сервера (`routes/roadTimesheet.ts`), яким там
 * знаходять, кому платити 20%: правило має бути одне, інакше застосунок
 * підпише «(Ви)» не тому, кого сервер потім вважає власником дня.
 */
export function normalizeName(v: string): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[’ʼ'`]/g, "ʼ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Рядок у ПРАЦІВНИКИ, що відповідає ПІБ цього користувача (або ""). */
export function findMyEmployeeId(employees: Employee[], pib: string): string {
  if (!pib) return "";
  const target = normalizeName(pib);
  const matches = employees.filter((e) => normalizeName(e.name) === target);
  return (matches.find((e) => e.active) ?? matches[0])?.id ?? "";
}
