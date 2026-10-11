import type { MetadataCandidate, TrendingQuery, TrendingResponse } from '@moa/shared';
import type { Store } from './db.js';
import type { Tmdb } from './tmdb.js';

type Snapshot = { items: MetadataCandidate[]; fetchedAt: number };
type Entry = { snapshot?: Snapshot; retryAfter: number; pending?: Promise<void> };
const FRESH = 30 * 60_000, STALE = 24 * 60 * 60_000, RETRY = 60_000;
const empty = (status: TrendingResponse['status']): TrendingResponse => ({ status, items: [], updatedAt: null, stale: false });

/** At most four cache entries. Shared public data, never shared profile/history information. */
export class PluginDiscovery {
  private revision = -1;
  private entries = new Map<string, Entry>();
  constructor(private db: Store, private tmdb: Pick<Tmdb, 'enabled' | 'configurationRevision' | 'trending'>, private now = Date.now) {}
  async trending(profile: string, query: TrendingQuery): Promise<TrendingResponse> {
    // TMDB trending has no reliable per-item age certification. Never expose its unrestricted list to children.
    const allowed = () => this.db.get('SELECT kids FROM profiles WHERE id=?', profile)?.kids === 0;
    if (!allowed()) return empty('restricted');
    if (this.revision !== this.tmdb.configurationRevision) {
      this.entries.clear(); this.revision = this.tmdb.configurationRevision;
    }
    if (!this.tmdb.enabled) return empty('unconfigured');
    const generation = this.revision, key = `${query.kind}/${query.window}`;
    if (!this.entries.has(key)) this.entries.set(key, { retryAfter: 0 });
    const entry = this.entries.get(key)!;
    if ((!entry.snapshot || this.now() - entry.snapshot.fetchedAt >= FRESH) && this.now() >= entry.retryAfter) {
      entry.pending ??= (async () => {
        try { entry.snapshot = { items: await this.tmdb.trending(query), fetchedAt: this.now() }; }
        catch { entry.retryAfter = this.now() + RETRY; }
        finally { entry.pending = undefined; }
      })();
      await entry.pending;
    }
    if (!allowed()) return empty('restricted');
    if (!this.tmdb.enabled) return empty('unconfigured');
    if (this.tmdb.configurationRevision !== generation) return empty('unavailable');
    if (!entry.snapshot || this.now() - entry.snapshot.fetchedAt >= STALE) return empty('unavailable');
    return { status: 'ready', items: entry.snapshot.items, updatedAt: new Date(entry.snapshot.fetchedAt).toISOString(), stale: this.now() - entry.snapshot.fetchedAt >= FRESH };
  }
}
