import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import {
  jsonText,
  invocationJsonLimit,
  MAX_TEXT_RPC_BYTES,
  PUBLIC_FAILURE_CODES,
  readFrames,
  sendFrame,
  rpcInputLimit,
  rpcResultLimit,
} from './wire.mjs';

let started = false;
let context;
let runtime;
let deadline = Infinity;
let nextRpc = 0;
const pending = new Map();
let pump;
let finished = false;
let rpcLimit = 64;
let cpuStarted = 0;
let cpuUsed = 0;

function fail(code = 'execution_failed') {
  if (finished) return;
  finished = true;
  sendFrame(process.stdout, { type: 'failure', code });
  // Parent owns hard termination even when guest promise jobs or native teardown fail.
}

function unwrap(result) {
  if (result.error) {
    result.error.dispose();
    throw new Error('execution_failed');
  }
  return result.value;
}

async function invoke(frame) {
  const engine = await newQuickJSWASMModuleFromVariant(releaseVariant);
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(frame.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  deadline = performance.now() + frame.timeoutMs;
  rpcLimit = ['mangayomi-v1', 'source-webview-v1'].includes(frame.profile) ? 512 : 64;
  cpuStarted = performance.now();
  runtime.setInterruptHandler(
    () =>
      performance.now() >= deadline ||
      (['mangayomi-v1', 'source-webview-v1'].includes(frame.profile) &&
        cpuUsed + performance.now() - cpuStarted >= 5000),
  );
  // No module loader, Node objects, OS modules, network globals, or application storage are installed.
  context = runtime.newContext();
  if (frame.profile === 'mangayomi-v1') {
    const cryptoHandler = context.newFunction(
      '__moaCryptoHandler',
      (textHandle, ivHandle, keyHandle, encryptHandle) => {
        if (
          context.typeof(textHandle) !== 'string' ||
          context.typeof(ivHandle) !== 'string' ||
          context.typeof(keyHandle) !== 'string'
        )
          return context.newString('');
        const text = context.getString(textHandle);
        const ivText = context.getString(ivHandle);
        const keyText = context.getString(keyHandle);
        const encrypt = context.dump(encryptHandle) === true;
        try {
          if (
            Buffer.byteLength(text) > 4 * 1024 * 1024 ||
            Buffer.byteLength(ivText) > 64 ||
            Buffer.byteLength(keyText) > 64
          )
            return context.newString(text);
          const iv = Buffer.from(ivText, 'utf8');
          const key = Buffer.from(keyText, 'utf8');
          if (iv.length !== 16 || ![16, 24, 32].includes(key.length)) return context.newString(text);
          const algorithm = `aes-${key.length * 8}-cbc`;
          if (encrypt) {
            const cipher = createCipheriv(algorithm, key, iv);
            return context.newString(Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64'));
          }
          const decipher = createDecipheriv(algorithm, key, iv);
          return context.newString(Buffer.concat([decipher.update(text, 'base64'), decipher.final()]).toString('utf8'));
        } catch {
          // Mangayomi returns the input unchanged when encryption or decryption fails.
          return context.newString(text);
        }
      },
    );
    context.setProp(context.global, '__moaCryptoHandler', cryptoHandler);
    cryptoHandler.dispose();
  }
  const rpc = context.newFunction('rpc', (request) => {
    if (context.typeof(request) !== 'string' || pending.size >= 4 || nextRpc >= rpcLimit)
      return { error: context.newError('rpc_limit') };
    const text = context.getString(request);
    if (Buffer.byteLength(text) > MAX_TEXT_RPC_BYTES) return { error: context.newError('payload_limit') };
    let data;
    try {
      data = JSON.parse(text);
      jsonText(data, rpcInputLimit(data.method));
    } catch {
      return { error: context.newError('invalid_rpc') };
    }
    const deferred = context.newPromise();
    const id = ++nextRpc;
    pending.set(id, { deferred, method: data.method });
    sendFrame(process.stdout, { type: 'rpc', id, method: data.method, input: data.input });
    return deferred.handle;
  });
  // Capture serialization before source code runs. Only serialized values cross the WASM boundary.
  const factory = unwrap(
    context.evalCode(`(function(rpc) {
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    const host = Object.freeze({ request: async function(method, input) {
      const reply = parse(await rpc(stringify({ method, input })));
      if (!reply.ok) { const error = new Error(reply.code); error.code = reply.code; throw error; }
      return reply.value;
    }});
    return async function(fn, method, input) { return stringify(await fn(method, parse(input), host)); };
  })`),
  );
  const dispatch = unwrap(context.callFunction(factory, context.undefined, rpc));
  factory.dispose();
  rpc.dispose();
  unwrap(context.evalCode(frame.source, 'extension.js', { type: 'global' })).dispose();
  const timerPump = frame.profile === 'mangayomi-v1' ? context.getProp(context.global, '__moaRunTimers') : undefined;
  const extension = context.getProp(context.global, 'moaExtension');
  if (context.typeof(extension) !== 'function') {
    extension.dispose();
    dispatch.dispose();
    fail('invalid_extension');
    return;
  }
  const method = context.newString(frame.method);
  const input = context.newString(frame.inputText);
  const promise = unwrap(context.callFunction(dispatch, context.undefined, extension, method, input));
  extension.dispose();
  dispatch.dispose();
  method.dispose();
  input.dispose();
  cpuUsed += performance.now() - cpuStarted;
  pump = () => {
    if (finished) return;
    if (performance.now() >= deadline) {
      fail('execution_timeout');
      return;
    }
    try {
      cpuStarted = performance.now();
      if (timerPump && context.typeof(timerPump) === 'function')
        unwrap(context.callFunction(timerPump, context.undefined)).dispose();
      const jobs = runtime.executePendingJobs(64);
      cpuUsed += performance.now() - cpuStarted;
      if (jobs.error) {
        jobs.error.dispose();
        throw new Error('execution_failed');
      }
      const state = context.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        if (context.typeof(state.value) !== 'string') {
          state.value.dispose();
          throw new Error('invalid_result');
        }
        const text = context.getString(state.value);
        state.value.dispose();
        if (Buffer.byteLength(text) > invocationJsonLimit(frame.profile)) {
          fail('payload_limit');
          return;
        }
        const value = JSON.parse(text);
        jsonText(value, invocationJsonLimit(frame.profile));
        finished = true;
        sendFrame(process.stdout, { type: 'result', value });
        promise.dispose();
        for (const { deferred } of pending.values()) deferred.dispose();
        pending.clear();
        timerPump?.dispose();
        context.dispose();
        runtime.dispose();
        return;
      }
      if (state.type === 'rejected') {
        const code = context.getProp(state.error, 'code');
        const publicCode = context.typeof(code) === 'string' ? context.getString(code) : undefined;
        code.dispose();
        state.error.dispose();
        fail(PUBLIC_FAILURE_CODES.has(publicCode) ? publicCode : 'execution_failed');
        return;
      }
      setTimeout(pump, runtime.hasPendingJob() ? 0 : 5);
    } catch {
      fail(performance.now() >= deadline ? 'execution_timeout' : 'execution_failed');
    }
  };
  pump();
}

readFrames(
  process.stdin,
  (frame) => {
    if (finished) return;
    if (!started && frame?.type === 'invoke') {
      started = true;
      invoke(frame).catch(() => fail(performance.now() >= deadline ? 'execution_timeout' : 'execution_failed'));
      return;
    }
    if (frame?.type !== 'rpc-result' || !pending.has(frame.id) || !context) {
      fail('invalid_extension');
      return;
    }
    const { deferred, method } = pending.get(frame.id);
    pending.delete(frame.id);
    const value = context.newString(jsonText(frame, rpcResultLimit(method) + 1024));
    deferred.resolve(value);
    value.dispose();
    deferred.dispose();
  },
  () => fail('invalid_extension'),
);
process.stdin.on('end', () => process.exit(0));
