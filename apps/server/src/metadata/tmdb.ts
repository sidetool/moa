import { catalogFreshMs } from '../system/catalog-refresh.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TmdbScheduler, type TmdbWork, type TmdbPriority } from './tmdb-scheduler.js';
import { trailerCandidates } from './tmdb-trailers.js';
import { tmdbPeople, tmdbPersonWorks } from './tmdb-people.js';
import { parseSeasonInfo } from '../catalog/season-info.js';
import { parseSeason } from '../subtitles/korean/index.js';
import type { Episode, MediaCard, MediaDetail, MetadataCandidate, MetadataKind, MetadataLink, Person } from '@moa/shared';
import { selectCertification } from '../profiles/kids.js';
import { Store } from '../db.js';
import { ApiFailure } from '../util.js';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 86_400_000;
const TITLE_TTL = 7 * DAY, MISS_TTL = 3 * DAY;
const ACCEPT = 80;
export const MATCH_VERSION = 2;

// TMDB leaves the combined TV genres untranslated in Korean.
const GENRES: Record<number, string> = { 10759: '액션·모험', 10765: 'SF·판타지', 10768: '전쟁·정치', 10762: '키즈', 10763: '뉴스', 10764: '리얼리티', 10766: '연속극', 10767: '토크' };
const img = (size: string, file?: string | null) => file ? IMG + size + file : undefined;
const yearOf = (date?: string | null) => date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const tmdbNorm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Small, card-sized metadata merged into every card of a linked title. */
interface CardInfo {
  status?: string; lastAirDate?: string;
  title: string; originalTitle?: string; poster?: string; backdrop?: string; logo?: string; year?: number; genres?: string[];
  adult?: boolean; genreIds?: number[]; rating?: number; certification?: string; overview?: string; animation: boolean; originCountries?: string[]; runtime?: number;
  seasons?: Record<string, { poster?: string; year?: number; episodes?: number }>;
}
interface DetailInfo { tagline?: string; people: Person[]; trailer?: string; trailers?: string[]; trailerCheckedAt?: number; similar: MetadataCandidate[] }
interface EpisodeInfo { number: number; name?: string; overview?: string; still?: string; airDate?: string; runtime?: number }
interface Target { text: string; season?: number }

function dice(a: string, b: string) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2), n = grams.get(g) || 0; if (n) { hits++; grams.set(g, n - 1); } }
  return 2 * hits / (a.length + b.length - 2);
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.includes(short) && short.length / long.length >= 0.7) return 0.9;
  return dice(a, b) * 0.95;
}

