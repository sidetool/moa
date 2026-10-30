import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cx } from '../../lib/format';

/** Collapsed advanced rows at the end of a settings card; `#id` in the address opens and scrolls to it. */
export function SettingsDisclosure({ id, title, summary, icon, className, children }: { id: string; title: string; summary: ReactNode; icon: ReactNode; className?: string; children: ReactNode }) {
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === `#${id}`);
  const region = useId();
  const anchor = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (hash !== `#${id}`) return;
    setOpen(true);
    requestAnimationFrame(() => anchor.current?.scrollIntoView({ block: 'start' }));
  }, [hash, id]);
  return (
    <details className={cx('settings-disclosure', className)} id={id} ref={anchor} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="setting setting-disclosure" aria-controls={region}>
        <span className="setting-icon">{icon}</span>
        <div><b>{title}</b><small>{summary}</small></div>
        <ChevronDown size={18} className={cx('disclosure-chevron', open && 'is-open')} aria-hidden="true" />
      </summary>
      <div id={region} className="settings-advanced" role="region" aria-label={title}>{children}</div>
    </details>
  );
}
