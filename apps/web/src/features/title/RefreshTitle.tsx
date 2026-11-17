import { useEffect, useLayoutEffect, useRef } from 'react';
import type { MediaDetail } from '@moa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { keys } from '../../api/queries';
import { Button } from '../../components/ui';
import { api, ApiError, currentProfileId } from '../../lib/api';

export function RefreshTitle({ id }: { id: string }) {
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

  return <>
    <Button variant="secondary" size="l" icon={<RefreshCw size={20} />} aria-busy={refresh.isPending}
      disabled={refresh.isPending} onClick={() => refresh.mutate(currentProfileId())}>
      <span aria-live="polite">{refresh.isPending ? '갱신 중…' : done ? '갱신 완료' : '새로고침'}</span>
    </Button>
    {(refresh.isError || !!refresh.data?.errors.length) && <span role="alert" className="settings-error title-refresh-error">
      {refresh.isError ? '새로고침하지 못했어요.' : '일부 정보를 갱신하지 못했어요.'}
    </span>}
  </>;
}
