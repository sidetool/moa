import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { authApi } from '../lib/api';
import { Button, ConfirmDialog, Skeleton } from './ui';

type Device = { id: string; name: string; current: boolean; createdAt: number; lastSeen: number; expiresAt: number };
const key = ['account', 'sessions'];
export function LoginDevices() {
  const client = useQueryClient();
  const [remove, setRemove] = useState<Device | 'others' | null>(null);
  const devices = useQuery({ queryKey: key, queryFn: () => authApi<Device[]>('/sessions'), refetchInterval: 60000 });
  const revoke = useMutation({
    mutationFn: () => authApi(`/sessions${remove && remove !== 'others' ? `/${remove.id}` : ''}`, { method: 'DELETE', body: {} }),
    onSuccess: () => { if (remove && remove !== 'others' && remove.current) window.location.assign('/__moa/login'); else { setRemove(null); void client.invalidateQueries({ queryKey: key }); } }
  });
  return <section className="settings-group"><h2>로그인 기기</h2><div className="settings-card">
    {devices.isPending ? <Skeleton className="settings-sk" /> : devices.isError ? <div className="setting"><b>기기를 불러오지 못했습니다</b><Button onClick={() => void devices.refetch()}>다시 시도</Button></div> : <>
      {devices.data?.map(device => <div className="setting" key={device.id}><span className="setting-icon"><Monitor size={20} /></span><div><b>{device.name}{device.current && ' · 현재 기기'}</b><small>최근 접속 {new Date(device.lastSeen).toLocaleString('ko-KR')}</small></div><Button variant="ghost" onClick={() => { revoke.reset(); setRemove(device); }}>로그아웃</Button></div>)}
      {(devices.data?.length ?? 0) > 1 && <div className="setting"><Button onClick={() => { revoke.reset(); setRemove('others'); }}>다른 기기 모두 로그아웃</Button></div>}
    </>}
  </div>{remove && <ConfirmDialog title={remove === 'others' ? '다른 기기를 모두 로그아웃할까요?' : `${remove.name}에서 로그아웃할까요?`} confirmLabel="로그아웃" busy={revoke.isPending} onClose={() => setRemove(null)} onConfirm={() => revoke.mutate()}>
    해당 기기는 다시 로그인해야 합니다.{revoke.isError && <p className="settings-error" role="alert">로그아웃하지 못했습니다. 다시 시도해 주세요.</p>}
  </ConfirmDialog>}</section>;
}
