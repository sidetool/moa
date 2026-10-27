import { api } from '../../lib/api';

let retiring: Promise<void> = Promise.resolve();
let preparing: Promise<void> = Promise.resolve();
const releases = new Map<string, Promise<void>>();
/** Wait for the preceding episode to release its APK slot before extracting the next one. */
export function preparePlayback<T>(create: () => Promise<T>) {
  // A cancelled POST can still acquire a server slot. Settle and release it before the next POST.
  const request = preparing.then(() => retiring).then(create);
  preparing = request.then(() => {}, () => {});
  return request;
}
export function retirePlayback(id: string, waitForRelease = false) {
  const existing = releases.get(id); if (existing) return existing;
  const request = api<void>(`/playback/${encodeURIComponent(id)}`, {
    method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(6000)
  }).catch(() => {}).finally(() => { releases.delete(id); });
  releases.set(id, request);
  if (waitForRelease) retiring = Promise.allSettled([retiring, request]).then(() => {});
  return request;
}
