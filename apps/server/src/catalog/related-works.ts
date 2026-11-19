import type { MetadataCandidate, MetadataKind, MediaType, RelatedWork, RelatedWorks } from '@moa/shared';
import type { AniListClient } from '../metadata/anilist-client.js';
import type { Tmdb } from '../metadata/tmdb.js';
import type { Catalog } from './service.js';
import type { TitleGroups } from './title-groups.js';

interface AnimeEdition { format: 'MOVIE' | 'TV'; year: number; search: string; names: string[] }
interface AnimeNode {
  id: number; type: string; format: string; isAdult: boolean;
  title?: {native?: string; romaji?: string; english?: string};
  startDate?: {year?: number}; coverImage?: {medium?: string};
}
interface Evidence extends RelatedWork { names: string[]; format?: string }
const fields = 'id type format isAdult title { native romaji english } startDate { year }';
const findAnime = `query($search:String!,$format:MediaFormat!,$from:FuzzyDateInt!,$to:FuzzyDateInt!){
  Page(page:1,perPage:8){pageInfo{hasNextPage} media(search:$search,type:ANIME,isAdult:false,format:$format,
  startDate_greater:$from,startDate_lesser:$to){${fields}}}}`;
const edgesQuery = `query($id:Int!){Media(id:$id,type:ANIME){${fields} relations{edges{
  relationType node{${fields} coverImage{medium}}}}}}`;
const relationTypes = new Map<string, RelatedWork['relation']>([
  ['PREQUEL','prequel'], ['SEQUEL','sequel'], ['SIDE_STORY','sideStory'], ['SPIN_OFF','sideStory'],
]);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 200;
const validYear = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1880 && n <= 2199;
const namesOf = (node: AnimeNode) => [node.title?.native, node.title?.english, node.title?.romaji].filter(text);
// Preserve subtitles, numbered parts and editions. Canonicalize only explicit numbered season markers.
const nameKey = (s: string) => s.normalize('NFKC').toLowerCase()
  .replace(/(?:시즌|season)\s*(\d+)|(\d+)\s*기|第\s*(\d+)\s*期|\b(\d+)(?:st|nd|rd|th)\s+season\b/giu,
    (_, a,b,c,d) => 'season' + Number(a || b || c || d))
  .replace(/[^\p{L}\p{N}]/gu, '');
const sharesName = (a: string[], b: string[]) => a.some(s => nameKey(s).length > 1 && b.some(t => nameKey(s) === nameKey(t)));

