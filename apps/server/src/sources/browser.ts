import { SourceSessions } from './session.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { publicUrl, type MangayomiInvocation, type SourceWebViewRequest } from './extensions/index.js';

const REQUEST_LIMIT = 512 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
// Only public diagnostics supported by the guest bridge can cross this boundary.
const FAILURE_CODES = new Set([
  'source_body_limit', 'source_request_timeout', 'source_browser_unavailable', 'source_browser_failed',
  'source_connection_failed', 'source_http_failed', 'source_tls_failed', 'source_access_denied',
  'source_url_denied', 'source_address_denied', 'source_redirect_denied', 'source_redirect_limit',
  'source_auth_required', 'source_auth_forbidden', 'source_rate_limited',
]);
const FAILURE_ALIASES: Record<string, string> = {
  source_browser_busy: 'source_rate_limited',
  source_browser_denied: 'source_access_denied',
};

/** Optional, site-neutral RPC transport. Only the host supplies scope and outbound proxy. */
export class SourceBrowser {
  private endpoint?: URL;
  private secret?: string;
  private generations = new Map<string, string>();
  readonly sessions = new SourceSessions((scope, proxy, request, signal) => this.evaluate(scope, proxy, request, signal));
  clear(scope: string) { this.generations.delete(scope); this.sessions.clear(scope); }
  close() { this.generations.clear(); this.sessions.close(); }

  constructor(config: { url?: string; secretFile?: string } = {
    url: process.env.MOA_SOURCE_BROWSER_URL,
    secretFile: process.env.MOA_SOURCE_BROWSER_SECRET_FILE,
  }) {
    if (config.url === undefined && config.secretFile === undefined) return;
    try {
      const url = new URL(config.url || '');
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
          !['/', '/evaluate'].includes(url.pathname) || !config.secretFile) throw new Error();
      const secret = readFileSync(config.secretFile, 'utf8').trim();
      if (secret.length < 32 || /[^\x21-\x7e]/.test(secret)) throw new Error();
      this.endpoint = new URL('/evaluate', url);
      this.secret = secret;
    } catch {
      // Never include endpoint credentials, secret values or secret-file paths in errors.
      throw new Error('invalid-source-browser-config');
    }
  }

  get configured() { return this.endpoint !== undefined; }

  invocation(scope: string, proxy: string | undefined): Pick<MangayomiInvocation, 'webview' | 'http' | 'timeoutMs'> {
    return this.configured ? {
      timeoutMs: 120_000,
      http: (request, signal) => this.sessions.request(scope, proxy, request, signal),
      webview: (request, signal) => this.evaluate(scope, proxy, request, signal),
    } : {};
  }

  async evaluate(scope: string, proxy: string | undefined, input: SourceWebViewRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.endpoint || !this.secret) throw new Error('source_browser_unavailable');
    if (signal.aborted) throw new Error('cancelled');
    let url: string;
    try { url = publicUrl(input?.url); }
    catch { throw new Error('source_url_denied'); }
    // publicUrl is the first URL check; DNS, redirects and all page resources are pinned by the service.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope) || typeof input.script !== 'string' ||
        !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 ||
        (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' ||
          Array.isArray(input.headers) || Object.entries(input.headers).some(([name, value]) =>
            !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)))))
      throw new Error('source_browser_failed');
    let generation = this.generations.get(scope);
    if (!generation) this.generations.set(scope, generation = randomUUID());
    const timeoutMs = Math.max(1, Math.min(90_000, Math.round(input.timeoutMs)));
    // Pick explicit fields: guest-supplied scope, proxy or RPC fields must never override host state.
    const sessionState = this.sessions.snapshot(scope, proxy, url);
    const body = Buffer.from(JSON.stringify({ scope: `${scope}:${generation}`, proxy: proxy || '', url, headers: input.headers || {}, script: input.script, timeoutMs, captureSession: true, sessionState }));
    if (body.length > REQUEST_LIMIT) throw new Error('source_body_limit');

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs + 5000);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let response: import('node:http').IncomingMessage | undefined;
    try {
      response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = (this.endpoint!.protocol === 'https:' ? httpsRequest : httpRequest)(this.endpoint!, {
          method: 'POST', signal: combined,
          headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        }, resolve);
        request.on('error', reject);
        request.end(body);
      });
      const parts: Buffer[] = [];
      let size = 0;
      const declaredSize = Number(response.headers['content-length']);
      if (declaredSize > RESPONSE_LIMIT) throw new Error('source_body_limit');
      for await (const chunk of response) {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) throw new Error('source_body_limit');
        parts.push(Buffer.from(chunk));
      }
      let data: unknown;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size))); }
      catch { throw new Error('source_browser_failed'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('source_browser_failed');
      const envelope = data as Record<string, unknown>;
      if (Object.hasOwn(envelope, 'error')) {
        const code = typeof envelope.error === 'string' ? FAILURE_ALIASES[envelope.error] || envelope.error : '';
        throw new Error(FAILURE_CODES.has(code) ? code : 'source_browser_failed');
      }
      // Redirects are deliberately not followed: the Bearer secret belongs only to this endpoint.
      if (response.statusCode !== 200 || !Object.hasOwn(envelope, 'result')) throw new Error('source_browser_failed');
      if (this.generations.get(scope) !== generation) throw new Error('source_browser_failed');
      if (envelope.session !== undefined) this.sessions.capture(scope, proxy, url, envelope.session);
      return envelope.result;
    } catch (error) {
      if (signal.aborted) throw new Error('cancelled');
      if (deadline.signal.aborted) throw new Error('source_request_timeout');
      if (error instanceof Error && FAILURE_CODES.has(error.message)) throw new Error(error.message);
      throw new Error('source_browser_unavailable');
    } finally {
      clearTimeout(timer);
      response?.destroy();
    }
  }
}
