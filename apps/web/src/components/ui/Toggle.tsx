import { cx } from "../../lib/format";

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx("switch", checked && "is-on")} onClick={() => onChange(!checked)}><i /></button>;
}
