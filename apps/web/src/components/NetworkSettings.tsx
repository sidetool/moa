import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NetworkSettings as Network } from '@moa/shared';
import { api } from '../lib/api';
import { Button, Skeleton } from './ui';

/** Server-wide proxy for extension, artwork and stream requests. */
export function NetworkSettings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['network'], queryFn: () => api<Network>('/network') });
  const [address, setAddress] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (query.data && !dirty) setAddress(query.data.defaultProxy); }, [query.data, dirty]);
  const save = useMutation({ mutationFn: () => api<Network>('/network', { method: 'PATCH', body: { defaultProxy: address, revision: query.data!.revision } }), onSuccess: data => { client.setQueryData(['network'], data); setDirty(false); void client.invalidateQueries({ queryKey: ['source-page'] }); void client.invalidateQueries({ queryKey: ['source-browse'] }); } });
  const check = useMutation({ mutationFn: () => api<{ ok: boolean; skipped?: boolean; elapsedMs: number }>('/network/test', { method: 'POST', body: { defaultProxy: address } }) });
  const edit = (value: string) => { setAddress(value); setDirty(true); save.reset(); check.reset(); };
  const status = check.isPending ? '연결 확인 중…'
    : check.isSuccess && check.data.skipped ? '검사할 Mangayomi 저장소를 먼저 등록해 주세요.'
    : check.isSuccess ? `연결 성공 · ${(check.data.elapsedMs / 1000).toFixed(1)}초`
    : check.isError ? '연결하지 못했어요. MOA 서버에서 접근 가능한 주소인지 확인해 주세요.'
    : save.isSuccess ? '저장했어요. 새로 여는 영상부터 적용돼요.'
    : save.isError ? '저장하지 못했어요. 주소 형식을 확인해 주세요.' : null;
  return <section className="settings-group" id="network">
    <h2>소스 연결</h2>
    <div className="settings-card">
      {query.isPending ? <Skeleton className="folder-sk" /> : query.isError ? <div className="setting"><div><b>연결 설정을 불러오지 못했어요.</b></div><Button onClick={() => void query.refetch()}>다시 시도</Button></div> :
        <form className="network-form" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
          <div><b>기본 프록시</b><small>HTTP·HTTPS·SOCKS5 지원. 비워 두면 직접 연결합니다. 모든 프로필에 적용돼요.</small></div>
          <input aria-label="기본 프록시 주소" type="text" spellCheck={false} placeholder="직접 연결 (예: socks5://서버주소:1080)" value={address} onChange={e => edit(e.target.value)} />
          <div className="network-actions">
            {address && <Button type="button" variant="ghost" onClick={() => edit('')}>비우기</Button>}
            <Button type="button" disabled={check.isPending || save.isPending} onClick={() => check.mutate()}>연결 테스트</Button>
            <Button type="submit" variant="primary" disabled={!dirty || save.isPending || check.isPending}>{save.isPending ? '저장 중…' : '저장'}</Button>
          </div>
          {status && <p className={(check.isError || save.isError) ? 'settings-error' : 'settings-hint'} role={(check.isError || save.isError) ? 'alert' : 'status'}>{status}</p>}
        </form>}
    </div>
  </section>;
}
