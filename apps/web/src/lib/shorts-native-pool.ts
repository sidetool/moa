import { closeShortNative, prepareShortNative, warmShortNative, type ShortsNativeSession } from "../api/shorts";

const KEEP_MS = 120_000; // a prepared but unused answer is trusted this long (the server lease is longer)
const AHEAD = 2;

/** One preparation request; whoever holds it releases its lease. */
export interface NativeTicket { key: string; promise: Promise<ShortsNativeSession>; abort: AbortController; session?: ShortsNativeSession; settledAt?: number; dropped?: boolean; returned?: number }

/** Per-feed preparation of the next two works; the playing work's ticket belongs to its player. The first
 *  ahead is requested at once, the second only after the first settles, so the foreground keeps capacity.
 *  Prefetched leases ask the server to warm their first media; nothing here plays media or reports
 *  seen/skip. A failed prefetch is kept, so moving there shows that failure instead of repeating it. */
export class NativePool {
  private slots = new Map<string, NativeTicket>();
  private wanted: string[] = [];
  private disposed = false;

  private request(key: string, warm: boolean): NativeTicket {
    const abort = new AbortController();
    const ticket: NativeTicket = { key, abort, promise: undefined as unknown as Promise<ShortsNativeSession> };
    ticket.promise = prepareShortNative(key, abort.signal).then(session => {
      ticket.session = session; ticket.settledAt = Date.now();
      if (ticket.dropped) closeShortNative(session.sessionId); // released while still preparing
      else if (warm) warmShortNative(session.sessionId, abort.signal).catch(() => {});
      return session;
    }, error => { ticket.settledAt = Date.now(); throw error; });
    ticket.promise.catch(() => {}); // a failure is read by whoever takes the ticket
    return ticket;
  }
  private static drop(ticket: NativeTicket) {
    if (ticket.dropped) return;
    ticket.dropped = true;
    window.clearTimeout(ticket.returned);
    ticket.abort.abort();
    if (ticket.session) closeShortNative(ticket.session.sessionId);
  }
  private static fresh(ticket: NativeTicket) { return ticket.settledAt === undefined || Date.now() - ticket.settledAt < KEEP_MS; }
  /** Keep only `keys`; everything else is released. */
  private keep(keys: string[]) {
    for (const [key, ticket] of this.slots) if (!keys.includes(key) || !NativePool.fresh(ticket)) { NativePool.drop(ticket); this.slots.delete(key); }
  }

  /** Prepare the works after the playing one, in order. Repeated calls with the same keys do nothing. */
  prefetch(keys: string[]) {
    if (this.disposed) return;
    const next = keys.slice(0, AHEAD);
    this.wanted = next;
    this.keep(next);
    const [first, second] = next;
    if (!first) return;
    if (!this.slots.has(first)) this.slots.set(first, this.request(first, true));
    if (!second || this.slots.has(second)) return;
    const gate = this.slots.get(first)!;
    const later = () => {
      if (this.disposed || gate.dropped || !this.wanted.includes(second) || this.slots.has(second)) return;
      this.slots.set(second, this.request(second, true));
    };
    gate.promise.then(later, later);
  }
  /** The player's ticket: the prepared one when it matches and is fresh, otherwise a new request. Works
   *  that are no longer ahead (a jump back or forward) are released first to free their leases. */
  take(key: string, ahead: string[]): NativeTicket {
    const slot = this.slots.get(key);
    this.slots.delete(key);
    this.keep(ahead.slice(0, AHEAD));
    if (slot) window.clearTimeout(slot.returned);
    if (slot && NativePool.fresh(slot) && !slot.dropped) return slot;
    if (slot) NativePool.drop(slot);
    return this.request(key, false);
  }
  /** Hand back a ticket the player never used. Unless taken again right away, it is released. */
  giveBack(ticket: NativeTicket) {
    if (this.disposed || ticket.dropped || this.slots.has(ticket.key) || this.slots.size >= AHEAD) return NativePool.drop(ticket);
    this.slots.set(ticket.key, ticket);
    ticket.returned = window.setTimeout(() => { if (this.slots.get(ticket.key) === ticket && !this.wanted.includes(ticket.key)) { this.slots.delete(ticket.key); NativePool.drop(ticket); } }, 0);
  }
  static close(ticket: NativeTicket) { NativePool.drop(ticket); }
  release() { for (const ticket of this.slots.values()) NativePool.drop(ticket); this.slots.clear(); this.wanted = []; }
  dispose() { this.disposed = true; this.release(); }
  /** Undo `dispose` when the owner mounts again (React's development double mount). */
  open() { this.disposed = false; }
}
