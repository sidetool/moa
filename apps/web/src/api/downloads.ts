import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DownloadChoice, DownloadJob, DownloadState, DownloadStatus, EpisodeDownloadStatus } from "@moa/shared";
import { api, ApiError } from "../lib/api";

export const downloadKeys = {
  admin: ["admin-downloads"] as const,
  episode: (id: string) => ["episode-download", id] as const
};

export const ACTIVE_DOWNLOAD: DownloadState[] = ["queued", "resolving", "downloading", "finalizing"];
export const RETRYABLE_DOWNLOAD: DownloadState[] = ["failed", "cancelled", "interrupted"];
export const DOWNLOAD_STATE_LABEL: Record<DownloadState, string> = {
  queued: "대기 중", resolving: "영상 확인 중", downloading: "저장 중", finalizing: "마무리 중",
  ready: "저장됨", failed: "실패", cancelled: "취소됨", interrupted: "중단됨"
};
export const GIB = 1024 ** 3;

const DOWNLOAD_ERROR_TEXT: Record<string, string> = {
  "download-subtitles-incomplete": "영상은 저장됐지만 일부 자막·트랙은 받지 못했어요.",
  "download-quota-exceeded": "저장 한도를 넘어요. 한도를 늘리거나 저장본을 정리해 주세요.",
  "download-space-low": "서버 디스크 여유 공간이 부족해요.",
  "download-auth-expired": "소스 인증이 만료됐어요. 다시 시도하면 영상 주소를 새로 받아요.",
  "download-selection-changed": "소스의 영상 목록이 바뀌었어요. 다시 골라 주세요.",
  "download-file-missing": "저장 파일을 찾을 수 없어요.",
  "download-disabled": "서버에서 새 영상 저장을 꺼 두었어요. 저장본은 계속 볼 수 있어요.",
  "download-quota-unconfigured": "저장 한도를 먼저 설정해 주세요.",
  "download-storage-unconfigured": "서버에 저장 폴더가 설정되지 않았어요.",
  "download-storage-overlap": "저장 폴더는 미디어·데이터 폴더와 분리해 주세요.",
  "download-storage-unavailable": "저장 폴더를 사용할 수 없어요.",
  "download-interrupted": "서버가 다시 시작돼 중단됐어요.",
  "download-cancelled": "취소했어요.",
  "download-drm-unsupported": "DRM으로 보호된 영상이라 저장할 수 없어요.",
  "download-live-unsupported": "라이브 방송은 저장할 수 없어요.",
  "download-stream-unsupported": "이 영상 형식은 저장을 지원하지 않아요. 재생은 그대로 할 수 있어요.",
  "download-hls-unsupported": "이 HLS 스트림은 저장을 지원하지 않아요. 재생은 그대로 할 수 있어요.",
  "download-duration-mismatch": "받은 영상 길이가 맞지 않아 저장하지 않았어요.",
  "download-failed": "저장하지 못했어요."
};
/** Server error codes as short Korean; unknown codes get a generic line instead of the raw code. */
export const downloadErrorText = (code: string | null | undefined) => !code ? null : DOWNLOAD_ERROR_TEXT[code] ?? "저장하지 못했어요. 다시 시도해 주세요.";

/** Admin list, paged by the server (newest first). Loaded pages are refetched together, so polling and
 *  mutations also drop removed rows from older pages. `mediaId` narrows the list to one title. */
const MAX_AUTO_PAGES = 50;

/** `loadAll` keeps following the cursor (bounded) for screens that must know every status, e.g. one title. */
export function useDownloadStatus(enabled = true, mediaId?: string, loadAll = false) {
  const query = useInfiniteQuery({
    queryKey: [...downloadKeys.admin, mediaId ?? "all"],
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      if (mediaId) params.set("mediaId", mediaId);
      return api<DownloadStatus>(`/admin/downloads${params.size ? `?${params}` : ""}`, { signal });
    },
    initialPageParam: "",
    getNextPageParam: last => last.nextCursor || undefined,
    enabled,
    retry: false,
    refetchInterval: query => query.state.data?.pages.some(page => page.jobs.some(job => ACTIVE_DOWNLOAD.includes(job.state))) ? 2000 : false
  });
  const pages = query.data?.pages;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (loadAll && enabled && hasNextPage && !isFetchingNextPage && !isFetchNextPageError && (pages?.length ?? 0) < MAX_AUTO_PAGES) void fetchNextPage();
  }, [loadAll, enabled, hasNextPage, isFetchingNextPage, isFetchNextPageError, pages?.length, fetchNextPage]);
  const data = useMemo(() => {
    if (!pages?.length) return undefined;
    const seen = new Set<string>(), jobs: DownloadJob[] = [];
    for (const job of pages.flatMap(page => page.jobs)) if (!seen.has(job.id)) { seen.add(job.id); jobs.push(job); }
    const first = pages[0];
    return { ...first, reason: downloadErrorText(first.reason), jobs, totalJobs: first.totalJobs ?? jobs.length };
  }, [pages]);
  return { data, isPending: query.isPending, refetch: query.refetch, fetchNextPage: query.fetchNextPage, hasNextPage: query.hasNextPage, isFetchingNextPage: query.isFetchingNextPage, isFetchNextPageError: query.isFetchNextPageError };
}

