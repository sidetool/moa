import { compatibilityHttp } from '../sources/extensions/index.js';
import { ApiFailure } from '../util.js';
import { localEndpoint, normalizeEndpoint } from './endpoint.js';

// Bound provider responses and keep credentials out of surfaced errors.
export async function requestTranslation(
  baseUrl: string,
  path: string,
  authorization: Record<string, string>,
  signal: AbortSignal,
  body?: unknown,
  transport?: typeof fetch,
) {
  let response: Response;
  try {
    const url = normalizeEndpoint(baseUrl) + path;
    const headers: Record<string, string> = {
      ...authorization,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const init = { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) };
    if (transport) response = await transport(url, { ...init, redirect: 'error' });
    else {
      const target = new URL(url);
      const result = await compatibilityHttp({ url, ...init, options: { timeout: 90, followRedirects: false } }, init.signal, localEndpoint(target) ? [target.origin] : [], 2 * 1024 * 1024);
      response = new Response([204, 205, 304].includes(result.statusCode) ? null : new Uint8Array(result.bytes), { status: result.statusCode });
    }
  } catch {
    if (signal.aborted) throw new ApiFailure(409, 'translation-cancelled');
    throw new ApiFailure(502, 'translation-unavailable');
  }
  if (!response.ok) {
    let code = response.status === 401 ? 'translation-key-invalid'
      : response.status === 402 ? 'translation-credit-exhausted'
      : response.status === 403 ? 'translation-permission-denied'
      : response.status === 404 ? 'translation-model-unavailable'
      : response.status === 429 ? 'translation-quota'
      : response.status === 400 ? 'translation-request-rejected' : 'translation-unavailable';
    if ([400, 401, 403, 404, 429].includes(response.status) && response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 65536) { await reader.cancel(); break; }
          chunks.push(value);
        }
        const error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error;
        const reasons = Array.isArray(error?.details) ? error.details.map((detail: any) => detail?.reason) : [];
        if (reasons.some((reason: string) => ['API_KEY_INVALID', 'API_KEY_EXPIRED'].includes(reason))) code = 'translation-key-invalid';
        else if (reasons.includes('API_KEY_SERVICE_BLOCKED')) code = 'translation-permission-denied';
        else if (error?.code === 'insufficient_quota') code = 'translation-credit-exhausted';
        else if (error?.code === 'model_not_found') code = 'translation-model-unavailable';
      } catch {}
    } else await response.body?.cancel();
    if (signal.aborted) throw new ApiFailure(409, 'translation-cancelled');
    throw new ApiFailure(502, code);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiFailure(502, 'translation-invalid-response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('large');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    if (signal.aborted) throw new ApiFailure(409, 'translation-cancelled');
    throw new ApiFailure(502, 'translation-invalid-response');
  }
}
