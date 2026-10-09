import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useMe } from '../api/queries';
import { busyStates, errorCode, installNote, newVersionLabel, updateErrors, useUpdateAction, useUpdateNoticePref, useUpdateStatus } from '../lib/updates';
import { Button, ConfirmDialog, IconButton } from './ui';

/** Quiet admin-only notice for a new server version. Closing it rests for a day; "다시 보지 않음" turns it off until re-enabled in settings. */
export function UpdateNotice() {
  const me = useMe().data;
  const admin = me?.role === 'admin';
  const pref = useUpdateNoticePref(me?.id);
  const onSettings = useLocation().pathname.startsWith('/settings');
  const [confirm, setConfirm] = useState(false);
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const snoozed = pref.snoozedUntil > now;
  const status = useUpdateStatus({ enabled: admin && (pref.enabled || started), refetchInterval: started ? 5000 : 300_000 });
  const install = useUpdateAction(() => { setConfirm(false); setStarted(true); });
  useEffect(() => {
    if (!snoozed) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(pref.snoozedUntil - now, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [snoozed, pref.snoozedUntil, now]);

  const data = status.data;
  if (!admin || !data || onSettings) return null;
  const busy = busyStates.includes(data.state);
  const error = errorCode(install.error);

  if (started) {
    const done = !busy && data.state !== 'available';
    const failed = done && data.state !== 'current';
    return <div className="update-notice" role="status">
      <p>{!done ? '업데이트 중…' : failed ? updateErrors[data.error ?? ''] ?? '업데이트를 마치지 못했어요.' : '업데이트를 마쳤어요.'}</p>
      {failed && <Link className="text-btn" to="/settings#updates">자세히</Link>}
      {done && <IconButton label="닫기" onClick={() => { setStarted(false); install.reset(); }}><X size={18} /></IconButton>}
    </div>;
  }
  if (!pref.enabled || snoozed || !(data.connected && data.state === 'available' || data.discovery?.updateAvailable)) return null;
  const label = newVersionLabel(data);

  return <>
    <div className="update-notice" role="status" aria-label="업데이트 알림">
      <p>{label ? <><b>MOA {label}</b> 업데이트가 있어요</> : '새 업데이트가 있어요'}</p>
      {data.connected ? <Button variant="primary" onClick={() => { install.reset(); setConfirm(true); }}>설치</Button> : <Link className="btn btn-primary btn-m" to="/settings#updates">릴리스 보기</Link>}
      <Button variant="ghost" onClick={() => pref.setEnabled(false)}>다시 보지 않음</Button>
      <IconButton label="닫기" onClick={() => { pref.snooze(); setNow(Date.now()); }}><X size={18} /></IconButton>
    </div>
    {confirm && <ConfirmDialog title="서버를 업데이트할까요?" confirmLabel="설치" busy={install.isPending} onClose={() => setConfirm(false)} onConfirm={() => install.mutate('apply')}>
      {label ? `MOA ${label}을 설치합니다. ` : '새 버전을 설치합니다. '}{installNote(data)}
      {error && <p className="settings-error" role="alert">{updateErrors[error] || '업데이트를 시작하지 못했어요.'}</p>}
    </ConfirmDialog>}
  </>;
}
