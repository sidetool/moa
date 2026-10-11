import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Recommendations } from '../src/recommendations.js';
import type { MetadataCandidate } from '@moa/shared';

const clock = Date.parse('2026-10-11T12:00:00.000Z');
const candidate = (id: number, title = `Candidate ${id}`): MetadataCandidate => ({ kind: 'movie', id, title });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-recommendations-'));
  const db = new Store(dir, new DatabaseSync(':memory:'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ['viewer', 'other', 'kids']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', id, id, '#fff', Number(id === 'kids'), '2026');
  const tmdb = { enabled: true, ensureDetail: async (_id: string) => {} };
  const service = new Recommendations(db, tmdb, () => clock);
  const detail = (id: number, similar: unknown[] = [], certification = 'ALL') => db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)', 'movie', id, JSON.stringify({ certification }), JSON.stringify({ similar }), clock);
  const title = (id: string, externalId: number, profile = 'viewer', position = 400, updated = '2026-10-10T00:00:00.000Z') => {
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id, 'movie', '{}', updated);
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', id, id, 1, 1, 'Episode', 1200, null);
    db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'movie',?,'manual',?)", id, externalId, clock);
    if (position >= 0) db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, id, position, 1200, 0, updated);
  };
  return { db, service, tmdb, title, detail };
}
const keys = (service: Recommendations, profile = 'viewer') => service.get(profile).items.map(r => r.key);

test('recommendations use recent substantial confirmed history and deduplicate source aliases', async t => {
  const { db, service, title, detail } = await fixture(t);
  title('seed', 1); title('alias', 1); title('brief', 2, 'viewer', 10);
  title('old', 3, 'viewer', 500, '2026-01-01T00:00:00.000Z'); title('ambiguous', 4); title('live', 5);
  db.run("UPDATE tmdb_links SET status='ambiguous' WHERE media_id='ambiguous'");
  db.run("UPDATE media SET metadata=? WHERE id='live'", JSON.stringify({ live: true }));
  for (let n = 1; n <= 5; n++) detail(n, [candidate(100 + n)]);
  assert.deepEqual(keys(service), ['movie:101']);
  assert.match(service.get('viewer').items[0].reason, /seed|alias/);
  assert.equal(service.get('other').status, 'insufficient-history');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM progress')!.n, 6, 'recommendation dedupe never merges stored progress');
});

test('seen exclusions and dismiss/undo/reset apply immediately and stay profile scoped', async t => {
  const { db, service, title, detail } = await fixture(t);
  title('seed', 1); title('seen-alias', 2, 'viewer', 1); title('available', 3, 'viewer', -1);
  detail(1, [candidate(2), candidate(3), candidate(4)]);
  db.run('INSERT INTO progress SELECT ?,episode_id,position,duration,completed,updated_at FROM progress WHERE episode_id=?', 'other', 'seed');
  assert.deepEqual(keys(service), ['movie:3', 'movie:4']);
  assert.equal(service.get('viewer').items[0].href, '/title/available');
  assert.equal(service.get('viewer').items[1].href, '/search?q=Candidate%204');
  service.dismiss('viewer', 'movie:3'); service.dismiss('viewer', 'movie:3');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM recommendation_feedback')!.n, 1);
  assert.deepEqual(keys(service), ['movie:4']); assert.ok(keys(service, 'other').includes('movie:3'));
  service.dismiss('viewer', 'movie:3', true); assert.ok(keys(service).includes('movie:3'));
  service.dismiss('viewer', 'movie:4'); service.reset('viewer'); assert.ok(keys(service).includes('movie:4'));
  assert.throws(() => service.dismiss('viewer', 'movie:0'), { error: 'invalid-recommendation' });
  db.run("DELETE FROM progress WHERE profile_id='viewer'");
  assert.deepEqual(service.get('viewer'), { items: [], status: 'insufficient-history' });
});

test('kids recommendations filter both seed reasons and external candidates using cached ratings', async t => {
  const { service, title, detail } = await fixture(t);
  title('safe-seed', 1, 'kids'); title('adult-seed', 2, 'kids');
  detail(1, [candidate(10), candidate(11), candidate(12)]); detail(2, [candidate(13)], '19');
  detail(10); detail(11, [], '19'); detail(13);
  assert.deepEqual(keys(service, 'kids'), ['movie:10'], 'unknown rating and adult seed evidence are excluded');
  assert.match(service.get('kids').items[0].reason, /safe-seed/);
});

test('disabled/unconfigured states and background TMDB failures do not block cached results', async t => {
  const { db, service, tmdb, title, detail } = await fixture(t);
  title('seed', 1); detail(1, [candidate(10)]);
  db.run('INSERT INTO settings VALUES(?,?)', 'viewer', JSON.stringify({ recommendationsEnabled: false }));
  assert.deepEqual(service.get('viewer'), { items: [], status: 'disabled' });
  db.run('DELETE FROM settings'); tmdb.enabled = false;
  assert.equal(service.get('viewer').status, 'unconfigured'); tmdb.enabled = true;
  db.run('UPDATE tmdb_titles SET fetched_at=0');
  let calls = 0; tmdb.ensureDetail = async () => { calls++; throw Error('synthetic outage'); };
  assert.deepEqual(keys(service), ['movie:10']); assert.equal(calls, 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(keys(service), ['movie:10']); assert.equal(calls, 1, 'failed warmup is bounded');
});

test('candidate validation and duplicate entries cannot produce repeated recommendations', async t => {
  const { service, title, detail } = await fixture(t);
  title('seed', 1);
  detail(1, [candidate(10), candidate(10), { kind: 'movie', id: -1, title: 'Invalid' }, { kind: 'tv', id: 0, title: 'Invalid' }, { kind: 'movie', id: 11, title: ' ' }, { kind: 'url', id: 12, title: 'Invalid' }, candidate(13)]);
  assert.deepEqual(keys(service), ['movie:10', 'movie:13']);
  assert.deepEqual(keys(service), keys(service), 'ordering is stable across repeated reads');
});
