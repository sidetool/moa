import { pinnedProxyAgent } from './proxy.js';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { isPublicSourceAddress } from './vendor/source-http.mjs';

/** Stream large media without buffering it. Every redirect resolves and pins a public IP. */
export async function publicStream(address: string, input: Record<string, string>, signal: AbortSignal, proxy?: string): Promise<{ response: IncomingMessage; url: string }> {
  let url = new URL(address);
  let headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' };
  for (const [k, v] of Object.entries(input).slice(0, 32)) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(k) || typeof v !== 'string' || v.length > 8192 || /[\r\n]/.test(v) || /^(host|connection|content-length|transfer-encoding|proxy-.*|accept-encoding)$/i.test(k)) continue;
    const name = k.toLowerCase();
    headers[name] = name === 'referer' ? new URL(v).href : name === 'origin' && v !== 'null' ? new URL(v).origin : v;
  }
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 16_384) throw new Error('source_url_denied');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(a => !isPublicSourceAddress(a.address))) throw new Error('source_address_denied');
    let response: IncomingMessage | undefined;
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const req = request(url, { signal, headers, agent: pinnedProxyAgent(proxy, url, addr.address, signal) ?? false, lookup: (_host, options, cb) => queueMicrotask(() => options.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)) }, resolve);
          req.setTimeout(30_000, () => req.destroy(new Error('source_stream_timeout')));
          req.on('error', reject); req.end();
        }); break;
      } catch (err) { if (signal.aborted || i === addresses.length - 1) throw err; }
    }
    if (!response) throw new Error('source_connection_failed');
    if ([301,302,303,307,308].includes(response.statusCode || 0)) {
      const location = response.headers.location; response.destroy();
      if (!location || redirects === 5) throw new Error('source_redirect_limit');
      const next = new URL(location, url);
      if (next.origin !== url.origin) { headers = { ...headers }; delete headers.cookie; delete headers.authorization; }
      url = next; continue;
    }
    return { response, url: url.href };
  }
  throw new Error('source_redirect_limit');
}
