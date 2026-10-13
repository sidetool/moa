import { useTitleGrouping } from '../lib/device-prefs';
import { useMemo } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BrowseSchema, BrowseSelection, MediaCard, NavigationTab, Row as RowData, VideoSource } from '@moa/shared';
import { api, currentProfileId } from '../lib/api';
import { categorySelection, sourcePage, sourceUrl } from '../lib/source-browse';
import { Row, RowSkeleton } from './Row';
import { PosterCard } from './Cards';
import { baseTitle, compareSeason, foreignCode, relevance, withLang } from '../lib/card-meta';
import { cx } from '../lib/format';

export function useGroupedCards(cards: MediaCard[], query?: string) {
  const groupingEnabled = useTitleGrouping();
  const ids = [...new Set(cards.map(c => c.id))].slice(0, 1000);
  const result = useQuery({
    queryKey: ['grouped-cards', ids, query],
    queryFn: ({ signal }) => api<MediaCard[]>('/media/groups/resolve', { method: 'POST', body: query ? { ids, query } : { ids }, signal }),
    // Preserve grouped cards for incremental arrivals, never across a new query or removed sources.
    placeholderData: (previous, previousQuery) => {
      const previousIds = previousQuery?.queryKey[1] as string[] | undefined;
      return ids.length && previousQuery?.queryKey[2] === query && previousIds?.every(id => ids.includes(id))
        ? keepPreviousData(previous) : undefined;
    },
    enabled: groupingEnabled && !!ids.length, staleTime: 30_000, retry: false
  });
  return { ...result, groupingEnabled };
}

type SourceList = { items: MediaCard[]; unsupported: boolean; selection?: BrowseSelection };

/** Popular + latest lists for every source of a tab, fetched independently. */
export function useTabFeed(sources: VideoSource[], tab?: NavigationTab) {
  const popular = useQueries({ queries: sources.map(source => ({
    queryKey: ['tab-source', source.id, tab?.id, tab?.sourceFilters?.[source.id]],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SourceList> => {
      let selection: BrowseSelection | undefined = tab?.sourceFilters?.[source.id];
      if (!selection && ['movies', 'series'].includes(tab?.id || '')) {
        const schema = await api<BrowseSchema>(`/sources/${source.id}/filters`, { signal });
        selection = categorySelection(schema, tab?.id);
        if (!selection) return { items: [], unsupported: true, selection };
      }
      const page = await sourcePage(source.id, 'popular', '', 1, selection, signal);
      return { items: page.items, unsupported: false, selection };
    },
    staleTime: 5 * 60_000, retry: false
  })) });
  // "Latest" only makes sense for the unfiltered catalogue of on-demand sources.
  const latest = useQueries({ queries: sources.map(source => ({
    queryKey: ['tab-source-latest', source.id],
    queryFn: ({ signal }: { signal: AbortSignal }) => sourcePage(source.id, 'latest', '', 1, undefined, signal),
    enabled: !source.live && !tab?.sourceFilters?.[source.id] && !['movies', 'series'].includes(tab?.id || ''),
    staleTime: 5 * 60_000, retry: false
  })) });

  // The hero keeps its mixed catalogue; TOP 10 combines ranks separately.
  const onDemand = sources.map((s, i) => s.live ? [] : popular[i].data?.items ?? []);
  const mixed: MediaCard[] = [];
  for (let i = 0; i < Math.max(0, ...onDemand.map(list => list.length)); i++) for (const list of onDemand) if (list[i]) mixed.push(list[i]);
  const rankingLists=sources.flatMap((source,i)=>source.live||!popular[i].data?.items.length?[]:[{sourceId:source.id,ids:popular[i].data!.items.slice(0,20).map(c=>c.id)}]);
  const ranking=useQuery({
    queryKey:['source-popularity',currentProfileId(),rankingLists],
    queryFn:({signal})=>api<MediaCard[]>('/media/popular',{method:'POST',body:{lists:rankingLists},signal}),
    enabled:rankingLists.length>0,staleTime:5*60_000,retry:false
  });
  const grouped = useGroupedCards(mixed);
  const settled = !grouped.groupingEnabled || !mixed.length || !grouped.isPending || grouped.isError;
  const cards = !grouped.groupingEnabled || grouped.isError ? mixed : mixed.length ? grouped.data || [] : [];
  return {
    sources, popular, latest,
    top: rankingLists.length ? ranking.data ?? [] : [],
    topPending: (popular.some(p=>p.isPending)&&!rankingLists.length)||(rankingLists.length>0&&ranking.isPending),
    cards: settled ? cards : [],
    pending: popular.some(p => p.isPending) && !mixed.length || !settled
  };
}

export type TabFeedData = ReturnType<typeof useTabFeed>;

