import { lookup as lookupDns } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const transientConnectionCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const tlsFailureCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
])
  denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicSourceAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export async function approveSourceUrl(
  value,
  origins,
  lookup = (host) => lookupDns(host, { all: true, verbatim: true }),
) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('source_url_denied');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source_url_denied');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.includes(url.origin))
    throw new Error('source_url_denied');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host);
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some(({ address, family }) => !isPublicSourceAddress(address) || isIP(address) !== family)
  )
    throw new Error('source_address_denied');
  return { url, address: addresses[0], addresses };
}

function pinnedRequest({ url, address }, input, signal) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: input.method,
        headers: input.headers,
        signal,
        agent: false,
        // Match async DNS timing: TLS must attach its error handlers before connect can fail.
        lookup: (_hostname, options, callback) =>
          queueMicrotask(() =>
            options.all ? callback(null, [address]) : callback(null, address.address, address.family),
          ),
      },
      (response) => resolve({ status: response.statusCode, headers: response.headers, body: response }),
    );
    request.once('error', reject);
    request.end(input.body);
  });
}

function requestInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['url', 'method', 'headers', 'body', 'response', 'authenticated'].includes(key),
    ) ||
    (input.authenticated !== undefined && typeof input.authenticated !== 'boolean')
  )
    throw new Error('invalid_source_request');
  const method = input.method ?? 'GET';
  if (!['GET', 'POST'].includes(method) || !['text', 'asset'].includes(input.response))
    throw new Error('invalid_source_request');
  if (
    input.body !== undefined &&
    (method !== 'POST' || typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256 * 1024)
  )
    throw new Error('source_request_limit');
  const headers = { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'MOA-Source/1' };
  if (input.headers !== undefined) {
    if (
      !input.headers ||
      typeof input.headers !== 'object' ||
      Array.isArray(input.headers) ||
      Object.keys(input.headers).length > 3
    )
      throw new Error('invalid_source_headers');
    for (const [key, value] of Object.entries(input.headers)) {
      if (
        !['accept', 'content-type', 'accept-language'].includes(key) ||
        typeof value !== 'string' ||
        value.length > 512 ||
        /[\r\n]/.test(value)
      )
        throw new Error('source_header_denied');
      headers[key] = value;
    }
  }
  return { ...input, method, headers };
}

/** Production transport pins the approved address. Test injection never comes from package metadata. */
export function createSourceHttp(origins, { lookup, transport = pinnedRequest, authenticate } = {}) {
  const grantedOrigins = [...origins];
  return async (untrusted, signal) => {
    const input = requestInput(untrusted);
    let next = input.url;
    let request = input;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    for (let redirects = 0; redirects <= 4; redirects++) {
      deadline.throwIfAborted();
      let approved;
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          approved = await approveSourceUrl(next, grantedOrigins, lookup);
          deadline.throwIfAborted();
          if (input.authenticated && !authenticate) throw new Error('source_auth_required');
          const authentication = input.authenticated ? await authenticate(approved.url, deadline) : {};
          deadline.throwIfAborted();
          for (let index = 0; index < approved.addresses.length; index++) {
            try {
              response = await transport(
                { ...approved, address: approved.addresses[index] },
                { ...request, headers: { ...request.headers, ...authentication } },
                deadline,
              );
              break;
            } catch (error) {
              deadline.throwIfAborted();
              const transient =
                transientConnectionCodes.has(error?.code) || error?.message === 'source_connection_failed';
              if (request.method !== 'GET' || !transient || index === approved.addresses.length - 1) throw error;
            }
          }
          break;
        } catch (error) {
          // eslint-disable-next-line preserve-caught-error -- Network exceptions can contain URLs; only safe public codes leave the broker.
          if (signal.aborted) throw new Error('cancelled');
          // eslint-disable-next-line preserve-caught-error -- Do not retain private transport details in public failures.
          if (deadline.aborted) throw new Error('source_request_timeout');
          const transient = transientConnectionCodes.has(error?.code) || error?.message === 'source_connection_failed';
          if (request.method === 'GET' && attempt === 0 && transient) {
            // Retry only a read before response headers, sharing the original deadline.
            // Recheck DNS/origin approval; never replay a POST or a rejected HTTP response.
            await delay(250, undefined, { signal: deadline }).catch(() => {
              throw new Error(signal.aborted ? 'cancelled' : 'source_request_timeout');
            });
            continue;
          }
          if (transient || error?.code === 'ENOTFOUND')
            // eslint-disable-next-line preserve-caught-error -- Do not retain private transport details in public failures.
            throw new Error('source_connection_failed');
          if (tlsFailureCodes.has(error?.code))
            // eslint-disable-next-line preserve-caught-error -- Certificate details and hostnames stay inside the broker.
            throw new Error('source_tls_failed');
          throw error;
        }
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body.destroy();
        if (redirects === 4 || typeof response.headers.location !== 'string') throw new Error('source_redirect_limit');
        const target = new URL(response.headers.location, approved.url);
        // Do not replay a POST payload onto a different origin, even if both origins are granted.
        if (target.origin !== approved.url.origin && (request.method === 'POST' || input.authenticated))
          throw new Error('source_redirect_denied');
        next = target.href;
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && request.method === 'POST')
        )
          request = { ...request, method: 'GET', body: undefined };
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.body.destroy();
        throw new Error(
          response.status === 401 && input.authenticated
            ? 'source_auth_required'
            : response.status === 403 && input.authenticated
              ? 'source_auth_forbidden'
              : response.status === 403 || response.status === 401
                ? 'source_access_denied'
                : response.status === 429
                  ? 'source_rate_limited'
                  : 'source_http_failed',
        );
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.body.destroy();
        throw new Error('source_encoding_unsupported');
      }
      return { ...response, signal: deadline };
    }
    throw new Error('source_redirect_limit');
  };
}
