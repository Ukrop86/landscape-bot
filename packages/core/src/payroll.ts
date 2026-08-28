// Mirrors apps/bot/src/bot/flows/roadTimesheet.payroll.ts + the role/points
// logic in roadTimesheet.flow.ts / roadTimesheet.utils.ts, exactly.

export function isBrigadierPosition(position: string | null | undefined, active: boolean) {
  return active && String(position ?? "").toLowerCase().includes("бригадир");
}

export function isSeniorPosition(position: string | null | undefined) {
  return String(position ?? "").toLowerCase().includes("старш");
}

/** Only one brigadier per trip: the first rider (in the given order) who is an active brigadier. */
export function pickBrigadierFromRiders(
  riderIds: string[],
  employeeById: Map<string, { position: string | null; active: boolean }>,
): string {
  for (const id of riderIds) {
    const e = employeeById.get(id);
    if (e && isBrigadierPosition(e.position, e.active)) return id;
  }
  return "";
}

export function pickSeniorsFromRiders(
  riderIds: string[],
  employeeById: Map<string, { position: string | null }>,
): string[] {
  return riderIds.filter((id) => isSeniorPosition(employeeById.get(id)?.position));
}

// The bot's roundToQuarterHours is currently hard-disabled (returns 1 for any
// input > 0) -- the real "hours * 4 rounded" formula is commented out in
// production. We mirror the ACTUAL deployed behavior, not the commented-out
// one: every employee who did any work at an object counts as exactly 1
// "hour unit" for points purposes, regardless of real time spent. This is a
// known quirk of the bot, not a bug we're introducing here.
export function roundToQuarterHours(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return 1;
}

export type SalaryRow = {
  employeeId: string;
  employeeName: string;
  hours: number;
  coefTotal: number;
  points: number;
  pay: number;
};

export type ObjectSalaryPack = {
  objectId: string;
  objectName: string;
  objectTotal: number;
  sumPoints: number;
  companyPay: number;
  rows: SalaryRow[];
};

/**
 * Per-object payroll split. The trip's brigadier takes 20% of every object's
 * fund and the seniors split 10% of it, whether or not they worked at that
 * particular object -- those cuts pay for running the day. The remainder
 * (70%, or 90% when the trip has no brigadier at all) is the crew share,
 * split EQUALLY between everyone with hours there, the brigadier and seniors
 * included: if they worked, they worked. With no senior on the trip the 10%
 * is not handed to the crew -- it stays with the company (companyPay).
 *
 * The worker remainder is split EQUALLY, not by hours. Works that name
 * specific people form their own pool each, so a job one person did alone
 * pays only that person -- and that person is then OUT of the shared pool,
 * which belongs to the crew that did the rest. Everything unassigned stays
 * one pool for whoever is left. The discipline/productivity coefficients are recorded
 * per person but move no money.
 */
