import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { todayISO } from "../lib/date";
import { useTelegramBackButton } from "../lib/telegram";
import { BackRow } from "../components/BackRow";
import { shortName } from "../lib/employee";

type Checkpoint = { state: string; objectName: string; at: string };
type ActiveTrip = {
  carId: string;
  carName: string;
  foremanTgId: number;
  foremanName: string;
  since: string;
  people: string[];
  /** Empty until the phone reports in -- an older build, or no signal yet. */
  timeline: Checkpoint[];
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

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

/** One checkpoint, as the admin reads it: what happened, not what state a machine is in. */
function checkpointLabel(c: Checkpoint): string {
  switch (c.state) {
    case "WORKING":
      return `🛠 почали роботи${c.objectName ? ` · ${c.objectName}` : ""}`;
    case "AT_OBJECT":
      return `📍 прибули${c.objectName ? ` · ${c.objectName}` : ""}`;
    case "RETURNING":
      return "↩️ повертаються";
    case "AT_BASE":
      return "🏁 на базі";
    default:
      return `🚗 в дорозі${c.objectName ? ` → ${c.objectName}` : ""}`;
  }
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
                    <span className="cell-sub">👤 {shortName(t.foremanName)}</span>
                  </div>

                  {/* The day as it happened, top to bottom. The departure comes
                      from the car reservation, so there is always at least one
                      point even before the phone has reported anything. */}
                  <div className="trip-timeline">
                    <div className="trip-point">
                      <span className="trip-time">{clock(t.since)}</span>
                      <span className="trip-label">🚗 виїхали</span>
                    </div>
                    {t.timeline.map((c, i) => (
                      <div key={`${c.at}-${i}`} className="trip-point">
                        <span className="trip-time">{clock(c.at)}</span>
                        <span className="trip-label">{checkpointLabel(c)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="hint" style={{ marginTop: 6 }}>
                    {t.people.length > 0 ? `${t.people.length} у бригаді` : "бригада не вказана"}
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
