import { recommendationsKey } from './recommendations';
import { catalogReadOptions } from './catalog-refresh';
import { deviceSettingsPatch, loadDevicePrefs, saveDevicePrefs, useDevicePrefs, useTitleGrouping, type DevicePrefs } from "../lib/device-prefs";
import { useInfiniteQuery, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Account, HomeResponse, LibraryFolder, MediaCard, MediaDetail, MediaType, Page, Profile, ScanStatus, SearchGroup, Settings, HistoryEntry } from "@moa/shared";
import { useState } from "react";
import { api, ApiError, currentProfileId } from "../lib/api";

export const keys = {
  me: ["me"] as const,
  profiles: ["profiles"] as const,
  home: (type?: MediaType) => ["home", type ?? "all"] as const,
  media: (id: string) => ["media", id] as const,
  list: (params: Record<string, string | number | undefined>) => ["media-list", params] as const,
  genres: (type?: MediaType) => ["genres", type ?? "all"] as const,
  search: (q: string) => ["search", q] as const,
  watchlist: ["watchlist"] as const,
  shortsWatchlist: (profile = currentProfileId()) => ["watchlist", profile, "shorts"] as const,
  history: ["history"] as const,
  folders: ["library-folders"] as const,
  scan: ["library-scan"] as const,
  saveSettings: (profile = currentProfileId()) => ["save-settings", profile] as const,
  settings: (profile = currentProfileId()) => ["settings", profile] as const
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Account>('/me'), retry: false });

export const useProfiles = () => useQuery({ queryKey: keys.profiles, queryFn: () => api<Profile[]>("/profiles") });

export const useHome = (type?: MediaType, providers?: string[], personalScope: "tab" | "all" = "tab") => {
  const titleGrouping = useTitleGrouping();
  const profile = currentProfileId();
  return useQuery({ ...catalogReadOptions, queryKey: [...keys.home(type), profile, providers, personalScope, titleGrouping],
    refetchOnWindowFocus: true, queryFn: ({ signal }) => {
      if (currentProfileId() !== profile) throw new DOMException('Profile changed', 'AbortError');
      return api<HomeResponse>(`/home?${new URLSearchParams({ continueScope: personalScope, watchlistScope: personalScope, titleGrouping: String(titleGrouping), ...(type ? { type } : {}), ...(providers ? { providers: providers.join(",") } : {}) })}`, { signal });
    } });
};

export const useMedia = (id: string) => {
  const query = useQuery({ ...catalogReadOptions, retry:false, queryKey: keys.media(id), queryFn: ({ signal }) => api<MediaDetail>(`/media/${encodeURIComponent(id)}`, { signal }), enabled: id !== "" });
  const denied = query.error instanceof ApiError && ([401,403,404].includes(query.error.status) || query.error.code === 'source-removing');
  return denied ? { ...query, data: undefined } : query;
};

export const useMediaList = (params: { type?: MediaType; provider?: string; genre?: string; sort?: string }) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return useInfiniteQuery({ ...catalogReadOptions, queryKey: keys.list(params), initialPageParam: 1, queryFn: ({ pageParam, signal }) => api<Page<MediaCard>>(`/media?${query}&page=${pageParam}`, { signal }), getNextPageParam: last => last.hasNextPage ? last.page + 1 : undefined, retry: false });
};

export const useGenres = (type?: MediaType) =>
  useQuery({ queryKey: keys.genres(type), queryFn: () => api<string[]>(`/genres${type ? `?type=${type}` : ""}`), staleTime: 5 * 60_000 });

export const useSearch = (q: string) =>
  useQuery({
    ...catalogReadOptions,
    queryKey: [...keys.search(q), currentProfileId()],
    queryFn: ({ signal }) => api<{ query: string; groups: SearchGroup[] }>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.trim().length > 0,
  });

