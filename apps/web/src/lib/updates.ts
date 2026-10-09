import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateStatus } from '@moa/shared';
import { api, ApiError } from './api';

/** One cache entry for the settings section and the admin notice; each observer sets its own poll rate. */
export const updatesKey = ['admin', 'updates'] as const;
export const useUpdateStatus = (options: { enabled?: boolean; refetchInterval: number }) =>
  useQuery({ queryKey: updatesKey, queryFn: () => api<UpdateStatus>('/admin/updates'), ...options });

export function useUpdateAction(onDone?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: 'check' | 'apply') => api<UpdateStatus>(`/admin/updates/${name}`, { method: 'POST', body: {} }),
    onSuccess: data => { client.setQueryData(updatesKey, data); onDone?.(); },
    onError: () => { void client.invalidateQueries({ queryKey: updatesKey }); }
  });
}

export const busyStates: UpdateStatus['state'][] = ['checking', 'updating', 'downloading', 'preflight', 'backup', 'applying', 'verifying', 'rolling-back'];
export const updateErrors: Record<string, string> = {
  'updater-unavailable': '호스트 업데이트 도구에 연결하지 못했어요.',
  'update-dirty': '수정한 파일을 커밋하거나 정리한 뒤 다시 확인해 주세요.',
  'update-diverged': '현재 브랜치와 원격 기록이 갈라졌어요. 호스트에서 먼저 병합해 주세요.',
  'update-deployment-diverged': '실행 중인 이미지가 현재 소스보다 앞서거나 기록이 달라요. 호스트에서 배포 브랜치를 확인해 주세요.',
  'update-version-unknown': '실행 중인 이미지에 버전 정보가 없어요. 설정 안내에 따라 커밋 정보를 포함해 한 번 빌드해 주세요.',
  'update-no-upstream': '현재 Git 브랜치의 추적 브랜치를 설정해 주세요.',
  'update-not-installed': '업데이트할 Git 또는 Docker Compose 설치를 찾지 못했어요.',
  'update-git-failed': '원격 Git 저장소와 접근 권한을 확인해 주세요.',
  'update-docker-failed': 'Docker 상태와 이미지 접근 권한을 확인해 주세요.',
  'update-build-failed': '빌드하지 못했어요. 호스트 환경을 확인하고 다시 시도해 주세요.',
  'update-restart-failed': '서버를 재시작하지 못했어요. 호스트의 서비스 설정을 확인해 주세요.',
  'update-busy': '다른 업데이트 작업이 진행 중이에요.',
  'update-release-incomplete': '새 릴리스 파일이 아직 준비되지 않았어요. 나중에 다시 확인해 주세요.',
  'update-signature-invalid': '릴리스 서명을 확인하지 못해 설치를 중단했어요.',
  'update-migration-required': '이 버전은 수동 이관이 필요해요. 릴리스 안내를 확인해 주세요.',
  'update-tool-required': '먼저 업데이트 도구를 갱신해 주세요.',
  'update-platform-unsupported': '현재 서버 환경을 지원하는 릴리스가 아니에요.',
  'update-compose-required': '먼저 호스트의 Docker Compose를 갱신해 주세요.',
  'update-rate-limited': '업데이트 서버의 요청 제한에 도달했어요. 나중에 다시 확인해 주세요.',
  'update-app-busy': '재생이나 다른 작업이 진행 중이에요. 끝난 뒤 다시 시도해 주세요.',
  'update-space-required': '백업과 업데이트에 필요한 디스크 공간을 확보해 주세요.',
  'update-check-failed': 'GitHub 릴리스를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  'update-response-limit': '릴리스 응답이 너무 커서 확인을 중단했어요.',
  'update-feed-truncated': '릴리스 목록이 너무 많아 최신 버전을 확정하지 못했어요. GitHub 릴리스 페이지를 확인해 주세요.',
  'update-no-releases': '선택한 채널에 공개된 릴리스가 아직 없어요.',
  'update-rolled-back': '이전 버전으로 복구했어요. 업데이트 기록을 확인해 주세요.',
  'update-recovery-required': '자동 복구를 마치지 못했어요. 설치 안내의 복구 방법을 확인해 주세요.',
  'update-invalid-policy': '업데이트 채널을 다시 선택해 주세요.',
  'update-not-available': '업데이트 상태가 바뀌었어요. 다시 확인해 주세요.'
};
export const errorCode = (error: unknown) => error instanceof ApiError ? error.code : error ? 'update-failed' : null;

export const version = (value: string) => value === 'unknown' ? '사용자 빌드' : /^\d/.test(value) ? `v${value}` : value;
export const revision = (value: string) => value === 'unknown' ? '알 수 없음' : value.replace(/^sha256:/, '').slice(0, 12);
/** Release builds have readable versions; git/docker builds only expose commits, which say nothing to a reader. */
export const newVersionLabel = (status: UpdateStatus) => status.discovery?.updateAvailable && status.discovery.releases[0] ? version(status.discovery.latestVersion || status.discovery.releases[0].version) : status.mode === 'release' && status.latest ? version(status.latest) : null;
export const installNote = (status?: UpdateStatus) => status?.mode === 'git'
  ? '자동 재시작을 설정하지 않았다면 설치 후 호스트에서 서버를 재시작해 주세요.'
  : '서버를 재시작하는 동안 영상 재생이 잠시 중단될 수 있어요.';

/* ---------- Admin notice preference (this browser, per account) ---------- */
// localStorage is already per server origin; the account id keeps admins sharing a browser apart.
const SNOOZE_MS = 24 * 3600e3;
const EVENT = 'moa:update-notice';
const noticeKey = (account: string, name: 'off' | 'snooze') => `moa.updateNotice.${name}.${account}`;
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private browsing */ }
  window.dispatchEvent(new Event(EVENT));
};
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener('storage', notify);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', notify); };
};

export function useUpdateNoticePref(account: string | undefined) {
  const off = useSyncExternalStore(subscribe, () => !!account && read(noticeKey(account, 'off')) === '1', () => false);
  const snoozedUntil = useSyncExternalStore(subscribe, () => account ? Number(read(noticeKey(account, 'snooze'))) || 0 : 0, () => 0);
  return {
    enabled: !off,
    snoozedUntil,
    setEnabled: (value: boolean) => { if (!account) return; write(noticeKey(account, 'off'), value ? null : '1'); if (value) write(noticeKey(account, 'snooze'), null); },
    snooze: () => { if (account) write(noticeKey(account, 'snooze'), String(Date.now() + SNOOZE_MS)); }
  };
}
