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
 * Per-object payroll split. A brigadier who worked at this object takes 20%,
 * seniors split 10%, and the remainder (70%, or 90% with no brigadier here)
 * goes to the workers. If nobody senior worked there that 10% is not handed
 * to the workers instead -- it stays with the company (companyPay), exactly
 * like the bot's roleTotals.company.
 *
 * The worker remainder is split EQUALLY, not by hours. Works that name
 * specific people form their own pool each, so a job one person did alone
 * pays only that person; everything unassigned stays one pool for the whole
 * crew at the object. The discipline/productivity coefficients are recorded
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
    const rowsSrc = o.rows
      .filter((r) => r.hours > 0)
      .map((r) => {
        const hoursRounded = roundToQuarterHours(r.hours);
        const coefTotal = Number(r.disciplineCoef) * Number(r.productivityCoef);
        return { ...r, hoursRounded, coefTotal, points: Math.round(hoursRounded * coefTotal * 100) / 100 };
      });

    const brigadierRows = rowsSrc.filter((r) => brigadierEmployeeId && r.employeeId === brigadierEmployeeId);
    const seniorRows = rowsSrc.filter((r) => seniorSet.has(r.employeeId));
    const hasBrigadier = brigadierRows.length > 0;
    const hasSenior = seniorRows.length > 0;

    const workerPercent = hasBrigadier ? 0.7 : 0.9;
    const brigadierPercent = hasBrigadier ? 0.2 : 0;
    const seniorPercent = hasSenior ? 0.1 : 0;
    const companyPercent = hasSenior ? 0 : 0.1;

    const workerRows = rowsSrc.filter((r) => {
      if (hasBrigadier && r.employeeId === brigadierEmployeeId) return false;
      if (hasSenior && seniorSet.has(r.employeeId)) return false;
      return true;
    });

    // The brigadier's and the senior's cuts, and the company's, are always
    // taken off the OBJECT's total, never off individual works -- assigning a
    // work to one person changes who splits the worker share, not the shape
    // of the object's split.
    const brigadierOnePay = brigadierRows.length ? (o.objectTotal * brigadierPercent) / brigadierRows.length : 0;
    const seniorOnePay = seniorRows.length ? (o.objectTotal * seniorPercent) / seniorRows.length : 0;

    // The worker share (70%/90% of the object's total, after the cuts above)
    // is split EQUALLY -- everyone in rowsSrc has hours > 0, so hours decide
    // who is in a split, never how much of it each takes.
    //
    // Deliberately not proportional to hours: an object's fund is earned by
    // the crew finishing the work there, and a stint recorded as 15 minutes
    // (a timer started and stopped again, which happens constantly in the
    // field) would otherwise collapse that person's pay to a rounding error
    // while whoever's timer ran longest took nearly the whole pool.
    //
    // Works assigned to specific people get their own pool each, split only
    // between those of them who were actually at the object; everything else
    // stays in one shared pool for the whole crew. "One person drove out,
    // watered the lawn and left" is the case this exists for.
    //
    // An assignment naming nobody who was there is treated as unassigned
    // rather than dropped -- otherwise that work's money would silently
    // vanish from the object.
    const dedicated: Array<{ value: number; workers: typeof workerRows }> = [];
    for (const w of o.works ?? []) {
      const assigned = new Set(w.employeeIds ?? []);
      if (!assigned.size) continue;
      const workers = workerRows.filter((r) => assigned.has(r.employeeId));
      if (!workers.length) continue;
      dedicated.push({ value: Number(w.value) || 0, workers });
    }
    // Derived by subtraction, not by summing the unassigned works, so the
    // buckets always add back up to objectTotal even if a caller's work
    // values don't quite sum to the total it passed.
    const sharedValue = Math.max(0, o.objectTotal - dedicated.reduce((a, d) => a + d.value, 0));
    const sharedOnePay = workerRows.length ? (sharedValue * workerPercent) / workerRows.length : 0;

    const dedicatedPayByEmployee = new Map<string, number>();
    for (const d of dedicated) {
      const onePay = (d.value * workerPercent) / d.workers.length;
      for (const w of d.workers) dedicatedPayByEmployee.set(w.employeeId, (dedicatedPayByEmployee.get(w.employeeId) ?? 0) + onePay);
    }

    const rows: SalaryRow[] = rowsSrc.map((r) => {
      let pay = 0;
      if (hasBrigadier && r.employeeId === brigadierEmployeeId) pay = brigadierOnePay;
      else if (hasSenior && seniorSet.has(r.employeeId)) pay = seniorOnePay;
      else pay = sharedOnePay + (dedicatedPayByEmployee.get(r.employeeId) ?? 0);

      return {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        hours: Math.round(Number(r.hours || 0) * 100) / 100,
        coefTotal: r.coefTotal,
        points: r.points,
        pay: Math.round(pay * 100) / 100,
      };
    });

    return {
      objectId: o.objectId,
      objectName: o.objectName,
      objectTotal: Math.round(o.objectTotal * 100) / 100,
      sumPoints: Math.round(rowsSrc.reduce((a, r) => a + r.points, 0) * 100) / 100,
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
