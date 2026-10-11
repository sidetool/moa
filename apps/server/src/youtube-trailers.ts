import type { Store } from './db.js';
import { ApiFailure } from './util.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const API_KEY = /^[A-Za-z0-9_-]{20,200}$/;
const CACHE_TTL = 6 * 60 * 60_000;
const MAX_CACHE = 512;
type Config = { apiKey?: string; regionCode?: string };
type Patch = Config & { clear?: true };
export interface TrailerCheck { trailers: string[]; checked: boolean }
interface Video {
  id: string;
  status: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
  contentDetails: { regionRestriction?: { allowed?: string[]; blocked?: string[] }; contentRating?: { ytRating?: string } };
}

/** Region is a preference, not IP geolocation. Keep region-blocked references last so a viewer in
 * another country can still try them. Never infer availability from a video's language. */
function regionalPriority(video: Video, region: string) {
  const rule = video.contentDetails.regionRestriction;
  return Number(Boolean(rule?.allowed && !rule.allowed.includes(region) || rule?.blocked?.includes(region)));
}
function validRegion(value: string): boolean {
  // Intl.DisplayNames accepts arbitrary alpha-2 strings; use the ISO region set supported by ICU.
  return /^[A-Z]{2}$/.test(value) && new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(value) !== undefined;
}
function readVideos(payload: any): Video[] {
  if (!payload || !Array.isArray(payload.items) || payload.items.length > 5) throw new Error('youtube-response-invalid');
  for (const video of payload.items) {
    if (!video || typeof video.id !== 'string' || !VIDEO_ID.test(video.id) || !video.status || !video.contentDetails
      || typeof video.status.embeddable !== 'boolean' || typeof video.status.privacyStatus !== 'string') throw new Error('youtube-response-invalid');
    const restriction = video.contentDetails.regionRestriction;
    for (const list of [restriction?.allowed, restriction?.blocked]) {
      if (list !== undefined && (!Array.isArray(list) || list.some((v: unknown) => typeof v !== 'string' || !/^[A-Z]{2}$/.test(v)))) throw new Error('youtube-response-invalid');
    }
  }
  return payload.items;
}

/** Optional, server-only Data API lookup. Existing playback never depends on its success.
 * API results are kept in bounded memory, not written into the country-neutral TMDB cache. */
export class YouTubeTrailers {
  private config: Config = {};
  private revision = 0;
  private closed = false;
  private cooldownUntil = 0;
  private controller = new AbortController();
  private cache = new Map<string, { expires: number; result: TrailerCheck }>();
  private pending = new Map<string, Promise<TrailerCheck>>();
  private readonly environment: Config;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private db: Store, options: { apiKey?: string; fetch?: typeof fetch; now?: () => number } = { apiKey: process.env.MOA_YOUTUBE_API_KEY }) {
    this.environment = { apiKey: options.apiKey?.trim() || undefined };
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.reload();
  }
  private saved(): Config {
    return JSON.parse(this.db.get("SELECT value FROM admin_settings WHERE key='youtube'")?.value || '{}');
  }
  private reload() {
    const saved = this.saved();
    this.config = { apiKey: this.environment.apiKey || saved.apiKey, regionCode: saved.regionCode || 'KR' };
  }
  status() {
    return { configured: Boolean(this.config.apiKey), source: this.environment.apiKey ? 'environment' : this.config.apiKey ? 'database' : 'none',
      hasSavedCredential: Boolean(this.saved().apiKey), regionCode: this.config.regionCode! };
  }
  configure(patch: Patch) {
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length
      || Object.keys(patch).some(k => !['apiKey', 'regionCode', 'clear'].includes(k))
      || patch.apiKey !== undefined && (typeof patch.apiKey !== 'string' || !API_KEY.test(patch.apiKey.trim()))
      || patch.regionCode !== undefined && (typeof patch.regionCode !== 'string' || !validRegion(patch.regionCode))
      || 'clear' in patch && patch.clear !== true || patch.clear && patch.apiKey !== undefined) throw new ApiFailure(400, 'invalid-request');
    if (this.environment.apiKey && patch.apiKey !== undefined) throw new ApiFailure(400, 'youtube-managed-by-environment');
    const saved = this.saved();
    if (patch.clear) delete saved.apiKey;
    if (patch.apiKey !== undefined) saved.apiKey = patch.apiKey.trim();
    if (patch.regionCode !== undefined) saved.regionCode = patch.regionCode;
    this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('youtube',?)", JSON.stringify(saved));
    this.reload();
    this.revision++;
    this.controller.abort(); this.controller = new AbortController();
    this.cache.clear(); this.pending.clear(); this.cooldownUntil = 0;
    return this.status();
  }
  async check(candidates: unknown[]): Promise<TrailerCheck> {
    const trailers = [...new Set(candidates.filter((v): v is string => typeof v === 'string' && VIDEO_ID.test(v)))].slice(0, 5);
    const fallback = { trailers, checked: false };
    if (this.closed || !this.config.apiKey || !trailers.length) return fallback;
    const key = `${this.config.regionCode}:${trailers.join(',')}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return { ...cached.result, trailers: [...cached.result.trailers] };
    this.cache.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    // No queue: prechecking must not hold up a user's existing trailer player.
    if (this.pending.size >= 4 || this.cooldownUntil > this.now()) return fallback;
    const revision = this.revision;
    const work = this.lookup(trailers, this.config.apiKey, this.config.regionCode!, this.controller.signal).then(result => {
      if (this.closed || revision !== this.revision) return fallback;
      this.cache.set(key, { result, expires: this.now() + CACHE_TTL });
      while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      return result;
    }).catch(() => {
      // Do not log upstream errors/URLs: they may contain the API key. Back off across all titles.
      if (!this.closed && revision === this.revision) this.cooldownUntil = this.now() + 5 * 60_000;
      return fallback;
    }).finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); });
    this.pending.set(key, work);
    return work;
  }
  private async lookup(ids: string[], apiKey: string, region: string, signal: AbortSignal): Promise<TrailerCheck> {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ key: apiKey, part: 'contentDetails,status', id: ids.join(','),
      fields: 'items(id,status(embeddable,privacyStatus,uploadStatus),contentDetails(regionRestriction,contentRating/ytRating))' }).toString();
    const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('youtube-unavailable'); }
    const rows = readVideos(await response.json());
    const byId = new Map(rows.map(v => [v.id, v]));
    const usable = ids.map(id => byId.get(id)).filter((v): v is Video => Boolean(v && v.status.embeddable && v.status.privacyStatus !== 'private'
      && !['deleted', 'failed', 'rejected'].includes(v.status.uploadStatus ?? '') && v.contentDetails.contentRating?.ytRating !== 'ytAgeRestricted'));
    usable.sort((a, b) => regionalPriority(a, region) - regionalPriority(b, region));
    return { trailers: usable.map(v => v.id), checked: true };
  }
  close() { this.closed = true; this.controller.abort(); this.cache.clear(); this.pending.clear(); }
}
