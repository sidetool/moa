import { createHash } from 'node:crypto';
import { Store } from '../db.js';
const DAY = 86400_000;
export const ACTIVE_DETAIL_POLICY = { freshMs: 15 * 60_000, staleMs: DAY };
export const COMPLETED_DETAIL_POLICY = { freshMs: 3 * DAY, staleMs: 7 * DAY };
export class DetailPolicy {
  constructor(private db: Store, private clock = Date.now) {
    // Old detail_at is not evidence of 21 days of stable episodes.
    db.db.exec(`CREATE TABLE IF NOT EXISTS source_detail_observations(
      media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, episode_count INTEGER NOT NULL, last_episode_id TEXT,
      changed_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      completed INTEGER NOT NULL, reset_until INTEGER NOT NULL DEFAULT 0)`);
  }
  observe(id: string, episodes: { id: string; number: number }[], completed: boolean) {
    const sorted = [...episodes].sort((a,b) => a.number-b.number || a.id.localeCompare(b.id));
    const fingerprint = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    const old = this.db.get('SELECT * FROM source_detail_observations WHERE media_id=?', id), now = this.clock();
    const changed = old && old.fingerprint !== fingerprint;
    this.db.run('INSERT OR REPLACE INTO source_detail_observations VALUES(?,?,?,?,?,?,?,?)', id, fingerprint,
      sorted.length, sorted.at(-1)?.id ?? null, !old || changed ? now : old.changed_at, now, Number(completed), changed ? now + 21*DAY : old?.reset_until ?? 0);
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