export function buildSalaryPacksWithRoles(params: {
  objects: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    // Each work's own money value (volume * tariff) and who it was assigned
    // to. A work with nobody assigned is shared by the whole crew at the
    // object, which is the normal case. Omit the array entirely and the
    // object behaves as one shared pool, exactly as before this existed.
    works?: Array<{ workId: string; value: number; employeeIds?: string[] }>;
    rows: Array<{ employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number }>;
  }>;
  brigadierEmployeeId: string;
  seniorEmployeeIds: string[];
}): ObjectSalaryPack[] {
  const { objects, brigadierEmployeeId, seniorEmployeeIds } = params;
  const seniorSet = new Set(seniorEmployeeIds.map(String));

  return objects.map((o) => {
    const all = o.rows.map((r) => {
      const hoursRounded = roundToQuarterHours(r.hours);
      const coefTotal = Number(r.disciplineCoef) * Number(r.productivityCoef);
      return { ...r, hoursRounded, coefTotal, points: Math.round(hoursRounded * coefTotal * 100) / 100 };
    });
    // Hours decide who splits the crew share; the role cuts do not depend on
    // them. A brigadier runs the day whether or not they picked up a spade at
    // this particular object, so their 20% is owed either way -- the caller
    // therefore passes a zero-hour row for them (and for the seniors) on every
    // object, and that row is what makes hasBrigadier/hasSenior true here.
    const worked = all.filter((r) => r.hours > 0);

    const isBrigadier = (id: string) => !!brigadierEmployeeId && id === brigadierEmployeeId;
    const isSenior = (id: string) => seniorSet.has(id);

    const brigadierRow = all.find((r) => isBrigadier(r.employeeId)) ?? null;
    const seniorRows = all.filter((r) => isSenior(r.employeeId));
    const hasBrigadier = !!brigadierRow;
    const hasSenior = seniorRows.length > 0;

    // The crew share, and on top of it the role cuts. A brigadier or senior
    // who DID work also takes an equal share of the crew pot -- they worked
    // alongside everyone else, and the 20%/10% pays for running the day, not
    // for the work itself.
    const workerPercent = hasBrigadier ? 0.7 : 0.9;
    const brigadierBonus = hasBrigadier ? o.objectTotal * 0.2 : 0;
    const seniorBonusEach = hasSenior ? (o.objectTotal * 0.1) / seniorRows.length : 0;
    const companyPercent = hasSenior ? 0 : 0.1;

    // Works assigned to specific people get their own pool each, split only
    // between those of them who were actually at the object; everything else
    // stays in one shared pool for the crew that did it. "One person drove
    // out, watered the lawn and left" is the case this exists for -- and that
    // person is paid for the watering, not for the crew's day as well.
    //
    // An assignment naming nobody who was there is treated as unassigned
    // rather than dropped -- otherwise that work's money would silently
    // vanish from the object.
    const dedicated: Array<{ value: number; workers: typeof worked }> = [];
    for (const w of o.works ?? []) {
      const assigned = new Set(w.employeeIds ?? []);
      if (!assigned.size) continue;
      const workers = worked.filter((r) => assigned.has(r.employeeId));
      if (!workers.length) continue;
      dedicated.push({ value: Number(w.value) || 0, workers });
    }
    // Derived by subtraction, not by summing the unassigned works, so the
    // buckets always add back up to objectTotal even if a caller's work
    // values don't quite sum to the total it passed.
    const sharedValue = Math.max(0, o.objectTotal - dedicated.reduce((a, d) => a + d.value, 0));

    // Someone named on a work is paid for that work and nothing else out of
    // the crew pot: the shared share is for the crew that did the rest.
    const dedicatedIds = new Set<string>();
    for (const d of dedicated) for (const w of d.workers) dedicatedIds.add(w.employeeId);

    // ...unless that would leave nobody holding the unassigned works. Money
    // must never vanish from an object, so when every worker present has a
    // named work, the remainder falls back to all of them.
    const sharedWorkers = worked.filter((r) => !dedicatedIds.has(r.employeeId));
    const sharedPool = sharedWorkers.length ? sharedWorkers : worked;
    const sharedIds = new Set(sharedPool.map((r) => r.employeeId));
    const sharedOnePay = sharedPool.length ? (sharedValue * workerPercent) / sharedPool.length : 0;

    const dedicatedPayByEmployee = new Map<string, number>();
    for (const d of dedicated) {
      const onePay = (d.value * workerPercent) / d.workers.length;
      for (const w of d.workers) dedicatedPayByEmployee.set(w.employeeId, (dedicatedPayByEmployee.get(w.employeeId) ?? 0) + onePay);
    }

    const rows: SalaryRow[] = all.map((r) => {
      const crewShare = (sharedIds.has(r.employeeId) ? sharedOnePay : 0) + (dedicatedPayByEmployee.get(r.employeeId) ?? 0);
      const roleBonus = (isBrigadier(r.employeeId) ? brigadierBonus : 0) + (isSenior(r.employeeId) ? seniorBonusEach : 0);
      return {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        hours: Math.round(Number(r.hours || 0) * 100) / 100,
        coefTotal: r.coefTotal,
        points: r.points,
        pay: Math.round((crewShare + roleBonus) * 100) / 100,
      };
    });

    return {
      objectId: o.objectId,
      objectName: o.objectName,
      objectTotal: Math.round(o.objectTotal * 100) / 100,
      sumPoints: Math.round(worked.reduce((a, r) => a + r.points, 0) * 100) / 100,
      companyPay: Math.round(o.objectTotal * companyPercent * 100) / 100,
      rows: rows.filter((r) => r.hours > 0 || r.pay > 0),
    };
  });
}

export const DEFAULT_ROAD_ALLOWANCE_BY_CLASS: Record<"S" | "M" | "L" | "XL", number> = {
  S: 50,
  M: 100,
  L: 150,
  XL: 200,
};
