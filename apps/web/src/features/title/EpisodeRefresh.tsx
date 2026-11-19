import { useEffect, useLayoutEffect, useRef } from 'react';
import type { MediaDetail } from '@moa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { keys } from '../../api/queries';
import { IconButton } from '../../components/ui';
import { api, ApiError, currentProfileId } from '../../lib/api';

export function EpisodeRefreshButton({ state, onRefresh }: { state: 'idle' | 'busy' | 'done'; onRefresh: () => void }) {
  const busy = state === 'busy';
  const Icon = busy ? LoaderCircle : state === 'done' ? Check : RefreshCw;
  return <>
    <IconButton type="button" className="icon-btn-l episode-refresh-button" label="회차 새로고침"
      aria-busy={busy} aria-disabled={busy} onClick={() => { if (!busy) onRefresh(); }}>
      <Icon size={18} aria-hidden="true" />
    </IconButton>
    <span className="sr-only" role="status">{busy ? '갱신 중…' : state === 'done' ? '갱신 완료' : ''}</span>
  </>;
}

export function useEpisodeRefresh(id: string) {
  const client = useQueryClient();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const active = (profile: string | null) => mounted.current && profile === currentProfileId();
  const detailKey = { queryKey: keys.media(id), exact: true };
  const invalidateLists = () => {
    for (const key of [['watchlist'], ['home'], ['grouped-cards'], ['title-group', id], ['franchise', id]]) {
      void client.invalidateQueries({ queryKey: key });
    }
  };
  const refresh = useMutation({
    mutationFn: (_profile: string | null) => api<{ detail: MediaDetail; errors: string[] }>(`/media/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    onSuccess: async (result, profile) => {
      if (!active(profile)) return;
      await client.cancelQueries(detailKey);
      if (!active(profile)) return;
      client.setQueryData(keys.media(id), result.detail);
      invalidateLists();
    },
    onError: (error, profile) => {
      if (!active(profile) || !(error instanceof ApiError) || (![401, 403, 404].includes(error.status) && error.code !== 'source-removing')) return;
      void client.resetQueries(detailKey);
      invalidateLists();
    },
  });
  const done = refresh.isSuccess && !refresh.data.errors.length;
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(refresh.reset, 2200);
    return () => clearTimeout(timer);
  }, [done, refresh.reset]);

  return {
    state: refresh.isPending ? 'busy' as const : done ? 'done' as const : 'idle' as const,
    run: () => refresh.mutate(currentProfileId()),
    error: refresh.isError ? '새로고침하지 못했어요.' : refresh.data?.errors.length ? '일부 정보를 갱신하지 못했어요.' : undefined,
  };
}
