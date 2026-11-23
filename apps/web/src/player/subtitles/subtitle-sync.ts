import type { PlaybackSession, SubtitleTrack } from '@moa/shared';
import { readTrack } from '../translation/subtitle-translation';
import type { Alignment, SubtitleTimingStep } from './subtitle-timing';
import { isKorean } from './subtitle-language';

export type RenderAlignment = Alignment & { step?: SubtitleTimingStep; blob?: Blob };
const empty = (): Alignment => ({ status: 'uncertain', offsetSeconds: 0, match: 0 });
// A new playback session must compare its own files, even when both track URLs are reused.
const sessions = new WeakMap<PlaybackSession, Map<string, RenderAlignment>>();

// Extension and online subtitle URLs normally point to the player's same-origin proxy.
function sameOriginTrack(track: SubtitleTrack): boolean {
  if (!track.url?.trim()) return false;
  try { return new URL(track.url, location.href).origin === location.origin; }
  catch { return false; }
}

/** Online Korean subtitles only. Translated tracks already inherit their original timings. */
export function subtitleAlignmentReference(target: SubtitleTrack, session: PlaybackSession): SubtitleTrack | undefined {
  if (target.source !== 'online' || !isKorean(target) || !sameOriginTrack(target)) return undefined;
  const originals = session.subtitles.filter(track => !/(?:forced|signs?|songs?|karaoke|가사|간판)/i.test(track.label) && sameOriginTrack(track));
  return originals.find(track => track.id !== target.id && ['embedded', 'local', 'extension'].includes(track.source || '') &&
    /^(?:en|eng|ja|jpn|jp)(?:-|$)/i.test(track.lang || ''))
    ?? originals.find(track => track.id !== target.id && !track.provenance && track.source !== 'online' && track.source !== 'translation' &&
      /english|japanese|日本語|영어|일본어/i.test(track.label));
}

export async function checkSubtitleAlignment(target: SubtitleTrack, session: PlaybackSession, signal: AbortSignal, segmented = false): Promise<RenderAlignment> {
  if (signal.aborted) return empty();
  const reference = subtitleAlignmentReference(target, session);
  if (!reference) return empty();
  const stop = new AbortController(), abort = () => stop.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 5000);
  let worker: Worker | undefined;
  try {
    let cache = sessions.get(session);
    if (!cache) { cache = new Map(); sessions.set(session, cache); }
    const key = JSON.stringify([target.id, target.url, target.format, reference.id, reference.url, segmented]);
    const cached = cache.get(key);
    if (cached) return cached;
    const [candidate, original] = await Promise.all([readTrack(target, stop.signal), readTrack(reference, stop.signal)]);
    stop.signal.throwIfAborted();
    worker = new Worker(new URL('./subtitle-sync-worker.ts', import.meta.url), { type: 'module' });
    const result = await new Promise<RenderAlignment>((resolve, reject) => {
      const fail = () => reject(new Error('sync-cancelled'));
      stop.signal.addEventListener('abort', fail, { once: true });
      worker!.onmessage = event => { stop.signal.removeEventListener('abort', fail); resolve(event.data); };
      worker!.onerror = () => { stop.signal.removeEventListener('abort', fail); reject(new Error('sync-worker')); };
      worker!.postMessage({ candidate: candidate.content, reference: original.content, format: target.format, segmented });
    });
    stop.signal.throwIfAborted();
    cache.set(key, result);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return result;
  } catch {
    return empty();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    stop.abort();
    worker?.terminate();
  }
}
