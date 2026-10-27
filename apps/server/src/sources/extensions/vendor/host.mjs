import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  jsonText,
  invocationJsonLimit,
  MAX_SOURCE_BYTES,
  PUBLIC_FAILURE_CODES,
  readFrames,
  sendFrame,
  rpcInputLimit,
  rpcResultLimit,
} from './wire.mjs';
import { ExtensionAdmission } from './admission.mjs';

export class ExtensionRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ExtensionRuntimeError';
    this.code = code;
  }
}

const helperPath = fileURLToPath(new URL('./helper.mjs', import.meta.url));
const admission = new ExtensionAdmission();
// Reserve a process for a user waiting on a title/player, even if both list slots are occupied.
const interactiveAdmission = new ExtensionAdmission({ concurrency: 1, queueLimit: 8 });

export async function runExtension(input) {
  // Bound retained source bytes before admission; queued invocations must not bypass the source limit.
  if (typeof input?.source !== 'string' || Buffer.byteLength(input.source) > MAX_SOURCE_BYTES)
    throw new ExtensionRuntimeError('invalid_invocation');
  try {
    jsonText(input.input ?? null, invocationJsonLimit(input.profile));
    const lane = input.profile === 'mangayomi-v1' && ['detail', 'chapters', 'videos'].includes(input.input?.action) ? interactiveAdmission : admission;
    return await lane.run(() => executeExtension(input), input.signal);
  } catch (error) {
    if (error instanceof ExtensionRuntimeError) throw error;
    throw new ExtensionRuntimeError(
      ['execution_busy', 'cancelled'].includes(error?.message) ? error.message : 'payload_limit',
    );
  }
}

/** One invocation/realm/process. The guest sees only explicitly supplied broker methods and JSON. */
async function executeExtension({
  source,
  method,
  input = null,
  broker = {},
  signal,
  timeoutMs = 5000,
  memoryBytes = 32 * 1024 * 1024,
  profile,
}) {
  if (signal?.aborted) throw new ExtensionRuntimeError('cancelled');
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > MAX_SOURCE_BYTES ||
    typeof method !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9.]{0,79}$/.test(method) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs >
      (method === 'source.listReleases' || (profile === 'mangayomi-v1' && input?.action === 'chapters')
        ? 600000
        : profile === 'mangayomi-v1' || profile === 'source-webview-v1'
          ? 150000
          : 30000) ||
    (profile !== undefined && !['mangayomi-v1', 'source-webview-v1'].includes(profile)) ||
    !Number.isInteger(memoryBytes) ||
    memoryBytes < 4 * 1024 * 1024 ||
    memoryBytes > 64 * 1024 * 1024
  ) {
    throw new ExtensionRuntimeError('invalid_invocation');
  }
  let inputText;
  try {
    inputText = jsonText(input, invocationJsonLimit(profile));
  } catch {
    throw new ExtensionRuntimeError('payload_limit');
  }
  const abort = new AbortController();
  // Do not pass application credentials, NODE_OPTIONS or provider environment to the helper.
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TMP', 'TEMP'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stderrBytes = 0;
    let calls = 0;
    const pending = new Set();
    const seen = new Set();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      abort.abort();
      // Admission retains the process slot until the child really closes, including cancellation cleanup.
      child.once('close', () => {
        if (error) reject(new ExtensionRuntimeError(error));
        else resolve(value);
      });
      child.stdin.destroy();
      child.kill();
    };
    const cancel = () => finish('cancelled');
    const timer = setTimeout(() => finish('execution_timeout'), timeoutMs + 1500);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    child.on('error', () => finish('runtime_unavailable'));
    child.on('exit', () => {
      if (!settled) finish('execution_failed');
    });
    child.stdin.on('error', () => finish('execution_failed'));
    child.stderr.on('data', (data) => {
      stderrBytes += data.length;
      if (stderrBytes > 8192) finish('execution_failed');
    });
    readFrames(
      child.stdout,
      (frame) => {
        if (settled) return;
        if (frame?.type === 'result') {
          try {
            jsonText(frame.value, invocationJsonLimit(profile));
            finish(undefined, frame.value);
          } catch {
            finish('payload_limit');
          }
          return;
        }
        if (frame?.type === 'failure') {
          finish(PUBLIC_FAILURE_CODES.has(frame.code) ? frame.code : 'execution_failed');
          return;
        }
        if (
          frame?.type !== 'rpc' ||
          !Number.isSafeInteger(frame.id) ||
          frame.id < 1 ||
          seen.has(frame.id) ||
          typeof frame.method !== 'string' ||
          ++calls > (profile === 'mangayomi-v1' ? 512 : 64) ||
          pending.size >= 4
        ) {
          finish('invalid_extension');
          return;
        }
        seen.add(frame.id);
        pending.add(frame.id);
        const respond = (response) => {
          pending.delete(frame.id);
          if (!settled) sendFrame(child.stdin, { type: 'rpc-result', id: frame.id, ...response });
        };
        const handler = Object.hasOwn(broker, frame.method) ? broker[frame.method] : undefined;
        if (typeof handler !== 'function') {
          respond({ ok: false, code: 'permission_denied' });
          return;
        }
        Promise.resolve()
          .then(() => {
            jsonText(frame.input, rpcInputLimit(frame.method));
            abort.signal.throwIfAborted();
            return handler(frame.input, abort.signal);
          })
          .then((value) => {
            jsonText(value, rpcResultLimit(frame.method));
            respond({ ok: true, value });
          })
          .catch((error) =>
            respond({ ok: false, code: PUBLIC_FAILURE_CODES.has(error?.message) ? error.message : 'execution_failed' }),
          );
      },
      () => finish('invalid_extension'),
    );
    sendFrame(child.stdin, { type: 'invoke', source, method, inputText, timeoutMs, memoryBytes, profile });
  });
}
