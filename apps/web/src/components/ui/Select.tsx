import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "../../lib/format";
import { remoteKey } from "../../lib/remote";

// Older TV browsers lack the Popover API; Select falls back to a native <select> there.
const popoverSupported = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function" && typeof HTMLElement.prototype.hidePopover === "function";

type SelectProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange" | "children"> & { options: { value: string; label: string }[] } & ({ multiple: true; value: string[]; onChange: (value: string[]) => void } | { multiple?: false; value: string; onChange: (value: string) => void });

export function Select({ value, options, onChange, multiple, className, disabled, ...rest }: SelectProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const position = useRef({ top: 0, left: 0 });
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const chosen = (option: string) => multiple ? value.includes(option) : option === value;
  const selected = options.findIndex(option => chosen(option.value));
  const close = () => { if (popoverSupported) menu.current?.hidePopover(); setOpen(false); };
  const show = () => {
    const button = trigger.current, list = menu.current;
    if (!button || !list || disabled || !options.length) return;
    const rect = button.getBoundingClientRect();
    position.current = rect;
    const width = Math.min(Math.max(rect.width, 180), innerWidth - 24);
    const below = innerHeight - rect.bottom - 18, above = rect.top - 18;
    list.style.width = `${width}px`;
    list.style.maxHeight = `${Math.max(48, Math.min(320, Math.max(below, above)))}px`;
    list.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    list.showPopover();
    list.style.top = `${below >= list.offsetHeight || below >= above ? rect.bottom + 6 : Math.max(12, rect.top - list.offsetHeight - 6)}px`;
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    if (multiple) onChange(chosen(option.value) ? value.filter(item => item !== option.value) : [...value, option.value]);
    else { onChange(option.value); close(); }
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const rect = trigger.current?.getBoundingClientRect();
      if (event.type === "resize" || rect?.top !== position.current.top || rect?.left !== position.current.left) close();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", dismiss, true); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.children[active]?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  useEffect(() => { if (disabled && !multiple) close(); }, [disabled, multiple]);
  if (!popoverSupported) {
    return <span className={cx("dropdown", className)}>
      <select id={rest.id} name={rest.name} title={rest.title} autoFocus={rest.autoFocus} tabIndex={rest.tabIndex} aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]} aria-describedby={rest["aria-describedby"]}
        className="dropdown-trigger" multiple={multiple} disabled={disabled || !options.length} value={value} onChange={event => multiple ? onChange([...event.target.selectedOptions].map(option => option.value)) : onChange(event.target.value)}>
        {!multiple && selected < 0 && <option value={value} hidden>{value}</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </span>;
  }
  return <span className={cx("dropdown", className)}>
    <button {...rest} ref={trigger} type="button" className="dropdown-trigger" disabled={(!multiple && disabled) || !options.length} aria-disabled={disabled || undefined} popoverTarget={id} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={event => { event.preventDefault(); if (open) close(); else show(); }} onKeyDown={event => {
        const key = remoteKey(event.nativeEvent);
        if (key === "Tab") { close(); return; }
        if (key === "Back" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) { show(); if (key === "End") setActive(options.length - 1); }
          else if (key === "Enter" || key === " ") choose(active);
          else setActive(index => key === "Home" ? 0 : key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (key === "ArrowDown" ? 1 : -1))));
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); event.stopPropagation();
          const now = Date.now();
          search.current = { text: now - search.current.time < 700 ? search.current.text + event.key : event.key, time: now };
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()));
          if (index >= 0) { if (open) setActive(index); else if (multiple) { show(); setActive(index); } else onChange(options[index].value); }
        }
      }}>
      <span>{multiple ? value.length ? options.filter(option => chosen(option.value)).map(option => option.label).join(", ") : "선택 없음" : options[selected]?.label ?? value}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    <div ref={menu} id={id} popover="auto" className="dropdown-menu" role="listbox" aria-multiselectable={multiple || undefined} aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}
      onToggle={event => setOpen(event.newState === "open")} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
      {options.map((option, index) => <button key={option.value} id={`${id}-${index}`} type="button" role="option" tabIndex={-1} disabled={disabled} aria-selected={chosen(option.value)} className={cx("dropdown-option", index === active && "is-active")}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        {multiple && <span className={cx("option-check", chosen(option.value) && "is-checked")} aria-hidden="true">{chosen(option.value) && <Check size={13} />}</span>}<span>{option.label}</span>{!multiple && chosen(option.value) && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>
  </span>;
}
