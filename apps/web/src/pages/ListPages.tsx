import { GroupedSearch } from '../features/catalog/GroupedFeed';
import { hasLoginGate } from "../lib/api";
import { Bookmark, ChevronRight, History, LogOut, Search as SearchIcon, Settings as SettingsIcon, Trash2, UsersRound, X } from "lucide-react";
import type { HistoryEntry, Settings } from "@moa/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSources } from "./SourcesPage";
import { keys, useHistory, useMe, useProfiles, useSearch, useSettings, useWatchlist } from "../api/queries";
import { PosterCard } from "../components/Cards";
import { Avatar } from "../features/layout/AppShell";
import { clearResumeScenes } from '../player/playback/resume-scene';
import { logout } from "./AccountsPage";
import { Artwork } from "../components/Artwork";
import { Button, ConfirmDialog, EmptyState, ProgressBar, ScrollLoader, Skeleton, Toggle, Select } from "../components/ui";
import { api, currentProfileId, setCurrentProfileId } from "../lib/api";
import { clock } from "../lib/format";
import { settledQuery, useSettledQuery } from "../lib/search-input";

function GridSkeleton({ count = 12 }: { count?: number }) {
  return <div className="grid" aria-hidden="true">{Array.from({ length: count }, (_, i) => <div key={i} className="card poster-card"><Skeleton className="art art-poster" /><Skeleton className="sk-text" style={{ width: "70%", marginTop: 10 }} /></div>)}</div>;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [value, setValue] = useState(q);
  const result = useSearch(q);
  const sources = useSources();
  const installed = sources.data?.filter(s => s.enabled) || [];
  const input = useRef<HTMLInputElement>(null);

  // Mobile has no search box in the header; this one mirrors the URL (without eating a space being typed).
  useEffect(() => { setValue(value => settledQuery(value) === q ? value : q); }, [q]);
  const commit = (query: string) => setParams(query ? { q: query } : {}, { replace: true });
  useSettledQuery(value, q, commit);

  const groups = result.data?.groups.filter(group => group.items.length || group.error) ?? [];
  const local = groups.flatMap(group => group.items).sort((a, b) => Number(!!a.genreMatch) - Number(!!b.genreMatch));
  return (
    <div className="page-pad search-page">
      <div className="searchbox searchbox-page">
        <SearchIcon size={20} aria-hidden="true" />
        <input ref={input} type="search" value={value} placeholder="제목, 장르 검색" aria-label="검색" onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { const query = settledQuery(event.currentTarget.value); if (query !== q) commit(query); } }} />
        {value && <button className="searchbox-clear" aria-label="지우기" onClick={() => { setValue(""); commit(""); input.current?.focus(); }}><X size={18} /></button>}
      </div>
      {!q && <EmptyState icon={<SearchIcon size={40} />} title="무엇을 볼까요?" body="내 라이브러리와 설치된 소스에서 한 번에 찾습니다." />}
      {q && result.isSuccess && !groups.length && !installed.length && <EmptyState title={`'${q}'에 대한 결과가 없습니다`} body="다른 제목이나 원제로 검색해 보세요." />}
      {q && <GroupedSearch key={q} sources={installed} query={q} local={local} pending={result.isPending || sources.isPending}/>}

    </div>
  );
}

