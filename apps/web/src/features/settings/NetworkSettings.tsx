import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NetworkSettings as Network } from '@moa/shared';
import { ApiError, api } from '../../lib/api';
import { Button, Skeleton, Toggle } from '../../components/ui';

/** Server-wide proxy for extension, artwork and stream requests. ByeDPI, when on, replaces the manual address. */
export function NetworkSettings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['network'], queryFn: () => api<Network>('/network') });
  const [address, setAddress] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (query.data && !dirty) setAddress(query.data.defaultProxy); }, [query.data, dirty]);
  const save = useMutation({
    mutationFn: (byedpiEnabled?: boolean) => api<Network>('/network', { method: 'PATCH', body: { defaultProxy: address, revision: query.data!.revision, ...(byedpiEnabled === undefined ? {} : { byedpiEnabled }) } }),
    onSuccess: data => { client.setQueryData(['network'], data); setDirty(false); void client.invalidateQueries({ queryKey: ['source-page'] }); void client.invalidateQueries({ queryKey: ['source-browse'] }); },
    onError: error => { if (error instanceof ApiError && error.status === 409) void query.refetch(); }
  });
  const byedpi = query.data?.byedpi;
  const enabled = save.isPending && save.variables !== undefined ? save.variables : byedpi?.enabled ?? false;
  const check = useMutation({ mutationFn: () => api<{ ok: boolean; skipped?: boolean; elapsedMs: number }>('/network/test', { method: 'POST', body: { defaultProxy: address, ...(byedpi?.enabled ? { byedpiEnabled: true } : {}) } }) });
  const edit = (value: string) => { setAddress(value); setDirty(true); save.reset(); check.reset(); };
  const toggle = (value: boolean) => { check.reset(); save.mutate(value); };
  const stalled = !!byedpi?.enabled && !byedpi.running && !save.isPending;
  const status = check.isPending ? '연결 확인 중…'
    : check.isSuccess && check.data.skipped ? '검사할 Mangayomi 저장소를 먼저 등록해 주세요.'
    : check.isSuccess ? `연결 성공 · ${(check.data.elapsedMs / 1000).toFixed(1)}초`
    : check.isError ? (check.error instanceof ApiError && check.error.code === 'byedpi-save-required' ? 'ByeDPI 설정이 바뀌었어요. 새로고침 후 다시 시도해 주세요.' : enabled ? 'ByeDPI로 연결하지 못했어요.' : '연결하지 못했어요. MOA 서버에서 접근 가능한 주소인지 확인해 주세요.')
    : save.isSuccess && save.variables === true ? 'ByeDPI를 켰어요. 새로 여는 영상부터 적용돼요.'
    : save.isSuccess && save.variables === false ? 'ByeDPI를 껐어요. 수동 설정으로 돌아갔어요.'
    : save.isSuccess ? '저장했어요. 새로 여는 영상부터 적용돼요.'
    : save.isError ? (save.error instanceof ApiError && save.error.status === 409 ? '다른 곳에서 설정이 바뀌었어요. 다시 시도해 주세요.' : save.variables === true ? 'ByeDPI를 시작하지 못했어요.' : '저장하지 못했어요. 주소 형식을 확인해 주세요.') : null;
  const failed = check.isError || save.isError;
  return <section className="settings-group" id="network">
    <h2>소스 연결</h2>
    <div className="settings-card">
      {query.isPending ? <Skeleton className="folder-sk" /> : query.isError ? <div className="setting"><div><b>연결 설정을 불러오지 못했어요.</b></div><Button onClick={() => void query.refetch()}>다시 시도</Button></div> :
        <form className="network-form" onSubmit={e => { e.preventDefault(); save.mutate(undefined); }}>
          <div className="network-head">
            <div><b>기본 프록시</b><small>모든 프로필에 적용돼요. 확장별 프록시가 있으면 그쪽이 우선이에요.</small></div>
            {byedpi && <label className={`network-byedpi${!byedpi.available && !enabled ? ' is-unavailable' : ''}`} title={byedpi.available ? undefined : '이 설치에는 ByeDPI가 없어요.'}>
              <span>ByeDPI 우회</span>
              <Toggle label="ByeDPI 우회" checked={enabled} disabled={save.isPending || (!byedpi.available && !enabled)} onChange={toggle} />
            </label>}
          </div>
          {enabled ? <div className={`network-active${stalled ? ' is-stalled' : ''}`} aria-live="polite">
            <i aria-hidden="true" />
            <div><b>{save.isPending ? 'ByeDPI 시작 중…' : stalled ? 'ByeDPI 응답 없음' : 'ByeDPI 사용 중'}</b><code>{byedpi?.proxy || '내장 프록시'}</code></div>
            {stalled && byedpi?.available && <Button type="button" variant="ghost" onClick={() => toggle(true)}>다시 시작</Button>}
          </div>
            : <input aria-label="기본 프록시 주소" type="text" spellCheck={false} placeholder="직접 연결 (예: socks5://서버주소:1080)" disabled={save.isPending} value={address} onChange={e => edit(e.target.value)} />}
          <small className="network-note">{enabled ? query.data.defaultProxy ? `끄면 수동 주소로 돌아가요 · ${query.data.defaultProxy}` : '끄면 직접 연결로 돌아가요.' : 'HTTP·HTTPS·SOCKS5 지원. 비워 두면 직접 연결해요.'}</small>
          <div className="network-actions">
            {!enabled && address && <Button type="button" variant="ghost" onClick={() => edit('')}>비우기</Button>}
            <Button type="button" disabled={check.isPending || save.isPending || (enabled && dirty)} onClick={() => check.mutate()}>연결 테스트</Button>
            {!enabled && <Button type="submit" variant="primary" disabled={!dirty || save.isPending || check.isPending}>{save.isPending ? '저장 중…' : '저장'}</Button>}
          </div>
          {status && <p className={failed ? 'settings-error' : 'settings-hint'} role={failed ? 'alert' : 'status'}>{status}</p>}
        </form>}
    </div>
  </section>;
}
