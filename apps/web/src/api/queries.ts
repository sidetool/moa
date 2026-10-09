import { useTitleGrouping } from "../lib/device-prefs";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, HomeResponse, LibraryFolder, MediaCard, MediaDetail, MediaType, Page, Profile, ScanStatus, SearchGroup, Settings, HistoryEntry } from "@moa/shared";
import { api, currentProfileId } from "../lib/api";

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

export const useHome = (type?: MediaType, providers?: string[], continueScope: "tab" | "all" = "tab") => {
  const titleGrouping = useTitleGrouping();
  return useQuery({ queryKey: [...keys.home(type), providers, continueScope, titleGrouping], queryFn: ({ signal }) => api<HomeResponse>(`/home?${new URLSearchParams({ continueScope, titleGrouping: String(titleGrouping), ...(type ? { type } : {}), ...(providers ? { providers: providers.join(",") } : {}) })}`, { signal }) });
};

export const useMedia = (id: string) =>
  useQuery({ queryKey: keys.media(id), queryFn: ({ signal }) => api<MediaDetail>(`/media/${encodeURIComponent(id)}`, { signal }), enabled: id !== "" });

export const useMediaList = (params: { type?: MediaType; provider?: string; genre?: string; sort?: string }) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return useInfiniteQuery({ queryKey: keys.list(params), initialPageParam: 1, queryFn: ({ pageParam, signal }) => api<Page<MediaCard>>(`/media?${query}&page=${pageParam}`, { signal }), getNextPageParam: last => last.hasNextPage ? last.page + 1 : undefined, retry: false });
};

export const useGenres = (type?: MediaType) =>
  useQuery({ queryKey: keys.genres(type), queryFn: () => api<string[]>(`/genres${type ? `?type=${type}` : ""}`), staleTime: 5 * 60_000 });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) => api<{ query: string; groups: SearchGroup[] }>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.trim().length > 0,
  });

export const useWatchlist = () => useQuery({ queryKey: keys.watchlist, queryFn: () => api<MediaCard[]>("/watchlist") });
export const useHistory = () => useQuery({ queryKey: keys.history, queryFn: () => api<Page<HistoryEntry>>("/history") });
export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: () => api<LibraryFolder[]>("/library/folders") });
export const useScanStatus = (poll: boolean) =>
  useQuery({ queryKey: keys.scan, queryFn: () => api<ScanStatus>("/library/status"), refetchInterval: poll ? 1500 : false });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: async ({ signal }) => {
  const profile = currentProfileId(), settings = await api<Settings>('/settings', { signal });
  if (!settings || settings.subtitleBackground !== undefined || settings.subtitleHeight !== undefined || settings.subtitleScale !== undefined || settings.subtitleOutline !== undefined || settings.subtitleShadow !== undefined || settings.subtitlePadding !== undefined) return settings;
  try {
    const old = JSON.parse(localStorage.getItem('moa.subtitleAppearance') || 'null'), height = localStorage.getItem('moa.subtitleHeight');
    if (!old && height === null || currentProfileId() !== profile || signal.aborted) return settings;
    const patch: Partial<Settings> = { subtitleBackground: 'original' };
    if (old && ['small', 'medium', 'large', 'xlarge'].includes(old.size) && ['original', 'none', 'soft', 'solid'].includes(old.background)) {
      patch.subtitleSize = old.size; patch.subtitleBackground = old.background;
      patch.subtitleShadow = ({ none: 0, soft: 2, strong: 4 } as Record<string, number>)[old.shadow] ?? null;
      patch.subtitleOutline = ({ none: 0, thin: 1, thick: 3 } as Record<string, number>)[old.outline] ?? null;
    }
    if (height !== null && Number.isFinite(Number(height))) patch.subtitleHeight = Math.max(0, Math.min(40, Number(height)));
    return await api<Settings>('/settings', { method: 'PATCH', body: patch, signal });
  } catch { return settings; }
} });

const settingsSaves = new Map<string | null, Promise<void>>();
export function useSaveSettings() {
  const client = useQueryClient();
  return (patch: Partial<Settings>) => {
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
    return save;
  };
}

/** Optimistic watchlist toggle; card and detail caches update immediately. */
export function useWatchlistToggle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, add }: { id: string; add: boolean }) => api<void>(`/watchlist/${encodeURIComponent(id)}`, { method: add ? "PUT" : "DELETE" }),
    onMutate: async ({ id, add }) => {
      client.setQueryData<MediaDetail>(keys.media(id), old => (old ? { ...old, inWatchlist: add } : old));
    },
    onSettled: (_data, _error, { id }) => {
      void client.invalidateQueries({ queryKey: keys.media(id) });
      void client.invalidateQueries({ queryKey: keys.watchlist });
      void client.invalidateQueries({ queryKey: ["home"] });
    }
  });
}
