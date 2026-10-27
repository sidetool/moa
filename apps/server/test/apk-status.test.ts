import test from 'node:test';
import assert from 'node:assert/strict';
import { ApkBridge } from '../src/sources/apk-bridge.js';

test('APK status distinguishes disabled, ready and unreachable without returning RPC secrets/errors', async () => {
  const disabled = new ApkBridge('', '');
  assert.deepEqual(await disabled.status(), { available: false, state: 'disabled', workers: null });
  const bridge = new ApkBridge('http://127.0.0.1:8797', 'test-only-credential-'.repeat(3));
  bridge.rpc = async <T>(method: string) => { assert.equal(method, 'status'); return { workers: 0 } as T; };
  assert.deepEqual(await bridge.status(), { available: true, state: 'ready', workers: 0 });
  bridge.rpc = async () => { throw new Error('private-diagnostic'); };
  assert.deepEqual(await bridge.status(), { available: false, state: 'unreachable', workers: null });
});