/** Search queries for a source title: tags, seasons and trailing numbers are tried without and with. */
export function searchTerms(raw: string) {
  let text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const movieHint = /극장판|劇場版|the movie/i.test(text);
  const year = Number(/[([]\s*((?:19|20)\d{2})\s*[)\]]/.exec(text)?.[1]) || undefined;
  text = text.replace(/[([]\s*(?:자막|더빙|한글\s*자막|자체\s*자막|무삭제|무자막|완결|극장판|4K|UHD|FHD|HD|(?:19|20)\d{2})\s*[)\]]/gi, ' ')
    .replace(/\b(?:4K|UHD|FHD)\b/gi, ' ').replace(/\s*전\s*시즌(?:\s*이어보기)?\s*$/, ' ').replace(/\s+/g, ' ').trim();
  const season = parseSeason(text);
  const base = text.replace(/(?:final\s+season)|(?:시즌|season)\s*\d{1,2}|\d{1,2}\s*기|\d{1,2}(?:st|nd|rd|th)\s+season|\s(?:part|파트)\s*\d+|\s\d{1,2}\s*(?:부|쿨)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim() || text;
  const targets: Target[] = [{ text: base, season }];
  if (base !== text) targets.push({ text });
  const numbered = !season && /^(.{2,}?)\s?(\d{1,2})$/.exec(text);
  if (numbered && Number(numbered[2]) > 1) targets.push({ text: numbered[1].trim(), season: Number(numbered[2]) });
  const subtitle = base.replace(/\s*[~〜].*$/, '').trim();
  if (subtitle.length >= 2 && subtitle !== base) targets.push({ text: subtitle, season });
  // "더 픽스 The Fix": Korean title followed by its English name.
  const korean = /\p{Script=Hangul}/u.test(base) ? base.replace(/\s+[A-Za-z][A-Za-z0-9 :'&!?.,-]*$/, '').trim() : base;
  if (korean.length >= 2 && korean !== base) targets.push({ text: korean, season });
  const unique = targets.filter((t, i) => targets.findIndex(o => o.text === t.text) === i);
  if (movieHint) unique.sort((a, b) => Number(b.text === text) - Number(a.text === text));
  return { targets: unique, season, year, movieHint };
}

interface SearchResult { media_type?: string; id: number; name?: string; title?: string; original_name?: string; original_title?: string; first_air_date?: string; release_date?: string; genre_ids?: number[]; popularity?: number; poster_path?: string; overview?: string }

export function scoreResult(result: SearchResult, targets: Target[], expected: { type: string; movieHint: boolean; year?: number }) {
  const kind = result.media_type === 'movie' ? 'movie' : 'tv';
  const names = [result.name || result.title, result.original_name || result.original_title].filter(Boolean).map(n => tmdbNorm(n!));
  let best = 0, target: Target | undefined;
  for (const t of targets) for (const n of names) {
    const s = similarity(tmdbNorm(t.text), n);
    if (s > best) { best = s; target = t; }
  }
  if (!target) return { score: 0, season: undefined };
  let score = best * 100;
  const wantMovie = expected.type === 'movie' || expected.movieHint;
  score += (kind === 'movie') === wantMovie ? 5 : -12;
  const animated = result.genre_ids?.includes(16);
  if (expected.type === 'anime') score += animated ? 5 : -30;
  const year = yearOf(result.first_air_date || result.release_date);
  if (expected.year && year && (target.season ?? 1) <= 1 && Math.abs(expected.year - year) > 1) score -= 30;
  return { score, season: target.season };
}

/** Keeps a small number of TMDB requests in flight and retries rate limits. */
export class Tmdb {
  readonly providerId = 'tmdb';
  configurationRevision = 0;
  get enabled() { return Boolean(this.token || this.key); }
  private environment: { token?: string; key?: string } = {};
  private reload() {
    const saved = JSON.parse(this.db.get("SELECT value FROM admin_settings WHERE key='tmdb'")?.value || '{}');
    const effective = this.environment.token || this.environment.key ? this.environment : saved;
    this.token = effective.token || undefined; this.key = effective.apiKey || effective.key || undefined;
  }
  status() {
    const saved = JSON.parse(this.db.get("SELECT value FROM admin_settings WHERE key='tmdb'")?.value || '{}');
    return { configured: this.enabled, source: this.environment.token || this.environment.key ? 'environment' : this.enabled ? 'database' : 'none',
      credentialType: this.token ? 'token' : this.key ? 'apiKey' : null, hasSavedCredential: Boolean(saved.token || saved.apiKey) };
  }
  configure(value: { token?: string; apiKey?: string; clear?: boolean }) {
    if (Object.keys(value).length !== 1 || value.clear !== undefined && value.clear !== true) throw new ApiFailure(400, 'invalid-request');
    this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('tmdb',?)", JSON.stringify(value.clear ? {} : value));
    this.reload();
    this.configurationRevision++;
    this.scheduler.close(); this.scheduler = new TmdbScheduler();
    this.inflight.clear(); this.linkContexts.clear(); this.seasonRequests.clear(); this.seasonContexts.clear(); this.trailerRequests.clear(); this.titleRequests.clear(); this.searchRequests.clear(); this.retryAfter.clear();
    return this.status();
  }
  private token?: string;
  private key?: string;
  private scheduler = new TmdbScheduler();
  private context = new AsyncLocalStorage<TmdbWork>();
  private linkContexts = new Map<string, TmdbWork>();
  private inflight = new Map<string, Promise<void>>();
  private titleRequests = new Map<string, {work: Promise<CardInfo | null>; context: TmdbWork}>();
  private searchRequests = new Map<string, Promise<MetadataCandidate[]>>();
  private retryAfter = new Map<string, number>();
  private seasonContexts = new Map<string, TmdbWork>();
  private trailerRequests = new Map<string, Promise<void>>();
  private seasonRequests = new Map<string, Promise<void>>();
  private abort = new AbortController();
  constructor(private db: Store, private log: (value: Record<string, unknown>) => void, options: { token?: string; key?: string; fetch?: typeof fetch } = { token: process.env.MOA_TMDB_TOKEN, key: process.env.MOA_TMDB_API_KEY }) {
    this.environment = { token: options.token?.trim() || undefined, key: options.key?.trim() || undefined };
    db.db.exec('CREATE TABLE IF NOT EXISTS tmdb_search_cache(query TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
    this.reload();
    if (options.fetch) this.fetcher = options.fetch;
  }
  private fetcher: typeof fetch = (...args) => fetch(...args);
  private currentWork(): TmdbWork { return this.context.getStore() ?? {priority: 'foreground', revision: this.configurationRevision}; }
  private validRevision(revision: number) { return !this.abort.signal.aborted && revision === this.configurationRevision; }
  private async get(pathname: string, params: Record<string, string> = {}): Promise<any> {
    const context = this.currentWork();
    if (!this.validRevision(context.revision)) throw new Error('tmdb-configuration-changed');
    const normalized = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([context.revision, pathname, normalized]);
    const url = new URL(API + pathname);
    for (const [k, v] of normalized) url.searchParams.set(k, v);
    const token = this.token;
    if (!token && this.key) url.searchParams.set('api_key', this.key);
    const value = await this.scheduler.request(key, context, signal => this.fetcher(url, {headers: {accept: 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, signal}));
    if (!this.validRevision(context.revision)) throw new Error('tmdb-configuration-changed');
    return value;
  }

  /** Read only existing accepted matches. Never run title matching on behalf of a plugin. */
  linkedTitle(mediaId: string): import('@moa/shared').LinkedPluginTitle | null {
    const row = this.db.get("SELECT m.title,l.kind,l.tmdb_id FROM media m JOIN tmdb_links l ON l.media_id=m.id WHERE m.id=? AND l.status IN ('auto','manual')", mediaId);
    if (!row || !['movie','tv'].includes(row.kind) || !Number.isSafeInteger(row.tmdb_id) || row.tmdb_id <= 0) return null;
    return {mediaId,provider:this.providerId,kind:row.kind,id:String(row.tmdb_id),name:row.title,scope:row.kind === 'tv' ? 'series' : 'movie'};
  }
  async reviewItems(title: import('@moa/shared').LinkedPluginTitle): Promise<import('@moa/shared').ReviewItem[]> {
    if (!this.enabled || title.provider !== 'tmdb' || !['movie','tv'].includes(title.kind) || !/^[1-9][0-9]{0,14}$/.test(title.id)) throw new Error('invalid-review-title');
    let data = await this.get(`/${title.kind}/${title.id}/reviews`, {language:'ko-KR',page:'1'});
    if (Array.isArray(data?.results) && !data.results.length) data = await this.get(`/${title.kind}/${title.id}/reviews`, {language:'en-US',page:'1'});
    if (!Array.isArray(data?.results)) throw new Error('invalid-reviews');
    return data.results.slice(0,8).flatMap((r:any) => {
      if (typeof r.url !== 'string' || !/^https:\/\/(?:www\.)?themoviedb\.org\/review\/[a-zA-Z0-9]+$/.test(r.url) || typeof r.content !== 'string') return [];
      return [{title:'사용자 리뷰',excerpt:r.content.slice(0,600),author:typeof r.author==='string'?r.author.slice(0,100):'',date:typeof r.created_at==='string'?r.created_at.slice(0,40):'',url:r.url,kind:'review' as const,language:'unknown' as const}];
    });
  }
  async peopleCredits(title: import('@moa/shared').LinkedPluginTitle) {
    if (!this.enabled) throw new ApiFailure(503, 'metadata-unconfigured');
    if (title.provider !== this.providerId || !['movie','tv'].includes(title.kind) || !/^[1-9][0-9]{0,14}$/.test(title.id)) throw new ApiFailure(400, 'invalid-metadata-identity');
    const data = await this.get(`/${title.kind}/${title.id}/${title.kind === 'tv' ? 'aggregate_credits' : 'credits'}`, {language:'ko-KR'});
    return tmdbPeople(data, title.kind);
  }
  async titleDetails(title: import('@moa/shared').LinkedPluginTitle): Promise<import('@moa/shared').TitleMetadata> {
    if (!this.enabled) throw new ApiFailure(503, 'metadata-unconfigured');
    if (title.provider !== this.providerId || !['movie','tv'].includes(title.kind) || !/^[1-9][0-9]{0,14}$/.test(title.id)) throw new ApiFailure(400, 'invalid-metadata-identity');
    const card = await this.title(title.kind, Number(title.id));
    if (!card || typeof card.title !== 'string' || !card.title.trim()) throw new Error('invalid-metadata-details');
    const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : undefined;
    const image = (value: unknown) => typeof value === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)$/.test(value) ? value : undefined;
    return {
      title: card.title.slice(0, 300), originalTitle: text(card.originalTitle, 300), overview: text(card.overview, 4000),
      genres: Array.isArray(card.genres) ? card.genres.filter((value: unknown) => typeof value === 'string').slice(0,16).map((value: string) => value.slice(0,80)) : [],
      year: typeof card.year === 'number' && Number.isInteger(card.year) && card.year > 0 && card.year < 10000 ? card.year : undefined,
      runtime: typeof card.runtime === 'number' && Number.isFinite(card.runtime) && card.runtime > 0 && card.runtime <= 1440 ? card.runtime : undefined,
      rating: typeof card.rating === 'number' && Number.isFinite(card.rating) && card.rating >= 0 && card.rating <= 10 ? card.rating : undefined,
      certification: text(card.certification, 40), poster: image(card.poster), backdrop: image(card.backdrop),
    };
  }
  async personWorks(id: string) {
    if (!this.enabled) throw new ApiFailure(503, 'metadata-unconfigured');
    if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new ApiFailure(400, 'invalid-metadata-identity');
    return tmdbPersonWorks(await this.get(`/person/${id}/combined_credits`, {language:'ko-KR'}));
  }
  /** Fixed first-page discovery; reuse credential storage, request limits and shutdown signal. */
  async trending(query: import('@moa/shared').TrendingQuery): Promise<import('@moa/shared').DiscoveryItem[]> {
    if (!['movie', 'tv'].includes(query.kind) || !['day', 'week'].includes(query.window)) throw new ApiFailure(400, 'invalid-discovery-query');
    if (!this.enabled) throw new ApiFailure(503, 'metadata-unconfigured');
    const data = await this.get(`/trending/${query.kind}/${query.window}`, { language: 'ko-KR' });
    if (!data || !Array.isArray(data.results)) throw new Error('invalid-trending-response');
    const seen = new Set<number>();
    return data.results.slice(0, 20).flatMap((row: any) => {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || row.adult !== false || seen.has(row.id) || row.media_type && row.media_type !== query.kind) return [];
      const title = query.kind === 'movie' ? row.title : row.name;
      if (typeof title !== 'string' || !title.trim()) return [];
      seen.add(row.id);
      const original = query.kind === 'movie' ? row.original_title : row.original_name;
      const date = query.kind === 'movie' ? row.release_date : row.first_air_date;
      const year = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0, 4)) : undefined;
      const poster = typeof row.poster_path === 'string' && /^\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)$/.test(row.poster_path) ? `https://image.tmdb.org/t/p/w342${row.poster_path}` : undefined;
      return [{ provider: this.providerId, kind: query.kind, id: String(row.id), title: title.slice(0, 300),
        ...(typeof original === 'string' ? { originalTitle: original.slice(0, 300) } : {}),
        ...(year ? { year } : {}), ...(poster ? { poster } : {}),
        ...(typeof row.overview === 'string' ? { overview: row.overview.slice(0, 2000) } : {}) }];
    });
  }

  /** Bounded popularity discovery with explicit genre filters; no keyword guesses for sports/variety. */
  async shortPopular(category: import('@moa/shared').ShortsCategory): Promise<import('@moa/shared').ShortsItem[]> {
    if(!this.enabled)throw new ApiFailure(503,'metadata-unconfigured');
    if(!['movie','series','anime'].includes(category))throw new ApiFailure(400,'invalid-shorts-category');
    const kinds:MetadataKind[]=category==='anime'?['movie','tv']:[category==='movie'?'movie':'tv'];
    const pages=await Promise.all(kinds.map(async kind=>{
      const data=await this.get(`/discover/${kind}`,{language:'ko-KR',include_adult:'false',sort_by:'popularity.desc',page:'1',
        ...(category==='anime'?{with_genres:'16'}:{without_genres:kind==='tv'?'16,10763,10764,10767':'16'})});
      if(!Array.isArray(data?.results))throw new Error('invalid-shorts-discovery');
      return data.results.slice(0,20).flatMap((row:any)=>{
        if(!row||row.adult!==false||!Number.isSafeInteger(row.id)||row.id<=0||!Array.isArray(row.genre_ids)||!row.genre_ids.length)return [];
        const animation=row.genre_ids.includes(16);
        if(category==='anime'?!animation:animation)return [];
        if(category==='series'&&row.genre_ids.some((g:number)=>[10763,10764,10767].includes(g)))return [];
        const c=candidate(row,kind);if(!c.title.trim())return [];
        return [{key:`${kind}:${c.id}`,kind,tmdbId:c.id,title:c.title,poster:c.poster,overview:c.overview,year:c.year,category,
          href:`/search?q=${encodeURIComponent(c.title)}`,reason:'popular' as const}];
      });
    }));
    // Interleave films and shows in the animation bucket rather than exhausting films first.
    const items:import('@moa/shared').ShortsItem[]=[];
    for(let i=0;i<20;i++)for(const page of pages)if(page[i]&&items.length<20)items.push(page[i]);
    return items;
  }

  /** Explicit trailer discovery: fixed TMDB identity, no extension extraction or automatic title linking. */
  async shortTrailers(kind: MetadataKind, id: number): Promise<{trailers:string[]; adult:boolean}> {
    if (!this.enabled) throw new ApiFailure(503,'metadata-unconfigured');
    if (!['tv','movie'].includes(kind) || !Number.isSafeInteger(id) || id <= 0) throw new ApiFailure(400,'invalid-metadata-identity');
    const cached=this.db.get('SELECT card,detail,fetched_at FROM tmdb_titles WHERE kind=? AND tmdb_id=?',kind,id);
    if(cached){
      void this.title(kind,id).catch(()=>{});
      const detail=JSON.parse(cached.detail),card=JSON.parse(cached.card);
      if(Array.isArray(detail.trailers))return {trailers:detail.trailers,adult:card.adult!==false};
    }
    const data=await this.get(`/${kind}/${id}`,{language:'ko-KR',append_to_response:'videos',include_video_language:'ko,en,ja,null'});
    return {trailers:trailerCandidates(data?.videos?.results),adult:data?.adult!==false};
  }

  async upcoming(kind:'movie'|'tv',id:number):Promise<Array<Omit<import('@moa/shared').WatchlistNewsEvent,'mediaId'|'title'>>>{
    if(!this.enabled||!['movie','tv'].includes(kind)||!Number.isSafeInteger(id)||id<1)throw new Error('invalid-upcoming');
    const data=await this.get(kind==='movie'?`/movie/${id}/release_dates`:`/tv/${id}`,{language:'ko-KR'});
    const validDate=(d:unknown):d is string=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
    if(kind==='movie'){
      if(!Array.isArray(data?.results))throw new Error('invalid-upcoming');
      const kr=data.results.find((r:any)=>r.iso_3166_1==='KR');
      const dates=new Set<string>();for(const r of Array.isArray(kr?.release_dates)?kr.release_dates:[]){const date=typeof r.release_date==='string'?r.release_date.slice(0,10):'';if([2,3].includes(r.type)&&validDate(date))dates.add(date);}
      return [...dates].sort().map(date=>({date,kind:'release' as const,detail:'한국 극장 개봉 · 재개봉 포함'}));
    }
    if(!data||data.id!==id)throw new Error('invalid-upcoming');
    const e=data.next_episode_to_air;
    if(!e||!validDate(e.air_date)||!Number.isSafeInteger(e.season_number)||e.season_number<0||!Number.isSafeInteger(e.episode_number)||e.episode_number<1)return [];
    return [{date:e.air_date,kind:'episode',detail:`시즌 ${e.season_number} · ${e.episode_number}화 · 원방영일 기준`}];
  }

  async movieSchedule(date:string):Promise<{items:import('@moa/shared').ScheduleItem[];truncated:boolean}>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!this.enabled)throw new Error('invalid-schedule');
    const data=await this.get('/discover/movie',{language:'ko-KR',region:'KR','release_date.gte':date,'release_date.lte':date,with_release_type:'2|3',include_adult:'false',sort_by:'popularity.desc',page:'1'});
    if(!Array.isArray(data?.results))throw new Error('invalid-schedule');
    const seen=new Set<number>();
    const candidates=data.results.filter((x:any)=>x&&Number.isSafeInteger(x.id)&&x.id>0&&x.adult===false&&typeof x.title==='string'&&!seen.has(x.id)&&seen.add(x.id)).slice(0,12);
    const rows=await Promise.allSettled(candidates.map(async(x:any)=>{
      const releases=await this.get(`/movie/${x.id}/release_dates`);
      if(!Array.isArray(releases?.results))throw new Error('invalid-release-dates');
      const kr=releases.results.find((r:any)=>r.iso_3166_1==='KR');
      const dates=Array.isArray(kr?.release_dates)?kr.release_dates:[];
      if(!dates.some((r:any)=>[2,3].includes(r.type)&&typeof r.release_date==='string'&&r.release_date.slice(0,10)===date))return null;
      return {id:String(x.id),title:x.title.slice(0,200),date,time:null,detail:'한국 극장 개봉 · 재개봉 포함'};
    }));
    const items:import('@moa/shared').ScheduleItem[]=rows.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]);
    if(candidates.length&&rows.every(r=>r.status==='rejected'))throw new Error('release-dates-unavailable');
    return {items,truncated:data.total_pages>1||data.results.length>12||rows.some(r=>r.status==='rejected')};
  }

  /** Link visible titles; the budget stops waiting without cancelling shared work. */
  ensure(ids: string[], budgetMs: number, priority: TmdbPriority = 'foreground'): Promise<void> {
    if (!this.enabled || !ids.length) return Promise.resolve();
    const work = this.context.run({priority, revision: this.configurationRevision}, () => Promise.allSettled([...new Set(ids)].map(async id => {
      await this.link(id);
      if (!this.validRevision(this.currentWork().revision)) return;
      const row = linked(this.db,id);
      if (row?.kind === 'tv' && row.season != null && !JSON.parse(row.card).seasons?.[row.season]?.poster) await this.season(row.tmdb_id,row.season);
    })).then(() => {}));
    return budgetMs > 0 ? Promise.race([work, sleep(budgetMs)]) : Promise.resolve();
  }

  private seasonNumbers(id: string, linkedSeason: number | null): number[] {
    const source = linkedSeason != null && this.db.get("SELECT 1 FROM sqlite_master WHERE name='source_media'") && this.db.get('SELECT 1 FROM source_media WHERE media_id=?',id);
    if (source) return [linkedSeason!];
    const seasons = this.db.all('SELECT DISTINCT season FROM episodes WHERE media_id=? ORDER BY season LIMIT 6',id);
    return seasons.length ? seasons.map(row => row.season) : [1];
  }
  /** A first detail can use a small matching budget. Persisted playable detail renders immediately. */
  async ensureDetail(id: string, budgetMs: number) {
    if (!this.enabled) return;
    const existing = linked(this.db,id);
    const ready = existing && Array.isArray(JSON.parse(existing.detail).trailers)
      || this.db.get('SELECT 1 FROM episodes WHERE media_id=? LIMIT 1',id);
    const context = this.currentWork();
    const work = this.context.run(context, async () => {
      await this.link(id);
      if (!this.validRevision(context.revision)) return;
      const link = linked(this.db,id);
      if (!link) return;
      await Promise.all([this.ensureTrailers(link.kind,link.tmdb_id), ...(link.kind === 'tv'
        ? this.seasonNumbers(id,link.season).map(number => this.season(link.tmdb_id, number)) : [])]);
    }).catch(error => this.log({ event: 'tmdb-detail-error', id, error: String(error) }));
    if (!ready && budgetMs > 0) await Promise.race([work, sleep(budgetMs)]);
  }
  detailRefreshing(id: string) {
    if (!this.enabled) return false;
    if (this.inflight.has(id)) return true;
    if (!this.titleRequests.size && !this.trailerRequests.size && !this.seasonRequests.size) return false;
    const link = this.db.get("SELECT kind,tmdb_id FROM tmdb_links WHERE media_id=? AND status IN ('auto','manual')",id);
    return Boolean(link && (this.titleRequests.has(`title:${link.kind}:${link.tmdb_id}`)
      || this.trailerRequests.has(`${link.kind}:${link.tmdb_id}`) || link.kind === 'tv' && [...this.seasonRequests.keys()].some(key=>key.startsWith(`${link.tmdb_id}:`))));
  }
  private link(id: string, force = false): Promise<void> {
    const running = this.inflight.get(id);
    if (running) {
      if (this.currentWork().priority === 'foreground') this.linkContexts.get(id)!.priority = 'foreground';
      return running;
    }
    if (!force && (this.retryAfter.get('match:'+id) ?? 0) > Date.now()) return Promise.resolve();
    const row = this.db.get(`SELECT l.*, t.fetched_at FROM tmdb_links l LEFT JOIN tmdb_titles t
      ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE l.media_id=?`, id);
    const accepted = row && ['auto','manual'].includes(row.status);
    if (row?.status === 'off') return Promise.resolve();
    if (force && accepted) return this.title(row.kind,row.tmdb_id,true).then(card => {
      if (!card) throw new ApiFailure(404,'metadata-not-found');
    });
    const retry = row && (row.status === 'none' || row.status === 'auto' && row.score < 100) && foreignSource(this.db, id).foreign && (this.db.get('SELECT version FROM tmdb_match_versions WHERE media_id=?', id)?.version || 0) < MATCH_VERSION;
    if (!force && !retry && row?.status === 'none' && row.checked_at > Date.now() - Math.min(MISS_TTL,catalogFreshMs(this.db,MISS_TTL))) return Promise.resolve();
    if (!retry && accepted && row.fetched_at != null) {
      if (row.fetched_at <= Date.now()-catalogFreshMs(this.db,TITLE_TTL)) void this.title(row.kind,row.tmdb_id).catch(() => {});
      return Promise.resolve();
    }
    const context = {...this.currentWork()};
    const pending = this.context.run(context, () => !retry && accepted ? this.title(row.kind,row.tmdb_id).then(() => {}) : this.match(id,force));
    if (!pending) return Promise.resolve();
    this.linkContexts.set(id, context);
    const work = pending
      .catch(error => {
        if (this.validRevision(context.revision)) {
          if (context.priority === 'background') this.backoff('match:'+id);
          this.log({ event: 'tmdb-match-error', id, error: String(error) });
        }
        throw error;
      })
      .finally(() => { if (this.inflight.get(id) === work) { this.inflight.delete(id); this.linkContexts.delete(id); } });
    this.inflight.set(id, work);
    return work;
  }
  private match(id: string, force: boolean) {
    const media = this.db.get('SELECT title,type,metadata FROM media WHERE id=?', id);
    if (!media) return;
    const meta = JSON.parse(media.metadata);
    // Live channels and truncated listing titles cannot be matched reliably.
    if (meta.live || /(?:\.{3}|…)\s*$/.test(media.title)) return;
    return this.matchTitle(id, media, meta.year, force);
  }
  private async matchTitle(id: string, media: Record<string, any>, year: number | undefined, force: boolean) {
    const revision = this.currentWork().revision;
    const previous = JSON.stringify(this.db.get('SELECT * FROM tmdb_links WHERE media_id=?',id));
    const unchanged = () => this.validRevision(revision) && Boolean(this.db.get('SELECT 1 FROM media WHERE id=?', id)) && previous === JSON.stringify(this.db.get('SELECT * FROM tmdb_links WHERE media_id=?',id));
    const terms = searchTerms(media.title);
    const source = foreignSource(this.db, id);
    const letters = media.title.match(/\p{L}/gu) || [];
    const english = source.foreign || letters.filter((c: string) => /\p{Script=Latin}/u.test(c)).length > letters.length / 2;
    const expected = { type: source.anime && media.type === 'series' ? 'anime' : media.type, movieHint: terms.movieHint, year: year || terms.year };
    let best: { result: SearchResult; score: number; season?: number } | undefined;
    for (const target of terms.targets.slice(0, 4)) {
      for (const language of english ? ['ko-KR', 'en-US'] : ['ko-KR']) {
        const page = await this.get('/search/multi', { query: target.text, language, include_adult: 'false' });
        if (!Array.isArray(page?.results)) throw new Error('tmdb-invalid-response');
        for (const result of (page?.results || []) as SearchResult[]) {
          if (!['tv', 'movie'].includes(result.media_type || '')) continue;
          const { score, season } = scoreResult(result, terms.targets, expected);
          if (!best || score > best.score + 2 || Math.abs(score - best.score) <= 2 && (result.popularity || 0) > (best.result.popularity || 0)) best = { result, score, season };
        }
      }
      if (best && best.score >= 95) break;
    }
    if (!unchanged()) return;
    if (!best || best.score < ACCEPT) {
      this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,status,checked_at) VALUES(?,'none',?)", id, Date.now());
      this.db.run('INSERT OR REPLACE INTO tmdb_match_versions VALUES(?,?)', id, MATCH_VERSION);
      return;
    }
    const kind = best.result.media_type as MetadataKind, info = await this.title(kind, best.result.id,force);
    if (!info && force) throw new ApiFailure(404,'metadata-not-found');
    if (!info || !unchanged()) return;
    const wanted = best.season ?? (/\bfinal\s+season\b/i.test(media.title) ? Math.max(0, ...Object.keys(info.seasons || {}).map(Number)) : undefined);
    const season = kind === 'tv' && wanted && info.seasons?.[wanted] ? wanted : null;
    this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,kind,tmdb_id,season,status,score,checked_at) VALUES(?,?,?,?,'auto',?,?)", id, kind, best.result.id, season, Math.round(best.score), Date.now());
    this.db.run('INSERT OR REPLACE INTO tmdb_match_versions VALUES(?,?)', id, MATCH_VERSION);
  }
  /** Upgrade legacy single-video caches only on detail access; no catalog-wide refresh. */
  private ensureTrailers(kind: MetadataKind, id: number): Promise<void> {
    const key = `${kind}:${id}`, running = this.trailerRequests.get(key);
    if (running) return running;
    const row = this.db.get('SELECT detail FROM tmdb_titles WHERE kind=? AND tmdb_id=?',kind,id);
    if (!row) return Promise.resolve();
    const extra: DetailInfo = JSON.parse(row.detail);
    if (Array.isArray(extra.trailers) || (extra.trailerCheckedAt ?? 0) > Date.now() - 5*60_000) return Promise.resolve();
    // A failed refresh keeps the old trailer and backs off, including after restart.
    this.db.run('UPDATE tmdb_titles SET detail=? WHERE kind=? AND tmdb_id=?',JSON.stringify({...extra,trailerCheckedAt:Date.now()}),kind,id);
    const revision = this.currentWork().revision;
    const work = (async () => {
      const data = await this.get(`/${kind}/${id}/videos`,{language:'ko-KR',include_video_language:'ko,en,ja,null'});
      if (!this.validRevision(revision) || !Array.isArray(data?.results)) return;
      const current = this.db.get('SELECT detail FROM tmdb_titles WHERE kind=? AND tmdb_id=?',kind,id);
      if (!current) return;
      const fresh: DetailInfo = JSON.parse(current.detail);
      if (Array.isArray(fresh.trailers)) return; // a concurrent title refresh already supplied newer metadata
      const trailers = trailerCandidates(data.results);
      this.db.run('UPDATE tmdb_titles SET detail=? WHERE kind=? AND tmdb_id=?',JSON.stringify({...fresh,trailer:trailers[0],trailers}),kind,id);
    })().finally(() => { if (this.trailerRequests.get(key) === work) this.trailerRequests.delete(key); });
    this.trailerRequests.set(key,work); return work;
  }
  private title(kind: MetadataKind, tmdbId: number, force = false): Promise<CardInfo | null> {
    const key = `title:${kind}:${tmdbId}`, revision = this.currentWork().revision;
    const cached = this.db.get('SELECT card,fetched_at FROM tmdb_titles WHERE kind=? AND tmdb_id=?',kind,tmdbId);
    const refresh = (background: boolean) => {
      const running = this.titleRequests.get(key);
      if (running) {
        if (!background && this.currentWork().priority === 'foreground') running.context.priority = 'foreground';
        return running.work;
      }
      const context: TmdbWork = { revision, priority:background ? 'background' : this.currentWork().priority };
      const work = this.context.run(context, () => this.fetchTitle(kind,tmdbId)).then(value => {
        if (!value && this.validRevision(revision)) this.backoff(key);
        return value;
      }).catch(error => {
        if (this.validRevision(revision)) this.backoff(key);
        throw error;
      }).finally(() => { if(this.titleRequests.get(key)?.work===work)this.titleRequests.delete(key); });
      this.titleRequests.set(key,{work,context}); return work;
    };
    if(cached && !force) {
      if(cached.fetched_at <= Date.now()-catalogFreshMs(this.db,TITLE_TTL) && (this.retryAfter.get(key)||0)<=Date.now()) void refresh(true).catch(()=>{});
      return Promise.resolve(JSON.parse(cached.card));
    }
    return refresh(false);
  }
  private backoff(key: string) {
    this.retryAfter.set(key,Date.now()+30_000);

    if(this.retryAfter.size>10000)for(const [key,until] of this.retryAfter)if(until<=Date.now())this.retryAfter.delete(key);
    while(this.retryAfter.size>10000)this.retryAfter.delete(this.retryAfter.keys().next().value!);
  }
  /** Explicit refresh preserves accepted/manual/off matches and propagates upstream failures. */
  async refreshDetail(id: string) {
    if(!this.enabled)return;
    const revision = this.configurationRevision;
    await this.link(id,true);
    if (!this.validRevision(revision)) throw new Error('tmdb-configuration-changed');
    const link = linked(this.db,id);
    if (!link) return;
    if (link.kind === 'tv') {
      await Promise.all(this.seasonNumbers(id,link.season).map(number=>this.season(link.tmdb_id,number,true)));
    }
  }
  private async fetchTitle(kind: MetadataKind, tmdbId: number): Promise<CardInfo | null> {
    const revision = this.currentWork().revision;
    const append = kind === 'tv' ? 'aggregate_credits,images,videos,recommendations,content_ratings' : 'credits,images,videos,recommendations,release_dates';
    const d = await this.get(`/${kind}/${tmdbId}`, { language: 'ko-KR', append_to_response: append, include_image_language: 'ko,en,null', include_video_language: 'ko,en,ja,null' });
    if (!this.validRevision(revision)) throw new Error('tmdb-configuration-changed');
    if (!d) return null;
    if(typeof (d.name || d.title)!=='string' || !(d.name || d.title).trim() || d.genres != null && !Array.isArray(d.genres))throw new Error('invalid-metadata-title');
    const logos: any[] = d.images?.logos || [];
    const pickLogo = (lang: string) => logos.filter(l => l.iso_639_1 === lang).sort((a, b) => b.vote_average - a.vote_average)[0];
    // A Korean logo, or the English one for English-language titles. Others keep the text title.
    const logo = pickLogo('ko') || (d.original_language === 'en' ? pickLogo('en') : undefined);
    const backdrop = (d.images?.backdrops || []).filter((b: any) => !b.iso_639_1).sort((a: any, b: any) => b.vote_average - a.vote_average)[0]?.file_path || d.backdrop_path;
    const certification = selectCertification(kind, d);
    const seasons: CardInfo['seasons'] = {};
    for (const s of d.seasons || []) if (s.season_number > 0) seasons[s.season_number] = { poster: img('w500', s.poster_path), year: yearOf(s.air_date), episodes: s.episode_count };
    const card: CardInfo = {
      ...(kind === 'tv' ? { status: d.status, lastAirDate: d.last_air_date } : {}),
      adult: Boolean(d.adult), genreIds: (d.genres || []).map((g: any) => g.id),
      title: d.name || d.title, originalTitle: d.original_name || d.original_title, poster: img('w500', d.poster_path), backdrop: img('w1280', backdrop),
      logo: logo ? img(logo.file_path.endsWith('.svg') ? 'original' : 'w500', logo.file_path) : undefined,
      year: yearOf(d.first_air_date || d.release_date), genres: (d.genres || []).map((g: any) => GENRES[g.id] || g.name).filter(Boolean).slice(0, 5),
      rating: d.vote_count >= 5 && d.vote_average ? Math.round(d.vote_average * 10) / 10 : undefined,
      certification: certification ? String(certification).replace(/^all$/i, 'ALL') : undefined,
      originCountries: d.origin_country || (d.production_countries || []).map((c: any) => c.iso_3166_1),
      overview: d.overview || undefined, animation: (d.genres || []).some((g: any) => g.id === 16),
      runtime: d.runtime || undefined, ...(kind === 'tv' ? { seasons } : {}),
    };
    const cast: any[] = (kind === 'tv' ? d.aggregate_credits?.cast : d.credits?.cast) || [];
    const trailers = trailerCandidates(d.videos?.results);
    const detail: DetailInfo = {
      tagline: d.tagline || undefined, trailer: trailers[0], trailers,
      people: cast.slice(0, 16).map(p => ({ ...(Number.isSafeInteger(p.id) && p.id > 0 ? {identity:{provider:this.providerId,id:String(p.id)}} : {}), name: p.name, role: (p.roles?.[0]?.character || p.character || '').replace(/\s*\((?:voice|목소리)\)\s*$/i, '') || undefined, photo: img('w185', p.profile_path) })),
      similar: (d.recommendations?.results || []).filter((r: any) => r.poster_path).slice(0, 18).map((r: any) => candidate(r, kind)),
    };
    this.db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)', kind, tmdbId, JSON.stringify(card), JSON.stringify(detail), Date.now());
    return card;
  }
  private season(tvId: number, number: number, force = false): Promise<void> {
    const key = `${tvId}:${number}`, retryKey = 'season:'+key;
    const cached = this.db.get('SELECT fetched_at,payload FROM tmdb_seasons WHERE tmdb_id=? AND season=?',tvId,number);
    const freshMs = cached?.payload === '[]' ? Math.min(60_000,catalogFreshMs(this.db,TITLE_TTL)) : catalogFreshMs(this.db,TITLE_TTL);
    if (!force && ((this.retryAfter.get(retryKey) ?? 0) > Date.now() || cached && Date.now()-cached.fetched_at < freshMs)) return Promise.resolve();
    let running = this.seasonRequests.get(key);
    if (running) {
      if ((!cached || force) && this.currentWork().priority === 'foreground') this.seasonContexts.get(key)!.priority = 'foreground';
    } else {
      const context = {...this.currentWork()};
      if (cached && !force) context.priority = 'background';
      this.seasonContexts.set(key, context);
      const work = this.context.run(context, () => this.fetchSeason(tvId,number)).catch(error => {
        if (this.validRevision(context.revision)) this.backoff(retryKey);
        throw error;
      }).finally(() => {
        if (this.seasonRequests.get(key) === work) { this.seasonRequests.delete(key); this.seasonContexts.delete(key); }
      });
      running = work;
      this.seasonRequests.set(key,work);
    }
    if (!force && cached) { void running.catch(() => {}); return Promise.resolve(); }
    return running;
  }
  private async fetchSeason(tvId: number, number: number) {
    const revision = this.currentWork().revision;

    const d = await this.get(`/tv/${tvId}/season/${number}`, { language: 'ko-KR' });
    if (!this.validRevision(revision)) return;
    if(!d || !Array.isArray(d.episodes))throw new Error('invalid-metadata-season');
    if (d?.poster_path) {
      const row = this.db.get("SELECT card FROM tmdb_titles WHERE kind='tv' AND tmdb_id=?", tvId);
      if (row) {
        const card: CardInfo = JSON.parse(row.card);
        card.seasons = { ...card.seasons, [number]: { ...card.seasons?.[number], poster: img('w500', d.poster_path) } };
        this.db.run("UPDATE tmdb_titles SET card=? WHERE kind='tv' AND tmdb_id=?", JSON.stringify(card), tvId);
      }
    }
    const episodes: EpisodeInfo[] = (d?.episodes || []).map((e: any) => ({ number: e.episode_number, name: e.name || undefined, overview: e.overview || undefined, still: img('w300', e.still_path), airDate: e.air_date || undefined, runtime: e.runtime || undefined }));
    this.db.run('INSERT OR REPLACE INTO tmdb_seasons VALUES(?,?,?,?)', tvId, number, JSON.stringify(episodes), Date.now());
  }

  async search(query: string): Promise<MetadataCandidate[]> {
    if (!this.enabled) throw new ApiFailure(409, 'metadata-unavailable');
    const key = query.trim();
    const cached = this.db.get('SELECT payload,fetched_at FROM tmdb_search_cache WHERE query=?',key);
    const value: MetadataCandidate[] | undefined = cached && JSON.parse(cached.payload);
    const age = cached ? Date.now()-cached.fetched_at : Infinity;
    const freshMs = catalogFreshMs(this.db,6*3_600_000);
    if (value && age <= (value.length ? freshMs : Math.min(60_000,freshMs))) return value;
    const usable = value && (value.length > 0 || age <= 5*60_000);
    if (usable && (this.retryAfter.get('search:'+key) ?? 0)>Date.now()) return value;
    let running = this.searchRequests.get(key);
    if (!running) {
      const revision = this.configurationRevision;
      const work = this.get('/search/multi', {query:key,language:'ko-KR',include_adult:'false'}).then(page => {
        if (!this.validRevision(revision) || !Array.isArray(page?.results)) throw new Error('tmdb-invalid-response');
        const matches = (page.results as SearchResult[]).filter(r => r && ['tv', 'movie'].includes(r.media_type || ''));
        if (matches.some(r => !Number.isSafeInteger(r.id) || r.id < 1 || typeof (r.name || r.title) !== 'string')) throw new Error('tmdb-invalid-response');
        const results = matches.slice(0,20).map(r => candidate(r,r.media_type as MetadataKind));
        this.db.run('INSERT OR REPLACE INTO tmdb_search_cache VALUES(?,?,?)',key,JSON.stringify(results),Date.now());
        this.db.run('DELETE FROM tmdb_search_cache WHERE rowid IN (SELECT rowid FROM tmdb_search_cache ORDER BY fetched_at DESC,rowid DESC LIMIT -1 OFFSET 500)');
        return results;
      }).catch(error => {
        if (this.validRevision(revision)) this.backoff('search:'+key);
        throw error;
      }).finally(() => { if (this.searchRequests.get(key) === work) this.searchRequests.delete(key); });
      this.searchRequests.set(key,work);
      running = work;
    }
    if (usable) { void running.catch(() => {}); return value; }
    return running;
  }
  searchRefreshing(query: string) { return this.searchRequests.has(query.trim()); }
  async change(id: string, body: { action: 'link' | 'off' | 'auto'; kind?: MetadataKind; tmdbId?: number; season?: number }): Promise<MetadataLink> {
    if (!this.enabled) throw new ApiFailure(409, 'metadata-unavailable');
    const revision = this.configurationRevision;
    const media = this.db.get('SELECT title FROM media WHERE id=?', id);
    if (!media) throw new ApiFailure(404, 'media-not-found');
    if (body.action === 'off') this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,status,checked_at) VALUES(?,'off',?)", id, Date.now());
    else if (body.action === 'auto') { this.db.run('DELETE FROM tmdb_links WHERE media_id=?', id); await this.link(id,true); }
    else {
      if (!body.kind || !body.tmdbId) throw new ApiFailure(400, 'invalid-request');
      const info = await this.title(body.kind, body.tmdbId,true);
      if (!this.validRevision(revision)) throw new Error('tmdb-configuration-changed');
      if (!info) throw new ApiFailure(404, 'metadata-not-found');
      if (!this.db.get('SELECT 1 FROM media WHERE id=?', id)) throw new ApiFailure(404, 'media-not-found');
      const wanted = body.season ?? searchTerms(this.db.displayTitle(id, media.title)).season;
      const season = body.kind === 'tv' && wanted && info.seasons?.[wanted] ? wanted : null;
      this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,kind,tmdb_id,season,status,score,checked_at) VALUES(?,?,?,?,'manual',100,?)", id, body.kind, body.tmdbId, season, Date.now());
    }
    await this.ensureDetail(id, 6000);
    return linkInfo(this.db, id, true);
  }
  /** Fill in titles that have never been checked, a few at a time. */
  async backfill() {
    if (!this.enabled) return;
    const revision = this.configurationRevision;
    const hasSources = this.db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'");
    const foreignRetry = hasSources ? `OR EXISTS(SELECT 1 FROM tmdb_links l
      JOIN source_media sm ON sm.media_id=l.media_id JOIN source_entries se ON se.id=sm.source_id
      LEFT JOIN tmdb_match_versions v ON v.media_id=l.media_id
      WHERE l.media_id=m.id AND json_extract(se.entry,'$.lang') IS NOT NULL
      AND lower(json_extract(se.entry,'$.lang')) NOT LIKE 'ko%'
      AND (l.status='none' OR l.status='auto' AND l.score<100) AND COALESCE(v.version,0)<${MATCH_VERSION})` : '';
    const rows = this.db.all(`SELECT id FROM media m WHERE json_extract(metadata,'$.live') IS NOT 1
      AND (NOT EXISTS(SELECT 1 FROM tmdb_links l WHERE l.media_id=m.id) ${foreignRetry}) ORDER BY added_at DESC LIMIT 2000`);
    for (let i = 0; i < rows.length && this.validRevision(revision); i += 6) await Promise.allSettled(rows.slice(i, i + 6).map(r => this.context.run({priority: 'background', revision}, () => this.link(r.id))));
  }
  close() { this.abort.abort(); this.scheduler.close(); }
}

