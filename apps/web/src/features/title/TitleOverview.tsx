import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RemotePlayerEvent } from '../../lib/remote';
import '../../styles/title-overview.scss';

const collapsedLines = 3;

export function TitleOverview({ text }: { text: string }) {
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = paragraph.current!;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      const clipped = element.scrollHeight > Math.ceil(lineHeight * collapsedLines);
      setOverflows(clipped);
      if (!clipped) setExpanded(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [text]);

  useLayoutEffect(() => {
    const button = toggle.current;
    if (button && document.activeElement === button) {
      const target = document.documentElement.hasAttribute('data-tv') ? button.parentElement! : button;
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onRemote = (event: Event) => {
      const element = paragraph.current;
      const { key } = (event as RemotePlayerEvent).detail;
      if (document.activeElement !== toggle.current || !element || (key !== 'ArrowUp' && key !== 'ArrowDown')) return;
      // Keep one line in view between reads. At either end the usual D-pad navigation takes over.
      const before = element.scrollTop;
      const line = parseFloat(getComputedStyle(element).lineHeight);
      const step = Math.max(line, element.clientHeight - line);
      element.scrollTop += key === 'ArrowDown' ? step : -step;
      if (element.scrollTop !== before) event.preventDefault();
    };
    window.addEventListener('moa:remote-key', onRemote);
    return () => window.removeEventListener('moa:remote-key', onRemote);
  }, [expanded]);

  const action = expanded ? '줄거리 접기' : '줄거리 펼치기';
  return <div className="title-overview">
    {overflows && <button type="button" className="text-btn" ref={toggle} id={`${id}-toggle`}
      aria-label={action} aria-controls={id} aria-expanded={expanded}
      onClick={() => {
        paragraph.current!.scrollTop = 0;
        setExpanded(value => !value);
      }}>{action}</button>}
    <p id={id} ref={paragraph} tabIndex={expanded ? -1 : undefined} className={expanded ? 'is-expanded' : undefined}
      style={{ WebkitLineClamp: expanded ? 'unset' : collapsedLines }}>
      {overflows ? <label htmlFor={`${id}-toggle`}>{text}</label> : text}
    </p>
  </div>;
}
