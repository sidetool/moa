import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, MonitorPlay } from 'lucide-react';
import { api } from '../../lib/api';
import { cx } from '../../lib/format';
import { Button, ConfirmDialog } from '../../components/ui';

interface YouTubeConfig { configured: boolean; source: 'environment' | 'database' | 'none'; hasSavedCredential: boolean; regionCode: string }
type YouTubePatch = { apiKey: string } | { clear: true } | { regionCode: string };

const youtubeKey = ['youtube-config'] as const;
const REGION = /^[A-Z]{2}$/;
const regionNames = (() => { try { return new Intl.DisplayNames(['ko'], { type: 'region' }); } catch { return null; } })();
const regionName = (code: string) => { try { const name = REGION.test(code) ? regionNames?.of(code) : undefined; return name && name !== code ? name : null; } catch { return null; } };

/** Admin-only, optional: a YouTube Data API key lets the server precheck existing trailer candidates.
 *  Write-only like TMDB; without it trailers open as before and fall back on playback errors. */
export function YouTubeSettings() {
  const client = useQueryClient();
  const config = useQuery({ queryKey: youtubeKey, queryFn: () => api<YouTubeConfig>('/admin/youtube/config'), staleTime: 60_000 });
  const [draft, setDraft] = useState('');
  const [region, setRegion] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: YouTubePatch) => api<YouTubeConfig>('/admin/youtube/config', { method: 'PATCH', body }),
    onSuccess: (data, body) => {
      client.setQueryData(youtubeKey, data);
      setDeleting(false);
      if ('regionCode' in body) { setRegion(null); setMessage({ text: '적용했어요.' }); }
      else { setDraft(''); setMessage({ text: 'clear' in body ? '키를 지웠어요.' : '키를 저장했어요.' }); }
    },
    onError: (_, body) => setMessage({ text: 'regionCode' in body ? '국가 코드를 확인해 주세요.' : 'clear' in body ? '키를 지우지 못했어요.' : '키를 저장하지 못했어요. 키를 확인해 주세요.', error: true })
  });

  const c = config.data;
  const value = draft.trim();
  const fromEnv = c?.source === 'environment';
  // The server only stores the key (no check with Google), so the pill says where it comes from, not that it works.
  const status = config.isPending ? '확인 중' : !c ? '알 수 없음' : !c.configured ? '선택 사항' : fromEnv ? '환경 변수 키' : '키 저장됨';
  const regionDraft = region ?? c?.regionCode ?? 'KR';
  const regionValid = REGION.test(regionDraft);
  const regionLabel = regionName(regionDraft);

  return <div className="tmdb-setting youtube-setting">
    <div className="setting">
      <span className="setting-icon"><MonitorPlay size={20} /></span>
      <div><span className="metadata-title"><b>예고편 확인 (YouTube)</b><span className={cx('status-pill', c?.configured && 'is-ok')}>{status}</span></span><small>재생 가능한 예고편을 먼저 확인해요.</small></div>
    </div>
    {config.isError && <p className="settings-error" role="alert">YouTube 설정을 불러오지 못했어요. <button className="text-btn" onClick={() => void config.refetch()}>다시 시도</button></p>}
    {c && <div className="tmdb-key">
      {fromEnv
        ? <p className="settings-hint metadata-locked"><Lock size={14} aria-hidden="true" /><span>서버 설정에서 관리하는 키예요.</span></p>
        : <form className="tmdb-key-form" onSubmit={e => { e.preventDefault(); if (value) save.mutate({ apiKey: value }); }}>
          <label htmlFor="youtube-key">{c.hasSavedCredential ? '새 키로 바꾸기' : 'YouTube Data API 키'}</label>
          <div className="tmdb-key-row">
            <input id="youtube-key" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              placeholder={c.hasSavedCredential ? '저장됨' : 'YouTube Data API v3 키'} value={draft} onChange={e => { setDraft(e.target.value); setMessage(null); }} />
            <Button type="submit" variant="primary" disabled={!value || save.isPending}>{save.isPending && 'apiKey' in (save.variables ?? {}) ? '저장 중…' : '저장'}</Button>
          </div>
          {c.hasSavedCredential && <button type="button" className="text-btn tmdb-clear" disabled={save.isPending} onClick={() => { setMessage(null); setDeleting(true); }}>저장한 키 지우기</button>}
        </form>}
      <form className="tmdb-key-form" onSubmit={e => { e.preventDefault(); if (regionValid && regionDraft !== c.regionCode) save.mutate({ regionCode: regionDraft }); }}>
        <label htmlFor="youtube-region">재생 지역</label>
        <div className="tmdb-key-row youtube-region-row">
          <input id="youtube-region" className="youtube-region" inputMode="text" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={2} aria-describedby="youtube-region-hint"
            value={regionDraft} onChange={e => { setRegion(e.target.value.toUpperCase().replace(/[^A-Z]/g, '')); setMessage(null); }} />
          <span className="youtube-region-name">{regionValid ? regionLabel ?? '' : '두 글자 국가 코드'}</span>
          <Button type="submit" disabled={!regionValid || regionDraft === c.regionCode || save.isPending}>{save.isPending && 'regionCode' in (save.variables ?? {}) ? '저장 중…' : '적용'}</Button>
        </div>
        <small id="youtube-region-hint" className="settings-hint">국가 코드: 한국 KR · 일본 JP · 미국 US</small>
      </form>
      {message && <p className={message.error ? 'settings-error' : 'settings-hint'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </div>}
    {deleting && <ConfirmDialog title="YouTube 키 삭제" confirmLabel="삭제" busy={save.isPending} onClose={() => setDeleting(false)} onConfirm={() => save.mutate({ clear: true })}>저장한 YouTube 키를 지울까요?</ConfirmDialog>}
  </div>;
}
