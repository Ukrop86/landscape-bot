// The browser's own file input renders as "Choose File / No file chosen" --
// the one control in the app that speaks English and ignores the surrounding
// style. This wraps it: the input stays (it's what opens the camera) but is
// hidden behind a label styled like every other button here.
export function PhotoButton({
  text,
  onPick,
  disabled,
  capture = true,
}: {
  text: string;
  onPick: (file: File) => void;
  disabled?: boolean;
  capture?: boolean;
}) {
  return (
    <label className={`photo-btn ${disabled ? "disabled" : ""}`}>
      {text}
      <input
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" as const } : {})}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Let the same file be picked again after a failed upload.
          e.target.value = "";
        }}
      />
    </label>
  );
}