export const useWatchlist = (sort: "saved" | "updated" = "saved") => {
  const profile = currentProfileId();
  return useQuery({
    queryKey: [...keys.watchlist, profile, sort],
    queryFn: ({ signal }) => api<MediaCard[]>(`/watchlist?sort=${sort}`, { signal }),
    placeholderData: (previous, query) => query?.queryKey[1] === profile ? previous : undefined,
    refetchOnMount: "always",
  });
};
interface HistoryPageParam { page: number; groupHistory?: boolean }
export const useHistory = () => useInfiniteQuery({
  queryKey: [...keys.history, currentProfileId()],
  initialPageParam: { page: 1 } as HistoryPageParam,
  queryFn: ({ pageParam, signal }) => {
    const params = new URLSearchParams({ page: String(pageParam.page) });
    if (pageParam.groupHistory !== undefined) params.set("groupHistory", String(pageParam.groupHistory));
    return api<Page<HistoryEntry>>(`/history?${params}`, { signal });
  },
  // Page one uses the profile's saved preference. Pin later pages to the view already on screen.
  getNextPageParam: (last, [first]) => last.hasNextPage ? { page: last.page + 1, groupHistory: first.items[0]?.groupedCount !== undefined } : undefined,
  retry: false,
});
export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: () => api<LibraryFolder[]>("/library/folders") });
export const useScanStatus = (poll: boolean) =>
  useQuery({ queryKey: keys.scan, queryFn: ({ signal }) => api<ScanStatus>("/library/status", { signal }),
    refetchInterval: query => poll || query.state.data?.running ? 1500 : false });
export const useSettings = () => {
  const device = useDevicePrefs();
  const profile = currentProfileId();
  const pending = useMutationState({
    filters: { mutationKey: ['save-settings'], status: 'pending' },
    select: mutation => ({ profile: mutation.options.mutationKey?.[1], patch: mutation.state.variables as Partial<Settings> }),
  });
  const optimistic: Partial<Settings> = Object.assign({}, ...pending.filter(item => item.profile === profile).map(item => item.patch));
  // Recording a resume scene requires a confirmed preference.
  delete optimistic.showResumeScene;
  // The feed checks the server-side enable flag on its first request.
  delete optimistic.shortsEnabled;
  const result = useQuery({ queryKey: keys.settings(profile), refetchOnWindowFocus: true, queryFn: async ({ signal }) => {
    if (currentProfileId() !== profile) throw new DOMException('Profile changed', 'AbortError');
    const settings = await api<Settings>('/settings', { signal });
    if (settings && currentProfileId() === profile) await loadDevicePrefs(settings, signal);
    return settings;
  } });
  return { ...result, data: result.data ? { ...result.data, ...optimistic, ...deviceSettingsPatch(device),
    // Legacy explicit "off" survives; the old shared default "on" must not crop every desktop.
    shortsScreenFit: device.shortsScreenFit ?? (result.data.shortsScreenFit !== false && typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches)
  } as Settings : result.data };
};

const scenePreferenceKey = (profile: string) => `moa.showResumeScene:${profile}`;

// Signal a confirmed server change to other tabs, including players paused in the background.
export function listenForScenePreference(client: QueryClient) {
  const receive = (event: StorageEvent) => {
    const profile = currentProfileId();
    if (!profile || event.key !== scenePreferenceKey(profile) || (event.newValue !== 'true' && event.newValue !== 'false')) return;
    const key = keys.settings(profile);
    // Invalidation alone would reuse an in-flight initial GET taken before the change.
    if (!client.getQueryData(key)) void client.cancelQueries({ queryKey: key });
    client.setQueryData<Settings>(key, old => old && { ...old, showResumeScene: event.newValue === 'true' });
    void client.invalidateQueries({ queryKey: key });
  };
  window.addEventListener('storage', receive);
  return () => window.removeEventListener('storage', receive);
}

export type SettingsPatch = Partial<Settings> & Partial<Omit<DevicePrefs, 'shortsScreenFit'>>;

