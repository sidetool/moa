import { catalogReadOptions } from './catalog-refresh';
import { deviceSettingsPatch, loadDevicePrefs, saveDevicePrefs, useDevicePrefs, useTitleGrouping } from "../lib/device-prefs";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, HomeResponse, LibraryFolder, MediaCard, MediaDetail, MediaType, Page, Profile, ScanStatus, SearchGroup, Settings, HistoryEntry } from "@moa/shared";
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
  history: ["history"] as const,
  folders: ["library-folders"] as const,
  scan: ["library-scan"] as const,
  settings: ["settings"] as const
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Account>('/me'), retry: false });

export const useProfiles = () => useQuery({ queryKey: keys.profiles, queryFn: () => api<Profile[]>("/profiles") });

export const useHome = (type?: MediaType, providers?: string[], personalScope: "tab" | "all" = "tab") => {
  const titleGrouping = useTitleGrouping();
  return useQuery({ ...catalogReadOptions, queryKey: [...keys.home(type), providers, personalScope, titleGrouping], queryFn: ({ signal }) => api<HomeResponse>(`/home?${new URLSearchParams({ continueScope: personalScope, watchlistScope: personalScope, titleGrouping: String(titleGrouping), ...(type ? { type } : {}), ...(providers ? { providers: providers.join(",") } : {}) })}`, { signal }) });
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
  useQuery({ queryKey: keys.scan, queryFn: () => api<ScanStatus>("/library/status"), refetchInterval: poll ? 1500 : false });
export const useSettings = () => {
  const device = useDevicePrefs();
  const result = useQuery({ queryKey: keys.settings, queryFn: async ({ signal }) => {
    const profile = currentProfileId();
    const settings = await api<Settings>('/settings', { signal });
    if (settings && currentProfileId() === profile) await loadDevicePrefs(settings, signal);
    return settings;
  } });
  return { ...result, data: result.data ? { ...result.data, ...deviceSettingsPatch(device),
    // Legacy explicit "off" survives; the old shared default "on" must not crop every desktop.
    shortsScreenFit: device.shortsScreenFit ?? (result.data.shortsScreenFit !== false && typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches)
  } as Settings : result.data };
};

const settingsSaves = new Map<string | null, Promise<void>>();
export function useSaveSettings() {
  const client = useQueryClient();
  return (patch: Partial<Settings>) => {
    const device = deviceSettingsPatch(patch);
    const deviceSave = Object.keys(device).length ? saveDevicePrefs(device) : Promise.resolve();
    patch = Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in device)));
    if (!Object.keys(patch).length) return deviceSave;
    const profile = currentProfileId();
    client.setQueryData<Settings>(keys.settings, old => old ? { ...old, ...patch } : old);
    const save = (settingsSaves.get(profile) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (currentProfileId() !== profile) return;
      const saved = await api<Settings>('/settings', { method: 'PATCH', body: patch, keepalive: true });
      if (settingsSaves.get(profile) === save && currentProfileId() === profile) client.setQueryData(keys.settings, saved);
    });
    settingsSaves.set(profile, save);
    void save.finally(() => {
      if (settingsSaves.get(profile) !== save) return;
      settingsSaves.delete(profile);
      if (currentProfileId() === profile) void client.invalidateQueries({ queryKey: keys.settings });
    }).catch(() => {});
    return Promise.all([save, deviceSave]).then(() => {});
  };
}

interface GroupWatchlistState { grouped: boolean; inWatchlist: boolean }
const groupWatchlistKey = (id: string, savedEdition: string | null) => [...keys.watchlist, currentProfileId(), "group", id, savedEdition] as const;
const groupWatchlistPath = (id: string, savedEdition: string) =>
  `/watchlist/${encodeURIComponent(id)}/group?savedEdition=${encodeURIComponent(savedEdition)}`;

export function useGroupWatchlist(id: string, savedEdition: string | null) {
  return useQuery({ queryKey: groupWatchlistKey(id, savedEdition), enabled: Boolean(savedEdition), retry: false,
    queryFn: ({ signal }) => api<GroupWatchlistState>(groupWatchlistPath(id, savedEdition!), { signal }) });
}

/** Optimistic watchlist toggle; card and detail caches update immediately. */
export function useWatchlistToggle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, add, savedEdition }: { id: string; add: boolean; savedEdition?: string }) => api<void>(
      savedEdition ? groupWatchlistPath(id, savedEdition) : `/watchlist/${encodeURIComponent(id)}`, { method: add ? "PUT" : "DELETE" }),
    onMutate: ({ id, add, savedEdition }) => {
      if (savedEdition) return groupWatchlistKey(id, savedEdition);
      client.setQueryData<MediaDetail>(keys.media(id), old => (old ? { ...old, inWatchlist: add } : old));
    },
    onSuccess: (_data, { add }, groupKey) => {
      if (groupKey) client.setQueryData<GroupWatchlistState>(groupKey, { grouped: true, inWatchlist: add });
    },
    onSettled: (_data, _error, { id, savedEdition }) => {
      void client.invalidateQueries({ queryKey: savedEdition ? ["media"] : keys.media(id) });
      void client.invalidateQueries({ queryKey: keys.watchlist });
      void client.invalidateQueries({ queryKey: ["recommendations"] });
      // Mark cached feeds stale, but never reorder the Shorts currently playing.
      void client.invalidateQueries({ queryKey: ["shorts"], refetchType: "none" });
      void client.invalidateQueries({ queryKey: ["home"] });
    }
  });
}
