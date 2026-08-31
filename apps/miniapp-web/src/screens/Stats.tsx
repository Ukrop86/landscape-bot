import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { todayISO } from "../lib/date";
import { fmtHours } from "../lib/hours";
import { useTelegramBackButton } from "../lib/telegram";
import { BackRow } from "../components/BackRow";

type WorkStat = { workName: string; unit: string; totalVolume: number; employeeNames: string[] };
type ObjEmployeeStat = { employeeName: string; hours: number; pay: number };
type ObjectStat = { objectId: string; objectName: string; totalFund: number; works: WorkStat[]; employees: ObjEmployeeStat[] };
type EmpObjectStat = { objectId: string; objectName: string; hours: number; pay: number };
type EmployeeStat = {
  employeeId: string;
  employeeName: string;
  totalHours: number;
  totalPay: number;
  roadAllowance: number;
  objects: EmpObjectStat[];
};
type CarDayStat = { date: string; km: number; tripClass: string; riderNames: string[]; objectNames: string[] };
type CarStat = { carId: string; carName: string; totalKm: number; days: CarDayStat[] };
type ForemanDayStat = { date: string; km: number; fund: number; crewCount: number; objectNames: string[]; approved: boolean };
type ForemanStat = {
  foremanTgId: string;
  foremanName: string;
  days: number;
  approvedDays: number;
  totalKm: number;
  totalFund: number;
  objectsCount: number;
  crewCount: number;
  dayList: ForemanDayStat[];
};
type StatsRangeResponse = {
  from: string;
  to: string;
  moneyApproved: boolean;
  pendingDates: string[];
  byObject: ObjectStat[];
  byEmployee: EmployeeStat[];
  byCar: CarStat[];
  byForeman: ForemanStat[];
};

