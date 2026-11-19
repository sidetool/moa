import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { currentProfileId } from './api';

type Position = { x: number; y: number; focus?: string; rows: Record<string, number> };
const positions = new Map<string, Position>();
function save(key: string, value: Position) {
  positions.set(key, value);
  if (positions.size > 80) positions.delete(positions.keys().next().value!);
}
const selector = 'a[href],button,input,select,textarea,summary,[tabindex]';
function identity(el: HTMLElement) {
  const row = el.closest('.row')?.getAttribute('aria-labelledby') ?? '';
  return `${row}:${el.dataset.remoteId || el.id || `${el.tagName}:${el.getAttribute('href') ?? ''}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 100) ?? ''}`}`;
}
function available(el: HTMLElement) {
  return el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]') && !el.matches(':disabled') && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
}
export const isRestoringBrowsingPosition = () => document.documentElement.hasAttribute('data-restoring-position');
export const cancelBrowsingPosition = () => window.dispatchEvent(new Event('moa:position-cancel'));

/** One history-entry owner for pointer, touch, keyboard and TV; retries while async lists grow. */
export function useBrowsingPosition() {
  const location = useLocation(), navigation = useNavigationType();
  const profile = currentProfileId();
  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);
  useLayoutEffect(() => {
    const key = `${profile}:${location.key}`;
    const saved = navigation === 'POP' ? positions.get(key) : undefined;
    let restoring = !!saved, frame = 0, stopped = false;
    let last: Position = saved ?? { x: 0, y: 0, rows: {} };
    let focusId = saved?.focus;
    const root = document.querySelector<HTMLElement>('main.page') ?? document.getElementById('root');
    const finish = () => {
      restoring = false;
      document.documentElement.removeAttribute('data-restoring-position');
      window.dispatchEvent(new Event('moa:position-restored'));
    };
    const capture = (event?: Event) => {
      if (restoring || stopped) return;
      const rows = { ...last.rows };
      const tracks = event?.type === 'scroll' ? (event.target instanceof HTMLElement && event.target.matches('.row-track') ? [event.target] : []) : root?.querySelectorAll<HTMLElement>('.row-track') ?? [];
      tracks.forEach(track => {
        const id = track.closest('.row')?.getAttribute('aria-labelledby');
        if (id) rows[id] = track.scrollLeft;
      });
      last = { x: window.scrollX, y: window.scrollY, focus: focusId, rows };
      save(key, last);
    };
    const attempt = () => {
      frame = 0;
      if (!restoring || !saved) return;
      const restoredRows = new Set<string>();
      for (const track of root?.querySelectorAll<HTMLElement>('.row-track') ?? []) {
        const id = track.closest('.row')?.getAttribute('aria-labelledby');
        if (id && saved.rows[id] !== undefined) {
          track.scrollLeft = saved.rows[id];
          if (Math.abs(track.scrollLeft - saved.rows[id]) <= 2) restoredRows.add(id);
        }
      }
      const target = saved.focus ? [...document.querySelectorAll<HTMLElement>(selector)].find(el => identity(el) === saved.focus && available(el)) : undefined;
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
      const rowsReady = Object.entries(saved.rows).every(([id, x]) => !x || restoredRows.has(id));
      if (rowsReady && Math.abs(window.scrollY - saved.y) <= 2 && (!saved.focus || target)) {
        // Restoring a touch search field should not reopen the software keyboard.
        if (target && !(matchMedia('(pointer: coarse)').matches && target.matches('input,textarea,[contenteditable="true"]'))) target.focus({ preventScroll: true });
        finish();
      }
    };
    const schedule = () => { if (restoring && !frame) frame = requestAnimationFrame(attempt); };
    const interact = () => { if (restoring) finish(); };
    window.addEventListener('moa:position-cancel', interact);
    const activate = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (target && available(target) && !target.closest('[aria-modal="true"],[role="menu"],.player-panel')) focusId = identity(target);
      capture();
    };
    if (saved) document.documentElement.setAttribute('data-restoring-position', '');
    else window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    const observer = new MutationObserver(schedule);
    if (root) observer.observe(root, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    if (root) resize.observe(root);
    const timeout = window.setTimeout(() => { if (restoring) finish(); }, 8000);
    window.addEventListener('scroll', capture, true);
    document.addEventListener('focusin', activate);
    document.addEventListener('click', activate, true);
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) document.addEventListener(event, interact, true);
    schedule();
    return () => {
      stopped = true;
      // Events snapshot the outgoing DOM before React replaces it.
      save(key, last);
      observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout);
      document.documentElement.removeAttribute('data-restoring-position');
      window.removeEventListener('scroll', capture, true);
      window.removeEventListener('moa:position-cancel', interact);
      document.removeEventListener('focusin', activate);
      document.removeEventListener('click', activate, true);
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) document.removeEventListener(event, interact, true);
    };
  }, [location.key, navigation, profile]);
}