export function useSaveSettings() {
  const client = useQueryClient();
  const profile = currentProfileId();
  const key = keys.settings(profile);
  const mutationKey = keys.saveSettings(profile);
  const save = useMutation({
    mutationKey,
    scope: { id: JSON.stringify(mutationKey) },
    networkMode: 'always',
    mutationFn: (patch: Partial<Settings>) => {
      if (currentProfileId() !== profile) throw new DOMException('Profile changed', 'AbortError');
      return api<Settings>('/settings', { method: 'PATCH', body: patch, keepalive: true });
    },
    onSuccess: (saved, patch) => {
      if (currentProfileId() !== profile) return;
      // Older responses can include stale values for fields changed in another tab.
      void client.cancelQueries({ queryKey: key, exact: true }, { revert: false });
      const confirmed = Object.fromEntries(Object.entries(saved).filter(([name]) => Object.hasOwn(patch, name)));
      client.setQueryData<Settings>(key, old => old ? { ...old, ...confirmed } : saved);
      if (patch.groupHistory !== undefined) void client.invalidateQueries({ queryKey: keys.history });
      if (patch.recommendationsEnabled !== undefined || patch.anilistRecommendationsEnabled !== undefined)
        void client.invalidateQueries({ queryKey: recommendationsKey });
      if (patch.showResumeScene !== undefined && profile) {
        try {
          localStorage.setItem(scenePreferenceKey(profile), String(saved.showResumeScene));
          localStorage.removeItem(scenePreferenceKey(profile));
        } catch { /* Other tabs can still refetch when focused. */ }
      }
    },
    onSettled: () => {
      if (currentProfileId() === profile && client.isMutating({ mutationKey }) === 1)
        void client.invalidateQueries({ queryKey: key });
    },
  });
  return (patch: SettingsPatch) => {
    if (currentProfileId() !== profile) return Promise.reject(new DOMException('Profile changed', 'AbortError'));
    const device = deviceSettingsPatch(patch);
    const deviceSave = Object.keys(device).length ? saveDevicePrefs(device) : Promise.resolve();
    const shared = Object.fromEntries(Object.entries(patch).filter(([name]) => !(name in device)));
    if (!Object.keys(shared).length) return deviceSave;
    return Promise.all([save.mutateAsync(shared), deviceSave]).then(() => {});
  };
}

export type WatchlistFailure = { add: boolean; groupChanged: boolean };
export const watchlistFailureText = (failure: WatchlistFailure) => failure.groupChanged
  ? "작품 묶음이 바뀌어 내 목록을 바꾸지 못했어요."
  : `내 목록${failure.add ? "에 추가하지" : "에서 빼지"} 못했어요.`;

/** A watchlist button keeps its add/remove role. Transient errors retry quietly; a final failure is
 *  reported beside the button, which falls back to the confirmed state. The report belongs to the view
 *  it was made in (profile, title and the page's saved edition), not to the write target: a 409 that
 *  splits the group moves the toggle to another key, yet the same page keeps its report. */
export function useWatchlistChange(id: string, confirmed: boolean, savedEdition?: string, view: string | null = null) {
  const toggle = useWatchlistToggle(id, savedEdition);
  const scope = JSON.stringify([currentProfileId(), id, view]);
  const [failure, setFailure] = useState<(WatchlistFailure & { scope: string }) | null>(null);
  const pending = toggle.isPending;
  // Another view drops the report. So does the first read showing the requested state after all,
  // so that a later change from elsewhere cannot bring the old note back.
  if (failure && (failure.scope !== scope || (!pending && failure.add === confirmed))) setFailure(null);
  const change = (add: boolean) => {
    if (pending) return;
    setFailure(null);
    toggle.mutate(add, { onError: error => setFailure({ add, groupChanged: error instanceof ApiError && error.code === "watchlist-group-changed", scope }) });
  };
  const current = !pending && failure && failure.scope === scope && failure.add !== confirmed ? failure : null;
  return {
    saved: pending ? toggle.variables : confirmed,
    pending,
    change,
    failure: current && { add: current.add, groupChanged: current.groupChanged }
  };
}

