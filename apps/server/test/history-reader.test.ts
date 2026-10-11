import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { HistoryReader } from '../src/history-reader.js';
import { buildApp } from '../src/app.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-history-reader-'));
  const db = new Store(dir, new DatabaseSync(':memory:'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ['viewer', 'other', 'kids']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', id, id, '#fff', Number(id === 'kids'), '2026');
  const reader = new HistoryReader(db);
  const add = (id: string, profile = 'viewer', time = '2026-10-10T12:00:00.000Z', rating?: string) => {
    db.run('INSERT OR IGNORE INTO media VALUES(?,NULL,?,?,?,?)', id, id, 'movie', JSON.stringify({ url: 'https://source.test/private', headers: { Cookie: 'secret' } }), '2026');
    db.run('INSERT OR IGNORE INTO episodes VALUES(?,?,?,?,?,?,?)', id, id, 1, 1, 'Episode', 1200, null);
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, id, 400, 1200, 0, time);
    if (rating) {
      const n = db.get('SELECT COUNT(*) AS n FROM tmdb_titles')!.n + 1;
      db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'movie',?,'manual',1)", id, n);
      db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)', 'movie', n, JSON.stringify({ certification: rating }), '{}', 1);
    }
  };
  return { db, reader, add, dir };
}

test('history pages isolate profiles, use stable ties and expose only the read contract', async t => {
  const { reader, add } = await fixture(t);
  for (const id of ['a', 'b', 'c']) add(id);
  add('foreign', 'other'); add('old', 'viewer', '2025-01-01T00:00:00.000Z');
  const first = reader.list('viewer', { limit: 2, since: '2026-01-01' });
  assert.deepEqual(first.items.map(r => r.episodeId), ['c', 'b']);
  const next = reader.list('viewer', { limit: 2, since: '2026-01-01', cursor: first.nextCursor! });
  assert.deepEqual(next.items.map(r => r.episodeId), ['a']); assert.equal(next.nextCursor, null);
  assert.deepEqual(first.items[0], { mediaId: 'c', episodeId: 'c', title: 'c', episodeTitle: 'Episode', season: 1, episode: 1, position: 400, duration: 1200, completed: false, updatedAt: '2026-10-10T12:00:00.000Z' });
  assert.deepEqual(reader.list('other').items.map(r => r.mediaId), ['foreign']);
  assert.deepEqual(reader.list('viewer',{since:'2026-10-10T11:30:00-02:00'}).items,[],'UTC instant must be compared, not offset text');
  const offset=reader.list('viewer',{limit:1,since:'2026-10-10T21:00:00+09:00'});
  assert.equal(reader.list('viewer',{cursor:offset.nextCursor!,since:'2026-10-10T12:00:00Z'}).items.length,2);
});

test('kids history can cross a fully filtered page without leaking blocked or unknown titles', async t => {
  const { reader, add } = await fixture(t);
  add('z-blocked', 'kids', undefined, '19'); add('y-unknown', 'kids'); add('a-safe', 'kids', undefined, 'ALL');
  const first = reader.list('kids', { limit: 2 });
  assert.deepEqual(first.items, []); assert.ok(first.nextCursor);
  const next = reader.list('kids', { limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(next.items.map(r => r.mediaId), ['a-safe']); assert.deepEqual(next.items[0].tmdb, { kind: 'movie', id: 2 });
  assert.equal(next.nextCursor, null);
});

test('history revisions invalidate deleted/updated records and reject cross-profile cursors', async t => {
  const { db, reader, add } = await fixture(t);
  add('a'); add('b');
  const before = reader.list('viewer', { limit: 1 });
  add('foreign', 'other');
  assert.equal(reader.list('viewer').revision, before.revision, 'another profile progress does not change this revision');
  assert.throws(() => reader.list('other', { cursor: before.nextCursor! }), { error: 'history-changed', statusCode: 409 });
  db.run('UPDATE progress SET position=500 WHERE profile_id=? AND episode_id=?', 'viewer', 'a');
  assert.notEqual(reader.list('viewer').revision, before.revision);
  assert.throws(() => reader.list('viewer', { cursor: before.nextCursor! }), { error: 'history-changed' });
  const updated = reader.list('viewer').revision;
  db.run('DELETE FROM progress WHERE profile_id=?', 'viewer');
  assert.notEqual(reader.list('viewer').revision, updated); assert.deepEqual(reader.list('viewer').items, []);
});

test('history limits, since binding and malformed requests are enforced', async t => {
  const { reader, add } = await fixture(t);
  for (let i = 0; i < 105; i++) add(`ep-${String(i).padStart(3, '0')}`);
  assert.equal(reader.list('viewer').items.length, 50);
  assert.equal(reader.list('viewer', { limit: 100 }).items.length, 100);
  for (const query of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { since: 'invalid' }, { cursor: 'not-json' }, { profile: 'other' }, []])
    assert.throws(() => reader.list('viewer', query as any), { statusCode: 400 });
  const first = reader.list('viewer', { limit: 1, since: '2026-01-01' });
  assert.throws(() => reader.list('viewer', { cursor: first.nextCursor!, since: '2026-02-01' }), { error: 'history-changed' });
});

test('plugin history endpoint checks permission, package revision, revocation, ownership and lock', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-history-endpoint-'));
  const store = new Store(dir, new DatabaseSync(':memory:'));
  const { app, db } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true }, false, { store, tmdb: { token: '', key: '' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
  const create = async (pin?: string) => (await app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Viewer', ...(pin ? { pin } : {}) } })).json().id;
  const profile = await create(), other = await create(), locked = await create('1234');
  const headers = { ...admin, 'x-moa-profile': profile };
  db.run("INSERT INTO media VALUES('m',NULL,'Private','movie','{}','2026')");
  db.run("INSERT INTO episodes VALUES('e','m',1,1,'Episode',1200,NULL)");
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, 'e', 400, 1200, 0, '2026-10-10');
  const pkg = { id: 'history-test', name: 'History test', version: '1.0.0', description: '', apiVersion: 1, placements: ['home'], permissions: [] as string[], connect: [], script: 'void 0;' };
  const install = async (permissions: string[]) => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...pkg, permissions } });
    assert.equal(r.statusCode, 200, r.body); return r.json().revision;
  };
  let revision = await install([]);
  const request = (h = headers, payload: object = { revision }) => app.inject({ method: 'POST', url: '/api/plugin-runtime/history-test/history', headers: h, payload });
  assert.equal((await request()).json().error, 'plugin-permission-denied');
  const stale = revision; revision = await install(['history.read']);
  assert.equal((await request(headers, { revision: stale })).json().error, 'plugin-updated');
  const result = await request(); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['cache-control'], 'private, no-store'); assert.deepEqual(result.json().items.map((r: any) => r.episodeId), ['e']);
  assert.deepEqual((await request({ ...headers, 'x-moa-profile': other })).json().items, []);
  assert.equal((await request({ ...headers, 'x-moa-account': 'foreign' })).json().error, 'profile-required');
  assert.equal((await request({ ...headers, 'x-moa-profile': locked })).json().error, 'profile-locked');
  assert.equal((await request(headers, { revision, query: { profile: other } })).statusCode, 400);
  revision = await install([]); assert.equal((await request()).json().error, 'plugin-permission-denied');
  await app.inject({ method: 'PATCH', url: '/api/admin/plugins/history-test', headers: admin, payload: { enabled: false } });
  assert.equal((await request()).json().error, 'plugin-not-found');
});
