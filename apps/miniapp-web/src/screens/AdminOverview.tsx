import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { todayISO } from "../lib/date";
import { useTelegramBackButton } from "../lib/telegram";
import { BackRow } from "../components/BackRow";
import { shortName } from "../lib/employee";

type Progress = { state: string; objectName: string; updatedAt: string };
type ActiveTrip = {
  carId: string;
  carName: string;
  foremanTgId: number;
  foremanName: string;
  since: string;
  people: string[];
  /** null until the phone reports in -- an older build, or no signal yet. */
  progress: Progress | null;
};
type SubmittedTrip = { tripSeq: number; status: string; submittedAt: string; objects: string[]; km: number };
type SubmittedDay = {
  foremanTgId: number;
  foremanName: string;
  trips: SubmittedTrip[];
  km: number;
  allApproved: boolean;
};
type Overview = { date: string; active: ActiveTrip[]; submitted: SubmittedDay[] };

/** "о 08:14 · 3 год 12 хв" -- when they left and how long they have been out. */
function outFor(sinceIso: string, now: number): string {
  const started = new Date(sinceIso);
  const mins = Math.max(0, Math.round((now - started.getTime()) / 60000));
  const time = started.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  if (mins < 60) return `з ${time} · ${mins} хв`;
  return `з ${time} · ${Math.floor(mins / 60)} год ${mins % 60} хв`;
}

/** The reported state, as a badge: what they are doing, not just that they left. */
function stateBadge(p: Progress | null): { text: string; cls: string } {
  if (!p) return { text: "🚗 виїхали", cls: "" };
  switch (p.state) {
    case "WORKING":
      return { text: `🛠 працюють${p.objectName ? ` · ${p.objectName}` : ""}`, cls: "ok" };
    case "AT_OBJECT":
      return { text: `📍 на обʼєкті${p.objectName ? ` · ${p.objectName}` : ""}`, cls: "" };
    case "RETURNING":
      return { text: "↩️ повертаються", cls: "warn" };
    case "AT_BASE":
      return { text: "🏁 на базі, здають звіт", cls: "warn" };
    default:
      return { text: `🚗 в дорозі${p.objectName ? ` → ${p.objectName}` : ""}`, cls: "" };
  }
}

/** How long ago the phone last reported -- stale has to look stale. */
function reportedAgo(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 2) return "щойно";
  if (mins < 60) return `${mins} хв тому`;
  return `${Math.floor(mins / 60)} год тому`;
}

/**
 * What every brigade is doing today, for an admin.
 *
 * Every other screen is scoped to one foreman -- car-status and people-status
 * even hide the caller's own reservations, since their job is to warn about
 * OTHER people. So an admin could approve a finished day but had no way to see
 * a day in progress at all, short of reading the Google Sheet.
 */
export function AdminOverview({ onBack }: { onBack: () => void }) {
  const [date, setDate] = useState(() => todayISO());
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useClearErrorOnSuccess(setError);
  const [now, setNow] = useState(Date.now());
  useTelegramBackButton(onBack);

  // The "out for" counters are the point of the screen, so they tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Overview>(`/api/road-timesheet/admin/overview?date=${date}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [date, now]);

  const shiftDay = (delta: number) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setData(null);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <div>
      <BackRow onBack={onBack} onHome={onBack} />
      <div className="header">
        <h1>🚚 Поточні поїздки</h1>
        <div className="hint">Що зараз роблять бригади</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      <div className="list">
        <div className="cell" style={{ cursor: "default" }}>
          <button className="back-btn" onClick={() => shiftDay(-1)}>‹ попередній</button>
          <span className="cell-title">{date}</span>
          <button className="back-btn" onClick={() => shiftDay(1)} disabled={date >= todayISO()}>
            наступний ›
          </button>
        </div>
      </div>

      {!data && !error && <div className="empty-state">Завантаження…</div>}

      {data && (
        <>
          <div className="section-title">У дорозі зараз</div>
          {data.active.length === 0 ? (
            <div className="empty-state">Жодне авто не в дорозі.</div>
          ) : (
            <div className="list">
              {data.active.map((t) => (
                <div key={t.carId} className="cell" style={{ cursor: "default", display: "block" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <span className="cell-title">🚙 {t.carName}</span>
                    <span className="cell-sub">{outFor(t.since, now)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                    <span className={`badge ${stateBadge(t.progress).cls}`}>{stateBadge(t.progress).text}</span>
                    {t.progress ? (
                      <span className="hint">{reportedAgo(t.progress.updatedAt, now)}</span>
                    ) : (
                      <span className="hint">стан не надходив</span>
                    )}
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    👤 {shortName(t.foremanName)}
                    {t.people.length > 0 && ` · ${t.people.length} у бригаді`}
                  </div>
                  {t.people.length > 0 && (
                    <ul className="bullets">
                      {t.people.map((n) => (
                        <li key={n}>{shortName(n)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="section-title">Здані за цей день</div>
          {data.submitted.length === 0 ? (
            <div className="empty-state">Ще нічого не здано.</div>
          ) : (
            data.submitted.map((d) => (
              <div key={d.foremanTgId} className="list" style={{ marginTop: 8 }}>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">👤 {shortName(d.foremanName)}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`badge ${d.allApproved ? "ok" : "warn"}`}>
                      {d.allApproved ? "✅ затверджено" : "очікує"}
                    </span>
                    <span className="cell-sub">{d.km} км</span>
                  </span>
                </div>
                {d.trips.map((t) => (
                  <div key={t.tripSeq} className="cell" style={{ cursor: "default", display: "block" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span className="cell-title">Поїздка {t.tripSeq}</span>
                      <span className="cell-sub">
                        {new Date(t.submittedAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })} · {t.km} км
                      </span>
                    </div>
                    <div className="hint" style={{ marginTop: 2 }}>{t.objects.join(", ") || "без обʼєктів"}</div>
                  </div>
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
