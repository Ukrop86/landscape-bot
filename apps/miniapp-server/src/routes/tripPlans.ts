import { asyncRouter } from "../asyncRouter.js";
import { db, schema, sendTelegramMessage, config } from "@landscape/core";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { normRole } from "../authMiddleware.js";

export const tripPlansRouter = asyncRouter();

type PlanWork = { workId: string; workName: string; unit?: string | null };
type PlanObject = { objectId: string; objectName: string; works: PlanWork[] };

type PlanBody = {
  /** Admins only: whose plan this is. Anyone else always plans for themselves. */
  foremanTgId?: number;
  carId?: string;
  employeeIds?: string[];
  objects?: PlanObject[];
  note?: string;
};

/** Trims a client payload down to what the table stores, defensively. */
function normalizeBody(body: PlanBody) {
  return {
    carId: String(body.carId ?? ""),
    employeeIds: Array.isArray(body.employeeIds) ? body.employeeIds.map(String) : [],
    objects: Array.isArray(body.objects)
      ? body.objects.map((o) => ({
          objectId: String(o.objectId),
          objectName: String(o.objectName ?? ""),
          works: Array.isArray(o.works)
            ? o.works.map((w) => ({ workId: String(w.workId), workName: String(w.workName ?? ""), unit: w.unit ?? "" }))
            : [],
        }))
      : [],
    note: String(body.note ?? ""),
  };
}

/**
 * GET /api/trip-plans — every ACTIVE plan, whoever it belongs to.
 *
 * Deliberately not filtered to the caller: the pickers mark a car or a person
 * that somebody else has already planned for, and that warning only works if
 * every foreman can see every plan. `mine` says which ones are actionable.
 */
tripPlansRouter.get("/", async (req, res) => {
  const rows = await db.select().from(schema.tripPlans).where(eq(schema.tripPlans.status, "АКТИВНИЙ"));
  const [users, cars, employees] = await Promise.all([
    db.select().from(schema.users),
    db.select().from(schema.cars),
    db.select().from(schema.employees),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const carById = new Map(cars.map((c) => [c.id, c.name]));
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));

  const plans = rows
    .map((r) => {
      const employeeIds = JSON.parse(r.employeeIds || "[]") as string[];
      return {
        id: r.id,
        foremanTgId: Number(r.foremanTgId),
        foremanName: nameByTgId.get(String(r.foremanTgId)) ?? String(r.foremanTgId),
        createdByName: r.createdByName,
        assignedByAdmin: r.assignedByAdmin,
        carId: r.carId,
        carName: carById.get(r.carId) ?? "",
        employeeIds,
        employeeNames: employeeIds.map((id) => employeeById.get(id) ?? id),
        objects: JSON.parse(r.objects || "[]") as PlanObject[],
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        mine: Number(r.foremanTgId) === req.user!.tgId,
      };
    })
    .sort((a, b) => (a.mine === b.mine ? b.createdAt.localeCompare(a.createdAt) : a.mine ? -1 : 1));

  res.json({ plans });
});

/**
 * GET /api/trip-plans/foremen — who an admin can plan for.
 * Admin-only because nobody else has a "кому" field to fill.
 */
