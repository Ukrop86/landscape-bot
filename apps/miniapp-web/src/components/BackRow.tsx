export function BackRow({
  onBack,
  onHub,
  onHome,
  onReset,
  label = "‹ Назад",
}: {
  onBack: () => void;
  /** Jump to the road timesheet's own hub -- where a day is set up, a next
      trip is planned, or a parallel one is started. "Back" only steps through
      the flow, so from deep inside a day (or from a submitted one) the hub was
      unreachable without leaving to the menu and coming in again. */
  onHub?: () => void;
  /** Escape hatch to the main menu. */
  onHome?: () => void;
  /** Throw away the trip in progress. Lives here so it sits in the same place
      on every step instead of only on the screens that happen to have room
      for it -- it is confirmed before it does anything. */
  onReset?: () => void;
  label?: string;
}) {
  return (
    <div className="back-row">
      <button className="back-btn" onClick={onBack}>
        {label}
      </button>
      <span style={{ display: "flex", gap: 12 }}>
        {onHub && (
          <button className="back-btn" onClick={onHub}>
            🚗 До табеля
          </button>
        )}
        {onHome && (
          <button className="back-btn" onClick={onHome}>
            🏠 Меню
          </button>
        )}
        {onReset && (
          <button className="back-btn danger-btn" onClick={onReset} title="Скинути поточну поїздку" aria-label="Скинути поточну поїздку">
            🗑
          </button>
        )}
      </span>
    </div>
  );
}
