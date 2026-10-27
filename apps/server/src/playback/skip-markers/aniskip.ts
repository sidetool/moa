import { cacheKey, readCache } from "./cache.js";
import type { CacheStore, SkipMarkers } from "./types.js";

export interface AnimeQuery { title: string; season?: number; format?: "TV" | "MOVIE"; aliases?: string[] }
export interface AniListMedia { id: number; idMal: number | null; format: string; title: { romaji?: string | null; english?: string | null; native?: string | null }; synonyms?: string[] }
export interface AnimeMatch { malId: number; anilistId: number; title: string; score: number }
export interface AniSkipInterval { type: "op" | "ed"; start: number; end: number; episodeLength?: number; skipId?: string }
export interface AniSkipResult { match: AnimeMatch | null; intervals: AniSkipInterval[]; markers: SkipMarkers | null }
export interface AniSkipOptions {
  cache?: CacheStore;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  anilistUrl?: string;
  aniskipUrl?: string;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
}
export class SkipApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "SkipApiError"; }
}
export function parseSeason(title: string): number | undefined {
  const match = title.match(/(?:season\s*|\bS|第)(\d+)(?:期)?|\b(\d+)(?:st|nd|rd|th)\s+season|(?:^|\s)(\d+)\s*[기期]/i);
  if (match) return Number(match[1] ?? match[2] ?? match[3]);
  const roman = title.match(/\s(II|III|IV|V)\s*$/i)?.[1]?.toUpperCase();
  return roman ? ({ II: 2, III: 3, IV: 4, V: 5 } as Record<string, number>)[roman] : undefined;
}
function baseTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase()
    .replace(/(?:season\s*|\bs|第)\d+(?:期)?|\b\d+(?:st|nd|rd|th)\s+season|\d+\s*[기期]|\s(?:ii|iii|iv|v)\s*$/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const pairs = (text: string) => { const result = new Set<string>(); for (let i = 0; i < text.length - 1; i++) result.add(text.slice(i, i + 2)); return result; };
  const a = pairs(left), b = pairs(right);
  if (!a.size || !b.size) return 0;
  return 2 * [...a].filter(pair => b.has(pair)).length / (a.size + b.size);
}
export function scoreAnimeMatch(media: AniListMedia, query: AnimeQuery): number {
  if (!Number.isInteger(media.idMal) || (media.idMal ?? 0) <= 0) return -Infinity;
  const titles = [...Object.values(media.title ?? {}), ...(media.synonyms ?? [])].filter((t): t is string => typeof t === "string");
  const wanted = [query.title, ...(query.aliases ?? [])];
  const titleScore = Math.max(0, ...wanted.flatMap(a => titles.map(b => similarity(baseTitle(a), baseTitle(b)))));
  if (titleScore < 0.6) return -Infinity;
  const season = query.season ?? parseSeason(query.title) ?? 1;
  const candidateSeason = titles.map(parseSeason).find(value => value !== undefined) ?? 1;
  const format = query.format ?? (/영화|극장판|movie|劇場版/i.test(query.title) ? "MOVIE" : "TV");
  return titleScore * 100 + (season === candidateSeason ? 45 : -100) + (media.format === format ? 20 : format === "TV" && media.format !== "MOVIE" ? 0 : -80);
}

