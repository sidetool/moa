import type { CSSProperties } from 'react';
import { cx } from '../../lib/format';

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

// Keeps selection, keyboard movement and the sliding indicator in one control.
export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled, className }: SegmentedControlProps<T>) {
  const selected = options.findIndex(option => option.value === value);
  return <div className={cx('segmented', className)} role="radiogroup" aria-label={label}
    style={{ '--segments': Math.max(1, options.length), '--selected': Math.max(0, selected) } as CSSProperties}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
      disabled={disabled} tabIndex={index === Math.max(0, selected) ? 0 : -1} className={cx(value === option.value && 'is-active')}
      onClick={() => { if (value !== option.value) onChange(option.value); }}
      onKeyDown={event => {
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1
          : event.key === 'ArrowRight' ? rtl ? -1 : 1 : event.key === 'ArrowLeft' ? rtl ? 1 : -1 : 0;
        if (!direction && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + direction + options.length) % options.length;
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
        if (options[next].value !== value) onChange(options[next].value);
      }}>{option.label}</button>)}
  </div>;
}
