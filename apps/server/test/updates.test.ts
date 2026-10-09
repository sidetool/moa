import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { Updates, installationInfo } from '../src/updates.js';

test('updates and system info require an administrator; installation requires a live agent', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-updates-api-'));
  const stateDir = path.join(dir, 'updater');
  await mkdir(stateDir);
  const previous = process.env.MOA_UPDATER_DIR;
  process.env.MOA_UPDATER_DIR = stateDir;
  const { app } = await buildApp({ dataDir: dir, mediaRoot: path.join(dir, 'media'), webDir: path.join(dir, 'web'), requireAccount: true }, false);
  const admin = { 'x-moa-account': 'admin', 'x-moa-role': 'admin' };
  const member = { 'x-moa-account': 'member', 'x-moa-role': 'member' };
  const state = { connected: true, state: 'available', mode: 'git', current: 'abc', latest: 'def', branch: 'feature', behind: 1, ahead: 0, checkedAt: Date.now(), heartbeat: Date.now(), error: null };
  try {
    for (const [method, url] of [['GET', '/api/admin/system'], ['GET', '/api/admin/updates'], ['POST', '/api/admin/updates/check'], ['POST', '/api/admin/updates/apply']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
      assert.equal((await app.inject({ method, url, headers: member })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/check', headers: admin })).statusCode, 202);
    const info = await app.inject({ url: '/api/admin/system', headers: admin });
    assert.equal(info.statusCode, 200);
    assert.equal(info.headers['cache-control'], 'private, no-store');
    assert.deepEqual(Object.keys(info.json()).sort(), ['architecture', 'cpuCount', 'deployment', 'kernel', 'memoryTotal', 'memoryUsed', 'nodeVersion', 'os', 'revision', 'uptimeSeconds', 'version']);
    assert.equal(info.json().nodeVersion, process.versions.node);
    assert.ok(info.json().cpuCount > 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers: admin })).statusCode, 503);
    await writeFile(path.join(stateDir, 'status.json'), JSON.stringify(state));
    const status = await app.inject({ url: '/api/admin/updates', headers: admin });
    assert.equal(status.json().connected, true);
    assert.equal(status.headers['cache-control'], 'private, no-store');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers: admin, payload: { command: 'anything' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers: admin })).statusCode, 202);
    const request = JSON.parse(await readFile(path.join(stateDir, 'request.json'), 'utf8'));
    assert.deepEqual(Object.keys(request).sort(), ['action', 'createdAt', 'id']);
    assert.equal(request.action, 'apply');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers: admin })).statusCode, 409);
    await rm(path.join(stateDir, 'request.json'));
    await writeFile(path.join(stateDir, 'status.json'), JSON.stringify({ ...state, state: 'current' }));
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/apply', headers: admin })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/check', headers: admin, payload: {} })).statusCode, 202);
    await rm(path.join(stateDir, 'request.json'));
    await writeFile(path.join(stateDir, 'status.json'), JSON.stringify({ ...state, heartbeat: 1 }));
    assert.equal((await app.inject({ url: '/api/admin/updates', headers: admin })).json().connected, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/updates/check', headers: admin })).statusCode, 202);
    assert.equal((await new Updates('').status()).configured, false);
  } finally {
    if (previous === undefined) delete process.env.MOA_UPDATER_DIR; else process.env.MOA_UPDATER_DIR = previous;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});


const installed = { MOA_VERSION: 'v1.9.0', MOA_REVISION: 'a'.repeat(40), MOA_REPOSITORY: 'fixture/moa', MOA_DEPLOYMENT: 'docker' };
const release = (tag_name: string, extra = {}) => ({ tag_name, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', html_url: 'https://untrusted.invalid/', ...extra });

test('release discovery sorts versions, uses installed metadata, caches and never enables unmanaged installation', async () => {
  let calls = 0;
  const updates = new Updates('', async input => {
    calls++;
    assert.equal(input, 'https://api.github.com/repos/fixture/moa/releases?per_page=100&page=1');
    return Response.json([release('v1.9.0'), release('v2.0.0'), release('v1.10.0'), release('v4.0.0', { draft: true }), release('v3.0.0-beta.1', { prerelease: true }), release('v999999999999999999999.0.0'), release('latest'), release('v5.0.0', { published_at: null })]);
  }, installed);
  const [first, second] = await Promise.all([updates.status(), updates.status()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.connected, false);
  assert.equal(first.discovery?.updateAvailable, true);
  assert.deepEqual(first.discovery?.releases.map(r => r.version), ['v3.0.0-beta.1', 'v2.0.0', 'v1.10.0', 'v1.9.0']);
  assert.equal(first.discovery?.latestVersion, 'v2.0.0');
  assert.equal(first.discovery?.releases[0].url, 'https://github.com/fixture/moa/releases/tag/v3.0.0-beta.1');
  await updates.request('check');
  assert.equal(calls, 1);
  await assert.rejects(updates.request('apply'), /updater-unavailable/);
  const current = await new Updates('', async () => Response.json([release('v1.8.0'), release('v1.9.0')]), installed).status();
  assert.equal(current.discovery?.updateAvailable, false);
  const beta = await new Updates('', async () => Response.json([release('v1.9.1-beta.2', { prerelease: true }), release('v1.9.0')]), { ...installed, MOA_VERSION: 'v1.9.1-beta.1' }).status();
  assert.equal(beta.discovery?.latestVersion, 'v1.9.1-beta.2');
  assert.equal(beta.discovery?.updateAvailable, true);
  const unknown = await new Updates('', async () => Response.json([release('v2.0.0')]), { ...installed, MOA_VERSION: 'latest' }).status();
  assert.equal(unknown.discovery?.currentVersion, null);
  assert.equal(unknown.discovery?.updateAvailable, null);
});

test('release discovery distinguishes an empty feed from failed or oversized responses', async () => {
  for (const [response, expected] of [[Response.json([]), null], [new Response('', { status: 404 }), 'update-check-failed'], [new Response('', { status: 429 }), 'update-rate-limited'], [new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'update-response-limit']] as const) {
    const status = await new Updates('', async () => response, installed).status();
    assert.equal(status.discovery?.error, expected);
    assert.equal(status.discovery?.updateAvailable, null);
  }
});

test('release metadata falls back to the upstream remote and an exact installed tag', async t => {
  const { execFileSync } = await import('node:child_process');
  const cwd = await mkdtemp(path.join(tmpdir(), 'moa-update-repository-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Initial');
  git('remote', 'add', 'origin', 'https://github.com/fork/moa.git');
  git('remote', 'add', 'upstream', 'git@github.com:sidetool/moa.git');
  git('-c', 'tag.gpgSign=false', 'tag', 'v1.0.0');
  assert.deepEqual(await installationInfo({}, cwd), { version: 'v1.0.0', revision: git('rev-parse', 'HEAD'), repository: 'sidetool/moa', mode: 'git' });
  assert.equal((await installationInfo({ ...installed, MOA_REPOSITORY: '../private/anything' }, cwd)).repository, 'sidetool/moa');
});