export function MyListPage() {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') === 'updated' ? 'updated' : 'saved';
  function setSort(value: string) {
    if (value === sort) return;
    const next = new URLSearchParams(params);
    if (value === 'updated') next.set('sort', value);
    else next.delete('sort');
    setParams(next, { replace: true });
  }
  const list = useWatchlist(sort);
  const client = useQueryClient();
  const profile = currentProfileId();
  const revision = useRef<{ profile: string | null; value: number } | undefined>(undefined);
  const refresh = useQuery({
    queryKey: ['watchlist-refresh', profile],
    queryFn: ({ signal }) => api<{ running: boolean; revision: number }>('/watchlist/refresh-status', { signal }),
    refetchOnMount: 'always',
    refetchInterval: query => query.state.data?.running ? 2000 : 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!refresh.data || profile !== currentProfileId()) return;
    const previous = revision.current;
    revision.current = { profile, value: refresh.data.revision };
    const lastSeen = previous?.profile === profile ? previous.value : 0;
    if (lastSeen !== refresh.data.revision) {
      // Even the first status response can describe a batch that finished after
      // the list request began. Replace any in-flight read of that older snapshot.
      const scope = { queryKey: [...keys.watchlist, profile] };
      void client.cancelQueries(scope).then(() => {
        if (profile === currentProfileId()) return client.invalidateQueries(scope);
      });
    }
  }, [refresh.data, profile, client]);
  const navigate = useNavigate();
  return (
    <div className="page-pad">
      <header className="page-head page-head-row"><h1>내 목록</h1>{!!list.data?.length && <Select aria-label="내 목록 정렬" value={sort} onChange={setSort} options={[{ value: "saved", label: "담은 순" }, { value: "updated", label: "회차 업데이트순" }]} />}</header>
      {list.isError && <p className="settings-error" role="alert">목록을 불러오지 못했어요. <button className="text-btn" onClick={() => void list.refetch()}>다시 시도</button></p>}
      {list.isPending && <GridSkeleton />}
      {list.data?.length === 0 && <EmptyState icon={<Bookmark size={40} />} title="아직 담은 작품이 없습니다" body="작품 상세 화면에서 '내 목록'을 누르면 여기에 모입니다." action={<Button variant="primary" onClick={() => navigate("/")}>둘러보기</Button>} />}
      {!!list.data?.length && <div className="grid">{list.data.map(card => <PosterCard key={card.id} identity={card.id} card={card} showUnseen />)}</div>}
    </div>
  );
}