interface GroupWatchlistState { grouped: boolean; inWatchlist: boolean }
const groupWatchlistKey = (id: string, savedEdition: string | null) => [...keys.watchlist, currentProfileId(), "group", id, savedEdition] as const;
const groupWatchlistPath = (id: string, savedEdition: string) =>
  `/watchlist/${encodeURIComponent(id)}/group?savedEdition=${encodeURIComponent(savedEdition)}`;

export function useGroupWatchlist(id: string, savedEdition: string | null) {
  // Reading the saved group recovers from the same transient failures as writing to it.
  return useQuery({ queryKey: groupWatchlistKey(id, savedEdition), enabled: Boolean(savedEdition),
    retry: (failures, error) => failures < WATCHLIST_RETRY_DELAYS.length && transientWatchlistError(error),
    retryDelay: failures => WATCHLIST_RETRY_DELAYS[failures] ?? 1500,
    queryFn: ({ signal }) => api<GroupWatchlistState>(groupWatchlistPath(id, savedEdition!), { signal }) });
}

// Lost connections and server hiccups are worth a couple of quiet attempts. Watchlist writes are
// idempotent, so repeating one cannot double-apply. A changed group (409) or other refusal is final.
const WATCHLIST_RETRY_DELAYS = [600, 1500];
const transientWatchlistError = (error: unknown) =>
  error instanceof ApiError ? error.status === 408 || error.status === 429 || error.status >= 500
    : error instanceof TypeError;

/** Show the requested state in the acting control while the server confirms the change. */
export function useWatchlistToggle(id: string, savedEdition?: string) {
  const client = useQueryClient();
  const profile = currentProfileId();
  const mutationKey = ['toggle-watchlist', profile, id, savedEdition ?? null];
  return useMutation({
    mutationKey,
    networkMode: 'always',
    scope: { id: JSON.stringify(mutationKey) },
    retry: (failures, error) => failures < WATCHLIST_RETRY_DELAYS.length && profile === currentProfileId() && transientWatchlistError(error),
    retryDelay: failures => WATCHLIST_RETRY_DELAYS[failures] ?? 1500,
    mutationFn: (add: boolean) => {
      if (profile !== currentProfileId()) throw new DOMException('Profile changed', 'AbortError');
      return api<void>(savedEdition ? groupWatchlistPath(id, savedEdition) : `/watchlist/${encodeURIComponent(id)}`, { method: add ? "PUT" : "DELETE" });
    },
    onSuccess: (_data, add) => {
      if (profile !== currentProfileId()) return;
      if (savedEdition) client.setQueryData<GroupWatchlistState>(groupWatchlistKey(id, savedEdition), { grouped: true, inWatchlist: add });
      else {
        client.setQueryData<MediaDetail>(keys.media(id), old => old && { ...old, inWatchlist: add });
        client.setQueryData<string[]>(keys.shortsWatchlist(profile), old => {
          if (!old || old.includes(id) === add) return old;
          return add ? [...old, id] : old.filter(saved => saved !== id);
        });
      }
    },
    onSettled: () => {
      if (profile !== currentProfileId()) return;
      void client.invalidateQueries({ queryKey: recommendationsKey });
      // Mark cached feeds stale, but never reorder the Shorts currently playing.
      void client.invalidateQueries({ queryKey: ["shorts"], refetchType: "none" });
      void client.invalidateQueries({ queryKey: ["home"] });
      void client.invalidateQueries({ queryKey: savedEdition ? ["media"] : keys.media(id) });
      void client.invalidateQueries({ queryKey: [...keys.watchlist, profile] });
    }
  });
}
