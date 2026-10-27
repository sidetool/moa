import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComponentsStatus, OptionalComponent, OptionalComponentId } from '@moa/shared';
import { api, ApiError } from '../../lib/api';
import { cx, fileSize } from '../../lib/format';
import { errorCode, updateErrors, updateStateLabels, version } from '../../lib/updates';
import { Button, ConfirmDialog, Skeleton } from '../../components/ui';

const key = ['admin', 'components'] as const;
const info: Record<OptionalComponentId, { name: string; about: string }> = {
  apk: { name: 'APK 확장', about: 'Aniyomi APK 확장을 실행해요.' },
  browser: { name: '브라우저 인증', about: '브라우저 확인이 필요한 사이트를 열어요.' }
};
const phases: Partial<Record<ComponentsStatus['phase'], string>> = { ...updateStateLabels, 'rolling-back': '이전 상태로 되돌리는 중…' };
const PICKUP_MS = 20_000;
const failure = (code: string | null) => code && updateErrors[code] || '작업을 마치지 못했어요. 호스트 상태를 확인하고 다시 시도해 주세요.';

/** Optional runtimes installed through the host updater. Disabling only stops the container; data and images stay. */
export function ComponentSettings() {
  const client = useQueryClient();
  // The host reads requests from a mailbox, so a GET right after the POST can still show the previous
  // operation for the same id. Only a GET that shows this job working (or the requested end state) settles it.
  const [job, setJob] = useState<{ id: OptionalComponentId; enabled: boolean; since: number; seen: boolean; done: boolean } | null>(null);
  const pending = !!job && !job.done;
  const [asking, setAsking] = useState<{ item: OptionalComponent; enabled: boolean } | null>(null);
  const status = useQuery({
    queryKey: key, queryFn: () => api<ComponentsStatus>('/admin/components'),
    // Poll quickly while work runs (the app may restart mid-operation); otherwise re-check quietly while visible.
    refetchInterval: query => { const data = query.state.data; return pending || data?.busy || data?.operation?.state === 'working' ? 2000 : 30_000; },
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2
  });
  const change = useMutation({
    mutationFn: ({ item, enabled }: { item: OptionalComponent; enabled: boolean }) => api<ComponentsStatus>(`/admin/components/${item.id}`, { method: 'POST', body: { enabled } }),
    // The 202 body is not proof the host picked the job up, so refetch instead of caching it.
    onSuccess: (_, { item, enabled }) => { setJob({ id: item.id, enabled, since: Date.now(), seen: false, done: false }); setAsking(null); void client.invalidateQueries({ queryKey: key }); }
  });
  const data = status.data;
  const operation = data?.operation;
  const working = operation?.state === 'working';
  useEffect(() => {
    if (!job || job.done || !data || status.isFetching) return;
    if (working && operation?.id === job.id) { if (!job.seen) setJob({ ...job, seen: true }); return; }
    const item = data.items.find(entry => entry.id === job.id);
    const finished = operation?.id === job.id && (job.seen || operation.state === 'complete' && item?.enabled === job.enabled);
    if (!finished && Date.now() - job.since < PICKUP_MS) return;
    setJob({ ...job, done: true });
    void client.invalidateQueries(); // the server may have restarted: refresh everything that depends on it
  }, [job, data, operation, working, status.dataUpdatedAt, status.isFetching, client]);

  if (status.error instanceof ApiError && status.error.status === 404) return null; // older server without this API
  const blocked = !data?.available || data.busy || working || pending || change.isPending;
  const reconnecting = !!data && status.isError && (working || pending);
  const result = operation && !working && !pending && (job?.id === operation.id || operation.state !== 'complete') ? operation : null;
  const stoppable = data?.items.filter(item => item.enabled && item.managed && item.supported && item.reason !== 'update-component-external') ?? [];
  const itemOf = (id: OptionalComponentId) => data?.items.find(item => item.id === id);

  const row = (item: OptionalComponent) => {
    const running = working && operation?.id === item.id || pending && job!.id === item.id;
    const installing = working && operation?.id === item.id ? operation.enabled : job?.enabled;
    const external = item.reason === 'update-component-external' || !item.managed && item.installed;
    const note = running ? working && data?.phase && phases[data.phase] || '요청을 전달하는 중…'
      : !item.supported ? (item.reason && updateErrors[item.reason]) || '이 서버 환경은 지원하지 않아요.'
      : external ? '직접 연결한 서버를 쓰고 있어요.'
      : !item.installed && item.downloadBytes ? `${info[item.id].about} 약 ${fileSize(item.downloadBytes)}`
      : info[item.id].about;
    const pill = running ? <span className="status-pill is-busy">{installing ? '설치 중' : '중지 중'}</span>
      : external ? <span className="status-pill">외부 연결</span>
      : item.enabled ? <span className="status-pill is-ok">사용 중</span>
      : item.installed ? <span className="status-pill">중지됨</span> : null;
    // Stopping is kept out of the row (see 관리 below) so it is never a stray click away.
    const action = !item.supported || external || running || item.enabled ? null
      : <Button disabled={blocked} onClick={() => { change.reset(); setAsking({ item, enabled: true }); }}>{item.installed ? '다시 사용' : '설치'}</Button>;
    return <div className={cx('setting component-row', running && 'is-running')} key={item.id} aria-busy={running || undefined}>
      <div><b>{info[item.id]?.name ?? item.id}</b><small>{note}</small></div>
      <div className="component-side">{pill}{action}</div>
    </div>;
  };

  const target = asking && itemOf(asking.item.id) || asking?.item;
  return <section className="settings-group" id="components">
    <h2>추가 기능</h2>
    <div className="settings-card">
      {!data ? status.isPending ? <Skeleton className="folder-sk" /> : <div className="setting"><p className="settings-error" role="alert">추가 기능 정보를 불러오지 못했어요.</p><Button onClick={() => void status.refetch()}>다시 시도</Button></div> : <>
        {data.items.map(row)}
        {stoppable.length > 0 && <details className="update-details component-manage">
          <summary>관리</summary>
          <p>사용 중지하면 실행만 멈추고 데이터와 이미지는 남아요. 언제든 다시 켤 수 있어요.</p>
          {stoppable.map(item => <div className="component-manage-row" key={item.id}><span>{info[item.id]?.name ?? item.id}</span><Button variant="ghost" className="btn-danger" disabled={blocked} onClick={() => { change.reset(); setAsking({ item, enabled: false }); }}>사용 중지</Button></div>)}
        </details>}
        <div role="status" aria-live="polite">
          {reconnecting ? <p className="settings-hint translation-message">서버가 다시 시작되는 중이에요. 연결되면 결과를 보여 드려요.</p>
            : !data.available ? <p className="settings-hint translation-message">{failure(data.reason)}</p>
            : data.busy && !working ? <p className="settings-hint translation-message">다른 업데이트 작업이 끝나면 바꿀 수 있어요.</p>
            : result?.state === 'complete' ? <p className="settings-hint translation-message">{info[result.id]?.name} {result.enabled ? '설치를 마쳤어요.' : '사용을 중지했어요. 데이터는 그대로 있어요.'}</p>
            : result?.state === 'rolled-back' ? <p className="settings-error translation-message" role="alert">{info[result.id]?.name} 적용에 실패해 이전 상태로 되돌렸어요.{result.error && result.error !== 'update-rolled-back' ? ` ${failure(result.error)}` : ''}</p>
            : result?.state === 'failed' ? <p className="settings-error translation-message" role="alert">{failure(result.error)}</p> : null}
        </div>
      </>}
    </div>
    {asking && target && <ConfirmDialog
      title={`${info[target.id]?.name ?? target.id} ${asking.enabled ? target.installed ? '다시 사용' : '설치' : '사용 중지'}`}
      confirmLabel={asking.enabled ? target.installed ? '사용' : '설치' : '사용 중지'}
      busy={change.isPending} confirmDisabled={!data?.available || data.busy || working}
      onClose={() => setAsking(null)} onConfirm={() => change.mutate({ item: target, enabled: asking.enabled })}>
      {asking.enabled
        ? target.installed ? '설치된 구성 요소를 다시 실행해요. ' : `MOA ${data?.currentVersion ? version(data.currentVersion) : ''}에 맞는 공식 이미지를 받아 설치해요${target.downloadBytes ? `(약 ${fileSize(target.downloadBytes)})` : ''}. `
        : '실행만 멈추고 데이터와 이미지는 남겨 둬요. '}
      적용하는 동안 접속이 잠시 끊길 수 있어요.
      {change.isError && <p className="settings-error" role="alert">{failure(errorCode(change.error))}</p>}
    </ConfirmDialog>}
  </section>;
}