tripPlansRouter.get("/foremen", async (req, res) => {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  const users = await db.select().from(schema.users).where(eq(schema.users.active, true));
  res.json({
    foremen: users
      .filter((u) => normRole(u.role) !== "ADMIN")
      .map((u) => ({ tgId: Number(u.tgId), name: u.pib }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

/** Tells the foreman an admin filled in their next trip for them. */
async function notifyAssignedForeman(foremanTgId: number, createdByName: string, body: ReturnType<typeof normalizeBody>) {
  const [cars, employees] = await Promise.all([db.select().from(schema.cars), db.select().from(schema.employees)]);
  const carName = cars.find((c) => c.id === body.carId)?.name ?? "—";
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));
  const lines = [
    "📋 *Вам заплановано наступний виїзд*",
    `👤 Запланував: ${createdByName}`,
    `🚙 Авто: ${carName}`,
    `👥 Люди: ${body.employeeIds.map((id) => employeeById.get(id) ?? id).join(", ") || "—"}`,
    `📍 Обʼєкти: ${body.objects.map((o) => o.objectName).join(", ") || "—"}`,
  ];
  if (body.note) lines.push(`📝 ${body.note}`);
  const buttons = config.publicUrl ? [[{ text: "📋 Відкрити застосунок", webAppUrl: `${config.publicUrl}/?openPlans=1` }]] : undefined;
  await sendTelegramMessage(foremanTgId, lines.join("\n"), { buttons });
}

/** POST /api/trip-plans — create. Admins may plan for someone else. */
tripPlansRouter.post("/", async (req, res) => {
  const body = req.body as PlanBody;
  const data = normalizeBody(body);
  if (!data.carId && !data.employeeIds.length && !data.objects.length) {
    res.status(400).json({ error: "Порожній план — оберіть хоча б авто, людей або обʼєкт" });
    return;
  }
  const isAdmin = req.user!.role === "ADMIN";
  // Only an admin may aim a plan at someone else; everyone else plans for self,
  // whatever the body says.
  const foremanTgId = isAdmin && body.foremanTgId ? Number(body.foremanTgId) : req.user!.tgId;
  const assignedByAdmin = isAdmin && foremanTgId !== req.user!.tgId;

  const row = {
    id: randomUUID(),
    foremanTgId: BigInt(foremanTgId),
    createdByTgId: BigInt(req.user!.tgId),
    createdByName: req.user!.pib,
    assignedByAdmin,
    carId: data.carId,
    employeeIds: JSON.stringify(data.employeeIds),
    objects: JSON.stringify(data.objects),
    note: data.note,
    status: "АКТИВНИЙ",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(schema.tripPlans).values(row);

  if (assignedByAdmin) await notifyAssignedForeman(foremanTgId, req.user!.pib, data);

  res.json({ id: row.id, assignedByAdmin });
});

/**
 * Who may do what with a plan.
 *
 * A plan an admin assigned to a brigadier is a TASK, not a suggestion: the
 * brigadier drives it, the admin is the one who changes it. So they may use it
 * and nothing else -- otherwise the assignment means nothing the moment it is
 * received. Plans a brigadier made for themselves stay entirely theirs.
 */
async function loadPlan(id: string, tgId: number, isAdmin: boolean) {
  const [row] = await db.select().from(schema.tripPlans).where(eq(schema.tripPlans.id, id));
  if (!row) return { row: null as null, canEdit: false, canUse: false };
  const isOwner = Number(row.foremanTgId) === tgId;
  const isCreator = Number(row.createdByTgId) === tgId;
  return {
    row,
    canEdit: isAdmin || ((isOwner || isCreator) && !row.assignedByAdmin),
    canUse: isAdmin || isOwner,
  };
}

tripPlansRouter.put("/:id", async (req, res) => {
  const { row, canEdit } = await loadPlan(req.params.id, req.user!.tgId, req.user!.role === "ADMIN");
  if (!row) {
    res.status(404).json({ error: "План не знайдено" });
    return;
  }
  if (!canEdit) {
    res.status(403).json({
      error: row.assignedByAdmin ? "Цей виїзд запланував адміністратор — змінити може тільки він" : "Це чужий план",
    });
    return;
  }
  const body = req.body as PlanBody;
  const data = normalizeBody(body);
  const isAdmin = req.user!.role === "ADMIN";
  const foremanTgId = isAdmin && body.foremanTgId ? Number(body.foremanTgId) : Number(row.foremanTgId);
  const assignedByAdmin = isAdmin ? foremanTgId !== req.user!.tgId : row.assignedByAdmin;

  await db
    .update(schema.tripPlans)
    .set({
      foremanTgId: BigInt(foremanTgId),
      assignedByAdmin,
      carId: data.carId,
      employeeIds: JSON.stringify(data.employeeIds),
      objects: JSON.stringify(data.objects),
      note: data.note,
      updatedAt: new Date(),
    })
    .where(eq(schema.tripPlans.id, req.params.id));

  // Re-notify only when an admin points an existing plan at a new person --
  // an admin tidying their own wording should not ping anybody.
  if (assignedByAdmin && foremanTgId !== Number(row.foremanTgId)) {
    await notifyAssignedForeman(foremanTgId, req.user!.pib, data);
  }
  res.json({ ok: true });
});

tripPlansRouter.delete("/:id", async (req, res) => {
  const { row, canEdit } = await loadPlan(req.params.id, req.user!.tgId, req.user!.role === "ADMIN");
  if (!row) {
    res.status(404).json({ error: "План не знайдено" });
    return;
  }
  if (!canEdit) {
    res.status(403).json({
      error: row.assignedByAdmin ? "Цей виїзд запланував адміністратор — прибрати може тільки він" : "Це чужий план",
    });
    return;
  }
  await db.delete(schema.tripPlans).where(eq(schema.tripPlans.id, req.params.id));
  res.json({ ok: true });
});

/**
 * POST /api/trip-plans/:id/use — the plan became a real trip.
 *
 * Kept as a status change rather than a delete so the badge in the pickers
 * stops immediately while the row is still there if anything needs looking up.
 */
tripPlansRouter.post("/:id/use", async (req, res) => {
  const { row, canUse } = await loadPlan(req.params.id, req.user!.tgId, req.user!.role === "ADMIN");
  if (!row) {
    res.status(404).json({ error: "План не знайдено" });
    return;
  }
  if (!canUse) {
    res.status(403).json({ error: "Це чужий план" });
    return;
  }
  await db
    .update(schema.tripPlans)
    .set({ status: "ВИКОРИСТАНИЙ", updatedAt: new Date() })
    .where(eq(schema.tripPlans.id, req.params.id));
  res.json({ ok: true });
});
