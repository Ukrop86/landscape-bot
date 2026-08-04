import type { Work } from "./api";

// A category, plus the works inside it split into an optional second level.
// `direct` are the works that named no subcategory and so belong straight
// under the category itself; `subgroups` are the named ones. `members` is
// everything in the category regardless, for counts and select-all.
export type WorkSubGroup = { id: string; title: string; members: Work[] };
export type WorkGroup = {
  id: string;
  title: string;
  members: Work[];
  direct: Work[];
  subgroups: WorkSubGroup[];
};

const NO_CATEGORY = "__NO_CATEGORY__";

function byName(a: Work, b: Work) {
  return a.name.localeCompare(b.name);
}

/**
 * Groups works by КАТЕГОРІЯ, splitting a category into ПІДКАТЕГОРІЯ groups
 * only where one is actually filled in.
 *
 * The subcategory column is optional by design, at the level of the single
 * work: a category whose works all leave it blank stays one flat list exactly
 * as before, and a category that uses it only for some of its works shows
 * those loose works first and the named groups after them. So the office can
 * fill the new column in gradually, or never, without the pickers changing
 * shape underneath the crews.
 */
export function groupWorks(list: Work[]): WorkGroup[] {
  const byCategory = new Map<string, Work[]>();
  for (const w of list) {
    const category = (w.category ?? "").trim() || NO_CATEGORY;
    const current = byCategory.get(category) ?? [];
    current.push(w);
    byCategory.set(category, current);
  }

  return [...byCategory.entries()]
    .map(([id, members]) => {
      const bySubcategory = new Map<string, Work[]>();
      for (const w of members) {
        const subcategory = (w.subcategory ?? "").trim();
        if (!subcategory) continue;
        const current = bySubcategory.get(subcategory) ?? [];
        current.push(w);
        bySubcategory.set(subcategory, current);
      }

      return {
        id,
        title: id === NO_CATEGORY ? "Без категорії" : id,
        members: [...members].sort(byName),
        direct: members.filter((w) => !(w.subcategory ?? "").trim()).sort(byName),
        subgroups: [...bySubcategory.entries()]
          // Prefixed with the category so two categories can reuse the same
          // subcategory name without sharing one expand/collapse state.
          .map(([title, subMembers]) => ({ id: `${id}::${title}`, title, members: [...subMembers].sort(byName) }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    })
    .sort((a, b) => (a.id === NO_CATEGORY ? 1 : b.id === NO_CATEGORY ? -1 : a.title.localeCompare(b.title)));
}
