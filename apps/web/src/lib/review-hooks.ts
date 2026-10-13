import { useSyncExternalStore } from 'react';
import { currentProfileId } from './api';

/** Optional title.reviews data hook. MOA owns presentation and validates every response. */
export type ReviewRequest = {mediaId:string;provider:import('@moa/shared').ReviewProvider;selection?:string};
export type ReviewHook = { profile: string; name: string; run: (value: ReviewRequest, signal: AbortSignal) => Promise<unknown> };
export type ReviewSource = { id: string; name: string; request: (value: ReviewRequest, signal: AbortSignal) => Promise<unknown> };

const hooks = new Map<string, ReviewHook>(), listeners = new Set<() => void>();
let snapshot: { valid: boolean; profile: string | null; source: ReviewSource | null } = { valid: false, profile: null, source: null };
const TIMEOUT = 20_000, MAX_BYTES = 262_144;

function changed() {
  snapshot = { valid: false, profile: null, source: null };
  for (const listener of listeners) listener();
}

export function registerReviewHook(id: string, hook: ReviewHook) {
  hooks.set(id, hook); changed();
  return () => { if (hooks.get(id) === hook) { hooks.delete(id); changed(); } };
}

/** Runs one request with a deadline. Rejects if the plugin unregisters, times out, or answers too much data. */
async function request(id: string, hook: ReviewHook, value: ReviewRequest, signal: AbortSignal) {
  if (signal.aborted) throw new Error('Request cancelled');
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, TIMEOUT);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await Promise.race([
      hook.run(value, controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Request cancelled')), { once: true })),
    ]);
    if (controller.signal.aborted || hooks.get(id) !== hook || currentProfileId() !== hook.profile) throw new Error('Plugin unavailable');
    if (JSON.stringify(result ?? null).length > MAX_BYTES) throw new Error('Response too large');
    return result;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** The first registered source for the active profile, by plugin ID. Null hides the optional review section. */
function current(): ReviewSource | null {
  const profile = currentProfileId();
  if (snapshot.valid && snapshot.profile === profile) return snapshot.source;
  const entry = [...hooks].filter(([, hook]) => hook.profile === profile).sort(([a], [b]) => a.localeCompare(b))[0];
  const source = entry ? { id: entry[0], name: entry[1].name, request: (value: ReviewRequest, signal: AbortSignal) => request(entry[0], entry[1], value, signal) } : null;
  snapshot = { valid: true, profile, source };
  return source;
}

export function useReviewSource() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, current);
}
