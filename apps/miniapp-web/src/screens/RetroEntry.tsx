import { useEffect, useMemo, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject, type SalaryPack } from "../lib/api";
import { todayISO } from "../lib/date";
import { confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, initials, roleAccent, groupByBrigade, type EmployeeRole } from "../lib/employee";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

/**
 * "Внести заднім числом" -- a flat form for entering a day that already
 * happened, as opposed to the live road timesheet (RoadTimesheet.tsx), which
 * walks the foreman through the day step by step and derives hours from
 * start/stop timers that only exist while the day is actually being worked.
 *
 * Nothing here is a new data path: it posts the exact same payload to the
 * exact same POST /api/road-timesheet as the live flow, so payroll, the trip
 * class, the travel allowance and the admin approval all behave identically.
 * The only difference is where the numbers come from -- hours are typed in
 * per person per object instead of measured, and the timestamps sent as
 * sessions are synthesised from those hours (see buildSessions).
 */

type RetroWork = { workId: string; workName: string; unit: string; volume: string };
type RetroObject = {
  objectId: string;
  objectName: string;
  works: RetroWork[];
  // Typed hours per employee, kept as raw strings so a half-typed "1." or an
  // intentionally blank field survives re-renders. Anything that isn't a
  // positive number is treated as "this person wasn't here" at submit time.
  hoursByEmployeeId: Record<string, string>;
};

type Stage = "form" | "volumes";

type PreviewResponse = {
  km: number;
  billableKm: number;
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
};

type TakenCars = { taken: { carId: string; foremanName: string }[] };
type TakenPeople = { taken: { employeeId: string; foremanName: string }[] };
type DayStatusResponse = { hasSubmission: boolean; approved: boolean };

