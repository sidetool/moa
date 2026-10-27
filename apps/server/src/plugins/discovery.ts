import type { DiscoveryItem, TrendingQuery, TrendingResponse } from '@moa/shared';
import type { Store } from '../db.js';
/** One host-selected provider. No registry, client-selected upstream or credential exposure. */
export interface TrendingProvider {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly configurationRevision: number;
  trending(query: TrendingQuery): Promise<DiscoveryItem[]>;
}

type Snapshot = { items: DiscoveryItem[]; fetchedAt: number };
type Entry = { snapshot?: Snapshot; retryAfter: number; pending?: Promise<void> };
const FRESH = 30 * 60_000, STALE = 24 * 60 * 60_000, RETRY = 60_000;
const empty = (provider: string, status: TrendingResponse['status']): TrendingResponse => ({ provider, status, items: [], updatedAt: null, stale: false });

/** At most four cache entries. Shared public data, never shared profile/history information. */
export class PluginDiscovery {
  private revision = -1;
  private providerId = '';
  private entries = new Map<string, Entry>();
  constructor(private db: Store, private source: TrendingProvider, private now = Date.now) {}
  async trending(profile: string, query: TrendingQuery): Promise<TrendingResponse> {
    const provider = this.source.providerId;
    // Trending results have no reliable per-item age certification. Never expose its unrestricted list to children.
    const allowed = () => this.db.get('SELECT kids FROM profiles WHERE id=?', profile)?.kids === 0;
    if (!allowed()) return empty(provider, 'restricted');
    if (this.revision !== this.source.configurationRevision || this.providerId !== provider) {
      this.entries.clear(); this.revision = this.source.configurationRevision; this.providerId = provider;
    }
    if (!this.source.enabled) return empty(provider, 'unconfigured');
    const generation = this.revision, key = `${query.kind}/${query.window}`;
    if (!this.entries.has(key)) this.entries.set(key, { retryAfter: 0 });
    const entry = this.entries.get(key)!;
    if ((!entry.snapshot || this.now() - entry.snapshot.fetchedAt >= FRESH) && this.now() >= entry.retryAfter) {
      entry.pending ??= (async () => {
        try { entry.snapshot = { items: await this.source.trending(query), fetchedAt: this.now() }; }
        catch { entry.retryAfter = this.now() + RETRY; }
        finally { entry.pending = undefined; }
      })();
      await entry.pending;
    }
    if (!allowed()) return empty(provider, 'restricted');
    if (!this.source.enabled) return empty(provider, 'unconfigured');
    if (this.source.configurationRevision !== generation || this.source.providerId !== provider) return empty(provider, 'unavailable');
    if (!entry.snapshot || this.now() - entry.snapshot.fetchedAt >= STALE) return empty(provider, 'unavailable');
    return { provider, status: 'ready', items: entry.snapshot.items, updatedAt: new Date(entry.snapshot.fetchedAt).toISOString(), stale: this.now() - entry.snapshot.fetchedAt >= FRESH };
  }
}