export class AniSkipClient {
  private readonly http: typeof globalThis.fetch;
  constructor(private readonly options: AniSkipOptions = {}) { this.http = options.fetch ?? globalThis.fetch; }
  private async request(url: string, init: RequestInit, signal?: AbortSignal, allowMissing = false): Promise<unknown> {
    signal?.throwIfAborted();
    const response = await this.http(url, { ...init, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 8000)]) });
    if (allowMissing && response.status === 404) {
      // Only a valid found:false response is a cacheable miss; outages/malformed bodies are errors.
      const body = await response.json() as { found?: boolean };
      if (body.found === false) return body;
    }
    if (!response.ok) throw new SkipApiError(`Skip API HTTP ${response.status}`, response.status);
    return response.json();
  }
  async findAnime(query: AnimeQuery, signal?: AbortSignal): Promise<AnimeMatch | null> {
    if (!query.title.trim() || (query.season !== undefined && (!Number.isInteger(query.season) || query.season < 1))) throw new TypeError("Invalid anime title/season");
    signal?.throwIfAborted();
    const key = cacheKey("anilist-v1", query);
    const cached = await readCache<AnimeMatch | null>(this.options.cache, key);
    signal?.throwIfAborted();
    if (cached !== undefined) return cached;
    const season = query.season ?? parseSeason(query.title) ?? 1;
    const searches = [...new Set([query.title, ...(query.aliases ?? [])].flatMap(title => season > 1 && !parseSeason(title) ? [`${title} Season ${season}`, title] : [title]))];
    const candidates = new Map<number, AniListMedia>();
    for (const search of searches) {
      const json = await this.request(this.options.anilistUrl ?? "https://graphql.anilist.co", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `query ($search: String!) { Page(page: 1, perPage: 15) { media(search: $search, type: ANIME) { id idMal format title { romaji english native } synonyms } } }`, variables: { search } }),
      }, signal) as { data?: { Page?: { media?: AniListMedia[] } }; errors?: unknown[] };
      if (json.errors?.length || !Array.isArray(json.data?.Page?.media)) throw new SkipApiError("Invalid AniList GraphQL response");
      for (const item of json.data.Page.media) candidates.set(item.id, item);
      if ([...candidates.values()].some(item => scoreAnimeMatch(item, query) >= 160)) break;
    }
    const ranked = [...candidates.values()].map(media => ({ media, score: scoreAnimeMatch(media, query) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const ambiguous = ranked[1] && best && ranked[1].media.idMal !== best.media.idMal && best.score - ranked[1].score < 5;
    const match: AnimeMatch | null = best && best.score >= 100 && !ambiguous ? {
      malId: best.media.idMal!, anilistId: best.media.id, title: best.media.title.romaji ?? best.media.title.english ?? best.media.title.native ?? query.title, score: best.score,
    } : null;
    await this.options.cache?.set(key, { value: match, expiresAt: Date.now() + (match ? this.options.positiveTtlMs ?? 30 * 86400_000 : this.options.negativeTtlMs ?? 3600_000) });
    return match;
  }
  async getSkipTimes(malId: number, episodeNumber: number, episodeLength: number, signal?: AbortSignal): Promise<AniSkipInterval[]> {
    if (!Number.isInteger(malId) || malId < 1 || !Number.isInteger(episodeNumber) || episodeNumber < 1 || !Number.isFinite(episodeLength) || episodeLength <= 0) throw new TypeError("Invalid MAL ID, episode number, or duration");
    signal?.throwIfAborted();
    const length = Number(episodeLength.toFixed(3));
    const key = cacheKey("aniskip-v2", [malId, episodeNumber, length]);
    const cached = await readCache<AniSkipInterval[]>(this.options.cache, key);
    signal?.throwIfAborted();
    if (cached !== undefined) return cached;
    const url = new URL(`${this.options.aniskipUrl ?? "https://api.aniskip.com/v2/skip-times"}/${malId}/${episodeNumber}`);
    url.searchParams.append("types[]", "op"); url.searchParams.append("types[]", "ed"); url.searchParams.set("episodeLength", length.toFixed(3));
    const json = await this.request(url.toString(), {}, signal, true) as { found?: boolean; results?: { skipType?: string; interval?: { startTime?: number; endTime?: number }; episodeLength?: number; skipId?: string }[] };
    if (typeof json.found !== "boolean" || (json.found && !Array.isArray(json.results))) throw new SkipApiError("Invalid AniSkip response");
    const intervals: AniSkipInterval[] = [];
    for (const item of json.found ? json.results! : []) {
      const start = item.interval?.startTime, end = item.interval?.endTime;
      if ((item.skipType !== "op" && item.skipType !== "ed") || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > episodeLength || end - start < 15 || end - start > 150) continue;
      if (intervals.some(interval => interval.type === item.skipType && interval.start === start && interval.end === end)) continue;
      intervals.push({ type: item.skipType, start, end, episodeLength: item.episodeLength, skipId: item.skipId });
    }
    intervals.sort((a, b) => Math.abs((a.episodeLength ?? length) - length) - Math.abs((b.episodeLength ?? length) - length) || a.start - b.start);
    await this.options.cache?.set(key, { value: intervals, expiresAt: Date.now() + (intervals.length ? this.options.positiveTtlMs ?? 7 * 86400_000 : this.options.negativeTtlMs ?? 3600_000) });
    return intervals;
  }
  async lookup(query: AnimeQuery & { episodeNumber: number; episodeLength: number }, signal?: AbortSignal): Promise<AniSkipResult> {
    const match = await this.findAnime({ title: query.title, season: query.season, format: query.format, aliases: query.aliases }, signal);
    if (!match) return { match: null, intervals: [], markers: null };
    const intervals = await this.getSkipTimes(match.malId, query.episodeNumber, query.episodeLength, signal);
    return { match, intervals, markers: markersFromAniSkip(intervals) };
  }
}
export function markersFromAniSkip(intervals: readonly AniSkipInterval[]): SkipMarkers | null {
  const intro = intervals.find(interval => interval.type === "op");
  const credits = intervals.find(interval => interval.type === "ed");
  return intro || credits ? { ...(intro ? { introStart: intro.start, introEnd: intro.end } : {}), ...(credits ? { creditsStart: credits.start, creditsEnd: credits.end } : {}), source: "aniskip", confidence: 0.75 } : null;
}
