import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Settings, ShortsCategory, ShortsFeed, ShortsItem, TranslationJob } from "@moa/shared";
import { api, currentProfileId } from "../lib/api";

export const SHORTS_CATEGORIES: Array<[ShortsCategory, string]> = [["movie", "영화"], ["series", "시리즈"], ["anime", "애니"]];
export const shortsCategories = (s?: Settings): ShortsCategory[] => {
  const picked = SHORTS_CATEGORIES.map(([value]) => value).filter(value => s?.shortsCategories?.includes(value));
  return picked.length ? picked : SHORTS_CATEGORIES.map(([value]) => value);
};
export const shortsAvailable = (s: Settings | undefined, kids: boolean | undefined) => s?.shortsEnabled === true && kids !== true;

const MAX_PAGES = 12; // the server pool is bounded; this only guards a misbehaving cursor

/** Feed pages keyed by everything that shapes them. Seen reports never invalidate it, so the open feed stays put. */
export const shortsFeedKey = (settings: Settings | undefined, replay: boolean) =>
  ["shorts", currentProfileId(), settings?.shortsMode ?? "mixed", settings?.shortsRepeatDays ?? 7, shortsCategories(settings).join(","), settings?.shortsHideWatched !== false, replay] as const;

export function useShortsFeed(settings: Settings | undefined, enabled: boolean, replay: boolean) {
  const key = shortsFeedKey(settings, replay);
  return useInfiniteQuery({
    queryKey: key,
    enabled,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api<ShortsFeed>(`/shorts?${new URLSearchParams({ ...(pageParam ? { cursor: pageParam } : {}), ...(replay ? { replay: "1" } : {}) })}`, { signal }),
    getNextPageParam: (last, pages) => last.status === "ready" && last.nextCursor && pages.length < MAX_PAGES ? last.nextCursor : undefined,
    staleTime: Infinity,
    gcTime: 0, // coming back starts a fresh feed that respects new views
    retry: false
  });
}

export function uniqueItems(pages: ShortsFeed[] | undefined): ShortsItem[] {
  const seen = new Set<string>(), items: ShortsItem[] = [];
  for (const page of pages ?? []) for (const item of page.items ?? []) if (!seen.has(item.key)) { seen.add(item.key); items.push(item); }
  return items;
}

const path = (key: string) => `/shorts/${encodeURIComponent(key)}`;
export const shortsTrailers = (key: string, signal: AbortSignal) => api<{ trailers: string[]; checked: boolean }>(`${path(key)}/trailers`, { signal });
export const markShortSeen = (key: string) => api<{ ok: true }>(`${path(key)}/seen`, { method: "POST", body: {}, keepalive: true });
/** Only for a person moving on from the work on screen; never for automatic transitions. */
export const markShortSkipped = (key: string) => api<{ ok: true }>(`${path(key)}/skip`, { method: "POST", body: {}, keepalive: true });

/** Experimental server-side trailer playback; the server answers only whether it is configured. */
export const useShortsNative = (enabled: boolean) => useQuery({
  queryKey: ["shorts-native"], enabled, staleTime: 60_000, retry: false,
  queryFn: ({ signal }) => api<{ available: boolean }>("/shorts/native", { signal })
});
export interface ShortsNativeSubtitle { id: string; label: string; lang: string; auto: boolean; url: string }
export interface ShortsNativeSession { sessionId: string; url: string; mime: "video/mp4" | "application/vnd.apple.mpegurl"; subtitles?: ShortsNativeSubtitle[] }
export const prepareShortNative = (key: string, signal: AbortSignal) => api<ShortsNativeSession>(`${path(key)}/native`, { method: "POST", body: {}, signal });
export const closeShortNative = (sessionId: string) => { api<{ ok: true }>(`/shorts/native/${encodeURIComponent(sessionId)}`, { method: "DELETE", keepalive: true }).catch(() => {}); };
const nativePath = (sessionId: string) => `/shorts/native/${encodeURIComponent(sessionId)}`;
/** Server-side warm-up of the first media for a prefetched lease; advisory only. */
export const warmShortNative = (sessionId: string, signal: AbortSignal) => api<{ ready: boolean }>(`${nativePath(sessionId)}/warm`, { method: "POST", body: {}, signal });
export const translateShortSubtitle = (sessionId: string, trackId: string, signal?: AbortSignal) =>
  api<TranslationJob>(`${nativePath(sessionId)}/subtitles/${encodeURIComponent(trackId)}/translate`, { method: "POST", body: {}, signal });