function candidate(r: SearchResult, fallback: MetadataKind): MetadataCandidate {
  const kind = (r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : fallback) as MetadataKind;
  const title = r.name || r.title || '', original = r.original_name || r.original_title;
  return { ...(Array.isArray(r.genre_ids)?{genreIds:r.genre_ids.filter(Number.isSafeInteger)}:{}), kind, id: r.id, title, ...(original && original !== title ? { originalTitle: original } : {}), year: yearOf(r.first_air_date || r.release_date), poster: img('w342', r.poster_path), ...(r.overview ? { overview: r.overview.slice(0, 300) } : {}) };
}

/* ---------- Read side: used by the catalog for every card and detail ---------- */

function linked(db: Store, id: string) {
  return db.get("SELECT l.kind,l.tmdb_id,l.season,l.status,t.card,t.detail FROM tmdb_links l JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE l.media_id=? AND l.status IN ('auto','manual')", id);
}
export function linkInfo(db: Store, id: string, enabled: boolean): MetadataLink {
  const row = db.get('SELECT * FROM tmdb_links WHERE media_id=?', id);
  if (!row) return { status: enabled ? 'pending' : 'none' };
  const title = row.kind ? db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?', row.kind, row.tmdb_id) : undefined;
  return { status: row.status, ...(row.kind ? { kind: row.kind, id: row.tmdb_id } : {}), ...(row.season != null ? { season: row.season } : {}), ...(title ? { title: JSON.parse(title.card).title } : {}) };
}
/** Remote titles prefer TMDB artwork; local libraries keep their own files first. */
export function overlayCard<T extends MediaCard>(db: Store, card: T, local: boolean, episodes?: Episode[]): T {
  const row = linked(db, card.id);
  const original = card.originalTitle || db.get('SELECT title FROM media WHERE id=?',card.id)?.title || card.title;
  if (!local && db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'")) {
    const entry = db.get('SELECT entry FROM source_entries WHERE id=?', card.provider.id);
    const lang = entry && JSON.parse(entry.entry).lang;
    if (lang) card = { ...card, provider: { ...card.provider, lang } };
  }
  if (!row) {
    const { baseTitle, seasonInfo, audio } = parseSeasonInfo(original, { kind: card.type === 'movie' ? 'movie' : undefined });
    return { ...card, baseTitle, seasonInfo, audio };
  }
  const info: CardInfo = JSON.parse(row.card), season = row.season != null ? info.seasons?.[row.season] : undefined;
  const poster = season?.poster || info.poster, prefer = <V>(own: V | undefined, theirs: V | undefined) => local ? own ?? theirs : theirs ?? own;
  let resume = card.resume;
  if (episodes && resume?.kind === 'resume' && !resume.thumb && row.kind === 'tv') {
    const targetId = resume.episodeId;
    const target = episodes.find(episode => episode.id === targetId);
    if (target) {
      const cached = cachedSeason(db, row.tmdb_id, !local && row.season != null ? row.season : target.season);
      if (cached?.length) {
        const season = episodes.filter(episode => episode.season === target.season);
        const thumb = matchSeasonEpisodes(season, cached).get(target.number)?.still;
        if (thumb) resume = { ...resume, thumb };
      }
    }
  }
  const sourceSeason = parseSeasonInfo(original);
  const inferredSeason = row.kind === 'tv' && !local && !sourceSeason.final ? sourceSeason.season ?? 1 : undefined;
  const parsed = parseSeasonInfo(original, { season: row.season ?? inferredSeason, seasons: Object.keys(info.seasons || {}).map(Number), kind: row.kind });
  return {
    ...card,
    ...(resume ? { resume } : {}),
    baseTitle: !local && foreignSource(db,card.id).foreign && /[가-힣]/.test(info.title) ? parseSeasonInfo(info.title).baseTitle : parsed.baseTitle,
    seasonInfo: parsed.seasonInfo,
    audio: parsed.audio,
    ...(!local && foreignSource(db,card.id).foreign && /[가-힣]/.test(info.title) ? { title: localizedTitle(info.title, original), originalTitle: original } : {}),
    ...(prefer(card.poster, poster) ? { poster: prefer(card.poster, poster) } : {}),
    ...(info.backdrop || card.backdrop ? { backdrop: info.backdrop || card.backdrop } : {}),
    ...(info.logo ? { logo: info.logo } : {}),
    ...(card.year ?? season?.year ?? info.year ? { year: card.year ?? season?.year ?? info.year } : {}),
    // "애니" is already the type label; keep the genre for animated movies and series.
    ...(info.genres?.length ? { genres: card.type === 'anime' ? info.genres.filter(g => g !== '애니메이션') : info.genres } : {}),
    ...(info.rating ? { rating: info.rating } : {}),
    ...(info.certification ? { certification: info.certification } : {}),
    ...(info.overview && (!local || !card.overview) ? { overview: info.overview.length > 280 ? info.overview.slice(0, 278).trimEnd() + '…' : info.overview } : {}),
  };
}
function cachedSeason(db: Store, tmdbId: number, season: number): EpisodeInfo[] | undefined {
  const row = db.get('SELECT payload FROM tmdb_seasons WHERE tmdb_id=? AND season=?', tmdbId, season);
  return row && JSON.parse(row.payload);
}

