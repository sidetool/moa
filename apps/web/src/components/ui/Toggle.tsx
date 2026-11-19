import { cx } from "../../lib/format";

type ToggleProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  'aria-describedby'?: string;
  'aria-disabled'?: boolean;
};

export function Toggle({ checked, onChange, label, disabled, 'aria-disabled': ariaDisabled, ...description }: ToggleProps) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} {...description}
    disabled={disabled} aria-disabled={ariaDisabled} className={cx("switch", checked && "is-on")} onClick={() => { if (!ariaDisabled) onChange(!checked); }}><i /></button>;
}
