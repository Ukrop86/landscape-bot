// A trip set up in advance and parked for later. A foreman with a spare hour
// picks tomorrow's car, crew, objects and works, saves it, and the next
// morning pulls it back in one tap instead of rebuilding it at 7am.
//
// Deliberately local, like the day's draft (see draft.ts): a plan is an
// intention, not a claim. Saving it must NOT reserve the car or the people --
// another brigade may still need them today, and a reservation made the night
// before would block them for hours over a plan that might change.
import { getInitDataUser } from "./telegram";

export type PlannedTripWork = { workId: string; workName: string; unit: string; volume: string };
export type PlannedTripObject = { objectId: string; objectName: string; works: PlannedTripWork[] };
export type TripPlan = {
  savedAt: number;
  carId: string;
  employeeIds: string[];
  objects: PlannedTripObject[];
};

// Long enough to plan on Friday for Monday, short enough that a plan nobody
// used stops offering itself forever.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function planKey(): string {
  return `roadTimesheetPlan:v1:${getInitDataUser()?.id ?? "anon"}`;
}

export function saveTripPlan(plan: Omit<TripPlan, "savedAt">) {
  try {
    localStorage.setItem(planKey(), JSON.stringify({ ...plan, savedAt: Date.now() } satisfies TripPlan));
  } catch {
    // storage unavailable/full -- planning is a convenience, not a critical path
  }
}

export function loadTripPlan(): TripPlan | null {
  try {
    const raw = localStorage.getItem(planKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TripPlan;
    if (!parsed || Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearTripPlan() {
  try {
    localStorage.removeItem(planKey());
  } catch {
    // ignore
  }
}
