import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteAccess } from '../src/network/remote-access.js';
test('desired state, masked credentials, safety, persistence, and external ownership', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-remote-'));
  const calls: string[] = []; let safe = true;
  const rpc = async (method: string) => { calls.push(method); return { state: method === 'stop' ? 'off' as const : 'starting' as const, url: null, loginUrl: null, lastError: null }; };
  const controller = new RemoteAccess(dir, rpc, async () => safe);
  try {
    await controller.init();
    await controller.mutate('configure', { mode: 'cloudflare-token', publicHostname: 'moa.example.com', cloudflareToken: 'test-token' });
    assert.equal(controller.status().config.cloudflareToken, '********');
    assert.ok(!JSON.stringify(controller.status()).includes('test-token'));
    assert.equal((await stat(path.join(dir, 'remote-access.json'))).mode & 0o777, 0o600);
    safe = false;
    await assert.rejects(controller.mutate('start'), /login-gate-and-admin-required/);
    assert.equal(controller.status().desiredEnabled, false);
    safe = true; await controller.mutate('start'); assert.equal(calls.at(-1), 'apply');
    controller.close();
    const restarted = new RemoteAccess(dir, rpc, async () => true); await restarted.init();
    assert.equal(restarted.status().desiredEnabled, true); assert.equal(calls.at(-1), 'apply');
    await restarted.mutate('stop'); restarted.close();
    assert.equal(JSON.parse(await readFile(path.join(dir, 'remote-access.json'), 'utf8')).enabled, false);
    const external = new RemoteAccess(dir, rpc, async () => true, true); await external.init();
    assert.equal(external.status().externallyManaged, true);
    await assert.rejects(external.mutate('start'), /externally-managed/);
    await assert.rejects(controller.mutate('configure', { mode: 'cloudflare-token', publicHostname: 'https://bad.test/path' }), /invalid-public-hostname/);
  } finally { controller.close(); await rm(dir, { recursive: true, force: true }); }
});
test('RPC failures expose a fixed error without secret-bearing upstream output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-remote-'));
  const controller = new RemoteAccess(dir, async () => { throw new Error('private token'); }, async () => true);
  try { await controller.init(); assert.equal(controller.status().lastError, 'connector-unavailable'); }
  finally { controller.close(); await rm(dir, { recursive: true, force: true }); }
});
