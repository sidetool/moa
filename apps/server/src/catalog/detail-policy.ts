import { createHash } from 'node:crypto';
import { Store } from '../db.js';
const DAY = 86400_000;
export const ACTIVE_DETAIL_POLICY = { freshMs: 15 * 60_000, staleMs: DAY };
export const COMPLETED_DETAIL_POLICY = { freshMs: 3 * DAY, staleMs: 7 * DAY };
type EpisodeIdentity = { id: string; number: number };
function sortEpisodes(episodes: EpisodeIdentity[]) {
  return [...episodes].sort((a,b) => a.number-b.number || a.id.localeCompare(b.id));
}
function fingerprintOf(sorted: EpisodeIdentity[]) {
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export class DetailPolicy {
  constructor(private db: Store, private clock = Date.now) {
    // Old detail_at is not evidence of 21 days of stable episodes.
    db.db.exec(`CREATE TABLE IF NOT EXISTS source_detail_observations(
      media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, episode_count INTEGER NOT NULL, last_episode_id TEXT,
      changed_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      completed INTEGER NOT NULL, reset_until INTEGER NOT NULL DEFAULT 0, episode_ids TEXT, episodes_updated_at INTEGER)`);
    const columns = db.all('PRAGMA table_info(source_detail_observations)').map(row=>row.name);
    if (!columns.includes('episode_ids')) db.transaction(() => {
      db.db.exec('ALTER TABLE source_detail_observations ADD COLUMN episode_ids TEXT');
      // Catalog rows for withdrawn episodes may still hold progress. Only recover
      // the last observed membership when its original fingerprint agrees.
      for (const row of db.all('SELECT media_id,fingerprint FROM source_detail_observations')) {
        const episodes = sortEpisodes(db.all('SELECT id,number FROM episodes WHERE media_id=?', row.media_id).map(e=>({id:e.id,number:e.number})));
        if (fingerprintOf(episodes) === row.fingerprint) db.run('UPDATE source_detail_observations SET episode_ids=? WHERE media_id=?', JSON.stringify(episodes.map(e=>e.id)), row.media_id);
      }
    });
    if (!columns.includes('episodes_updated_at')) db.db.exec('ALTER TABLE source_detail_observations ADD COLUMN episodes_updated_at INTEGER');
  }
  observe(id: string, episodes: EpisodeIdentity[], completed: boolean) {
    const sorted = sortEpisodes(episodes);
    const fingerprint = fingerprintOf(sorted);
    const old = this.db.get('SELECT * FROM source_detail_observations WHERE media_id=?', id), now = this.clock();
    const changed = old && old.fingerprint !== fingerprint;
    const previous = old?.episode_ids ? new Set<string>(JSON.parse(old.episode_ids)) : null;
    const added = previous && sorted.some(episode=>!previous.has(episode.id));
    this.db.run('INSERT OR REPLACE INTO source_detail_observations(media_id,fingerprint,episode_count,last_episode_id,changed_at,observed_at,completed,reset_until,episode_ids,episodes_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, fingerprint,
      sorted.length, sorted.at(-1)?.id ?? null, !old || changed ? now : old.changed_at, now, Number(completed), changed ? now + 21*DAY : old?.reset_until ?? 0, JSON.stringify(sorted.map(episode=>episode.id)), added ? now : old?.episodes_updated_at ?? null);
  }
  invalidateSource(source: string) {
    this.db.run('DELETE FROM source_detail_observations WHERE media_id IN (SELECT media_id FROM source_media WHERE source_id=?)', source);
  }
  policy(id: string) {
    const now = this.clock(), observation = this.db.get('SELECT * FROM source_detail_observations WHERE media_id=?', id);
    if (observation?.reset_until > now) return ACTIVE_DETAIL_POLICY;
    const media = this.db.get('SELECT type,metadata FROM media WHERE id=?', id);
    if (!media || JSON.parse(media.metadata).live) return ACTIVE_DETAIL_POLICY;
    if (media.type === 'movie') return COMPLETED_DETAIL_POLICY;
    const link = this.db.get("SELECT t.card FROM tmdb_links l LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE l.media_id=? AND l.status IN ('auto','manual')", id);
    if (link) {
      const card = JSON.parse(link.card || '{}'), date = card.lastAirDate;
      const ended = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : NaN;
      const validDate = Number.isFinite(ended) && new Date(ended).toISOString().slice(0,10) === date;
      return ['Ended','Canceled'].includes(card.status) && validDate && now-ended >= 30*DAY ? COMPLETED_DETAIL_POLICY : ACTIVE_DETAIL_POLICY;
    }
    return observation?.completed && observation.episode_count > 0 && now-observation.changed_at >= 21*DAY
      ? COMPLETED_DETAIL_POLICY : ACTIVE_DETAIL_POLICY;
  }
}
