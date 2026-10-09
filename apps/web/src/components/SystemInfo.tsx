import { useQuery } from '@tanstack/react-query';
import type { SystemInfo as Info } from '@moa/shared';
import { useMe } from '../api/queries';
import { api } from '../lib/api';
import { version, revision } from '../lib/updates';
import { Button, Skeleton } from './ui';

export function SystemInfo() {
  const admin = useMe().data?.role === 'admin';
  const result = useQuery({ queryKey: ['admin', 'system'], queryFn: () => api<Info>('/admin/system'), enabled: admin, refetchInterval: 30000 });
  if (!admin) return null;
  const data = result.data;
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const rows = data ? [
    ['MOA 버전', data.version === 'unknown' && data.revision !== 'unknown' ? '개발 빌드' : version(data.version)], ['커밋', revision(data.revision)],
    ['운영체제', data.os], ['커널', data.kernel], ['아키텍처', data.architecture],
    ['실행 환경', `${data.deployment} · Node.js ${data.nodeVersion}`], ['CPU', `${data.cpuCount}개`],
    ['메모리', `${gib(data.memoryUsed)} / ${gib(data.memoryTotal)}`],
    ['실행 시간', `${Math.floor(data.uptimeSeconds / 3600)}시간 ${Math.floor(data.uptimeSeconds % 3600 / 60)}분`],
  ] : [];
  return <section className="settings-group"><h2>시스템 정보</h2><div className="settings-card">
    {data ? rows.map(([label, value]) => <div className="setting" key={label}><div><b>{label}</b><small>{value}</small></div></div>) : result.isPending ? <Skeleton className="settings-sk" /> : <div className="setting"><p role="alert">시스템 정보를 불러오지 못했어요.</p><Button onClick={() => void result.refetch()}>다시 시도</Button></div>}
  </div><p className="settings-hint">MOA가 실행되는 환경의 정보예요.</p></section>;
}
