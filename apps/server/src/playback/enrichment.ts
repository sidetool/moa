import { episodeQuery } from '../catalog/episode-query.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AniSkipClient, ANALYSIS_VERSION, mergeMarkers, type SeasonAnalysis, type LocalEpisode, type SkipMarkers, type AnimeQuery, type AniSkipResult } from './skip-markers/index.js';
import type { PlaybackSession } from '@moa/shared';
import { Store } from '../db.js';
import type { Config } from '../config.js';
import { hash } from '../util.js';
import { OnlineSubtitles, sqliteCache } from '../subtitles/online.js';

export function seasonRevision(files: Record<string, any>[]) {
  return hash(JSON.stringify([ANALYSIS_VERSION, files.map(f => [f.episode_id, f.path, f.size, f.mtime])]));
}
export function validMarkers(row: Record<string, any> | undefined, file: Record<string, any>): SkipMarkers | null {
  if (!row || row.file_path !== file.path || row.file_size !== file.size || row.file_mtime !== file.mtime) return null;
  try { return JSON.parse(row.markers); } catch { return null; }
}
export interface EnrichmentOptions {
  analyze?: (episodes: LocalEpisode[], signal: AbortSignal, progress: (value: any) => void) => Promise<SeasonAnalysis>;
  aniSkip?: { lookup(query: AnimeQuery & { episodeNumber: number; episodeLength: number }, signal?: AbortSignal): Promise<AniSkipResult> };
}
export class Enrichment {
  pending?: Promise<void>;
  titlePending?: Promise<void>;
  private closed = false;
  private controller = new AbortController();
  private active?: { key: string; revision: string; controller: AbortController };
  private titleAgain = false;
  private api: NonNullable<EnrichmentOptions['aniSkip']>;
  private apiRequests = new Map<string, Promise<SkipMarkers | null>>();
  private apiActive = 0;
  constructor(private db: Store, private cfg: Config, private online: OnlineSubtitles, private log: (value: Record<string, unknown>) => void, private options: EnrichmentOptions = {}) {
    this.api = options.aniSkip ?? new AniSkipClient({ cache: sqliteCache(db), timeoutMs: 3500 });
    db.run("UPDATE skip_analysis_jobs SET status='queued' WHERE status IN ('running','cancelled')");
  }
  private files(mediaId: string, season: number) {
    return this.db.all('SELECT f.*,e.number FROM files f JOIN episodes e ON e.id=f.episode_id WHERE e.media_id=? AND e.season=? ORDER BY e.number,e.id', mediaId, season);
  }
  schedule() {
    if (this.closed) return;
    this.db.run('DELETE FROM enrichment_cache WHERE expires_at IS NOT NULL AND expires_at<=?', Date.now());
    // File/season revisions supersede cached detections, including manual markers of a different edition.
    this.db.run('DELETE FROM episode_skip_markers WHERE NOT EXISTS(SELECT 1 FROM files f WHERE f.episode_id=episode_skip_markers.episode_id AND f.path=file_path AND f.size=file_size AND f.mtime=file_mtime)');
    const keys = new Set<string>();
    for (const season of this.db.all("SELECT e.media_id,e.season,COUNT(*) AS n FROM episodes e JOIN media m ON m.id=e.media_id JOIN files f ON f.episode_id=e.id WHERE m.type IN ('anime','series') GROUP BY e.media_id,e.season")) {
      const key = `${season.media_id}:${season.season}`, files = this.files(season.media_id, season.season), revision = seasonRevision(files);
      keys.add(key);
      const job = this.db.get('SELECT * FROM skip_analysis_jobs WHERE season_key=?', key);
      if (this.active?.key === key && this.active.revision !== revision) this.active.controller.abort();
      if (job?.revision !== revision) {
        this.db.run("DELETE FROM episode_skip_markers WHERE source='fingerprint' AND episode_id IN(SELECT id FROM episodes WHERE media_id=? AND season=?)", season.media_id, season.season);
        this.db.run("INSERT INTO skip_analysis_jobs(season_key,media_id,season,revision,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(season_key) DO UPDATE SET revision=excluded.revision,status=excluded.status,attempts=0,error=NULL,progress=0,updated_at=excluded.updated_at", key, season.media_id, season.season, revision, season.n >= 3 ? 'queued' : 'complete', Date.now());
      } else if (job.status === 'failed' && job.attempts < 3 && job.updated_at < Date.now() - 60_000) this.db.run("UPDATE skip_analysis_jobs SET status='queued' WHERE season_key=?", key);
    }
    for (const job of this.db.all('SELECT season_key FROM skip_analysis_jobs')) if (!keys.has(job.season_key)) this.db.run('DELETE FROM skip_analysis_jobs WHERE season_key=?', job.season_key);
    if (this.active && !keys.has(this.active.key)) this.active.controller.abort();
    this.titleAgain = true;
    if (!this.titlePending) this.titlePending = this.resolveTitles().catch(error => this.log({ event: 'title-queue-error', error: String(error) })).finally(() => { this.titlePending = undefined; });
    if (!this.pending) this.pending = this.drain().catch(error => this.log({ event: 'skip-queue-error', error: String(error) })).finally(() => { this.pending = undefined; });
  }
  private async resolveTitles() {
    while (this.titleAgain && !this.closed) {
      this.titleAgain = false;
      for (const row of this.db.all("SELECT m.id,m.title,e.season FROM media m JOIN episodes e ON e.media_id=m.id WHERE m.type IN ('anime','series') GROUP BY m.id,e.season")) {
        if (this.closed) return;
        await this.online.resolveTitle(row.id, row.title, row.season, this.controller.signal);
      }
    }
  }
  private analyze(episodes: LocalEpisode[], signal: AbortSignal, progress: (value: any) => void): Promise<SeasonAnalysis> {
    if (this.options.analyze) return this.options.analyze(episodes, signal, progress);
    return new Promise((resolve, reject) => {
      const compiled = fileURLToPath(new URL('./skip-worker.js', import.meta.url));
      const file = existsSync(compiled) ? compiled : fileURLToPath(new URL('./skip-worker.ts', import.meta.url));
      const child = spawn('nice', ['-n', '10', process.execPath, ...(existsSync(compiled) ? [] : process.execArgv), file, this.cfg.dataDir, this.cfg.ffmpeg, this.cfg.ffprobe, this.cfg.mediaRoot], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let result: SeasonAnalysis | undefined, failure: string | undefined, stderr = '';
      let killTimer: NodeJS.Timeout | undefined;
      const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref(); };
      signal.addEventListener('abort', abort, { once: true });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.on('message', (message: any) => { if (message.progress) progress(message.progress); if (message.result) result = message.result; if (message.error) failure = message.error; });
      child.once('error', reject);
      child.once('close', () => { signal.removeEventListener('abort', abort); clearTimeout(killTimer); if (result && !signal.aborted) resolve(result); else reject(new Error(failure || stderr || 'skip analysis cancelled')); });
      child.send(episodes);
      if (signal.aborted) abort();
    });
  }
  private async drain() {
    while (!this.closed) {
      const job = this.db.get("SELECT * FROM skip_analysis_jobs WHERE status='queued' ORDER BY updated_at,season_key LIMIT 1");
      if (!job) return;
      const files = this.files(job.media_id, job.season), controller = new AbortController();
      if (seasonRevision(files) !== job.revision) { this.schedule(); continue; }
      this.active = { key: job.season_key, revision: job.revision, controller };
      this.db.run("UPDATE skip_analysis_jobs SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE season_key=?", Date.now(), job.season_key);
      let lastProgress = 0;
      try {
        const result = await this.analyze(files.map(f => ({ id: f.episode_id, path: f.path, episodeNumber: f.number })), controller.signal, p => {
          if (Date.now() - lastProgress < 500 && p.phase !== 'complete') return;
          lastProgress = Date.now();
          this.db.run('UPDATE skip_analysis_jobs SET phase=?,progress=?,updated_at=? WHERE season_key=? AND revision=?', p.phase, p.ratio, Date.now(), job.season_key, job.revision);
        });
        if (controller.signal.aborted || this.closed || seasonRevision(this.files(job.media_id, job.season)) !== job.revision) continue;
        let failed = false;
        this.db.transaction(() => {
          for (const episode of result.episodes) {
            const file = this.db.get('SELECT * FROM files WHERE episode_id=?', episode.id);
            if (!file || file.path !== episode.file.path || file.size !== episode.file.size || file.mtime !== episode.file.mtimeMs) { failed = true; continue; }
            if (episode.error) failed = true;
            this.save(episode.id, 'fingerprint', episode.markers, file, job.revision);
          }
          this.db.run('UPDATE skip_analysis_jobs SET status=?,phase=?,progress=1,error=?,updated_at=? WHERE season_key=? AND revision=?', failed ? 'failed' : 'complete', 'complete', failed ? 'some-files-failed' : null, Date.now(), job.season_key, job.revision);
        });
        this.log({ event: 'skip-analysis-complete', season: job.season_key, elapsedMs: result.elapsedMs, backend: result.backend, cached: result.cached });
      } catch (error) {
        this.db.run("UPDATE skip_analysis_jobs SET status=?,error=?,updated_at=? WHERE season_key=? AND revision=?", controller.signal.aborted ? 'cancelled' : 'failed', String(error), Date.now(), job.season_key, job.revision);
        if (!controller.signal.aborted) this.log({ event: 'skip-analysis-error', error: String(error) });
      } finally { this.active = undefined; }
    }
  }
  private save(id: string, source: string, markers: SkipMarkers | null, file: Record<string, any>, revision: string | null = null) {
    this.db.run('INSERT OR REPLACE INTO episode_skip_markers VALUES(?,?,?,?,?,?,?,?)', id, source, JSON.stringify(markers), file.path, file.size, file.mtime, revision, Date.now());
  }
  async remoteMarkers(episodeId: string, duration: number): Promise<{ markers: PlaybackSession['markers'] | null; status: 'matched' | 'unavailable' | 'unsupported' | 'error' }> {
    const episode = this.db.get('SELECT e.*,m.title AS original_title,m.type FROM episodes e JOIN media m ON m.id=e.media_id JOIN source_media sm ON sm.media_id=m.id JOIN source_entries se ON se.id=sm.source_id WHERE e.id=? AND se.live=0', episodeId);
    if (!episode || episode.type !== 'anime') return { markers: null, status: 'unsupported' };
    const query = episodeQuery(this.db, episode);
    if (!Number.isInteger(query.episode) || query.episode < 1) return { markers: null, status: 'unsupported' };
    const key = 'remote-aniskip-v1:' + hash(JSON.stringify([episodeId,query.title,query.season,query.episode,Math.round(duration)]));
    const cache = sqliteCache(this.db), cached = await cache.get(key);
    if (cached) return cached.value;
    const pending = this.remoteRequests.get(key);
    if (pending) return pending;
    if (this.remoteRequests.size >= 2 || this.closed) return { markers: null, status: 'error' };
    const task = (async () => {
      try {
        const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
        let aliases = query.aliases;
        if (!aliases.length && this.online.client.animeAliases) {
          const aliasKey = 'anime-alias-v1:' + hash(JSON.stringify([query.title,query.season]));
          const saved = await cache.get(aliasKey);
          aliases = saved?.value ?? await this.online.client.animeAliases(query.title,{season:query.season,signal,timeoutMs:5000});
          if (!saved && aliases.length) await cache.set(aliasKey,{value:aliases,expiresAt:Date.now()+30*86400_000});
        }
        const result = await this.api.lookup({ title: query.title, season: query.season, aliases: aliases.slice(0,2), format:'TV', episodeNumber:query.episode, episodeLength:duration },signal);
        const response = { markers: result.markers, status: result.markers ? 'matched' as const : 'unavailable' as const };
        if (!this.closed) await cache.set(key,{value:response,expiresAt:Date.now()+(result.markers ? 7*86400_000 : 300_000)});
        return response;
      } catch (error) { this.log({event:'remote-aniskip-error',error:String(error)}); return {markers:null,status:'error' as const}; }
    })().finally(()=>this.remoteRequests.delete(key));
    this.remoteRequests.set(key,task);
    return task;
  }
  private remoteRequests = new Map<string, ReturnType<Enrichment['remoteMarkers']>>();
  async markers(episodeId: string): Promise<PlaybackSession['markers']> {
    const file = this.db.get('SELECT f.*,e.media_id,e.season,e.number,e.duration,m.title,m.type FROM files f JOIN episodes e ON e.id=f.episode_id JOIN media m ON m.id=e.media_id WHERE e.id=?', episodeId);
    if (!file || file.type === 'movie') return undefined;
    const rows = this.db.all('SELECT * FROM episode_skip_markers WHERE episode_id=?', episodeId);
    const manual = validMarkers(rows.find(r => r.source === 'manual'), file), fingerprint = validMarkers(rows.find(r => r.source === 'fingerprint'), file);
    let online: SkipMarkers | null = null;
    if ((!manual?.introEnd && !fingerprint?.introEnd) || (!manual?.creditsEnd && !fingerprint?.creditsEnd)) {
      const key = hash(`${episodeId}:${file.path}:${file.size}:${file.mtime}`);
      let task = this.apiRequests.get(key);
      if (!task && this.apiActive < 2 && !this.closed) {
        this.apiActive++;
        task = this.api.lookup({ title: file.title, season: file.season, aliases: [this.db.displayTitle(file.media_id, file.title, file.season)], format: 'TV', episodeNumber: file.number, episodeLength: file.duration }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(6000)])).then(result => {
          if (!this.closed && this.db.get('SELECT episode_id FROM files WHERE episode_id=? AND path=? AND size=? AND mtime=?', episodeId, file.path, file.size, file.mtime)) {
            this.save(episodeId, 'aniskip', result.markers, file);
            if (result.match) void sqliteCache(this.db).set(`anime-match:${file.media_id}:${file.season}`, { value: result.match, expiresAt: Date.now() + 30 * 86400_000 });
          }
          return result.markers;
        }).catch(error => { this.log({ event: 'aniskip-error', error: String(error) }); return null; }).finally(() => { this.apiActive--; this.apiRequests.delete(key); });
        this.apiRequests.set(key, task);
      }
      online = task ? await task : validMarkers(rows.find(r => r.source === 'aniskip'), file);
    }
    const chosen = mergeMarkers(manual, fingerprint, online);
    if (!chosen) return undefined;
    const { introStart, introEnd, creditsStart, creditsEnd, source } = chosen;
    return { ...(introStart === undefined ? {} : { introStart, introEnd }), ...(creditsStart === undefined ? {} : { creditsStart, creditsEnd }), source };
  }
  async close() {
    this.closed = true; this.controller.abort(); this.active?.controller.abort();
    await Promise.allSettled([this.pending, this.titlePending, ...this.apiRequests.values(), ...this.remoteRequests.values()]);
  }
}
