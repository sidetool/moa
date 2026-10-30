import { useState, type KeyboardEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { cx } from "../../lib/format";

type Change = { clamped: boolean };

/**
 * Whole-number field with − / + buttons, so a remote or touch screen never needs a keyboard.
 * Typing commits on Enter or blur; Escape restores the last value.
 */
export function NumberStepper({ value, onChange, min, max, step = 1, label, unit, disabled, invalid, className, "aria-describedby": describedBy }: {
  value: number; onChange: (value: number, change: Change) => void; min: number; max: number; step?: number;
  label: string; unit?: string; disabled?: boolean; invalid?: boolean; className?: string; "aria-describedby"?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const set = (next: number) => { const clamped = clamp(next); setDraft(null); if (clamped !== value || clamped !== next) onChange(clamped, { clamped: clamped !== next }); };
  const commit = () => {
    if (draft === null) return;
    if (!draft.trim()) { setDraft(null); return; }
    set(Number(draft));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number> = { ArrowUp: step, ArrowDown: -step, PageUp: step * 6, PageDown: -step * 6 };
    if (event.key in moves) { event.preventDefault(); set((draft === null ? value : Number(draft) || 0) + moves[event.key]); }
    else if (event.key === "Home") { event.preventDefault(); set(min); }
    else if (event.key === "End") { event.preventDefault(); set(max); }
    else if (event.key === "Enter") { event.preventDefault(); commit(); }
    else if (event.key === "Escape" && draft !== null) { event.preventDefault(); setDraft(null); }
  };
  const amount = `${step}${unit ?? ""}`;
  // aria-disabled keeps focus on the button at a limit, which matters for remotes.
  const atMin = value <= min, atMax = value >= max;
  return (
    <div className={cx("number-stepper", invalid && "is-invalid", className)} role="group" aria-label={label}>
      <button type="button" className="number-stepper-button" aria-label={`${amount} 줄이기`} title={`${amount} 줄이기`} disabled={disabled} aria-disabled={atMin || undefined} onClick={() => { if (!atMin) set(value - step); }}><Minus size={18} aria-hidden="true" /></button>
      <label className="number-stepper-value">
        <input role="spinbutton" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={unit ? `${value}${unit}` : undefined}
          aria-invalid={invalid || undefined} aria-describedby={describedBy} inputMode="numeric" autoComplete="off" enterKeyHint="done" disabled={disabled}
          size={Math.max(2, String(max).length)} value={draft ?? String(value)}
          onChange={event => setDraft(event.target.value.replace(/\D/g, "").slice(0, String(max).length + 1))}
          onFocus={event => event.currentTarget.select()} onBlur={commit} onKeyDown={onKeyDown} />
        {unit && <span aria-hidden="true">{unit}</span>}
      </label>
      <button type="button" className="number-stepper-button" aria-label={`${amount} 늘리기`} title={`${amount} 늘리기`} disabled={disabled} aria-disabled={atMax || undefined} onClick={() => { if (!atMax) set(value + step); }}><Plus size={18} aria-hidden="true" /></button>
    </div>
  );
}