export function TabFeed({ feed, startIndex = 0 }: { feed: TabFeedData; startIndex?: number }) {
  const { sources, popular, latest } = feed;
  const single = sources.filter(s => !s.live).length <= 1;
  const top = feed.top;
  const rows: React.ReactNode[] = [];
  let index = startIndex;
  const push = (key: string, node: React.ReactNode) => rows.push(<FeedSlot key={key}>{node}</FeedSlot>);

  if (top.length >= 5) push('top', <Row index={index++} rank row={{ id: 'top10', title: '오늘의 TOP 10', kind: 'media', layout: 'poster', items: top }} />);
  else if (feed.topPending) push('top-sk', <RowSkeleton />);

  const firstOnDemand = sources.findIndex(s => !s.live);
  if (firstOnDemand < 0) push('live', <LiveSlot sources={sources} popular={popular} />);
  sources.forEach((source, i) => {
    if (source.live) return;
    const p = popular[i], l = latest[i];
    const name = (label: string) => single ? label : `${source.name} · ${label}`;
    if (p.isPending) push(`${source.id}-p`, <RowSkeleton />);
    else if (p.isError) push(`${source.id}-p`, <RowError title={source.name} retry={() => void p.refetch()} />);
    else if (p.data.items.length) push(`${source.id}-p`, <Row index={index++} row={{ id: `pop-${source.id}`, title: name(p.data.selection ? '추천' : '지금 인기'), kind: 'media', layout: 'poster', items: p.data.items.slice(0, 24), more: { path: sourceUrl(source.id, p.data.selection) } }} />);
    if (l.data?.items.length) push(`${source.id}-l`, <Row index={index++} row={{ id: `new-${source.id}`, title: name('최신 업데이트'), kind: 'media', layout: 'poster', items: l.data.items.slice(0, 24), more: { path: `${sourceUrl(source.id)}?mode=latest` } }} />);
    else if (l.isPending && l.fetchStatus !== 'idle') push(`${source.id}-l`, <RowSkeleton />);
    // Live channels sit after the first on-demand source, like a channel shelf.
    if (i === firstOnDemand) push('live', <LiveSlot sources={sources} popular={popular} />);
  });

  const unsupported = sources.filter((s, i) => popular[i].data?.unsupported);
  return <>
    {rows}
    {!!unsupported.length && <p className="feed-note">{unsupported.map(s => s.name).join(', ')}은(는) 이 탭의 분류를 지원하지 않아 숨겼어요. <Link to="/settings/tabs">표시 조건 고르기</Link></p>}
  </>;
}

function FeedSlot({ children }: { children: React.ReactNode }) { return <>{children}</>; }

/** Live shelves, rendered in one slot so they keep their position in the feed. */
function LiveSlot({ sources, popular }: { sources: VideoSource[]; popular: TabFeedData['popular'] }) {
  return <>{sources.map((source, i) => {
    if (!source.live) return null;
    const p = popular[i];
    if (p.isPending) return <RowSkeleton key={source.id} layout="landscape" />;
    if (p.isError) return <RowError key={source.id} title={source.name} retry={() => void p.refetch()} />;
    if (!p.data.items.length) return null;
    const row: RowData = { id: `live-${source.id}`, title: `실시간 채널 · ${source.name}`, kind: 'media', layout: 'landscape', items: p.data.items.slice(0, 24), more: { path: sourceUrl(source.id) } };
    return <Row key={source.id} row={row} />;
  })}</>;
}

function RowError({ title, retry }: { title: string; retry: () => void }) {
  return <section className="row row-error" role="alert">
    <header className="row-head"><h2>{title}</h2></header>
    <p>소스에 연결하지 못했어요. <button className="text-btn" onClick={retry}>다시 시도</button></p>
  </section>;
}

/** Search results in reading order: the best-matching franchise first (relevance only orders, never hides), its seasons in sequence, movies and OADs after. */
function byFranchise(cards: MediaCard[]) {
  const key = (card: MediaCard) => baseTitle(card).toLowerCase().replace(/[\s:·~\-\[\]()]+/g, '');
  const rank = new Map<string, { score: number; first: number }>();
  cards.forEach((card, i) => {
    const k = key(card), score = relevance(card) ?? 0, seen = rank.get(k);
    if (!seen) rank.set(k, { score, first: i }); else seen.score = Math.max(seen.score, score);
  });
  return [...cards].sort((a, b) => {
    const x = rank.get(key(a))!, y = rank.get(key(b))!;
    return y.score - x.score || x.first - y.first || compareSeason(a, b);
  });
}

export function GroupedSearch({ sources, query, local, pending = false }: { sources: VideoSource[]; query: string; local: MediaCard[]; pending?: boolean }) {
  const pages = useQueries({ queries: sources.map(s => ({ queryKey: ['source-page', s.id, 'search', query], queryFn: ({ signal }: { signal: AbortSignal }) => sourcePage(s.id, 'search', query, 1, undefined, signal), staleTime: 60_000, retry: false })) });
  const all = [...pages.flatMap(p => p.data?.items || []), ...local], grouped = useGroupedCards(all, query);
  const langs = useMemo(() => new Map(sources.map(s => [s.id, s.lang])), [sources]);
  const cards = (!grouped.groupingEnabled || grouped.isError ? all : all.length ? grouped.data || [] : []).map(card => withLang(card, langs));
  const searching = pending || pages.some(p => p.isPending) || (grouped.groupingEnabled && !!all.length && grouped.isFetching);
  // Sources with nothing to show stay out of the way; pending and failed ones still say so.
  const chips = sources.map((source, i) => ({ source, page: pages[i] })).filter(({ page }) => page.isPending || page.isError || !!page.data?.items.length);
  return <>
    {!!chips.length && <div className="search-sources no-scrollbar">
      {chips.map(({ source, page }) => {
        const code = foreignCode(source.lang);
        return <Link className={cx('chip', page.isError && 'is-failed')} key={source.id} to={`/sources/${source.id}?q=${encodeURIComponent(query)}`}>
          {source.name}{code && <i className="lang-tag">{code.toUpperCase()}</i>}
          <small>{page.isPending ? '…' : page.isError ? '실패' : page.data?.items.length}</small>
        </Link>;
      })}
    </div>}
    {(cards.length > 0 || searching) && <div className="grid">
      {byFranchise(cards).map(c => <PosterCard key={c.id} card={c} />)}
      {searching && Array.from({ length: cards.length ? 6 : 12 }, (_, i) => <div key={`pending-${i}`} className="card poster-card" aria-hidden="true"><span className="sk art art-poster" /></div>)}
    </div>}
    {!cards.length && !searching && <p className="search-empty">‘{query}’에 대한 결과가 없어요. 다른 제목으로 검색해 보세요.</p>}
  </>;
}
