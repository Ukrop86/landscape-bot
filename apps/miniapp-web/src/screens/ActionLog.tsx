import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { todayISO } from "../lib/date";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { useTelegramBackButton } from "../lib/telegram";
import { shortName } from "../lib/employee";

/**
 * Журнал дій — що люди натискали в застосунку. ТИМЧАСОВЕ, на час обкатки.
 *
 * Читається згори вниз як стрічка: найновіше зверху, бо коли щось щойно пішло
 * не так, дивляться саме в хвіст.
 */

type Row = {
  id: string;
  ts: string;
  tgId: string;
  pib: string;
  role: string;
  screen: string;
  step: string;
  kind: string;
  label: string;
  detail: string | null;
};

const KIND_ICON: Record<string, string> = { click: "👆", screen: "📱", step: "➡️", error: "⚠️" };

export function ActionLog({ onBack }: { onBack: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [tgId, setTgId] = useState("");
  const [users, setUsers] = useState<{ tgId: string; pib: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearErrorOnSuccess(setError);
  useTelegramBackButton(onBack);

  useEffect(() => {
    api
      .get<{ users: { tgId: string; pib: string }[] }>("/api/telemetry/users")
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    const params = new URLSearchParams({ date, limit: "500" });
    if (tgId) params.set("tgId", tgId);
    api
      .get<{ rows: Row[] }>(`/api/telemetry?${params}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(load, [date, tgId]);

  const shiftDate = (days: number) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <div>
      <div className="back-row">
        <button className="back-btn" onClick={onBack}>‹ Назад</button>
        <button className="back-btn" onClick={load}>↻ Оновити</button>
      </div>

      <div className="header">
        <h2>🧾 Журнал дій</h2>
        <div className="hint">Хто що натискав. Тимчасово, на час обкатки.</div>
      </div>

      {error && <div className="empty-state" style={{ color: "#d70015" }}>{error}</div>}

      <div className="list">
        <div className="cell" style={{ cursor: "default" }}>
          <button className="back-btn" onClick={() => shiftDate(-1)}>‹ попередній</button>
          <span className="cell-title">{date}</span>
          <button className="back-btn" onClick={() => shiftDate(1)}>наступний ›</button>
        </div>
      </div>

      <div style={{ padding: "8px 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className={`chip ${tgId === "" ? "chip-on" : ""}`} onClick={() => setTgId("")}>Усі</button>
        {users.map((u) => (
          <button key={u.tgId} className={`chip ${tgId === u.tgId ? "chip-on" : ""}`} onClick={() => setTgId(u.tgId)}>
            {shortName(u.pib) || u.tgId}
          </button>
        ))}
      </div>

      {loading && <div className="empty-state">Читаю…</div>}
      {!loading && rows.length === 0 && <div className="empty-state">За цей день записів немає.</div>}

      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="cell" style={{ cursor: "default", alignItems: "flex-start" }}>
            <span className="cell-title" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>
                {KIND_ICON[r.kind] ?? "•"} {r.label || r.kind}
              </span>
              <span className="cell-sub">
                {shortName(r.pib) || r.tgId}
                {r.screen ? ` · ${r.screen}` : ""}
                {r.step ? ` / ${r.step}` : ""}
              </span>
              {r.detail && <span className="cell-sub">{r.detail}</span>}
            </span>
            <span className="cell-sub">
              {new Date(r.ts).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}