interface Entry {
  id: string; title: string; type: MediaType; sourceYear?: number; kind: MetadataKind; tmdb_id: number; season: number | null;
  provider: string; lang?: string; observedFirst?: number; observedLast?: number;
  card: { title: string; originalTitle?: string; year?: number; adult?: boolean;
    genreIds?: number[]; collectionId?: number | null; seasons?: Record<string,{year?: number}> };
}
function edition(entry: Entry): AnimeEdition | undefined {
  const {card, title, kind} = entry;
  const names = [card.originalTitle, card.title].filter(text);
  if (!text(card.originalTitle) || !card.genreIds?.includes(16) || !names.length) return;
  if (kind === 'movie') {
    if (!validYear(card.year) || validYear(entry.sourceYear) && entry.sourceYear !== card.year) return;
    return {format:'MOVIE', year:card.year, search:card.originalTitle, names:[card.originalTitle]};
  }
  if (entry.type === 'movie' || entry.season === 0 || entry.observedLast !== entry.observedFirst) return;
  const season = entry.season ?? (entry.provider === 'local' ? entry.observedFirst : undefined) ?? 1;
  if (!Number.isInteger(season) || season < 1) return;
  const qualified = names.map(n => n + ' Season ' + season);
  const possible = season === 1 ? [...names, ...qualified] : qualified;
  // A shared TV link cannot identify a cour, OVA or a named spinoff. Only the actual
  // edition title and its year may participate in cross-provider matching.
  if (!sharesName([title], possible)) return;
  const year = card.seasons?.[season]?.year ?? (season === 1 ? card.year : undefined);
  if (!validYear(year) || validYear(entry.sourceYear) && entry.sourceYear !== year) return;
  const original = card.originalTitle + ' Season ' + season;
  return {format:'TV', year, search:card.originalTitle, names:season === 1 ? [card.originalTitle, original] : [original]};
}
function catalogTitle(entry: Entry) {
  const title = entry.card.title;
  if (!text(title) || !/[가-힣]/.test(title)) return entry.title;
  if (entry.kind === 'movie') return title;
  if (/[가-힣]/.test(entry.title)) return entry.title;
  const season = entry.season ?? entry.observedFirst ?? 1;
  return season > 1 ? title + ' 시즌 ' + season : title;
}
function matches(edition: AnimeEdition, node: AnimeNode) {
  return node && Number.isSafeInteger(node.id) && node.id > 0 && node.type === 'ANIME' && node.isAdult === false &&
    node.format === edition.format && node.startDate?.year === edition.year && sharesName(edition.names, namesOf(node));
}
async function animeEdges(client: AniListClient, seed: AnimeEdition): Promise<Evidence[]> {
  const page = (await client.graphql(findAnime, {search:seed.search, format:seed.format,
    from:seed.year * 10000 + 100, to:(seed.year + 1) * 10000 + 101}, undefined, 256*1024))?.Page;
  if (page?.pageInfo?.hasNextPage !== false || !Array.isArray(page.media) || page.media.length > 8) return [];
  const choices = page.media.filter((node: AnimeNode) => matches(seed,node));
  if (choices.length !== 1) return [];
  const parent = (await client.graphql(edgesQuery, {id:choices[0].id}, undefined, 512*1024))?.Media;
  if (!matches(seed,parent) || parent.id !== choices[0].id || !Array.isArray(parent.relations?.edges)) return [];
  const items: Evidence[] = [];
  const seen = new Set<number>();
  for (const edge of parent.relations.edges) {
    const relation = relationTypes.get(edge?.relationType), node: AnimeNode = edge?.node;
    if (!relation || !node || node.type !== 'ANIME' || node.isAdult !== false || !Number.isSafeInteger(node.id) ||
      node.id < 1 || node.id === parent.id || seen.has(node.id)) continue;
    const names = namesOf(node);
    if (!names.length) continue;
    seen.add(node.id);
    const title = names.find(n => /[가-힣]/.test(n)) ?? names[0];
    const cover = node.coverImage?.medium;
    const poster = typeof cover === 'string' && /^https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/[a-zA-Z0-9/_-]+\.(?:jpg|png|webp)$/.test(cover) ? cover : undefined;
    items.push({key:'anilist:' + node.id, relation, title, query:title, names, format:node.format, poster,
      year:validYear(node.startDate?.year) ? node.startDate.year : undefined});
    if (items.length >= 24) break;
  }
  return items;
}

// Read only accepted TMDB identities on accessible installations. Local season numbers
// guard against treating a multi-season folder as one AniList entry.
const entriesSql = `SELECT m.id,m.title,m.type,json_extract(m.metadata,'$.year') AS sourceYear,l.kind,l.tmdb_id,l.season,t.card,
  COALESCE(sm.source_id,json_extract(m.metadata,'$.provider.id'),'local') AS provider,
  json_extract(s.entry,'$.lang') AS lang,
  (SELECT MIN(e.season) FROM available_episodes e WHERE e.media_id=m.id) AS observedFirst,
  (SELECT MAX(e.season) FROM available_episodes e WHERE e.media_id=m.id) AS observedLast
  FROM media m JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('manual','auto')
  JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id
  LEFT JOIN source_media sm ON sm.media_id=m.id
  LEFT JOIN source_entries s ON s.id=sm.source_id
  WHERE l.kind IN ('movie','tv') AND l.tmdb_id>0 AND COALESCE(json_extract(m.metadata,'$.adult'),0)=0 AND COALESCE(json_extract(m.metadata,'$.live'),0)=0
  AND json_extract(t.card,'$.adult')=0
  AND ((sm.source_id IS NULL AND COALESCE(json_extract(m.metadata,'$.provider.id'),'local')='local')
    OR (s.enabled=1 AND s.code IS NOT NULL AND s.live=0))`;
