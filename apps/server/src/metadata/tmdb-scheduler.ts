export type TmdbPriority = 'foreground' | 'background';
export interface TmdbWork { priority: TmdbPriority; revision: number }
interface Request {
  key: string; contexts: Set<TmdbWork>; run: (signal: AbortSignal) => Promise<Response>;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  promise: Promise<any>; controller: AbortController; deadline: number; attempts: number; timer: ReturnType<typeof setTimeout>;
}

/** One credential generation's shared queue. Keys and response errors never leave this module. */
export class TmdbScheduler {
  private requests = new Map<string, Request>();
  private queue: Request[] = [];
  private active = 0;
  private burst = 0;
  private cooldown = 0;
  private wake?: ReturnType<typeof setTimeout>;
  private closed = false;
  request(key: string, context: TmdbWork, run: Request['run']): Promise<any> {
    if (this.closed) return Promise.reject(new Error('tmdb-closed'));
    const existing = this.requests.get(key);
    if (existing) { existing.contexts.add(context); this.pump(); return existing.promise; }
    let resolve!: Request['resolve'], reject!: Request['reject'];
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const request: Request = {key, contexts: new Set([context]), run, resolve, reject, promise, controller: new AbortController(), deadline: Date.now() + 8000, attempts: 0, timer: setTimeout(() => {}, 0)};
    clearTimeout(request.timer);
    request.timer = setTimeout(() => { request.controller.abort(); this.finish(request, new Error('tmdb-timeout')); }, 8000);
    this.requests.set(key, request); this.queue.push(request); this.pump(); return promise;
  }
  private finish(request: Request, error?: Error, value?: unknown) {
    if (this.requests.get(request.key) !== request) return;
    this.requests.delete(request.key); this.queue = this.queue.filter(r => r !== request); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(value);
  }
  private pump() {
    clearTimeout(this.wake); this.wake = undefined;
    if (this.closed || !this.queue.length) return;
    const delay = this.cooldown - Date.now();
    if (delay > 0) {
      for (const r of [...this.queue]) if (r.deadline <= this.cooldown) this.finish(r, new Error('tmdb-429'));
      if (this.queue.length) this.wake = setTimeout(() => this.pump(), Math.min(delay, 2_147_483_647));
      return;
    }
    while (this.active < 6 && this.queue.length) {
      const foreground = (r: Request) => [...r.contexts].some(c => c.priority === 'foreground');
      let index = this.queue.findIndex(r => foreground(r) === (this.burst < 4));
      if (index < 0) index = 0;
      const r = this.queue.splice(index, 1)[0];
      this.burst = foreground(r) ? this.burst + 1 : 0;
      this.active++;
      void this.execute(r).finally(() => { this.active--; this.pump(); });
    }
  }
  private async execute(r: Request) {
    try {
      const response = await r.run(r.controller.signal);
      if (this.requests.get(r.key) !== r) { await response.body?.cancel(); return; }
      if (response.status === 429) {
        const raw = response.headers.get('retry-after')?.trim();
        const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : NaN;
        const date = raw ? Date.parse(raw) - Date.now() : NaN;
        const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date) : 1000 * (r.attempts + 1);
        this.cooldown = Math.max(this.cooldown, Date.now() + delay);
        await response.body?.cancel();
        if (++r.attempts <= 2 && r.deadline > this.cooldown) this.queue.push(r);
        else this.finish(r, new Error('tmdb-429'));
      } else if (response.status === 404) { await response.body?.cancel(); this.finish(r, undefined, null); }
      else if (!response.ok) { await response.body?.cancel(); this.finish(r, new Error(`tmdb-${response.status}`)); }
      else this.finish(r, undefined, await response.json());
    } catch { this.finish(r, new Error(r.controller.signal.aborted ? 'tmdb-aborted' : 'tmdb-request-failed')); }
  }
  close() {
    this.closed = true; clearTimeout(this.wake);
    for (const request of [...this.requests.values()]) { request.controller.abort(); this.finish(request, new Error('tmdb-closed')); }
  }
}