// Sessions are only ever read as a duration (pickedUpAt - droppedAt) by the
// server's payroll code, but they're stored in the event log too, so anchor
// them at a plausible 08:00 start on the day being entered rather than at
// "now" -- an audit trail showing a July shift logged at today's clock time
// would be actively misleading.
const DAY_START_HOUR = 8;

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function RetroEntry({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<Stage>("form");

  const [cars, setCars] = useState<Car[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [objects, setObjects] = useState<WorkObject[]>([]);

  const [date, setDate] = useState(() => yesterdayISO());
  const [carId, setCarId] = useState("");
  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [plans, setPlans] = useState<RetroObject[]>([]);

  const [takenCars, setTakenCars] = useState<Map<string, string>>(new Map());
  const [busyEmployees, setBusyEmployees] = useState<Map<string, string>>(new Map());
  const [dayApproved, setDayApproved] = useState(false);
  const [daySubmitted, setDaySubmitted] = useState(false);

  const [peopleSearch, setPeopleSearch] = useState("");
  const [expandedBrigadeId, setExpandedBrigadeId] = useState<string | null>(null);
  const [objectSearch, setObjectSearch] = useState("");
  const [showObjectPicker, setShowObjectPicker] = useState(false);
  const [worksPickerObjectId, setWorksPickerObjectId] = useState<string | null>(null);
  const [worksSearch, setWorksSearch] = useState("");

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
  }, []);

  // Everything below is keyed by the date being entered, not by today, so the
  // "already taken by another foreman" locks and the "day is approved" block
  // reflect that past day -- the server enforces all three on submit anyway,
  // and finding out here beats a 409 after the whole form is filled in.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    api
      .get<TakenCars>(`/api/road-timesheet/car-status?date=${date}`)
      .then((r) => !cancelled && setTakenCars(new Map(r.taken.map((t) => [t.carId, t.foremanName]))))
      .catch(() => undefined);
    api
      .get<TakenPeople>(`/api/road-timesheet/people-status?date=${date}`)
      .then((r) => !cancelled && setBusyEmployees(new Map(r.taken.map((t) => [t.employeeId, t.foremanName]))))
      .catch(() => undefined);
    api
      .get<DayStatusResponse>(`/api/road-timesheet/day-status?date=${date}`)
      .then((r) => {
        if (cancelled) return;
        setDayApproved(r.approved);
        setDaySubmitted(r.hasSubmission);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [date]);

  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const employeeName = (id: string) => employeeById.get(id)?.name ?? id;
  const roleFor = (id: string): EmployeeRole => {
    const emp = employeeById.get(id);
    return emp ? employeeRole(emp) : "робітник";
  };

  const km = useMemo(() => {
    const a = Number(odoStart);
    const b = Number(odoEnd);
    if (!odoStart || !odoEnd || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return b - a;
  }, [odoStart, odoEnd]);

  const today = todayISO();
  const dateInFuture = !!date && date > today;

  function planFor(objectId: string) {
    return plans.find((p) => p.objectId === objectId);
  }

  function updatePlan(objectId: string, patch: (p: RetroObject) => RetroObject) {
    setPlans((prev) => prev.map((p) => (p.objectId === objectId ? patch(p) : p)));
  }

  function toggleEmployee(id: string) {
    if (busyEmployees.has(id)) return;
    if (employeeIds.includes(id)) {
      setEmployeeIds((prev) => prev.filter((x) => x !== id));
      // Dropping someone from the day has to drop their typed hours too:
      // buildSessions filters by employeeIds, so a leftover entry would go
      // quiet rather than wrong -- but it would come back the moment the
      // same person is re-picked, silently restoring hours the foreman
      // thought they had cleared.
      setPlans((cur) =>
        cur.map((p) => {
          if (!(id in p.hoursByEmployeeId)) return p;
          const rest = { ...p.hoursByEmployeeId };
          delete rest[id];
          return { ...p, hoursByEmployeeId: rest };
        }),
      );
    } else {
      setEmployeeIds((prev) => [...prev, id]);
    }
    haptic("selection");
  }

  function toggleObject(obj: WorkObject) {
    setPlans((prev) =>
      prev.some((p) => p.objectId === obj.id)
        ? prev.filter((p) => p.objectId !== obj.id)
        : [...prev, { objectId: obj.id, objectName: obj.name, works: [], hoursByEmployeeId: {} }],
    );
    haptic("selection");
  }

  function removeObject(objectId: string) {
    setPlans((prev) => prev.filter((p) => p.objectId !== objectId));
    if (worksPickerObjectId === objectId) setWorksPickerObjectId(null);
    haptic("selection");
  }

  function toggleWork(objectId: string, work: Work) {
    updatePlan(objectId, (p) =>
      p.works.some((w) => w.workId === work.id)
        ? { ...p, works: p.works.filter((w) => w.workId !== work.id) }
        : { ...p, works: [...p.works, { workId: work.id, workName: work.name, unit: work.unit ?? "", volume: "" }] },
    );
    haptic("selection");
  }

  function setHours(objectId: string, employeeId: string, raw: string) {
    updatePlan(objectId, (p) => ({ ...p, hoursByEmployeeId: { ...p.hoursByEmployeeId, [employeeId]: raw } }));
  }

  function setVolume(objectId: string, workId: string, raw: string) {
    updatePlan(objectId, (p) => ({ ...p, works: p.works.map((w) => (w.workId === workId ? { ...w, volume: raw } : w)) }));
  }

  /** Typed hours -> the (droppedAt, pickedUpAt) pair the server measures. */
  function buildSessions(plan: RetroObject) {
    const base = new Date(`${date}T${String(DAY_START_HOUR).padStart(2, "0")}:00:00`).getTime();
    if (!Number.isFinite(base)) return [];
    return Object.entries(plan.hoursByEmployeeId)
      .map(([employeeId, raw]) => ({ employeeId, hours: Number(raw) }))
      .filter((x) => employeeIds.includes(x.employeeId) && Number.isFinite(x.hours) && x.hours > 0)
      .map((x) => ({
        employeeId: x.employeeId,
        employeeName: employeeName(x.employeeId),
        droppedAt: new Date(base).toISOString(),
        pickedUpAt: new Date(base + x.hours * 3_600_000).toISOString(),
      }));
  }

  function buildObjects() {
    return plans.map((p) => {
      const sessions = buildSessions(p);
      return {
        objectId: p.objectId,
        objectName: p.objectName,
        // "?" is the server's marker for "volume not filled in yet"
        // (volumeStatus НЕ_ЗАПОВНЕНО), same as the live flow sends.
        works: p.works.map((w) => ({
          workId: w.workId,
          workName: w.workName,
          volume: w.volume || "?",
          employeeIds: sessions.map((s) => s.employeeId),
        })),
        sessions,
        notes: "",
        photoUrls: [],
      };
    });
  }

  const peopleWithHours = new Set(plans.flatMap((p) => buildSessions(p).map((s) => s.employeeId)));

  const formComplete =
    !!date && !dateInFuture && !dayApproved && !!carId && km !== null && km >= 0 && employeeIds.length > 0 && plans.length > 0;

  async function goToVolumes() {
    if (!formComplete) return;
    setError(null);
    setStage("volumes");
    try {
      const res = await api.post<PreviewResponse>("/api/road-timesheet/preview", {
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds,
        objects: buildObjects(),
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    // Same guard as the live flow's save(): an object with real volume but
    // nobody with hours earns money that can't be split (pay is by hours), so
    // most of it silently goes to the company instead of the crew.
    const noHoursObjects = plans.filter(
      (p) => !buildSessions(p).length && p.works.some((w) => w.volume && w.volume !== "?" && Number(w.volume) > 0),
    );
    if (noHoursObjects.length) {
      const many = noHoursObjects.length > 1;
      const ok = await confirmDialog(
        `На об'єкт${many ? "ах" : "і"} ${noHoursObjects.map((p) => `«${p.objectName}»`).join(", ")} ` +
          `не введено години нікому — за ${many ? "них" : "нього"} гроші не розподіляться між людьми.\n\n` +
          `Відправити все одно?`,
      );
      if (!ok) return;
    }

    // This form always submits as a NEW trip for the day (it never sends a
    // tripSeq), so on a date that already has a report it ADDS to it rather
    // than replacing it -- and this screen doesn't show what's already there.
    // Sending the same day twice would double its volumes and hours.
    if (daySubmitted) {
      const ok = await confirmDialog(
        `На ${date} вже є зданий звіт. Ці дані додадуться до нього окремою поїздкою, а не замінять його.\n\n` +
          `Якщо треба виправити наявний звіт — робіть це у «Дорожньому табелі», а не тут. Продовжити?`,
      );
      if (!ok) return;
    }

    const emptyVolumes = plans.flatMap((p) => p.works.filter((w) => !w.volume)).length;
    if (emptyVolumes) {
      const ok = await confirmDialog(
        `Не заповнено обсяг у ${emptyVolumes} робіт${emptyVolumes === 1 ? "и" : "ах"} — вони підуть як «не заповнено» ` +
          `і за них не нарахується оплата.\n\nВідправити все одно?`,
      );
      if (!ok) return;
    }

    setSaving(true);
    setError(null);
    try {
      // Same role as in the live flow: one key per tap, reused across this
      // call's own network retries, so a lost response can't turn into a
      // second, duplicate leg for the day.
      const idempotencyKey = crypto.randomUUID();
      await api.post("/api/road-timesheet", {
        date,
        carId,
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds,
        objects: buildObjects(),
        idempotencyKey,
      });
      haptic("success");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setSaving(false);
    }
  }

  const goBack = () => {
    if (stage === "volumes") {
      setStage("form");
      return;
    }
    if (worksPickerObjectId) {
      setWorksPickerObjectId(null);
      return;
    }
    if (showObjectPicker) {
      setShowObjectPicker(false);
      return;
    }
    onBack();
  };
  useTelegramBackButton(goBack);

  const totalHours = plans.reduce((acc, p) => acc + buildSessions(p).reduce((a, s) => a + (new Date(s.pickedUpAt).getTime() - new Date(s.droppedAt).getTime()) / 3_600_000, 0), 0);
  const allWorksCount = plans.reduce((acc, p) => acc + p.works.length, 0);

  return (
    <div>
      <BackRow onBack={goBack} />
      <div className="header">
        <h1>🗓 Заднім числом</h1>
        <div className="hint">Внесення дня, який уже відпрацювали</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {stage === "form" && (
        <>
          <div className="step-badge">📅 ДАТА</div>
          <div className="field">
            <label>День, який вносимо</label>
            <input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {dateInFuture && <div className="empty-state">⚠️ Дата в майбутньому — оберіть сьогодні або раніше.</div>}
          {dayApproved && (
            <div className="empty-state">
              🔒 Цей день уже затверджено — редагування недоступне без запиту на редагування.
            </div>
          )}
          {daySubmitted && !dayApproved && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ℹ️ На цю дату вже є зданий звіт — те, що внесете тут, додасться до нього окремою поїздкою.
            </div>
          )}

          <div className="step-badge">🚙 АВТО ТА КІЛОМЕТРАЖ</div>
          <div className="list">
            {cars.map((c) => {
              const takenBy = takenCars.get(c.id);
              return (
                <button
                  key={c.id}
                  className={`cell ${carId === c.id ? "selected" : ""}`}
                  disabled={!!takenBy}
                  style={takenBy ? { opacity: 0.4 } : undefined}
                  onClick={() => {
                    setCarId(c.id);
                    haptic("selection");
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="setup-icon accent-blue">🚙</span>
                    <span className="cell-title">{c.name}</span>
                  </span>
                  {takenBy ? <span className="badge warn">🔒 {takenBy}</span> : <span className="cell-sub">{c.plate ?? ""}</span>}
                </button>
              );
            })}
          </div>

          <div className="grid-2">
            <div className="field">
              <label>Одометр на старті</label>
              <input inputMode="decimal" placeholder="0" value={odoStart} onChange={(e) => setOdoStart(e.target.value)} />
            </div>
            <div className="field">
              <label>Одометр на фініші</label>
              <input inputMode="decimal" placeholder="0" value={odoEnd} onChange={(e) => setOdoEnd(e.target.value)} />
            </div>
          </div>
          {km !== null && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              {km < 0 ? "⚠️ Фініш менший за старт" : `Проїхано: ${Math.round(km * 100) / 100} км`}
            </div>
          )}

          <div className="section-title row">
            <span>👥 Люди — обрано {employeeIds.length}</span>
            {employeeIds.length > 0 && (
              <button className="chip" onClick={() => setEmployeeIds([])}>
                🗑 Очистити
              </button>
            )}
          </div>
          <input className="search-box" placeholder="Пошук людини…" value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} />
          <div className="list">
            {groupByBrigade(employees.filter((e) => e.name.toLowerCase().includes(peopleSearch.toLowerCase())), employees).map((g) => {
              const expanded = expandedBrigadeId === g.id || !!peopleSearch;
              const selectedCount = g.members.filter((e) => employeeIds.includes(e.id)).length;
              return (
                <div key={g.id}>
                  <button className="cell" onClick={() => setExpandedBrigadeId(expanded ? null : g.id)}>
                    <span className="cell-title">
                      {expanded ? "▾" : "▸"} {g.title}
                    </span>
                    <span className="badge">
                      {selectedCount}/{g.members.length}
                    </span>
                  </button>
                  {expanded && (
                    <div style={{ paddingLeft: 12 }}>
                      {g.members.map((emp) => {
                        const busyBy = busyEmployees.get(emp.id);
                        const checked = employeeIds.includes(emp.id);
                        return (
                          <button
                            key={emp.id}
                            className={`cell ${checked ? "selected" : ""}`}
                            disabled={!!busyBy}
                            style={busyBy ? { opacity: 0.4 } : undefined}
                            onClick={() => toggleEmployee(emp.id)}
                          >
                            <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                              <span className={`avatar-circle ${roleAccent(employeeRole(emp))}`}>{initials(emp.name)}</span>
                              {emp.name}
                            </span>
                            {busyBy ? <span className="badge warn">🔒 {busyBy}</span> : <span className="role-tag">{employeeRole(emp)}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-title row">
            <span>📍 Обʼєкти — обрано {plans.length}</span>
            <button className="chip" onClick={() => setShowObjectPicker((v) => !v)}>
              {showObjectPicker ? "▾ Згорнути" : "➕ Додати"}
            </button>
          </div>
          {showObjectPicker && (
            <>
              <input className="search-box" placeholder="Пошук обʼєкта…" value={objectSearch} onChange={(e) => setObjectSearch(e.target.value)} />
              <div className="list">
                {objects
                  .filter((o) => o.name.toLowerCase().includes(objectSearch.toLowerCase()))
                  .map((o) => {
                    const checked = !!planFor(o.id);
                    return (
                      <button key={o.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleObject(o)}>
                        <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                          📍 {o.name}
                        </span>
                        <span className="cell-sub">{o.address ?? ""}</span>
                      </button>
                    );
                  })}
              </div>
            </>
          )}

          {plans.map((p) => {
            const sessions = buildSessions(p);
            return (
              <div key={p.objectId}>
                <div className="section-title row">
                  <span>📍 {p.objectName}</span>
                  <button className="chip danger-btn" onClick={() => removeObject(p.objectId)}>
                    🗑 Прибрати
                  </button>
                </div>

                <div className="chip-row">
                  {p.works.map((w) => (
                    <button key={w.workId} className="chip selected" onClick={() => setWorksPickerObjectId(p.objectId)}>
                      🧱 {w.workName}
                    </button>
                  ))}
                  <button
                    className="chip"
                    onClick={() => {
                      setWorksSearch("");
                      setWorksPickerObjectId(worksPickerObjectId === p.objectId ? null : p.objectId);
                    }}
                  >
                    {worksPickerObjectId === p.objectId ? "▾ Згорнути роботи" : "➕ Роботи"}
                  </button>
                </div>

                {worksPickerObjectId === p.objectId && (
                  <>
                    <input className="search-box" placeholder="Пошук роботи…" value={worksSearch} onChange={(e) => setWorksSearch(e.target.value)} />
                    <div className="list">
                      {works
                        .filter((w) => w.name.toLowerCase().includes(worksSearch.toLowerCase()))
                        .map((w) => {
                          const checked = p.works.some((pw) => pw.workId === w.id);
                          return (
                            <button key={w.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleWork(p.objectId, w)}>
                              <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                {w.name}
                              </span>
                              <span className="cell-sub">
                                {w.tariff} грн/{w.unit ?? "од."}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </>
                )}

                <div className="hint" style={{ padding: "0 16px 4px" }}>
                  Години на цьому обʼєкті ({sessions.length} з {employeeIds.length} людей)
                </div>
                {!employeeIds.length && <div className="hint" style={{ padding: "0 16px 8px" }}>Спочатку оберіть людей вище.</div>}
                <div className="list">
                  {employeeIds.map((id) => (
                    <div key={id} className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {employeeName(id)}
                      </span>
                      <input
                        className="hours-input"
                        inputMode="decimal"
                        placeholder="год"
                        value={p.hoursByEmployeeId[id] ?? ""}
                        onChange={(e) => setHours(p.objectId, id, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <MainButton text="Далі → Обсяги робіт" onClick={goToVolumes} disabled={!formComplete} />
        </>
      )}

      {stage === "volumes" && (
        <>
          <div className="step-badge">📦 ОБСЯГИ РОБІТ</div>
          {!allWorksCount && <div className="empty-state">Роботи не додані — повернись назад і додай їх.</div>}

          {plans.map((p) => (
            <div key={p.objectId}>
              <div className="section-title">📍 {p.objectName}</div>
              {!p.works.length && <div className="hint" style={{ padding: "0 16px 8px" }}>Без робіт</div>}
              <div className="list">
                {p.works.map((w) => (
                  <div key={w.workId} className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title">{w.workName}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        className="hours-input"
                        inputMode="decimal"
                        placeholder="0"
                        value={w.volume}
                        onChange={(e) => setVolume(p.objectId, w.workId, e.target.value)}
                      />
                      <span className="cell-sub">{w.unit || "од."}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="section-title">Підсумок</div>
          <div className="list">
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Дата</span>
              <span className="cell-sub">{date}</span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Авто · пробіг</span>
              <span className="cell-sub">
                {cars.find((c) => c.id === carId)?.name ?? carId} · {km ?? 0} км
              </span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Людей · годин</span>
              <span className="cell-sub">
                {employeeIds.length} · {Math.round(totalHours * 100) / 100} год
              </span>
            </div>
            {preview && (
              <>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">Клас виїзду</span>
                  <span className="cell-sub">
                    {preview.tripClass} · доплата {preview.roadAllowance.perPerson} грн/особу
                  </span>
                </div>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">Фонд за роботи</span>
                  <span className="cell-sub">{Math.round(preview.salaryPacks.reduce((a, s) => a + s.objectTotal, 0) * 100) / 100} грн</span>
                </div>
              </>
            )}
          </div>
          {peopleWithHours.size < employeeIds.length && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ⚠️ {employeeIds.length - peopleWithHours.size} з обраних людей без годин — вони отримають лише доплату за виїзд.
            </div>
          )}

          <MainButton text={saving ? "Відправлення…" : "💾 Відправити на підтвердження"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