export function HistoryPage() {
  const settings = useSettings();
  const history = useHistory();
  const firstEntry = history.data?.pages[0]?.items[0];
  const grouping = firstEntry ? firstEntry.groupedCount !== undefined : settings.data?.groupHistory;
  const profile = currentProfileId();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  // A grouped entry stands for the whole title, so deleting it clears every episode's record.
  const remove = async (entry: HistoryEntry, opener?: HTMLButtonElement) => {
    setBusy(true); setError("");
    try {
      const grouped = entry.groupedCount !== undefined;
      await api(grouped ? `/history/media/${encodeURIComponent(entry.media.id)}` : `/history/${encodeURIComponent(entry.episode.id)}`, { method: "DELETE" });
      if (profile) clearResumeScenes(profile, grouped ? { mediaId: entry.media.id } : { episodeId: entry.episode.id });
      if (opener && document.activeElement === opener) {
        const row = opener.closest("li");
        const neighbor = row?.nextElementSibling ?? row?.previousElementSibling;
        (neighbor?.querySelector<HTMLElement>(".history-body") ?? heading.current)?.focus();
      }
      setConfirm(null);
      void client.invalidateQueries({ queryKey: ["recommendations"] });
      void client.invalidateQueries({ queryKey: ["grouped-cards"] });
      void client.invalidateQueries({ queryKey: ["home"] });
      await client.invalidateQueries({ queryKey: [...keys.history, profile] });
    } catch {
      setError("기록을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally { setBusy(false); }
  };
  const setGrouping = async (groupHistory: boolean) => {
    setSaving(true); setError("");
    try {
      const saved = await api<Settings>("/settings", { method: "PATCH", body: { groupHistory } });
      if (currentProfileId() !== profile) return;
      client.setQueryData(keys.settings, saved);
      await client.resetQueries({ queryKey: [...keys.history, profile] });
    } catch { setError("설정을 저장하지 못했어요."); }
    finally { setSaving(false); }
  };
  const entries = history.data?.pages.flatMap(page => page.items) ?? [];
  const items = [...new Map(entries.map(entry => [grouping ? entry.media.id : entry.episode.id, entry])).values()];
  const retry = () => history.isFetchNextPageError ? history.fetchNextPage() : history.refetch();
  return (
    <div className="page-pad">
      <header className="page-head page-head-row">
        <h1 ref={heading} tabIndex={-1}>시청 기록</h1>
        {grouping !== undefined && <label className="history-grouping"><span>작품별로 보기</span><Toggle label="작품별로 보기" checked={grouping} aria-disabled={saving || busy} onChange={value => void setGrouping(value)} /></label>}
      </header>
      {error && !confirm && <p className="history-error" role="alert">{error}</p>}
      {history.isPending && <div className="history-list">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="history-sk" />)}</div>}
      {history.isSuccess && !items.length && <EmptyState icon={<History size={40} />} title="시청 기록이 없습니다" />}
      <ul className="history-list">
        {items.map(entry => {
          const p = entry.episode.progress;
          const count = entry.groupedCount;
          const rowId = count !== undefined ? `media:${entry.media.id}` : `episode:${entry.episode.id}`;
          const episodes = count !== undefined && count > 1 ? `${count}개 회차` : null;
          return (
            <li key={rowId} className="history-item">
              <Link to={`/watch/${encodeURIComponent(entry.episode.id)}`} className="history-thumb" aria-label={`${entry.media.title} ${entry.media.type === "movie" ? "" : entry.episode.title} 재생`}>
                <Artwork src={entry.episode.thumb ?? entry.media.backdrop} title={entry.media.title} ratio="landscape" width={320} labelFallback={false} />
                {p && <ProgressBar ratio={p.completed ? 1 : p.position / Math.max(1, p.duration)} className="card-progress" />}
              </Link>
              <Link to={`/title/${encodeURIComponent(entry.media.id)}`} className="history-body" data-remote-id={`history-title:${rowId}`}>
                <b>{entry.media.title}</b>
                <span>{entry.media.type === "movie" ? "" : `${count !== undefined ? "최근 " : ""}${entry.episode.title} · `}{p?.completed ? "시청 완료" : p ? `${clock(p.position)} / ${clock(p.duration)}` : ""}</span>
                <small>{[new Date(entry.watchedAt).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }), episodes].filter(Boolean).join(" · ")}</small>
              </Link>
              <button className="icon-btn" data-remote-id={`history-delete:${rowId}`}
                aria-label={count !== undefined ? `${entry.media.title} 작품 기록 모두 삭제` : "기록에서 삭제"}
                title={count !== undefined ? "작품 기록 모두 삭제" : "기록에서 삭제"} aria-disabled={busy || saving}
                onClick={event => {
                  if (busy || saving) return;
                  if (count !== undefined && count > 1) { setError(""); setConfirm(entry); }
                  else void remove(entry, event.currentTarget);
                }}>
                {count !== undefined ? <Trash2 size={18} /> : <X size={18} />}
              </button>
            </li>
          );
        })}
      </ul>
      {history.isError && <EmptyState title="시청 기록을 불러오지 못했어요" action={<Button onClick={() => void retry()}>다시 시도</Button>} />}
      <ScrollLoader hasMore={history.hasNextPage} loading={history.isFetching || saving || busy} failed={history.isError} onLoad={history.fetchNextPage} />
      {confirm && <ConfirmDialog title="작품 기록을 모두 삭제할까요?" confirmLabel="모두 삭제" busy={busy} onConfirm={() => void remove(confirm)} onClose={() => { setConfirm(null); setError(""); }}>
        <p>‘{confirm.media.title}’의 {confirm.groupedCount}개 회차 기록과 이어볼 위치가 모두 지워져요.</p>
        {error && <p className="history-error" role="alert">{error}</p>}
      </ConfirmDialog>}
    </div>
  );
}

/** Mobile "마이" tab: profile, shortcuts to history / library / settings. */
export function MePage() {
  const profiles = useProfiles();
  const navigate = useNavigate();
  const profile = profiles.data?.find(item => item.id === currentProfileId());
  const me = useMe();
  const link = (to: string, icon: React.ReactNode, label: string) => (
    <Link to={to} className="me-link">{icon}<span>{label}</span><ChevronRight size={18} /></Link>
  );
  return (
    <div className="page-pad me-page">
      <div className="me-head"><Avatar profile={profile} size={64} /><div><b>{profile?.name}</b><button className="text-btn" onClick={() => { setCurrentProfileId(null); navigate("/profiles"); }}><UsersRound size={14} />프로필 전환</button></div></div>
      <nav className="me-links">
        {link("/history", <History size={20} />, "시청 기록")}
        {link("/my-list", <Bookmark size={20} />, "내 목록")}
        {link("/settings", <SettingsIcon size={20} />, "설정")}
        {hasLoginGate && <button className="me-link" onClick={() => void logout()}><LogOut size={20} /><span>로그아웃{me.data && <small> · {me.data.username}</small>}</span><ChevronRight size={18} /></button>}
      </nav>
    </div>
  );
}
