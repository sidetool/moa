import type { Store } from '../db.js';
import type { Sources } from '../sources/service.js';
import type { TitleGroups } from '../catalog/title-groups.js';
import { COMPLETED_DETAIL_POLICY } from '../catalog/detail-policy.js';
import { catalogFreshMs, catalogRefreshMs } from '../system/catalog-refresh.js';

const MINUTE = 60_000;
const BATCH_LIMIT = 20;

/** Work exists only after an authorized visit. Profiles take turns on a single worker. */
export class WatchlistRefresh {
  private batches = new Map<string, string[]>();
  private revisions = new Map<string, number>();
  private checked = new Map<string, number>();
  private attempts = new Map<string, number>();
  private starts: number[] = [];
  private fetching?: string;
  private worker?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private db: Store, private sources: Sources, private groups: TitleGroups, private clock = Date.now) {}

  status(profile: string) {
    return { running: this.batches.has(profile), revision: this.revisions.get(profile) ?? 0 };
  }

  private watched(profile: string) {
    const mapping = this.groups.mapping(profile);
    const selected = new Set(this.groups.savedIds(profile).flatMap(id => mapping.get(id) ?? []));
    return this.groups.latestWatchedMembers(profile, mapping, selected);
  }

  private lastCheck(id: string) {
    const source = this.db.get(`SELECT s.detail_at FROM source_media s
      JOIN source_entries se ON se.id=s.source_id AND se.enabled=1 AND se.code IS NOT NULL AND se.live=0
      JOIN media m ON m.id=s.media_id
      WHERE s.media_id=? AND m.type!='movie' AND COALESCE(json_extract(m.metadata,'$.live'),0)=0`, id);
    return source ? Math.max(source.detail_at, this.attempts.get(id) ?? 0) : Infinity;
  }

  private due(id: string, age: number, interval: number) {
    return age >= interval && age >= this.sources.detailFreshMs(id);
  }

  request(profile: string) {
    if (this.closed || this.batches.has(profile)) return;
    const now = this.clock();
    if (now < (this.checked.get(profile) ?? -Infinity) + MINUTE) return;
    this.checked.set(profile, now);
    const interval = catalogRefreshMs(this.db);
    const retention = Math.max(interval, catalogFreshMs(this.db, COMPLETED_DETAIL_POLICY.freshMs));
    for (const [id, at] of this.attempts) if (now - at > retention) this.attempts.delete(id);
    const ids = [...this.watched(profile).values()].map(id => ({ id, at: this.lastCheck(id) }))
      .filter(item => item.id === this.fetching || this.due(item.id, now - item.at, interval))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .slice(0, BATCH_LIMIT).map(item => item.id);
    if (!ids.length) return;
    this.batches.set(profile, ids);
    this.wake();
  }

  private wake() {
    if (this.closed || this.worker || this.timer || !this.batches.size) return;
    this.worker = Promise.resolve().then(() => this.run()).finally(() => {
      this.worker = undefined;
      this.wake();
    });
  }

  private async run() {
    while (!this.closed && this.batches.size) {
      const now = this.clock();
      this.starts = this.starts.filter(at => now - at < MINUTE);
      if (this.starts.length >= BATCH_LIMIT) {
        this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, this.starts[0] + MINUTE - now);
        this.timer.unref();
        return;
      }
      const [profile, ids] = this.batches.entries().next().value!;
      const id = ids.shift()!;
      // Membership, selected edition and kids visibility can change while another read awaits its source.
      if ([...this.watched(profile).values()].includes(id) && this.due(id, now - this.lastCheck(id), catalogRefreshMs(this.db))) {
        this.starts.push(now);
        this.attempts.set(id, now);
        this.fetching = id;
        try {
          await this.sources.detail(id, true, 'background');
          this.attempts.delete(id); // The successful check is persisted in source_media.detail_at.
        } catch { /* Reuse saved episodes until the next check. */ }
        finally { this.fetching = undefined; }
      }
      if (this.closed || !this.batches.delete(profile)) continue;
      if (ids.length) this.batches.set(profile, ids);
      else this.revisions.set(profile, (this.revisions.get(profile) ?? 0) + 1);
    }
  }

  forget(profile: string) {
    this.batches.delete(profile);
    this.checked.delete(profile);
    this.revisions.delete(profile);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.batches.clear();
    return this.worker;
  }
}