function matchSeasonEpisodes(episodes: Episode[], cached: EpisodeInfo[]) {
  const numbers = new Set(cached.map(episode => episode.number));
  // Some sources continue numbering sequel seasons from the previous season.
  const min = Math.min(...episodes.map(episode => episode.number));
  const offset = episodes.some(episode => numbers.has(episode.number)) ? 0 : min > 1 && numbers.has(1) ? min - 1 : 0;
  return new Map(cached.filter(episode => Number.isInteger(episode.number)).map(episode => [episode.number + offset, episode]));
}

const GENERIC_EPISODE = /^(?:제?\s*\d+\s*(?:화|회|편)|에피소드\s*\d+|episode\s*\d+|ep\.?\s*\d+)$/i;
export function overlayDetail(db: Store, detail: MediaDetail, local: boolean, enabled: boolean): MediaDetail {
  const metadata = linkInfo(db, detail.id, enabled);
  const row = linked(db, detail.id);
  if (!row) return enabled ? { ...detail, metadata } : detail;
  const info: CardInfo = JSON.parse(row.card), extra: DetailInfo = JSON.parse(row.detail);
  const foreign = !local && foreignSource(db,detail.id).foreign;
  const seasonCache = new Map<number, EpisodeInfo[] | undefined>();
  const episodesOf = (n: number) => {
    if (!seasonCache.has(n)) seasonCache.set(n, row.kind === 'tv' ? cachedSeason(db, row.tmdb_id, n) : undefined);
    return seasonCache.get(n);
  };
  const seasons = detail.seasons.map(season => {
    const list = episodesOf(!local && row.season != null ? row.season : season.number);
    if (!list?.length) return season;
    const matched = matchSeasonEpisodes(season.episodes, list);
    const titleKey = tmdbNorm(detail.title);
    return { ...season, episodes: season.episodes.map(ep => {
      const e = matched.get(ep.number);
      if (!e) return ep;
      const name = e.name && !GENERIC_EPISODE.test(e.name.trim()) && tmdbNorm(e.name) !== titleKey ? e.name : undefined;
      return { ...ep, ...(name ? { name, ...(foreign && /[가-힣]/.test(name) ? { title: name } : {}) } : {}), ...(e.overview && !ep.overview ? { overview: e.overview } : {}), ...(e.still && !ep.thumb ? { thumb: e.still } : {}), ...(e.airDate ? { airDate: e.airDate } : {}), ...(!ep.duration && e.runtime ? { duration: e.runtime * 60 } : {}) };
    }) };
  });
  return {
    ...detail, seasons, metadata,
    ...(info.overview && (!local || !detail.overview || info.overview.length > 20) ? { overview: info.overview } : {}),
    ...(extra.tagline ? { tagline: extra.tagline } : {}),
    ...(detail.type === 'movie' && !detail.runtime && info.runtime ? { runtime: info.runtime * 60 } : {}),
    ...(extra.people.length ? { people: extra.people, cast: extra.people.map(p => p.name) } : {}),
    ...(Array.isArray(extra.trailers) ? { trailers: extra.trailers, trailer: extra.trailers[0] } : extra.trailer ? { trailer: extra.trailer, trailers: [extra.trailer] } : {}),
    ...(extra.similar.length ? { similar: extra.similar } : {}),
  };
}

