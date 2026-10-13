import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Updates, validatePolicy } from '../src/updates.js';
import { UpdateMaintenance } from '../src/update-maintenance.js';
import { ApiFailure } from '../src/util.js';
import { buildApp } from '../src/app.js';
const policy = { channel: 'stable' as const };

test('release policies are validated, administrator-only and queued without claiming acknowledgement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-release-api-'));
  const previous = process.env.MOA_UPDATER_DIR; process.env.MOA_UPDATER_DIR = dir;
  const { app } = await buildApp({ dataDir: path.join(dir, 'data'), mediaRoot: path.join(dir, 'media'), webDir: path.join(dir, 'web'), requireAccount: true }, false);
  const state = { connected: true, state: 'available', mode: 'release', current: 'v1.0.0', latest: 'v1.1.0', heartbeat: Date.now(), policy, updaterVersion: '1.0.0', notesUrl: 'https://github.com/sidetool/moa/releases/tag/v1.1.0', history: [] };
  const headers = { 'x-moa-account': 'fixture-admin', 'x-moa-role': 'admin' };
  try {
    await writeFile(path.join(dir, 'status.json'), JSON.stringify(state));
    const url = '/api/admin/updates/settings';
    assert.equal((await app.inject({ method: 'PATCH', url, payload: policy })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PATCH', url, headers: { ...headers, 'x-moa-role': 'member' }, payload: policy })).statusCode, 403);
    for (const change of [{ autoCheck: false, autoApply: true }, { command: 'anything' }, { windowStart: ['03:00'] }, { timezone: 'invalid/zone' }, { windowEnd: '03:00' }]) {
      assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: { ...policy, ...change } })).statusCode, 400);
    }
    const chosen = { ...policy, channel: 'beta' };
    const response = await app.inject({ method: 'PATCH', url, headers, payload: chosen });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().policy.channel, 'stable');
    const queued = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8'));
    assert.deepEqual(Object.keys(queued).sort(), ['action','createdAt','id','policy']);
    assert.equal(queued.action, 'configure'); assert.deepEqual(queued.policy, chosen);
    assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: chosen })).statusCode, 409);
    await rm(path.join(dir, 'request.json'));
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ ...state, state: 'applying' }));
    assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: chosen })).statusCode, 409);
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ ...state, state: 'available', notesUrl: 'https://untrusted.invalid/', history: [{ version: 'v1.0.0', previous: 'v0.9.0', at: 1, outcome: 'complete', secret: 'hidden' }] }));
    const status = await new Updates(dir).status();
    assert.equal(status.notesUrl, null);
    assert.equal('secret' in status.history![0], false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers, payload: {} })).statusCode, 202);
    assert.deepEqual(validatePolicy(policy), policy);
  } finally {
    await app.close(); if (previous === undefined) delete process.env.MOA_UPDATER_DIR; else process.env.MOA_UPDATER_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('maintenance acknowledges a live lease, blocks new work, preserves status and expires', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-maintenance-'));
  const app = Fastify(); let busy = false;
  const maintenance = new UpdateMaintenance(dir, () => busy); maintenance.register(app);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ApiFailure ? error.statusCode : 500).send({ error: error.message }));
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/admin/updates', async () => ({}));
  app.get('/api/admin/components', async () => ({}));
  app.post('/api/playback', async () => ({ started: true }));
  const id = '00000000-0000-0000-0000-000000000001';
  try {
    await app.ready();
    assert.equal((await app.inject({ method: 'POST', url: '/api/playback' })).statusCode, 200);
    busy = true; await maintenance.tick();
    assert.equal(JSON.parse(await readFile(path.join(dir, 'activity.json'), 'utf8')).busy, true);
    busy = false;
    await writeFile(path.join(dir, 'maintenance.json'), JSON.stringify({ id, expiresAt: Date.now() + 30000 }));
    await maintenance.tick();
    const activity = JSON.parse(await readFile(path.join(dir, 'activity.json'), 'utf8'));
    assert.equal(activity.leaseId, id); assert.equal(activity.busy, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/playback' })).statusCode, 503);
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/api/admin/updates')).statusCode, 200);
    assert.equal((await app.inject('/api/admin/components')).statusCode, 200);
    await writeFile(path.join(dir, 'maintenance.json'), JSON.stringify({ id, expiresAt: Date.now() - 1 }));
    await maintenance.tick();
    assert.equal((await app.inject({ method: 'POST', url: '/api/playback' })).statusCode, 200);
    assert.equal(maintenance.paused, false);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
