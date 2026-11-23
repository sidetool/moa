import { useLayoutEffect, useRef, useState } from 'react';
import type { SubtitlePreference, SubtitleSelection, SubtitleTrack } from '@moa/shared';
import { api, currentProfileId } from '../../lib/api';

const choiceKey = (episodeId: string) => `moa.subtitleChoice:${JSON.stringify([currentProfileId(), episodeId])}`;
const choices = new Map<string, SubtitlePreference | null>();
const saves = new Map<string | null, Promise<void>>();
const revisions = new Map<string, number>();
export async function loadSubtitlePreference(episodeId: string, signal: AbortSignal, recommend = true) {
  const profile = currentProfileId(), key = choiceKey(episodeId);
  await saves.get(profile)?.catch(() => {});
  if (signal.aborted || currentProfileId() !== profile) return undefined;
  const revision = revisions.get(key);
  try {
    const result = await api<SubtitleSelection>(`/episodes/${encodeURIComponent(episodeId)}/subtitles/preference`, { signal });
    if (signal.aborted || currentProfileId() !== profile) return undefined;
    if (revisions.get(key) !== revision) return subtitlePreference(episodeId);
    if (!result) return subtitlePreference(episodeId);
    choices.delete(key);
    if (result.choice !== undefined) choices.set(key, result.choice);
    try { if (result.choice === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(result.choice)); } catch {}
    return result.choice !== undefined ? result.choice : recommend ? result.recommendation : undefined;
  } catch { return signal.aborted || currentProfileId() !== profile ? undefined : subtitlePreference(episodeId); }
}
export function subtitlePreference(episodeId: string): SubtitlePreference | null | undefined {
  const key = choiceKey(episodeId);
  if (choices.has(key)) return choices.get(key);
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const value = JSON.parse(raw);
    if (value === null) return null;
    return value && typeof value.id === 'string' && typeof value.episodeId === 'string' && typeof value.label === 'string' && ['vtt', 'ass'].includes(value.format) ? value : undefined;
  } catch { return undefined; }
}
export function rememberSubtitle(episodeId: string, track: SubtitleTrack | null, originEpisodeId?: string) {
  const previous = subtitlePreference(episodeId);
  const value = track ? { id: track.id, source: track.source, label: track.label, lang: track.lang, format: track.format, episodeId: originEpisodeId ?? (previous?.id === track.id ? previous.episodeId : episodeId) } : null;
  const key = choiceKey(episodeId);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  try { localStorage.setItem(key, JSON.stringify(value)); choices.delete(key); } catch { choices.set(key, value); }
  const profile = currentProfileId();
  const save = (saves.get(profile) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (currentProfileId() !== profile) return;
    await api(`/episodes/${encodeURIComponent(episodeId)}/subtitles/preference`, { method: 'PUT', body: { choice: value }, keepalive: true });
  });
  saves.set(profile, save);
  void save.finally(() => { if (saves.get(profile) === save) saves.delete(profile); }).catch(() => {});
  return save;
}
export function findSessionSubtitle(tracks: SubtitleTrack[], preference: Omit<SubtitlePreference, 'episodeId'>, sameEpisode = true): SubtitleTrack | null {
  const saved = ['upload', 'translation', 'online'].includes(preference.source ?? '');
  const matches = (track: SubtitleTrack) => track.source === preference.source && track.label === preference.label && track.lang === preference.lang && track.format === preference.format;
  const current = tracks.find(track => track.id === preference.id && (saved || matches(track)));
  if (current) return current;
  if (sameEpisode && !saved) {
    const matching = tracks.filter(matches);
    return matching.length === 1 ? matching[0] : null;
  }
  return null;
}
export async function restoreSubtitle(episodeId: string, tracks: SubtitleTrack[], preference: SubtitlePreference, signal: AbortSignal): Promise<SubtitleTrack | null> {
  const current = findSessionSubtitle(tracks, preference, preference.episodeId === episodeId);
  if (current) return current;
  if (preference.source !== 'upload' && preference.source !== 'translation') return null;
  const items = await api<SubtitleTrack[]>(`/episodes/${encodeURIComponent(preference.episodeId)}/subtitles/${preference.source === 'upload' ? 'uploads' : 'translations'}`, { signal });
  return items.find(track => track.id === preference.id) ?? null;
}

const key = (mediaId: string) => `moa.subtitlesOff:${JSON.stringify([currentProfileId(), mediaId])}`;
// Preserve the choice for this app session even when browser storage is unavailable.
const fallback = new Map<string, boolean>();
export function subtitlesOffForTitle(mediaId: string): boolean {
  const id = key(mediaId);
  if (fallback.has(id)) return fallback.get(id)!;
  try { return localStorage.getItem(id) === '1'; } catch { return fallback.get(id) ?? false; }
}
export function rememberSubtitlesOff(mediaId: string, off: boolean) {
  const id = key(mediaId);
  try {
    if (off) localStorage.setItem(id, '1'); else localStorage.removeItem(id);
    fallback.delete(id);
  } catch { fallback.set(id, off); }
}

function storedOffset(key: string): number | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw?.trim()) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(-600, Math.min(600, seconds)) : undefined;
  } catch { return undefined; }
}

export function useEpisodeSubtitleOffset(profile: string | null, episodeId: string) {
  const key = `moa.subtitleEpisodeOffset:${JSON.stringify([profile, episodeId])}`;
  const [seconds, setSeconds] = useState(() => storedOffset(key));
  const current = useRef(seconds);
  const [saveFailed, setSaveFailed] = useState(false);
  useLayoutEffect(() => {
    const read = () => {
      current.current = storedOffset(key);
      setSeconds(current.current);
      setSaveFailed(false);
    };
    const changed = (event: StorageEvent) => {
      // Read the latest value: another tab's queued event can predate this tab's edit.
      if (event.storageArea === localStorage && (event.key === null || event.key === key)) read();
    };
    window.addEventListener('storage', changed);
    read();
    return () => window.removeEventListener('storage', changed);
  }, [key]);

  const save = (value: number | undefined) => {
    current.current = value;
    setSeconds(value);
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
      setSaveFailed(false);
    } catch { setSaveFailed(true); }
  };
  return { seconds, current, save, saveFailed };
}
