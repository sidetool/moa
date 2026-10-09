import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, Trash2 } from 'lucide-react';
import type { SavedSubtitle } from '@moa/shared';
import { api, ApiError } from '../lib/api';
import { episodeTitle, fileSize } from '../lib/format';
import { exportSubtitle } from '../player/subtitle-files';
import { Button, ConfirmDialog, IconButton, Skeleton } from './ui';

const key = ['admin', 'subtitles'];
const url = (row: SavedSubtitle) => `/admin/subtitles/${row.source}/${encodeURIComponent(row.id)}`;
const chapter = (episode: SavedSubtitle['episodes'][number]) => {
  const title = episodeTitle(episode.title);
  return `${episode.mediaTitle} · 시즌 ${episode.season} · ${episode.number}화${title === `${episode.number}화` ? '' : ` · ${title}`}`;
};

export function SubtitleLibrarySettings() {
  const client = useQueryClient();
  const subtitles = useQuery({ queryKey: key, queryFn: ({ signal }) => api<SavedSubtitle[]>('/admin/subtitles', { signal }) });
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<SavedSubtitle[] | null>(null);
  const remove = useMutation({
    mutationFn: async (rows: SavedSubtitle[]) => {
      const failed: SavedSubtitle[] = []; let running = false;
      for (const row of rows) {
        try { await api(url(row), { method: 'DELETE' }); }
        catch (error) { failed.push(row); running ||= error instanceof ApiError && error.code === 'translation-running'; }
      }
      return { failed, running };
    },
    onSuccess: ({ failed, running }, rows) => {
      setSelected(current => current.filter(id => !rows.some(row => url(row) === id) || failed.some(row => url(row) === id)));
      setDeleting(failed.length ? failed : null);
      setError(failed.length ? `${failed.length}개 자막을 삭제하지 못했어요.${running ? ' 번역 중인 자막은 작업이 끝난 뒤 삭제해 주세요.' : ' 다시 시도해 주세요.'}` : null);
      void client.invalidateQueries({ queryKey: key });
    }
  });
  const rows = (subtitles.data ?? []).filter(row => `${row.name} ${row.title} ${row.profile ?? ''} ${row.episodes.map(chapter).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selectedRows = rows.filter(row => selected.includes(url(row)));
  return <section className="settings-group" id="saved-subtitles">
    <h2>저장한 자막</h2>
    <div className="settings-card">
      <div className="setting setting-stack">
        <div><b>{subtitles.data?.length ?? 0}개 · {fileSize((subtitles.data ?? []).reduce((sum, row) => sum + row.bytes, 0))}</b><small>자막의 회차를 눌러 영상을 재생하거나 자막을 내려받고 삭제할 수 있어요.</small></div>
        <label className="field"><input type="search" aria-label="저장한 자막 검색" placeholder="파일·작품·회차·프로필 이름" value={search} disabled={remove.isPending} onChange={event => { setSearch(event.target.value); setSelected([]); }} /></label>
      </div>
      {!!rows.length && <div className="list-selection"><label><input type="checkbox" aria-label="표시된 자막 모두 선택" checked={selectedRows.length === rows.length} ref={input => { if (input) input.indeterminate = selectedRows.length > 0 && selectedRows.length < rows.length; }} disabled={remove.isPending} onChange={event => setSelected(event.target.checked ? rows.map(url) : [])} />전체 선택</label><span>{selectedRows.length}개 선택</span><Button icon={<Trash2 size={16} />} disabled={!selectedRows.length || remove.isPending} onClick={() => { setError(null); setDeleting(selectedRows); }}>선택 삭제</Button></div>}
      {subtitles.isPending ? <Skeleton className="folder-sk" /> : subtitles.isError ? <p className="settings-error" role="alert">저장한 자막을 불러오지 못했어요. <button className="text-btn" onClick={() => void subtitles.refetch()}>다시 시도</button></p> : rows.length ? rows.map(row => <div className="setting" key={`${row.source}:${row.id}`}>
        <input className="selection-checkbox" type="checkbox" aria-label={`${row.name} 선택`} checked={selected.includes(url(row))} disabled={remove.isPending} onChange={event => setSelected(current => event.target.checked ? [...current, url(row)] : current.filter(id => id !== url(row)))} />
        <div><b>{row.name}</b>{row.episodes.length ? row.episodes.map(episode => <Link key={episode.id} className="text-btn" to={`/watch/${encodeURIComponent(episode.id)}`}><Play size={14} aria-hidden="true" /><span>{chapter(episode)}</span></Link>) : <small>{row.title} · 연결된 영상 없음</small>}<small>{row.source === 'translation' ? `AI 번역${row.complete ? '' : ' · 일부'}` : row.source === 'online' ? '온라인 자막' : `가져온 자막 · ${row.profile}`} · {row.format.toUpperCase()} · {fileSize(row.bytes)}</small></div>
        <span className="network-actions">
        <IconButton label={`${row.name} 다운로드`} onClick={() => void exportSubtitle({ id: row.id, label: row.name, source: row.source, format: row.format, url: `/api${url(row)}/content` }, row.source === 'upload' ? row.name.replace(/\.[^.]+$/, '') : row.title).catch(() => setError('자막을 내려받지 못했어요. 다시 시도해 주세요.'))}><Download size={18} /></IconButton>
        <IconButton label={`${row.name} 삭제`} disabled={remove.isPending} onClick={() => { setError(null); setDeleting([row]); }}><Trash2 size={18} /></IconButton>
        </span>
      </div>) : <p className="settings-hint">{search ? '검색 결과가 없어요.' : '저장한 자막이 없어요.'}</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
    {deleting && <ConfirmDialog title="자막 삭제" confirmLabel="삭제" busy={remove.isPending} onClose={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting)}>{deleting.length === 1 ? `‘${deleting[0].name}’ 자막을` : `선택한 자막 ${deleting.length}개를`} 서버에서 삭제할까요? 삭제한 자막은 복구할 수 없어요.{error && <p className="settings-error" role="alert">{error}</p>}</ConfirmDialog>}
  </section>;
}
