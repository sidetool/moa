import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import type { UpdatePolicy, UpdateStatus } from '@moa/shared';
import { useMe } from '../../api/queries';
import { api, ApiError } from '../../lib/api';
import { cx } from '../../lib/format';
import { busyStates, errorCode, installNote, revision, updateStateLabels as states, updateErrors, updatesKey, useUpdateAction, useUpdateNoticePref, useUpdateStatus, version } from '../../lib/updates';
import { Button, ConfirmDialog, IconButton, Select, Skeleton } from '../../components/ui';

type Channel = UpdatePolicy['channel'];
const steps: UpdateStatus['state'][] = ['downloading', 'preflight', 'backup', 'applying', 'verifying'];
const outcomes: Record<NonNullable<UpdateStatus['history']>[number]['outcome'], string> = { complete: '완료', 'rolled-back': '복구됨', failed: '실패' };
const Markdown = lazy(() => import('react-markdown'));
const when = (at: number) => new Date(at).toLocaleString('ko-KR');
function ReleaseNotes({ tag, onClose }: { tag: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const notes = useQuery({ queryKey: ['admin', 'release-notes', tag], queryFn: () => api<{ body: string }>('/admin/updates/releases/' + encodeURIComponent(tag)), staleTime: 300000 });
  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog release-notes-dialog" aria-label={`${tag} 릴리스`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="sheet-head"><h2>{tag}</h2><IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
    <div className="confirm-dialog-body">{notes.isPending ? <Skeleton className="settings-sk" /> : notes.isError ? <><p>변경 사항을 불러오지 못했습니다.</p><Button onClick={() => void notes.refetch()}>다시 시도</Button></> : <div className="release-notes-content"><Suspense fallback={<Skeleton className="settings-sk" />}><Markdown skipHtml components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{notes.data?.body || '등록된 변경 사항이 없습니다.'}</Markdown></Suspense></div>}</div>
  </dialog>;
}

export function UpdateSettings() {
  const client = useQueryClient();
  const me = useMe().data;
  const notice = useUpdateNoticePref(me?.id);
  const section = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  const [confirm, setConfirm] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [pending, setPending] = useState<Channel | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const status = useUpdateStatus({ refetchInterval: 3000 });
  const action = useUpdateAction(() => setConfirm(false));
  // The host applies the channel asynchronously; show the chosen value until polling confirms it.
  const save = useMutation({
    mutationFn: (channel: Channel) => api<UpdateStatus>('/admin/updates/settings', { method: 'PATCH', body: { channel } }),
    onMutate: channel => { setMessage(null); setPending(channel); },
    onSuccess: data => client.setQueryData(updatesKey, data),
    onError: error => { setPending(null); setMessage(error instanceof ApiError && updateErrors[error.code] || '설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
  });
  const data = status.data;
  const server = data?.policy?.channel;
  useEffect(() => { if (pending && server === pending && !save.isPending) setPending(null); }, [server, pending, save.isPending]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { setPending(null); setMessage('업데이트 서비스가 채널을 반영하지 못했습니다. 다시 선택해 주세요.'); }, 60_000);
    return () => clearTimeout(timer);
  }, [pending]);
  const loaded = !!data;
  useEffect(() => { if (loaded && hash === '#updates') section.current?.scrollIntoView({ block: 'start' }); }, [loaded, hash]);

  const discovery = data?.discovery;
  const release = data?.mode === 'release';
  const busy = action.isPending || !!data && busyStates.includes(data.state);
  const error = errorCode(action.error) ?? discovery?.error ?? (data?.error === 'updater-unavailable' && discovery ? null : data?.error);
  const channel = pending ?? server ?? 'stable';
  const canApply = !!data?.connected && data.state === 'available' && !busy && !pending;
  const step = data ? steps.indexOf(data.state) : -1;
  const history = data?.history ?? [];
  const pill = (ok: boolean) => data && <span className={cx('status-pill', ok && 'is-ok')} role="status">{data.connected ? states[data.state] ?? data.state : data.configured ? '업데이트 서비스 중지' : '업데이트 서비스 없음'}</span>;

  return <section className="settings-group" id="updates" ref={section}>
    <h2>업데이트</h2>
    <div className="settings-card">
      {!data ? status.isPending ? <Skeleton className="folder-sk" /> : <div className="setting"><p className="settings-error" role="alert">업데이트 정보를 불러오지 못했어요.</p><Button onClick={() => void status.refetch()}>다시 시도</Button></div> : <>
        {discovery ? <>
          <div className="setting"><div><b>MOA {discovery.currentVersion ? version(discovery.currentVersion) : '개발 빌드'}</b><small>{discovery.repository} · {discovery.currentVersion ? `현재 ${version(discovery.currentVersion)}` : `커밋 ${revision(data.current)}`}</small></div><span className={cx('status-pill', discovery.updateAvailable === false && 'is-ok')} role="status">{discovery.error ? '확인 실패' : !discovery.releases.length ? '공개 릴리스 없음' : discovery.updateAvailable === true ? '새 릴리스 있음' : discovery.updateAvailable === false ? '새 버전 없음' : '버전 비교 불가'}</span></div>
          <div className="setting"><div><b>최근 확인 · {when(discovery.checkedAt)}</b></div><Button disabled={busy} onClick={() => action.mutate('check')}>업데이트 확인</Button></div>
          {discovery.releases.map(item => <div className="setting" key={item.version}><div><b>{version(item.version)}</b><small>{item.version.includes('-beta.') ? '사전 릴리스' : '안정 릴리스'} · {new Date(item.publishedAt).toLocaleDateString('ko-KR')} 공개</small></div><Button variant="ghost" onClick={() => setNotes(item.version)}>릴리스 보기</Button></div>)}
          <p className="settings-hint translation-message">{data.configured ? '업데이트 서비스가 시작되면 설치할 수 있습니다.' : 'Compose의 moa-updater 서비스가 필요합니다.'}</p>
        </> : <>
        {release
          ? <div className="setting"><div><b>MOA {version(data.current)}</b><small>{server === 'beta' ? '베타' : '정식'} 채널{data.latest && data.latest !== data.current ? ` · 새 버전 ${version(data.latest)}` : ''}{data.current !== 'unknown' && <> · <button className="text-btn update-notes" onClick={() => setNotes(data.current)}>릴리스 보기</button></>}</small></div>{pill(data.connected && data.state === 'current')}</div>
          : <div className="setting"><div><b>{data.mode === 'docker' ? 'Docker' : data.mode === 'git' ? 'Git' : '서버'} 업데이트</b><small>현재 {revision(data.current)}{data.branch ? ` · ${data.branch}` : ''}{data.latest && data.latest !== data.current ? ` → ${revision(data.latest)}` : ''}</small></div>{pill(false)}</div>}
        {release && data.connected && step >= 0 && <div className="setting update-progress"><div><b>{states[data.state]} <span className="update-step">{step + 1}/{steps.length}</span></b><small>잠시 접속이 끊겨도 업데이트는 계속돼요. 다시 연결되면 결과를 보여 드려요.</small></div></div>}
        {release && data.connected && data.state === 'rolling-back' && <div className="setting"><div><b>문제가 생겨 이전 버전으로 되돌리는 중이에요</b><small>저장된 데이터는 그대로 두고 이전 버전을 다시 실행해요.</small></div></div>}
        {release && data.state === 'rolled-back' && <p className="settings-hint translation-message" role="status">새 버전에 문제가 있어 이전 버전으로 되돌렸어요.</p>}
        {release && data.state === 'recovery-required' && error !== 'update-recovery-required' && <p className="settings-error translation-message" role="alert">{updateErrors['update-recovery-required']}</p>}
        <div className="setting"><div><b>{data.checkedAt ? `최근 확인 · ${when(data.checkedAt)}` : '새 버전 확인'}</b><small>{release
          ? '6시간마다 확인해요. 설치는 직접 할 때만 해요.'
          : data.state === 'restart-required' ? '빌드를 마쳤어요. 호스트에서 MOA 서버를 재시작해 주세요.' : data.ahead ? `현재 브랜치에 원격보다 앞선 커밋이 ${data.ahead}개 있어요.` : '업데이트 중에는 재생과 접속이 잠시 끊길 수 있어요.'}</small></div><Button disabled={!data.connected || busy} onClick={() => action.mutate('check')}>업데이트 확인</Button></div>
        {data.connected && data.state === 'available' && <div className="setting"><div>
            <b>{release ? `새 버전 ${version(data.latest || '')}` : '새 버전이 있어요'}</b>
            <small>데이터와 설정은 그대로 유지돼요.{data.latest && <> <button className="text-btn update-notes" onClick={() => setNotes(data.latest)}>변경 사항 보기</button></>}</small>
          </div><Button variant="primary" disabled={!canApply} onClick={() => { action.reset(); setConfirm(true); }}>지금 업데이트</Button></div>}

        </>}
        {(release || discovery) && <div className="setting"><div><b>업데이트 채널</b><small>{pending ? '채널 변경 중…' : channel === 'beta' ? '새 기능을 먼저 받지만 문제가 있을 수 있어요.' : '충분히 확인한 버전만 받아요.'}</small></div>
          <Select className="setting-select" aria-label="업데이트 채널" value={channel} disabled={busy || !!pending} options={[{ value: 'stable', label: '안정 릴리스' }, { value: 'beta', label: '사전 릴리스' }]} onChange={value => value !== channel && save.mutate(value as Channel)} /></div>}
        <div className="setting"><div><b>업데이트 알림</b><small>새 버전이 나오면 알려 드려요. 이 브라우저에만 적용돼요.</small></div>
          <button type="button" role="switch" aria-checked={notice.enabled} aria-label="업데이트 알림" className={cx('switch', notice.enabled && 'is-on')} disabled={!me} onClick={() => notice.setEnabled(!notice.enabled)}><i /></button></div>
        {message && <p className="settings-error translation-message" role="alert">{message}</p>}

        {release && (data.updaterVersion || history.length > 0) && <details className="update-details">
          <summary>자세히</summary>
          <dl>
            <dt>설치 버전</dt><dd>{version(data.current)}</dd>
            {data.updaterVersion && <><dt>업데이트 도구</dt><dd>{version(data.updaterVersion)}</dd></>}
          </dl>
          {history.length > 0 && <ol aria-label="업데이트 기록">{history.map(item => <li key={`${item.at}-${item.version}`}>
            <span>{version(item.previous)} → {version(item.version)}</span><small>{when(item.at)}</small><span className={cx('status-pill', item.outcome === 'complete' && 'is-ok')}>{outcomes[item.outcome]}</span>
          </li>)}</ol>}
        </details>}

        {!discovery && (!data.configured || !data.connected || error === 'update-version-unknown') && <p className="settings-hint translation-message">{error === 'update-version-unknown' ? '배포 버전 정보를 설정해 주세요.' : '업데이트 서비스 상태를 확인해 주세요.'} <a className="text-btn" href="https://github.com/sidetool/moa/blob/main/docs/UPDATES.md" target="_blank" rel="noreferrer">설정 안내</a></p>}
        {error && <p className="settings-error translation-message" role="alert">{updateErrors[error] || '업데이트하지 못했어요. 호스트 상태를 확인하고 다시 시도해 주세요.'}</p>}
      </>}
    </div>
    {notes && <ReleaseNotes tag={notes} onClose={() => setNotes(null)} />}
    {confirm && <ConfirmDialog title="서버를 업데이트할까요?" confirmLabel="업데이트" busy={action.isPending} onClose={() => setConfirm(false)} onConfirm={() => action.mutate('apply')}>{release ? `새 버전(${version(data?.latest || '')})을 설치합니다. ` : '새 버전을 설치합니다. '}{installNote(data)}{error && <p className="settings-error" role="alert">{updateErrors[error] || '업데이트를 시작하지 못했어요.'}</p>}</ConfirmDialog>}
  </section>;
}
