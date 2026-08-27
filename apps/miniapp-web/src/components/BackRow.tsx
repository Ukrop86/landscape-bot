export function BackRow({
  onBack,
  onHome,
  label = "‹ Назад",
}: {
  onBack: () => void;
  /** Escape hatch to the main menu. "Back" walks the flow one step at a time,
      which is right while working through a day but a long way home from the
      middle of one. */
  onHome?: () => void;
  label?: string;
}) {
  return (
    <div className="back-row">
      <button className="back-btn" onClick={onBack}>
        {label}
      </button>
      {onHome && (
        <button className="back-btn" onClick={onHome}>
          🏠 Меню
        </button>
      )}
    </div>
  );
}
