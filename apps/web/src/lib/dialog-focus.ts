import type { KeyboardEvent } from 'react';

/** Keep Tab at the ends of an open modal in the page instead of the browser chrome. */
export function keepTabInDialog(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [inert]') && element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first || document.activeElement === (event.shiftKey ? first : last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}