// «Бригадири» має сенс лише адміну: бригадиру запит і так повертає тільки
// його власні дані, тож вкладка показувала б один рядок про нього самого.
type Tab = "objects" | "employees" | "cars" | "foremen";

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function Stats({ onBack, isAdmin }: { onBack: () => void; isAdmin?: boolean }) {
  const [from, setFrom] = useState(() => daysAgoISO(6));
  const [to, setTo] = useState(() => todayISO());
  const [data, setData] = useState<StatsRangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("objects");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Otherwise Telegram's native back gesture/button exits the whole mini app
  // instead of stepping back to the menu, same as the in-app "‹ Назад" row.
  useTelegramBackButton(onBack);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<StatsRangeResponse>(`/api/stats/range?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  function selectTab(t: Tab) {
    setTab(t);
    setExpandedId(null);
  }

  return (
    <div>
      <BackRow onBack={onBack} onHome={onBack} />
      <div className="header">
        <h1>📊 Статистика</h1>
        <div className="hint">
          {from} — {to}
          {isAdmin ? " · усі бригадири" : ""}
        </div>
      </div>

      <div className="grid-2">
        <div className="field" style={{ margin: 0 }}>
          <label>Від</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>До</label>
          <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="unit-tabs" style={{ margin: "8px 0" }}>
        <button className={`unit-tab ${tab === "objects" ? "selected" : ""}`} onClick={() => selectTab("objects")}>
          📍 Обʼєкти
        </button>
        <button className={`unit-tab ${tab === "employees" ? "selected" : ""}`} onClick={() => selectTab("employees")}>
          👥 Люди
        </button>
        {isAdmin && (
          <button className={`unit-tab ${tab === "foremen" ? "selected" : ""}`} onClick={() => selectTab("foremen")}>
            🧑‍🔧 Бригадири
          </button>
        )}
        <button className={`unit-tab ${tab === "cars" ? "selected" : ""}`} onClick={() => selectTab("cars")}>
          🚙 Машини
        </button>
      </div>

      {loading && <div className="empty-state">Завантаження…</div>}
      {error && <div className="empty-state">⚠️ {error}</div>}

      {data && !data.moneyApproved && (
        <div className="hint" style={{ padding: "0 16px 8px" }}>
          🔒 {data.pendingDates.length > 1 ? `Дні ${data.pendingDates.join(", ")} ще` : `День ${data.pendingDates[0]} ще`} не затверджено
          адміністратором — суми приховано.
        </div>
      )}

      {/* Same shape as the approval report: a card per row, and inside it
          labelled blocks whose figures line up in one right-hand column. The
          tabs used to be runs of grey text where a name, an hour count and a
          sum all looked the same. */}
      {data && !loading && (
        <>
          {tab === "objects" && (
            <>
              {!data.byObject.length && <div className="empty-state">Немає даних за цей період</div>}
              {data.byObject.map((o) => {
                const expanded = expandedId === o.objectId;
                return (
                  <div key={o.objectId} className={`approval-card ${expanded ? "open" : ""}`}>
                    <button className="cell" onClick={() => setExpandedId(expanded ? null : o.objectId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {o.objectName}
                      </span>
                      <span className="badge ok">{data.moneyApproved ? `${o.totalFund} ₴` : "🔒 •••"}</span>
                    </button>
                    {expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        <div className="approval-object">
                          <div className="approval-sub">🛠 Роботи</div>
                          {o.works.length ? (
                            <div className="approval-rows">
                              {o.works.map((w, i) => (
                                <div key={i} className="approval-row">
                                  <div className="approval-row-main">
                                    <span className="approval-row-name wrap">{w.workName}</span>
                                    <span className="badge badge-sm ok">
                                      {w.totalVolume} {w.unit}
                                    </span>
                                  </div>
                                  {!!w.employeeNames.length && (
                                    <div className="hint" style={{ marginTop: 2 }}>
                                      👤 окремо: {w.employeeNames.join(", ")}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="hint">Немає робіт</div>
                          )}

                          <div className="approval-sub">👥 Люди та нарахування</div>
                          {!data.moneyApproved ? (
                            <div className="hint">🔒 Буде видно після затвердження адміністратором</div>
                          ) : o.employees.length ? (
                            <div className="approval-rows">
                              {o.employees.map((e, i) => (
                                <div key={i} className="approval-row">
                                  <div className="approval-row-main">
                                    <span className="approval-row-name">{e.employeeName}</span>
                                    <span className="approval-nums">
                                      <span className="badge badge-sm">{fmtHours(e.hours)}</span>
                                      <span className="badge badge-sm ok">{e.pay} ₴</span>
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="hint">Немає даних</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {tab === "employees" && (
            <>
              {!data.byEmployee.length && <div className="empty-state">Немає даних за цей період</div>}
              {data.byEmployee.map((e) => {
                const expanded = expandedId === e.employeeId;
                return (
                  <div key={e.employeeId} className={`approval-card ${expanded ? "open" : ""}`}>
                    <button className="cell" onClick={() => setExpandedId(expanded ? null : e.employeeId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {e.employeeName}
                      </span>
                      <span className="approval-nums">
                        <span className="badge badge-sm">{e.totalHours} год</span>
                        <span className="badge badge-sm ok">{data.moneyApproved ? `${e.totalPay} ₴` : "🔒 •••"}</span>
                      </span>
                    </button>
                    {expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        <div className="approval-object">
                          <div className="approval-sub">📍 Обʼєкти</div>
                          {e.objects.length ? (
                            <div className="approval-rows">
                              {e.objects.map((o) => (
                                <div key={o.objectId} className="approval-row">
                                  <div className="approval-row-main">
                                    <span className="approval-row-name">{o.objectName}</span>
                                    <span className="approval-nums">
                                      <span className="badge badge-sm">{fmtHours(o.hours)}</span>
                                      <span className="badge badge-sm ok">{data.moneyApproved ? `${o.pay} ₴` : "🔒 •••"}</span>
                                    </span>
                                  </div>
                                </div>
                              ))}
                              {e.roadAllowance > 0 && (
                                <div className="approval-row">
                                  <div className="approval-row-main">
                                    <span className="approval-row-name">💸 Доплата за виїзд</span>
                                    <span className="approval-nums">
                                      <span className="badge badge-sm ok">{data.moneyApproved ? `${e.roadAllowance} ₴` : "🔒 •••"}</span>
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="hint">Без обʼєктів (лише доплата за виїзд)</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {tab === "foremen" && (
            <>
              {!data.byForeman.length && <div className="empty-state">Немає даних за цей період</div>}
              {data.byForeman.map((f) => {
                const expanded = expandedId === f.foremanTgId;
                const pending = f.days - f.approvedDays;
                return (
                  <div key={f.foremanTgId} className={`approval-card ${expanded ? "open" : ""}`}>
                    <button className="cell" onClick={() => setExpandedId(expanded ? null : f.foremanTgId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {f.foremanName}
                      </span>
                      <span className="badge ok">{data.moneyApproved ? `${f.totalFund} ₴` : "🔒 •••"}</span>
                    </button>
                    {expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        <div className="approval-object">
                          <div className="approval-sub">Разом за період</div>
                          <div className="approval-rows">
                            <div className="approval-row">
                              <div className="approval-row-main">
                                <span className="approval-row-name">📅 Днів</span>
                                <span className="approval-nums">
                                  <span className="badge badge-sm">{f.days}</span>
                                  {pending > 0 && <span className="badge badge-sm warn">{pending} без затвердження</span>}
                                </span>
                              </div>
                            </div>
                            <div className="approval-row">
                              <div className="approval-row-main">
                                <span className="approval-row-name">🚗 Пробіг</span>
                                <span className="approval-nums">
                                  <span className="badge badge-sm">{f.totalKm} км</span>
                                </span>
                              </div>
                            </div>
                            <div className="approval-row">
                              <div className="approval-row-main">
                                <span className="approval-row-name">📍 Обʼєктів · 👥 людей</span>
                                <span className="approval-nums">
                                  <span className="badge badge-sm">{f.objectsCount}</span>
                                  <span className="badge badge-sm">{f.crewCount}</span>
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="approval-sub">📅 По днях</div>
                          <div className="approval-rows">
                            {f.dayList.map((d) => (
                              <div key={d.date} className="approval-row">
                                <div className="approval-row-main">
                                  <span className="approval-row-name">
                                    {d.approved ? "✅" : "⏳"} {d.date}
                                  </span>
                                  <span className="approval-nums">
                                    <span className="badge badge-sm">{d.km} км</span>
                                    <span className="badge badge-sm">👥 {d.crewCount}</span>
                                    <span className="badge badge-sm ok">{data.moneyApproved ? `${d.fund} ₴` : "🔒 •••"}</span>
                                  </span>
                                </div>
                                <div className="hint" style={{ marginTop: 2 }}>
                                  📍 {d.objectNames.join(", ") || "—"}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {tab === "cars" && (
            <>
              {!data.byCar.length && <div className="empty-state">Немає даних за цей період</div>}
              {data.byCar.map((c) => {
                const expanded = expandedId === c.carId;
                return (
                  <div key={c.carId} className={`approval-card ${expanded ? "open" : ""}`}>
                    <button className="cell" onClick={() => setExpandedId(expanded ? null : c.carId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {c.carName}
                      </span>
                      <span className="badge">{c.totalKm} км</span>
                    </button>
                    {expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        <div className="approval-object">
                          <div className="approval-sub">📅 По днях</div>
                          <div className="approval-rows">
                            {c.days.map((d, i) => (
                              <div key={i} className="approval-row">
                                <div className="approval-row-main">
                                  <span className="approval-row-name">{d.date}</span>
                                  <span className="approval-nums">
                                    <span className="badge badge-sm">{d.km} км</span>
                                    <span className="badge badge-sm">клас {d.tripClass || "—"}</span>
                                  </span>
                                </div>
                                <div className="hint" style={{ marginTop: 2 }}>
                                  👥 {d.riderNames.join(", ") || "—"}
                                </div>
                                <div className="hint">📍 {d.objectNames.join(", ") || "—"}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
