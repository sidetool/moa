import { MAX_SOURCE_TEXT_BYTES } from './content-limits.mjs';

// Text RPCs may contain six JSON bytes per source byte (escaped control characters).
export const MAX_TEXT_RPC_BYTES = MAX_SOURCE_TEXT_BYTES * 6 + 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;
// Compatibility state includes up to 2MiB of preferences plus a result. Other guests retain 1MiB.
export const invocationJsonLimit = (profile) => (profile === 'mangayomi-v1' ? 4 * MAX_JSON_BYTES : MAX_JSON_BYTES);
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const rpcInputLimit = (method) => (method === 'asset.fromText' ? MAX_TEXT_RPC_BYTES : MAX_JSON_BYTES);
export const rpcResultLimit = (method) =>
  ['http.request', 'webview.evaluate', 'source.request'].includes(method) ? MAX_TEXT_RPC_BYTES : MAX_JSON_BYTES;
export const PUBLIC_FAILURE_CODES = new Set([
  'compatibility_feature_unsupported',
  'source_storage_limit',
  'source_storage_conflict',
  'execution_failed',
  'execution_timeout',
  'payload_limit',
  'invalid_extension',
  'permission_denied',
  'source_auth_required',
  'source_auth_forbidden',
  'source_rate_limited',
  'source_http_failed',
  'source_access_denied',
  'source_connection_failed',
  'source_tls_failed',
  'source_request_timeout',
  'source_body_limit',
  'source_browser_unavailable',
  'source_browser_failed',
  'source_url_denied',
  'source_address_denied',
  'source_redirect_denied',
  'source_redirect_limit',
  'source_encoding_unsupported',
  'source_empty_body',
  'source_asset_limit',
]);

export function jsonText(value, limit = MAX_JSON_BYTES) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) throw new Error('payload_limit');
  return text;
}

/** Bounded before decoding/parsing; chunks never cause repeated concatenation of an unfinished frame. */
export function readFrames(stream, onFrame, onError) {
  let chunks = [];
  let bytes = 0;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    onError();
  };
  stream.on('data', (chunk) => {
    if (failed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      bytes += part.length;
      if (bytes > MAX_FRAME_BYTES) return fail();
      chunks.push(part);
      if (end < 0) break;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        chunks = [];
        bytes = 0;
        onFrame(JSON.parse(text));
      } catch {
        return fail();
      }
      start = end + 1;
    }
  });
  stream.on('end', () => {
    if (bytes) fail();
  });
  stream.on('error', fail);
}

export function sendFrame(stream, value) {
  stream.write(`${jsonText(value, MAX_FRAME_BYTES)}\n`);
}