/** Source metadata is optional for local-only catalogs/tests. */
export function foreignSource(db: Store, id: string) {
  if (!db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'")) return { foreign: false, anime: false };
  const source = db.get('SELECT e.entry,e.repository FROM source_media m JOIN source_entries e ON e.id=m.source_id WHERE m.media_id=?',id);
  const entry = source ? JSON.parse(source.entry) : {};
  return { foreign: Boolean(entry.lang && !/^ko(?:-|$)/i.test(entry.lang)), anime: /anime|애니/i.test((entry.name || '') + ' ' + (source?.repository || '')) };
}
export function localizedTitle(korean: string, original: string) {
  const tail = /((?:season\s+\d+|final\s+season|part\s+\d+)(?:\s+(?:season\s+\d+|part\s+\d+))*)\s*$/i.exec(original)?.[1];
  return korean + (tail ? ' ' + tail.replace(/final\s+season/gi,'파이널 시즌').replace(/season/gi,'시즌').replace(/part/gi,'파트') : '');
}
export function subtitleIdentity(db: Store, id: string) {
  const row = linked(db,id);
  if (!row || !foreignSource(db,id).foreign) return undefined;
  const info: CardInfo = JSON.parse(row.card);
  return /[가-힣]/.test(info.title) ? { title: info.title, season: row.season as number | null, aliases: info.originalTitle ? [info.originalTitle] : [] } : undefined;
}

/** Playback classification only; preserve user catalog/source types. */
export function playbackMediaType(db: Store, id: string, type: MediaCard['type']): MediaCard['type'] {
  if (type !== 'series') return type;
  const row = linked(db, id);
  const info: CardInfo | undefined = row ? JSON.parse(row.card) : undefined;
  if (info && !info.animation) return type;
  return foreignSource(db, id).anime || info?.animation && info.originCountries?.includes('JP') ? 'anime' : type;
}