/** Whether a saved copy exists for any viewer allowed to play the episode. */
export const useEpisodeDownload = (episodeId: string, enabled = true) => useQuery({
  queryKey: downloadKeys.episode(episodeId),
  queryFn: ({ signal }) => api<EpisodeDownloadStatus>(`/episodes/${encodeURIComponent(episodeId)}/download`, { signal }),
  enabled: enabled && episodeId !== "",
  retry: false
});

/** The newest job per episode, preferring a ready copy over older failures. */
export function jobsByEpisode(jobs: DownloadJob[] = []) {
  const map = new Map<string, DownloadJob>();
  for (const job of jobs) {
    const current = map.get(job.episodeId);
    const rank = (item: DownloadJob) => ACTIVE_DOWNLOAD.includes(item.state) ? 2 : item.state === "ready" ? 1 : 0;
    if (!current || rank(job) > rank(current) || (rank(job) === rank(current) && job.updatedAt > current.updatedAt)) map.set(job.episodeId, job);
  }
  return map;
}

export const downloadRatio = (job: DownloadJob) => job.totalBytes ? Math.min(1, job.bytes / job.totalBytes) : null;

export const fetchDownloadChoices = (episodeId: string, signal?: AbortSignal) =>
  api<{ choices: DownloadChoice[]; selectionToken: string }>(`/admin/downloads/choices?episodeId=${encodeURIComponent(episodeId)}`, { signal });

export type RemoveResult = { removed: DownloadJob[]; failed: Array<{ job: DownloadJob; inUse: boolean }> };

/** Deletes one at a time so each saved copy keeps the server's in-use protection; failures stay listed. */
export function useRemoveDownloads() {
  const client = useQueryClient();
  return async (jobs: DownloadJob[], onProgress: (done: number) => void): Promise<RemoveResult> => {
    const result: RemoveResult = { removed: [], failed: [] };
    try {
      for (const [index, job] of jobs.entries()) {
        try { await api<void>(`/admin/downloads/${encodeURIComponent(job.id)}`, { method: "DELETE" }); result.removed.push(job); }
        catch (cause) {
          if (cause instanceof ApiError && cause.status === 404) result.removed.push(job); // already gone
          else result.failed.push({ job, inUse: cause instanceof ApiError && cause.status === 409 });
        }
        onProgress(index + 1);
      }
    } finally {
      void client.invalidateQueries({ queryKey: downloadKeys.admin });
      for (const episodeId of new Set(jobs.map(job => job.episodeId))) void client.invalidateQueries({ queryKey: downloadKeys.episode(episodeId) });
    }
    return result;
  };
}

export function useDownloadActions() {
  const client = useQueryClient();
  const refresh = (episodeId?: string) => {
    void client.invalidateQueries({ queryKey: downloadKeys.admin });
    if (episodeId) void client.invalidateQueries({ queryKey: downloadKeys.episode(episodeId) });
  };
  const run = async <T,>(promise: Promise<T>, episodeId?: string) => { try { return await promise; } finally { refresh(episodeId); } };
  return {
    start: (episodeId: string, selectionToken: string, choiceId: string) => run(api<DownloadJob>("/admin/downloads", { method: "POST", body: { episodeId, selectionToken, choiceId } }), episodeId),
    cancel: (job: DownloadJob) => run(api<DownloadJob>(`/admin/downloads/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }), job.episodeId),
    retry: (job: DownloadJob) => run(api<DownloadJob>(`/admin/downloads/${encodeURIComponent(job.id)}/retry`, { method: "POST" }), job.episodeId),
    remove: (job: DownloadJob) => run(api<void>(`/admin/downloads/${encodeURIComponent(job.id)}`, { method: "DELETE" }), job.episodeId),
    setQuota: (quotaBytes: number) => run(api<DownloadStatus>("/admin/downloads/config", { method: "PUT", body: { quotaBytes } }))
  };
}
