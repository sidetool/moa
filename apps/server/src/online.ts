import { subtitleIdentity } from './tmdb.js';
import { subtitleQuery } from './subtitle-query.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createSubtitleClient, parseSeason, type SubtitleClient, type SubtitleCandidate } from '@moa/subtitles-ko';
import type { OnlineSubtitleSearch, OnlineSubtitleQuery, SubtitleTrack, OnlineSubtitleIssue } from '@moa/shared';
import { Store } from './db.js';
import { ApiFailure, hash } from './util.js';

export function sqliteCache(db: Store) {
  return {
    async get(key: string) {
      const row = db.get('SELECT * FROM enrichment_cache WHERE key=?', key);
      if (!row || row.expires_at !== null && row.expires_at <= Date.now()) return undefined;
      try { return { value: JSON.parse(row.payload), expiresAt: row.expires_at ?? Number.MAX_SAFE_INTEGER }; } catch { return undefined; }
    },
    async set(key: string, entry: { value: unknown; expiresAt?: number }) {
      db.run('INSERT OR REPLACE INTO enrichment_cache VALUES(?,?,?)', key, JSON.stringify(entry.value), entry.expiresAt ?? Date.now() + 30 * 86400_000);
    },
  };
}
export type OnlineClient = Pick<SubtitleClient, 'searchSubtitles' | 'resolveKoreanTitle'> & Partial<Pick<SubtitleClient, 'animeAliases'>>;
interface Search { episodeId: string; profileId: string; expiresAt: number; candidates: SubtitleCandidate[] }
export class OnlineSubtitles {
  readonly client: OnlineClient;
  searches = new Map<string, Search>();
  private assets = new Map<string, { episodeId: string; subtitleId: string; profileId: string; touched: number }>();
  private janitor: NodeJS.Timeout;
  private diagnostics = new AsyncLocalStorage<{ partial: boolean; issues: OnlineSubtitleIssue[] }>();
  private controller = new AbortController();
  constructor(private db: Store, private log: (value: Record<string, unknown>) => void, client?: OnlineClient) {
    this.client = client ?? createSubtitleClient({ cache: sqliteCache(db), onDiagnostic: d => {
      if (['timeout', 'error', 'aborted'].includes(d.code)) { const state = this.diagnostics.getStore(); if (state) state.partial = true; }
      const current = this.diagnostics.getStore();
      const kind: OnlineSubtitleIssue['kind'] = /HTTP (401|403)\b/.test(d.message ?? '') ? 'access-denied'
        : d.code === 'timeout' || d.code === 'aborted' ? 'timeout' : d.code === 'not-found' ? 'not-found' : 'fetch-failed';
      if (current && current.issues.length < 16 && !current.issues.some(item => item.kind === kind && item.creatorName === d.creatorName))
        current.issues.push({kind, ...(d.creatorName ? {creatorName: d.creatorName.slice(0,100)} : {})});
      this.log({ event: 'online-subtitle-diagnostic', ...d });
    } });
    this.janitor = setInterval(() => {
      for (const [id, asset] of this.assets) if (Date.now() - asset.touched > 30 * 60_000) this.assets.delete(id);
      for (const [id, search] of this.searches) if (search.expiresAt <= Date.now()) this.searches.delete(id);
    }, 60_000); this.janitor.unref();
  }
  episode(id: string) {
    const row = this.db.get('SELECT e.*,m.title AS original_title,m.type FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?', id);
    if (!row) throw new ApiFailure(404, 'episode-not-found');
    return row;
  }
  async resolveTitle(mediaId: string, original: string, season: number, signal?: AbortSignal): Promise<string> {
    season = parseSeason(original) ?? season;
    const cached = this.db.get('SELECT * FROM media_titles WHERE media_id=? AND season=? AND original_title=?', mediaId, season, original);
    if (cached && cached.expires_at > Date.now()) return cached.title;
    let title = original;
    try {
      const resolved = await this.client.resolveKoreanTitle(original, { season, signal: AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]), timeoutMs: 12_000 });
      // The package's unresolved fallback can append "2기" to an English title.
      // Only adopt an actual Korean title; keep the original on a failed match.
      if (/[가-힣]/.test(resolved.replace(/\s+\d+기$/, ''))) title = resolved;
    }
    catch (error) { this.log({ event: 'korean-title-error', title: original, error: String(error) }); }
    if (!this.controller.signal.aborted && this.db.get('SELECT id FROM media WHERE id=? AND title=?', mediaId, original)) {
      this.db.run('INSERT OR REPLACE INTO media_titles VALUES(?,?,?,?,?)', mediaId, season, original, title, Date.now() + (title !== original ? 30 * 86400_000 : 300_000));
    }
    return title;
  }
  async search(episodeId: string, profileId: string, signal?: AbortSignal, override: Partial<OnlineSubtitleQuery> = {}): Promise<OnlineSubtitleSearch> {
    const episode = this.episode(episodeId), state = { partial: false, issues: [] as OnlineSubtitleIssue[] };
    for (const [id, search] of this.searches) if (search.expiresAt <= Date.now()) this.searches.delete(id);
    if (this.searches.size >= 100) this.searches.delete(this.searches.keys().next().value!);
    const requestSignal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
    return this.diagnostics.run(state, async () => {
      const query = subtitleQuery(this.db, episode, override);
      const identity = subtitleIdentity(this.db, episode.media_id);
      // Title lookup and collection share the budget, but neither waits for
      // the other to finish before starting its own network requests.
      const titleTask = identity || Object.keys(override).length > 0 ? Promise.resolve(query.season > 1 ? `${query.title} ${query.season}기` : query.title) : this.resolveTitle(episode.media_id, query.title, query.season, requestSignal);
      let candidates: SubtitleCandidate[] = [];
      try { candidates = await this.client.searchSubtitles({ title: query.title, aliases: query.aliases, season: query.season, episode: query.episode, episodeOffset: query.episodeOffset, timeoutMs: 12_000, signal: requestSignal }); }
      catch (error) { state.partial = true; this.log({ event: 'online-subtitle-error', error: String(error) }); }
      const resolvedTitle = await titleTask;
      if (requestSignal.aborted) state.partial = true;
      // Metadata is public; subtitle bodies stay on the server, scoped to this profile and episode.
      const searchId = randomUUID(), expiresAt = Date.now() + 300_000;
      this.episode(episodeId);
      this.searches.set(searchId, { episodeId, profileId, candidates, expiresAt });
      return { searchId, resolvedTitle, query, autoApply: query.warnings.length === 0, candidates: candidates.map(c => ({ id: c.id, creatorName: c.creatorName, sourceUrl: c.sourceUrl, filename: c.filename, format: c.format, matchedEpisode: c.matchedEpisode, confidence: c.confidence })), partial: state.partial, issues: state.issues, expiresAt };
    });
  }
  track(row: Record<string, any>, url: string): SubtitleTrack {
    return { id: row.id, label: `${row.creator_name} · 한국어`, lang: 'ko', format: row.format, source: 'online', provenance: { creatorName: row.creator_name, sourceUrl: row.source_url }, default: true,
      url };
  }
  apply(episodeId: string, profileId: string, searchId: string, candidateId: string): SubtitleTrack {
    this.episode(episodeId);
    const search = this.searches.get(searchId);
    if (!search || search.expiresAt <= Date.now()) throw new ApiFailure(409, 'subtitle-search-expired');
    if (search.episodeId !== episodeId || search.profileId !== profileId) throw new ApiFailure(404, 'subtitle-candidate-not-found');
    const c = search.candidates.find(c => c.id === candidateId);
    if (!c) throw new ApiFailure(404, 'subtitle-candidate-not-found');
    const digest = hash(c.content);
    this.db.run('INSERT OR IGNORE INTO online_subtitles VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), episodeId, c.creatorName, c.sourceUrl, c.format, c.content, digest, randomUUID(), Date.now());
    const row = this.db.get('SELECT * FROM online_subtitles WHERE episode_id=? AND creator_name=? AND content_hash=?', episodeId, c.creatorName, digest)!;
    // Applying a subtitle may precede video playback. Give it an asset-only
    // session with the same profile binding and 30-minute idle expiry as playback.
    return this.savedTrack(row, profileId);
  }
  saved(episodeId: string) { return this.db.all('SELECT * FROM online_subtitles WHERE episode_id=? ORDER BY created_at DESC,id', episodeId); }
  tracks(episodeId: string, profileId: string) { return this.saved(episodeId).map(row => this.savedTrack(row, profileId)); }
  private savedTrack(row: Record<string, any>, profileId: string) {
    const token = randomUUID();
    this.assets.set(token, { episodeId: row.episode_id, subtitleId: row.id, profileId, touched: Date.now() });
    return this.track(row, `/api/playback/${token}/subtitles/${row.id}.${row.format}`);
  }
  content(episodeId: string, subtitleId: string, token?: string, profileId?: string) {
    const row = this.db.get('SELECT * FROM online_subtitles WHERE id=? AND episode_id=?', subtitleId, episodeId);
    if (!row || !profileId && token !== row.token) throw new ApiFailure(404, 'subtitle-not-found');
    return row;
  }
  assetProfile(sessionId: string) { return this.assets.get(sessionId)?.profileId; }
  asset(sessionId: string, track: string, profileId?: string) {
    const asset = this.assets.get(sessionId);
    if (!asset) return undefined;
    if (Date.now() - asset.touched > 30 * 60_000) { this.assets.delete(sessionId); throw new ApiFailure(404, 'session-expired'); }
    if (profileId && asset.profileId !== profileId) throw new ApiFailure(403, 'session-profile-mismatch');
    const row = this.content(asset.episodeId, asset.subtitleId, undefined, asset.profileId);
    if (track !== `${row.id}.${row.format}`) throw new ApiFailure(404, 'subtitle-not-found');
    asset.touched = Date.now(); return row;
  }
  removeAsset(sessionId: string, profileId: string) {
    const asset = this.assets.get(sessionId);
    if (!asset) return false;
    if (asset.profileId !== profileId) throw new ApiFailure(403, 'session-profile-mismatch');
    this.assets.delete(sessionId); return true;
  }
  removeEpisodes(ids: Set<string>) {
    for (const [id, search] of this.searches) if (ids.has(search.episodeId)) this.searches.delete(id);
    for (const [id, asset] of this.assets) if (ids.has(asset.episodeId)) this.assets.delete(id);
  }
  removeProfile(profileId: string) { for (const [id, search] of this.searches) if (search.profileId === profileId) this.searches.delete(id); for (const [id, asset] of this.assets) if (asset.profileId === profileId) this.assets.delete(id); }
  remove(episodeId: string, subtitleId: string) {
    this.episode(episodeId);
    const row = this.db.get('SELECT id FROM online_subtitles WHERE episode_id=? AND id=?', episodeId, subtitleId);
    if (!row) throw new ApiFailure(404, 'subtitle-not-found');
    this.db.run('DELETE FROM online_subtitles WHERE id=?', subtitleId);
  }
  close() { clearInterval(this.janitor); this.controller.abort(); this.searches.clear(); this.assets.clear(); }
}
