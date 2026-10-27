import { createHash } from 'node:crypto';
import { compatibilityHttp, publicUrl, type SourceWebViewRequest } from './extensions/index.js';
import type { CompatibilityHttpInput } from './extensions/index.js';

type Response = Awaited<ReturnType<typeof compatibilityHttp>>;
type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires: number };
export type BrowserState = { cookies: Cookie[]; userAgent: string; engine: string };
type Row = { scope: string; origin: string; state?: BrowserState; touched: number; generation: number; cooldown: number; refresh?: Promise<void>; abort?: AbortController; waiters: number };
const TTL = 60 * 60_000;
const MAX_ROWS = 64;
const MAX_COOKIES = 96;
const redirects = new Set([301, 302, 303, 307, 308]);
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const clean = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const matchesDomain = (host: string, domain: string) => domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
function validCookie(c: Cookie, host: string) {
  return c && cookieName.test(c.name) && clean(c.name, 256) && clean(c.value, 8192) && !/[;\s]/.test(c.value) &&
    clean(c.domain, 256) && matchesDomain(host, c.domain.toLowerCase()) && clean(c.path, 2048) && c.path.startsWith('/') &&
    typeof c.secure === 'boolean' && typeof c.httpOnly === 'boolean' && Number.isFinite(c.expires) &&
    (!c.name.startsWith('__Secure-') || c.secure) && (!c.name.startsWith('__Host-') || c.secure && c.domain === host && c.path === '/');
}
function expired(c: Cookie) { return c.expires !== -1 && c.expires <= Date.now() / 1000; }
function header(state: BrowserState, url: URL) {
  return state.cookies.filter(c => !expired(c) && matchesDomain(url.hostname, c.domain) && (!c.secure || url.protocol === 'https:') &&
    (url.pathname === c.path || url.pathname.startsWith(c.path) && (c.path.endsWith('/') || url.pathname[c.path.length] === '/')))
    .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
}
function setCookies(state: BrowserState, url: URL, values: string[] = []) {
  for (const raw of values.slice(0, MAX_COOKIES)) {
    if (!clean(raw, 16384)) continue;
    const [pair, ...parts] = raw.split(';'); const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: url.hostname,
      path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1).replace(/\/$/, '') || '/', secure: false, httpOnly: false, expires: -1 };
    let maxAge: number | undefined;
    for (const part of parts) {
      const pos = part.indexOf('='), name = (pos < 0 ? part : part.slice(0, pos)).trim().toLowerCase();
      const value = pos < 0 ? '' : part.slice(pos + 1).trim();
      if (name === 'domain') c.domain = '.' + value.toLowerCase().replace(/^\./, '');
      if (name === 'path' && value.startsWith('/')) c.path = value;
      if (name === 'secure') c.secure = true;
      if (name === 'httponly') c.httpOnly = true;
      if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
      if (name === 'expires' && Number.isFinite(Date.parse(value))) c.expires = Date.parse(value) / 1000;
    }
    if (maxAge !== undefined) c.expires = maxAge <= 0 ? 0 : Date.now() / 1000 + Math.min(maxAge, 365 * 86400);
    if (!validCookie(c, url.hostname)) continue;
    const identity = (x: Cookie) => x.name === c.name && x.domain === c.domain && x.path === c.path;
    state.cookies = state.cookies.filter(x => !identity(x) && !expired(x));
    if (!expired(c) && state.cookies.length < MAX_COOKIES && JSON.stringify(state.cookies).length + JSON.stringify(c).length < 128 * 1024) state.cookies.push(c);
  }
}
function challenge(response: Response) {
  return response.headers['cf-mitigated'] === 'challenge' ||
    [403, 503].includes(response.statusCode) && /(?:just a moment|checking your browser)/i.test(response.bytes.subarray(0, 65536).toString()) &&
    /(?:challenge-platform|cf-chl-|challenge-form)/i.test(response.bytes.subarray(0, 65536).toString());
}

