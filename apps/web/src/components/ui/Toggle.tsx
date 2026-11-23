import { cx } from "../../lib/format";

type ToggleProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  'aria-describedby'?: string;
};

export function Toggle({ checked, onChange, label, disabled, ...description }: ToggleProps) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} {...description}
    disabled={disabled} className={cx("switch", checked && "is-on")} onClick={() => onChange(!checked)}><i /></button>;
}