type Cached = {until: number; work: Promise<unknown>};

/** Cache provider evidence only. Read profile permissions, source visibility and grouping on every response. */
export class WorkRelations {
  private cache = new Map<string, Cached>();
  private active = 0;
  constructor(private catalog: Catalog, private groups: TitleGroups,
    private tmdb: Pick<Tmdb,'enabled'|'configurationRevision'|'movieCollectionId'|'collectionMembers'>, private anilist: AniListClient, private now = Date.now) {}
  private read(where: string, ...values: string[]): Entry[] {
    const rows = this.catalog.db.all<Omit<Entry,'card'> & {card:string}>(entriesSql + ' AND ' + where, ...values);
    return rows.map(row => ({...row, card:JSON.parse(row.card)}));
  }
  private cached<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
    const prior = this.cache.get(key);
    if (prior && prior.until > this.now()) return prior.work as Promise<T[]>;
    if (this.active >= 4) return Promise.resolve([]);
    if (this.cache.size >= 128) {
      const oldest = [...this.cache].find(([,v]) => v.until !== Infinity);
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.active++;
    const entry = {until:Infinity,work:Promise.resolve().then(load).then(rows => {
      entry.until = this.now() + (rows.length ? 6*3600_000 : 3600_000);
      return rows;
    }, () => {entry.until = this.now()+60_000; return [] as T[];}).finally(() => {this.active--;})};
    this.cache.set(key,entry);
    return entry.work;
  }
  private async collection(current: Entry, revision: number) {
    if (current.kind !== 'movie' || current.card.collectionId === null ||
      validYear(current.sourceYear) && validYear(current.card.year) && current.sourceYear !== current.card.year) return;
    let collectionId = current.card.collectionId;
    if (collectionId === undefined) {
      const ids = await this.cached('legacy-movie:' + revision + ':' + current.tmdb_id, async () => {
        const id = await this.tmdb.movieCollectionId(current.tmdb_id);
        return id ? [id] : [];
      });
      collectionId = ids[0];
    }
    if (!collectionId || !this.tmdb.enabled || this.tmdb.configurationRevision !== revision) return;
    const items = await this.cached('collection:' + revision + ':' + collectionId, async () => {
      const parts = await this.tmdb.collectionMembers(collectionId);
      return parts.map((part: MetadataCandidate): Evidence => ({key:'tmdb:movie:' + part.id, relation:'collection',
        title:part.title, query:part.title, poster:part.poster, year:part.year, names:[part.originalTitle || part.title].filter(text),
        tmdb:{kind:'movie',id:part.id}}));
    });
    return {id:collectionId,items};
  }
  private animeEnabled(profile: string) {
    const settings = this.catalog.db.settings(profile);
    return !this.catalog.kids.active(profile) && settings.recommendationsEnabled !== false && settings.anilistRecommendationsEnabled === true;
  }
  async get(id: string, profile: string): Promise<RelatedWorks> {
    const empty = {items:[]};
    if (!this.tmdb.enabled) return empty;
    const current = this.read('m.id=?', id)[0];
    if (!current) return empty;
    const revision = this.tmdb.configurationRevision;
    const seed = this.animeEnabled(profile) ? edition(current) : undefined;
    if (!seed && (current.kind !== 'movie' || current.card.collectionId === null)) return empty;
    const [anime, movies] = await Promise.all([
      seed ? this.cached(JSON.stringify(['anime',revision,seed]), () => animeEdges(this.anilist,seed)) : [],
      this.collection(current,revision),
    ]);
    if (!this.tmdb.enabled || revision !== this.tmdb.configurationRevision) return empty;
    const fresh = this.read('m.id=?',id)[0];
    if (!fresh || current.kind !== fresh.kind || current.tmdb_id !== fresh.tmdb_id || current.season !== fresh.season) return empty;
    const validAnime = seed && this.animeEnabled(profile) && JSON.stringify(edition(fresh)) === JSON.stringify(seed) ? anime : [];
    const members = movies && movies.id === fresh.card.collectionId && movies.items.some(r => r.tmdb?.id === fresh.tmdb_id)
      ? movies.items.filter(r => r.tmdb?.id !== fresh.tmdb_id) : [];
    if (!members.length && !validAnime.length) return empty;
    const evidence = validAnime.map(work => {
      if (work.format !== 'MOVIE' || !work.year) return work;
      const same = members.filter(m => m.year === work.year && sharesName(m.names,work.names));
      if (same.length !== 1) return work;
      // Both providers identify this film in the same relation set. Retain the
      // explicit edge, localized movie title and exact collection member id.
      return {...same[0], key:work.key, relation:work.relation, format:work.format};
    });
    const ids = JSON.stringify(members.map(r => r.tmdb!.id));
    const years = JSON.stringify(validAnime.flatMap(r => r.year ? [r.year] : []));
    const movieIds = `(l.kind='movie' AND l.tmdb_id IN (SELECT value FROM json_each(?)))`;
    const animeYears = `(l.kind,l.tmdb_id) IN (SELECT kind,tmdb_id FROM tmdb_titles
      WHERE EXISTS(SELECT 1 FROM json_each(card,'$.genreIds') WHERE value=16) AND
      (json_extract(card,'$.year') IN (SELECT value FROM json_each(?)) OR EXISTS(
      SELECT 1 FROM json_each(card,'$.seasons') WHERE json_extract(value,'$.year') IN (SELECT value FROM json_each(?)))))`;
    const candidates = this.read(years === '[]' ? movieIds : `(${movieIds} OR ${animeYears})`, ids, ...(years === '[]' ? [] : [years, years]));
    const map = candidates.length ? this.groups.mapping(profile) : new Map<string,string>();
    const kids = this.catalog.kids.active(profile);
    const visible = candidates.filter(row => map.has(row.id));
    const rank = (r: Entry) => r.provider === fresh.provider ? 0 : r.lang === 'ko' ? 1 : r.lang === 'all' || r.provider === 'local' ? 2 : 3;
    visible.sort((a,b) => rank(a)-rank(b) || a.id.localeCompare(b.id));
    const editions = new Map(validAnime.length ? visible.map(row => [row.id,edition(row)] as const) : []);
    const result: RelatedWork[] = [], seen = new Set<string>();
    for (const work of [...evidence,...members]) {
      const matched = visible.filter(row => {
        if (work.tmdb) return row.kind === work.tmdb.kind && row.tmdb_id === work.tmdb.id &&
          (!validYear(work.year) || [row.sourceYear,row.card.year].every(y => !validYear(y) || y === work.year));
        const target = editions.get(row.id);
        return !!target && target.format === work.format && target.year === work.year && sharesName(target.names,work.names);
      });
      const groups = new Set(matched.map(r => map.get(r.id)));
      const identities = new Set(matched.map(r => JSON.stringify([r.kind,r.tmdb_id,r.season ?? 1])));
      const target = groups.size === 1 && identities.size === 1 ? matched[0] : undefined;
      if (kids && !target || target && map.get(target.id) === map.get(id)) continue;
      const tmdb = work.tmdb ?? (target ? {kind:target.kind,id:target.tmdb_id} : undefined);
      // Distinct AniList seasons can share a TMDB TV id. Only movie IDs and
      // resolved catalog groups identify duplicates across these providers.
      const keys = [work.key];
      if (tmdb?.kind === 'movie') keys.push('tmdb:movie:' + tmdb.id);
      if (target) keys.push('group:' + map.get(target.id));
      if (keys.some(k => seen.has(k))) continue;
      keys.forEach(k => seen.add(k));
      const titles = new Set(matched.map(catalogTitle));
      const commonTitle = titles.size === 1 ? titles.values().next().value : undefined;
      const title = target ? catalogTitle(target) : commonTitle && /[가-힣]/.test(commonTitle) ? commonTitle : work.title;
      result.push({key:work.key, relation:work.relation, title, query:title, year:work.year, poster:work.poster, tmdb, mediaId:target?.id});
      if (result.length >= 24) break;
    }
    return {items:result};
  }
}
