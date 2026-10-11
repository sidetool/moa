// Unit test for plugin.js with a fake SDK (no browser, no network). Run: node --test plugins/title-people/test/plugin.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../plugin.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const title = { mediaId: 'm1', provider: 'tmdb', kind: 'tv', id: '100', name: 'x', scope: 'series' };

function load(metadata) {
  const calls = { credits: [], person: [] }, hooks = {};
  const moa = {
    hooks: { register: (name, handler) => { hooks[name] = handler; return Promise.resolve(); } },
    metadata: metadata === null ? undefined : {
      credits: (...args) => { calls.credits.push(args); return Promise.resolve(metadata?.credits ?? { provider: 'tmdb', status: 'ready', title, cast: [], crew: [], truncated: false }); },
      person: (...args) => { calls.person.push(args); return Promise.resolve(metadata?.person ?? { provider: 'tmdb', status: 'ready', title, person: null, items: [], truncated: false }); },
    },
  };
  vm.runInNewContext(source, { moa });
  return { hook: hooks['title.people'], calls, hooks };
}

test('manifest declares only the hook and metadata permission', () => {
  assert.deepEqual(manifest.placements, ['app']);
  assert.deepEqual(manifest.permissions, ['metadata.read']);
  assert.deepEqual(manifest.hooks, ['title.people']);
  assert.deepEqual(manifest.connect, []);
  assert.equal(manifest.apiVersion, 2);
});

test('registers only title.people', () => {
  const { hooks } = load();
  assert.deepEqual(Object.keys(hooks), ['title.people']);
});

test('credits are requested without arguments and passed through', async () => {
  const { hook, calls } = load();
  const result = await hook({ action: 'credits', mediaId: 'm1' });
  assert.equal(JSON.stringify(calls.credits), '[[]]');
  assert.equal(result.title.mediaId, 'm1');
});

test('person identity is forwarded exactly as an opaque string', async () => {
  const { hook, calls } = load();
  await hook({ action: 'person', mediaId: 'm1', person: { provider: 'tmdb', id: '0042', extra: 'dropped' } });
  assert.equal(JSON.stringify(calls.person), JSON.stringify([[{ provider: 'tmdb', id: '0042' }]]));
});

test('refuses other providers, other titles, unknown requests and a missing SDK', async () => {
  const { hook, calls } = load();
  await assert.rejects(hook({ action: 'person', mediaId: 'm1', person: { provider: 'example', id: '1' } }));
  await assert.rejects(hook({ action: 'person', mediaId: 'm1', person: { provider: 'tmdb', id: 42 } }));
  await assert.rejects(hook({ action: 'other', mediaId: 'm1' }));
  await assert.rejects(hook(null));
  assert.equal(calls.person.length, 0);
  await assert.rejects(load({ credits: { provider: 'example', status: 'ready', title } }).hook({ action: 'credits', mediaId: 'm1' }), /provider/);
  await assert.rejects(load().hook({ action: 'credits', mediaId: 'm2' }), /Title changed/);
  await assert.rejects(load(null).hook({ action: 'credits', mediaId: 'm1' }), /unavailable/);
});

test('non-ready answers pass through for MOA to display', async () => {
  const { hook } = load({ credits: { provider: 'tmdb', status: 'restricted', title: null } });
  assert.equal((await hook({ action: 'credits', mediaId: 'm2' })).status, 'restricted');
});
