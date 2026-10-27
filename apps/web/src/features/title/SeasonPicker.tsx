import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";

export interface SeasonChoice {
  key: string;
  label: string;
  /** Episode count shown on the right; omitted when unknown. */
  count?: number;
  /** Second line, e.g. the source when the season lives in another source. */
  note?: string;
  current: boolean;
}

/** Netflix-style season switcher: "시즌 3 · 22화 ▾" opens the regular seasons of the title in order. */
export function SeasonPicker({ choices, count, onPick }: { choices: SeasonChoice[]; count: number; onPick: (choice: SeasonChoice) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = choices.find(choice => choice.current) ?? choices[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLElement>(".season-trigger")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    // Long franchises scroll; start with the current season in view.
    list.current?.querySelector<HTMLElement>("[aria-checked='true']")?.scrollIntoView({ block: "nearest" });
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!current) return null;
  const label = <>{current.label}<span className="season-trigger-count">{count}화</span></>;
  if (choices.length < 2) return <span className="season-trigger is-static">{label}</span>;
  return (
    <div className="season-picker" ref={root}>
      <button className="season-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {label}<ChevronDown size={16} aria-hidden="true" className="season-trigger-icon" />
      </button>
      {open && <>
        <div className="season-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
        <div className="menu season-menu" role="menu" aria-label="시즌 선택" ref={list}>
          <div className="season-menu-head" aria-hidden="true">시즌 선택</div>
          {choices.map(choice => (
            <button key={choice.key} role="menuitemradio" aria-checked={choice.current} className={cx("menu-item season-item", choice.current && "is-current")}
              onClick={() => { setOpen(false); if (!choice.current) onPick(choice); }}>
              <span className="season-item-text">
                <b>{choice.label}</b>
                {choice.note && <small>{choice.note}</small>}
              </span>
              {choice.count ? <span className="season-item-count">{choice.count}화</span> : null}
              <Check size={18} className="season-item-check" aria-hidden="true" />
            </button>
          ))}
        </div>
      </>}
    </div>
  );
}