/** Host-only memory. Nothing here is serialized into guest state, logs, or the database. */
export class SourceSessions {
  private rows = new Map<string, Row>();
  private reaper = setInterval(() => this.prune(), 60_000).unref();
  constructor(private authenticate: (scope: string, proxy: string | undefined, request: SourceWebViewRequest, signal: AbortSignal) => Promise<unknown>,
    private transport = compatibilityHttp) {}
  private key(scope: string, proxy: string | undefined, url: string) {
    return createHash('sha256').update(JSON.stringify([scope, proxy || '', new URL(publicUrl(url)).origin])).digest('hex');
  }
  private prune() {
    for (const [key, row] of this.rows) if (!row.refresh && Date.now() - row.touched > TTL) this.rows.delete(key);
  }
  private row(scope: string, proxy: string | undefined, url: string) {
    this.prune(); const key = this.key(scope, proxy, url); let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= MAX_ROWS) {
        const oldest = [...this.rows].filter(([, r]) => !r.refresh).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw new Error('source_rate_limited');
        this.rows.delete(oldest[0]);
      }
      row = { scope, origin: new URL(url).origin, touched: Date.now(), generation: 0, cooldown: 0, waiters: 0 }; this.rows.set(key, row);
    }
    row.touched = Date.now(); return row;
  }
  capture(scope: string, proxy: string | undefined, url: string, raw: unknown) {
    const value = raw as BrowserState;
    if (!value || !clean(value.userAgent, 512) || !value.userAgent || !clean(value.engine, 128) || !value.engine ||
        !Array.isArray(value.cookies) || value.cookies.length > MAX_COOKIES || JSON.stringify(value).length > 128 * 1024)
      throw new Error('source_browser_failed');
    const host = new URL(url).hostname;
    const row = this.row(scope, proxy, url);
    row.state = { userAgent: value.userAgent, engine: value.engine, cookies: value.cookies.filter(c => validCookie(c, host) && !expired(c)).map(c => ({ ...c })) };
    row.generation++; row.cooldown = 0;
  }
  clear(scope?: string) {
    for (const [key, row] of this.rows) if (!scope || row.scope === scope) { row.abort?.abort(new Error('source_cancelled')); this.rows.delete(key); }
  }
  has(scope: string, proxy: string | undefined, url: string) {
    this.prune();
    return Boolean(this.rows.get(this.key(scope, proxy, url))?.state);
  }
  snapshot(scope: string, proxy: string | undefined, url: string) {
    this.prune();
    const state = this.rows.get(this.key(scope, proxy, url))?.state;
    return state ? { ...state, cookies: state.cookies.filter(c => !expired(c)).map(c => ({ ...c })) } : undefined;
  }
  close() { clearInterval(this.reaper); this.clear(); }
  private async refresh(row: Row, scope: string, proxy: string | undefined, url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!row.refresh) {
      if (Date.now() < row.cooldown) throw new Error('source_rate_limited');
      const abort = row.abort = new AbortController();
      const generation = row.generation;
      row.refresh = (async () => {
        try {
          await this.authenticate(scope, proxy, { url, script: 'true', waitUntil: 'load', timeoutMs: 85_000 }, AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]));
          if (!row.state || row.generation === generation) throw new Error('source_browser_failed');
        } catch (error) { row.cooldown = Date.now() + 30_000; throw error; }
        finally { row.refresh = undefined; row.abort = undefined; }
      })();
    }
    // Keep shared authentication alive while at least one caller still needs it.
    row.waiters++;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        row.refresh!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
    } finally {
      if (--row.waiters === 0) row.abort?.abort(new Error('source_cancelled'));
    }
  }
  async request(scope: string, proxy: string | undefined, input: CompatibilityHttpInput, signal: AbortSignal, maximum = 4 * 1024 * 1024): Promise<Response> {
    const opt = input.options?.browserSession;
    if (!opt) return this.transport(input, signal, [], maximum, proxy);
    const deadline = AbortSignal.timeout(115_000);
    signal = AbortSignal.any([signal, deadline]);
    const target = new URL(publicUrl(input.url)), bootstrap = new URL(publicUrl(opt.url));
    if (bootstrap.origin !== target.origin || !['GET', 'HEAD', 'POST'].includes(input.method || 'GET') ||
        (input.method === 'POST' && opt.readOnly !== true)) throw new Error('source_access_denied');
    const row = this.row(scope, proxy, input.url);
    const current = () => { signal.throwIfAborted(); if (this.rows.get(this.key(scope, proxy, input.url)) !== row) throw new Error('source_cancelled'); };
    if (!row.state || row.state.cookies.some(c => c.name === 'cf_clearance' && expired(c))) await this.refresh(row, scope, proxy, bootstrap.href, signal);
    current();
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = row.generation;
      const result = await this.follow(row, proxy, input, signal, maximum);
      current();
      if (!challenge(result)) return result;
      if (attempt) { row.cooldown = Date.now() + 30_000; throw new Error('source_access_denied'); }
      if (generation === row.generation) await this.refresh(row, scope, proxy, bootstrap.href, signal);
      current();
    }
    throw new Error('source_access_denied');
  }
  private async follow(row: Row, proxy: string | undefined, input: CompatibilityHttpInput, signal: AbortSignal, maximum: number): Promise<Response> {
    let url = new URL(input.url), method = input.method || 'GET', body = input.body;
    const headers = Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const max = Math.min(4, input.options?.maxRedirects ?? 4);
    let remaining = maximum;
    for (let n = 0; n <= max; n++) {
      const state = row.state!; const same = url.origin === row.origin;
      const outbound = { ...headers };
      if (same) { outbound['user-agent'] = state.userAgent; outbound.cookie = header(state, url); }
      if (remaining <= 0) throw new Error('source_body_limit');
      const response = await this.transport({ ...input, url: url.href, method, body, headers: outbound,
        options: { ...input.options, followRedirects: false, maxRedirects: 0 } }, signal, [], remaining, proxy, false);
      remaining -= response.bytes.length;
      if (same) setCookies(state, url, response.headers['set-cookie']);
      const safeHeaders = { ...response.headers }; delete safeHeaders['set-cookie']; delete safeHeaders['set-cookie2'];
      if (!redirects.has(response.statusCode) || input.options?.followRedirects === false) return { ...response, headers: safeHeaders };
      if (n === max || !response.headers.location) throw new Error('source_redirect_limit');
      const next = new URL(publicUrl(new URL(response.headers.location, url).href));
      if (next.origin !== url.origin) {
        if (!['GET', 'HEAD'].includes(method)) throw new Error('source_redirect_denied');
        delete headers.cookie; delete headers.authorization; delete headers.origin; delete headers.referer;
      }
      if (response.statusCode === 303 || [301, 302].includes(response.statusCode) && method === 'POST') { method = 'GET'; body = undefined; delete headers['content-type']; }
      url = next;
    }
    throw new Error('source_redirect_limit');
  }
}
