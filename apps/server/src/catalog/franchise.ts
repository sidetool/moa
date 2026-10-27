import type { Franchise, FranchiseSeason, MediaCard } from '@moa/shared';
import type { Catalog } from './service.js';
import type { Sources } from '../sources/service.js';
import type { Tmdb } from '../metadata/tmdb.js';
import type { TitleGroups } from './title-groups.js';
import { parseSeasonInfo } from './season-info.js';
import { titleGroupSeason } from './title-groups.js';
import { LOCAL_PROVIDER } from './service.js';
import { ApiFailure } from '../util.js';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export interface FranchiseMedia {
  card: MediaCard;
  title: string;
  link?: { id: number; kind: string; season?: number };
  metadata?: { title?: string; originalTitle?: string; seasons?: Record<string, { episodes?: number; year?: number }> };
  seasons: { number: number; count: number }[];
  group?: string;
}
function parsed(m: FranchiseMedia) {
  const inferred = titleGroupSeason(m.title, m.metadata?.title);
  const title = inferred && parseSeasonInfo(m.title).season == null ? m.title.replace(/\s(?:[1-9]\d?|II|III|IV|V|VI|VII|VIII|IX|X)$/i, '') : m.title;
  return parseSeasonInfo(title, { kind: m.link?.kind, season: m.link?.season ?? inferred });
}
function regular(m: FranchiseMedia) {
  const p = parsed(m);
  if (m.link?.season === 0 || m.card.type === 'movie' || m.link?.kind === 'movie' || ['movie','ova','special'].includes(p.seasonInfo?.kind || '')) return false;
  if (/총집|재편집|실사|\b(?:chronicle|recap|live[ -]action|spin[ -]?off)\b/i.test(m.title)) return false;
  const identity = norm(p.identityTitle);
  const titles = [m.metadata?.title, m.metadata?.originalTitle].filter((t): t is string => !!t).map(norm);
  // A named TV arc needs an explicit, accepted season link. A shared parent TV ID alone
  // must not admit a subtitle/spinoff. Punctuation-only title differences are harmless.
  const subtitle = norm(p.identityTitle) !== norm(p.baseTitle) || /\s[-–—]\s/.test(p.identityTitle);
  // A Japanese title may be repeated in romanization after its English title.
  // Keep this narrow: arbitrary Latin subtitles are still editions, not seasons.
  const bilingual = m.link?.kind === 'tv' && m.card.type === 'anime'
    && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(m.metadata?.originalTitle || '')
    && /[:：].*\bno\b/.test(p.identityTitle) && /[:：]\s*\p{Script=Latin}[\p{Script=Latin}\p{M}\s'’.-]*$/u.test(p.identityTitle)
    && !/\b(?:arc|story|stories|chronicles?|gaiden|side|adventures?)\b/i.test(p.identityTitle);
  if (subtitle && !bilingual && !titles.includes(identity) && !(m.link?.season && /편\s*$/.test(p.identityTitle))) return false;
  if (m.metadata?.title && identity.startsWith(norm(m.metadata.title)) && identity !== norm(m.metadata.title)
    && !(m.link?.season && /편\s*$/.test(p.identityTitle))) return false;
  return true;
}
export function franchiseIdentity(m: FranchiseMedia) {
  return m.link?.kind === 'tv' ? `tv:${m.link.id}:${m.card.type}` : `${m.card.type}:${norm(parsed(m).baseTitle)}`;
}
export function buildFranchise(current: FranchiseMedia, media: FranchiseMedia[], complete = true): Franchise {
  const base = parsed(current).baseTitle;
  if (!regular(current)) return {title:current.metadata?.title || base,seasons:[],complete};
  const aliases = new Set([base, current.metadata?.title, current.metadata?.originalTitle, current.card.baseTitle].filter((v): v is string => !!v).map(norm));
  const same = (m: FranchiseMedia) => {
    if (m.card.type !== current.card.type || !regular(m)) return false;
    if (current.link && m.link) return current.link.kind === 'tv' && m.link.kind === 'tv' && current.link.id === m.link.id;
    // Unlinked subtitles never acquire membership just because baseTitle discards them.
    return aliases.has(norm(parsed(m).identityTitle));
  };
  const candidates = media.filter(same);
  const finalNumbers = new Set(candidates.filter(m=>parsed(m).final && m.link?.season).map(m=>m.link!.season!));
  const confirmedFinal = finalNumbers.size === 1 ? [...finalNumbers][0] : undefined;
  const groupSources = new Map<string, Set<string>>();
  for (const m of candidates) {
    const key = m.group || m.card.id, set = groupSources.get(key) || new Set<string>();
    set.add(m.card.provider.id); groupSources.set(key, set);
  }
  type Row = FranchiseSeason & { groupSize: number; expected?: number };
  const buckets = new Map<string, Row[]>();
  for (const m of candidates) {
    const p = parsed(m), multi = m.seasons.filter(s => s.number > 0).length > 1;
    const local = m.card.provider.kind === 'local';
    const entries = multi || local ? m.seasons.filter(s => s.number > 0) : [{ number: p.season, count: m.seasons.reduce((n,s) => n + s.count,0) || m.card.episodeCount || 0 }];
    for (const entry of entries) {
      const season = multi || local ? entry.number : p.season ?? (p.final ? confirmedFinal : 1);
      const part = multi || local ? undefined : p.part;
      const final = !multi && !local && p.final;
      const key = `${season != null ? `s${season}` : 'final'}${part ? `p${part}` : ''}`;
      const label = `${final ? '파이널 시즌' : `시즌 ${season}`}${part ? ` · 파트 ${part}` : ''}`;
      const info = season ? m.metadata?.seasons?.[season] : undefined;
      const row: Row = { key, label, ...(season != null ? {season} : {}), ...(part ? {part} : {}), ...(final ? {final:true} : {}),
        mediaId:m.card.id, ...(multi || local ? {seasonNumber:entry.number} : {}),
        ...(entry.count > 0 ? {episodeCount:entry.count} : {}), ...(info?.year || m.card.year ? {year:info?.year || m.card.year} : {}),
        provider:m.card.provider, current:m.card.id === current.card.id,
        groupSize:groupSources.get(m.group || m.card.id)?.size || 1, expected:info?.episodes };
      const bucket = buckets.get(key) || []; bucket.push(row); buckets.set(key,bucket);
    }
  }
  const rank = (r: Row) => r.provider.id === current.card.provider.id ? 0 : r.provider.lang === 'ko' ? 1 : r.provider.lang === 'all' || r.provider.kind === 'local' ? 2 : 3;
  const sameSeason = (a: Row,b: Row) => a.season === b.season && (a.season != null || a.final === b.final);
  const fullCounts = (row: Row) => {
    const parts = [...buckets.values()].filter(rows=>rows[0].part && sameSeason(rows[0],row))
      .sort((a,b)=>a[0].part!-b[0].part!);
    const counts = parts.map(rows=>Math.max(...rows.map(r=>r.episodeCount || 0)));
    const contiguous = parts.length > 1 && parts.every((rows,i)=>rows[0].part===i+1) && counts.every(Boolean);
    return contiguous ? counts.reduce((a,b)=>a+b,0) : undefined;
  };
  const isFull = (row: Row) => {
    if (row.part || !row.episodeCount) return false;
    const sum = fullCounts(row);
    return Boolean(row.expected && row.episodeCount >= row.expected || sum && row.episodeCount >= sum);
  };
  const selected = [...buckets.values()].map(rows => {
    // A proven full season beats an unmarked partial cour; provider preference applies
    // among the full editions. Otherwise it could hide the actual 22-episode option.
    const full = rows.filter(isFull), eligible = full.length ? full : rows;
    eligible.sort((a,b) => rank(a)-rank(b) || (b.episodeCount || 0)-(a.episodeCount || 0) || b.groupSize-a.groupSize || a.mediaId.localeCompare(b.mediaId));
    return {...eligible[0], current:rows.some(r=>r.current)};
  });
  const seasons = selected.filter(row => {
    if (!row.part || row.current) return true;
    const full = selected.find(r => !r.part && r.season === row.season && (r.season != null || r.final === row.final));
    if (!full?.episodeCount) return true;
    // An unmarked 12-episode cour is not evidence of a whole 22-episode season.
    return !isFull(full);
  }).sort((a,b)=>(a.season ?? Infinity)-(b.season ?? Infinity) || (a.part || 0)-(b.part || 0))
    .map(({groupSize,expected,...row})=>row);
  return {title:current.metadata?.title || current.card.baseTitle || base, seasons, complete};
}

interface Discovery { expires: number; pending?: Promise<void> }
export class Franchises {
  private cache = new Map<string, Discovery>();
  private abort = new AbortController();
  async close() { this.abort.abort(); await Promise.allSettled([...this.cache.values()].flatMap(s=>s.pending ? [s.pending] : [])); }
  constructor(private catalog: Catalog, private groups: TitleGroups, private sources: Pick<Sources,'browse'>,
    private tmdb?: Pick<Tmdb,'ensure'>, private timeoutMs = 12_000, private ttlMs = 3*60*60_000) {}
  private snapshot(profile: string): FranchiseMedia[] {
    const db = this.catalog.db;
    const mapping = this.groups.mapping(profile);
    const enabled = new Map(db.all('SELECT id,entry FROM source_entries WHERE enabled=1 AND live=0').map(r=>[r.id, JSON.parse(r.entry).lang as string | undefined]));
    const counts = new Map<string, {number:number;count:number}[]>();
    for (const r of db.all('SELECT media_id,season,COUNT(*) AS n FROM episodes GROUP BY media_id,season')) {
      const list = counts.get(r.media_id) || []; list.push({number:r.season,count:r.n}); counts.set(r.media_id,list);
    }
    return db.all(`SELECT m.*,l.kind,l.tmdb_id,l.season,t.card AS tmdb_card FROM media m
      LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id`)
      .flatMap(r => {
        const meta = JSON.parse(r.metadata), provider = meta.provider || LOCAL_PROVIDER;
        if (!mapping.has(r.id) || meta.live || provider.kind !== 'local' && !enabled.has(provider.id) || /(?:\.{3}|…)\s*$/.test(r.title)) return [];
        const seasons = counts.get(r.id) || [];
        return [{ title:r.title, card:{id:r.id,title:r.title,type:r.type,
          provider:{...provider,...(enabled.get(provider.id) ? {lang:enabled.get(provider.id)} : {})},year:meta.year,
          episodeCount:seasons.reduce((n,s)=>n+s.count,0)}, group:mapping.get(r.id), seasons,
          ...(r.tmdb_id != null ? {link:{id:r.tmdb_id,kind:r.kind,season:r.season ?? undefined}} : {}),
          ...(r.tmdb_card ? {metadata:JSON.parse(r.tmdb_card)} : {}) }];
      });
  }
  get(id: string, profile: string): Franchise {
    this.catalog.kids.assert(id,profile);
    const media = this.snapshot(profile), current = media.find(m=>m.card.id === id);
    if (!current) throw new ApiFailure(404,'media-not-found');
    const active = this.catalog.db.all('SELECT id FROM source_entries WHERE enabled=1 AND live=0 AND type=? AND code IS NOT NULL ORDER BY id',current.card.type).map(r=>r.id as string);
    const key = JSON.stringify([profile,franchiseIdentity(current),active]);
    const now = Date.now();
    for (const [k,v] of this.cache) if (!v.pending && v.expires <= now) this.cache.delete(k);
    let state = this.cache.get(key);
    const initial = buildFranchise(current,media);
    const expected = Object.entries(current.metadata?.seasons || {}).filter(([n])=>Number(n)>0);
    const covered = expected.length > 0 && expected.every(([n,info])=>info.episodes && initial.seasons.some(s=>s.season===Number(n) && !s.part && (s.episodeCount || 0)>=info.episodes!));
    if (!state && !covered && active.length && regular(current) && !this.abort.signal.aborted) {
      state = {expires:Infinity}; this.cache.set(key,state);
      const entry = state;
      // Defer external work until after the fast DB response; cache is scoped by profile
      // (profile ownership is enforced by the app's account authentication hook).
      entry.pending = Promise.resolve().then(()=>this.discover(current,profile,active)).catch(()=>{}).finally(()=>{
        entry.pending = undefined; entry.expires = Date.now()+this.ttlMs;
      });
    }
    return {...initial,complete:!state?.pending};
  }
  private async discover(current: FranchiseMedia, profile: string, sources: string[]) {
    const queries = [...new Set([current.metadata?.title || parsed(current).baseTitle, current.metadata?.originalTitle].filter((q): q is string=>!!q))].slice(0,2);
    await Promise.allSettled(sources.map(async source => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      const work = async () => {
        for (const q of queries) {
          if (expired || this.abort.signal.aborted) break;
          const page = await this.sources.browse(source,profile,'search',1,q);
          if (expired || this.abort.signal.aborted) break;
          // Existing metadata queue/cache; no detail crawl or per-episode requests.
          await this.tmdb?.ensure(page.items.map(m=>m.id),1500);
          if (page.items.length) break;
        }
      };
      let stop = () => {};
      const deadline = new Promise<void>(resolve => {
        stop = () => { expired=true; resolve(); };
        timer=setTimeout(stop,this.timeoutMs);
        this.abort.signal.addEventListener('abort',stop,{once:true});
        if (this.abort.signal.aborted) stop();
      });
      try { await Promise.race([work(),deadline]); }
      finally { if (timer) clearTimeout(timer); this.abort.signal.removeEventListener('abort',stop); }
    }));
  }
}
