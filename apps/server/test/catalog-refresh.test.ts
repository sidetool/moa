import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';
import { SourceReadCache } from '../src/sources/cache.js';
import { buildApp } from '../src/app.js';
import { Tmdb } from '../src/metadata/tmdb.js';

const temporaryRoot = process.env.MOA_TEST_TMPDIR || '/tmp';
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(10); }
  assert.ok(check(), 'background work did not settle');
}
async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(temporaryRoot, 'moa-catalog-refresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function seedSource(db: Store) {
  const entry = JSON.stringify({ id: 'fixture', name: 'Fixture source', version: '1', baseUrl: 'https://fixture.invalid', format: 'mangayomi-js' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'fixture', 'https://fixture.invalid/repository', entry, entry, 'fixture');
}

test('old persisted source catalogs render before one background refresh and retain profile hydration', async t => {
  const dir = await directory(t), db = new Store(dir), catalog = new Catalog(db);
  let calls = 0, blocked = false, release = () => {};
  const sources = new Sources(db, catalog, async input => {
    calls++;
    if (blocked) await new Promise<void>(resolve => { release = resolve; });
    return { result: { list: [{ name: blocked ? 'Updated fixture' : 'Stored fixture', link: '/title' }], hasNextPage: false }, changes: {} };
  });
  t.after(async () => { release(); await sources.close(); db.close(); });
  seedSource(db);
  for (const id of ['viewer', 'other']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,0,?)', id, id, 'blue', '2026');
  const first = await sources.browse('fixture', 'viewer');
  db.run('INSERT INTO watchlist VALUES(?,?,?)', 'viewer', first.items[0].id, '2026');
  db.run('UPDATE source_read_cache SET fetched=?', Date.now() - 400 * 86_400_000);
  blocked = true;
  const responses = await Promise.race([
    Promise.all(Array.from({ length: 20 }, (_, i) => sources.browse('fixture', i % 2 ? 'viewer' : 'other'))),
    wait(500).then(() => { throw Error('a stored catalog waited for the upstream request'); })
  ]);
  await eventually(() => calls === 2);
  assert.ok(responses.every(response => response.items[0].title === 'Stored fixture'));
  assert.equal(responses[0].items[0].inWatchlist, false);
  assert.equal(responses[1].items[0].inWatchlist, true);
  release();
  await eventually(() => JSON.stringify(db.all('SELECT title FROM media')).includes('Updated fixture'));
  assert.equal((await sources.browse('fixture', 'viewer')).items[0].title, 'Updated fixture');
  assert.equal(calls, 2);
});

test('forced source refresh bypasses freshness, coalesces requests and reports failures without losing saved facts', async t => {
  const dir = await directory(t), db = new Store(dir), catalog = new Catalog(db), sources = new Sources(db, catalog);
  t.after(async () => { await sources.close(); db.close(); });
  seedSource(db);
  const cache = new SourceReadCache(db, new AbortController().signal);
  const policy = { freshMs: 60_000, staleMs: Infinity };
  cache.prime('fixture', 'page', 'saved', Date.now());
  let calls = 0, release = () => {};
  const reads = Array.from({ length: 10 }, () => cache.read('fixture', 'page', { ...policy, force: true }, async () => {
    calls++; await new Promise<void>(resolve => { release = resolve; }); return 'updated';
  }));
  await eventually(() => calls > 0);
  assert.equal(calls, 1); release();
  assert.deepEqual(await Promise.all(reads), Array(10).fill('updated'));
  await assert.rejects(cache.read('fixture', 'page', { ...policy, force: true }, async () => { throw Error('forced failure'); }), /forced failure/);
  assert.equal(await cache.read('fixture', 'page', policy, async () => 'wrong'), 'updated');
});

test('catalog refresh frequency is restricted to admins, validated and persisted', async t => {
  const dir = await directory(t);
  const { app, db } = await buildApp({ dataDir: dir, mediaRoot: dir, requireAccount: true }, false, { tmdb: { token: '', key: '' } });
  t.after(() => app.close());
  const url = '/api/admin/catalog-refresh', admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
  const member = { ...admin, 'x-moa-role': 'member' };
  for (const method of ['GET', 'PATCH'] as const) {
    const payload = method === 'PATCH' ? { intervalMinutes: 30 } : undefined;
    assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method, url, payload, headers: member })).statusCode, 403);
  }
  assert.deepEqual((await app.inject({ url, headers: admin })).json(), { intervalMinutes: 60 });
  for (const intervalMinutes of [0, -1, 1.5, 10081]) {
    assert.equal((await app.inject({ method: 'PATCH', url, headers: admin, payload: { intervalMinutes } })).statusCode, 400);
  }
  for (const intervalMinutes of [1, 10080, 45]) {
    const result = await app.inject({ method: 'PATCH', url, headers: admin, payload: { intervalMinutes } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { intervalMinutes });
    assert.deepEqual((await app.inject({ url, headers: admin })).json(), { intervalMinutes });
  }
  assert.ok(db.all('SELECT value FROM admin_settings').some(row => row.value.includes('45')), 'refresh preference is persisted in the database');
});

test('old TMDB titles and seasons render immediately, share background work and explicit refresh reports errors', async t => {
  const dir = await directory(t), db = new Store(dir), catalog = new Catalog(db), sources = new Sources(db, catalog);
  let release = () => {}, fail = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), calls: string[] = [];
  const tmdb = new Tmdb(db, () => {}, { token: 'fixture', fetch: async input => {
    const pathname = new URL(String(input)).pathname; calls.push(pathname);
    await gate;
    if (fail) return Response.json({ status_message: 'fixture unavailable' }, { status: 403 });
    return Response.json(pathname.endsWith('/season/1')
      ? { episodes: [{ episode_number: 1, name: 'Updated episode' }] }
      : { name: 'Updated TMDB title', original_name: 'Original', seasons: [], videos: { results: [] } });
  } });
  t.after(async () => { release(); tmdb.close(); await sources.close(); db.close(); });
  db.run("INSERT INTO media VALUES('series',NULL,'Source title','series','{}','2026')");
  db.run("INSERT INTO episodes VALUES('episode','series',1,1,'1화',1200,NULL)");
  db.run("INSERT INTO tmdb_links VALUES('series','tv',100,1,'manual',100,?)", Date.now());
  const old = Date.now() - 400 * 86_400_000;
  db.run("INSERT INTO tmdb_titles VALUES('tv',100,?,?,?)", JSON.stringify({ title: 'Saved TMDB title', animation: false }), JSON.stringify({ people: [], similar: [], trailers: [] }), old);
  db.run('INSERT INTO tmdb_seasons VALUES(?,?,?,?)', 100, 1, JSON.stringify([{ number: 1, name: 'Saved episode' }]), old);
  const title = { mediaId: 'series', provider: 'tmdb', kind: 'tv' as const, id: '100', name: 'Source title', scope: 'series' as const };
  const results = await Promise.race([
    Promise.all(Array.from({ length: 20 }, async () => { await tmdb.ensureDetail('series', 5000); return tmdb.titleDetails(title); })),
    wait(500).then(() => { throw Error('saved TMDB detail waited for the upstream request'); })
  ]);
  assert.ok(results.every(result => result.title === 'Saved TMDB title'));
  await eventually(() => calls.length === 2);
  assert.deepEqual(calls.sort(), ['/3/tv/100', '/3/tv/100/season/1']);
  assert.equal(catalog.detail('series', 'viewer').seasons[0].episodes[0].name, 'Saved episode');
  release();
  await eventually(() => db.get('SELECT fetched_at FROM tmdb_seasons')!.fetched_at > old && db.get('SELECT fetched_at FROM tmdb_titles')!.fetched_at > old);
  assert.equal((await tmdb.titleDetails(title)).title, 'Updated TMDB title');
  fail = true;
  await assert.rejects(tmdb.refreshDetail('series'));
  assert.equal((await tmdb.titleDetails(title)).title, 'Updated TMDB title');
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='series'")!.status, 'manual');
});

test('manual title refresh requests current source data and preserves cached detail on partial failure', async t => {
  const dir = await directory(t);
  const { app, db, sources } = await buildApp({ dataDir: dir, mediaRoot: dir }, false, { tmdb: { token: '', key: '' } });
  t.after(() => app.close());
  const viewer = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
  db.run("INSERT INTO media VALUES('fixture',NULL,'Saved title','series','{}','2026')");
  db.run("INSERT INTO episodes VALUES('episode','fixture',1,1,'Saved episode',1200,NULL)");
  const reads = t.mock.method(sources, 'detail', async () => { throw Error('fixture offline'); });
  const result = await app.inject({ method: 'POST', url: '/api/media/fixture/refresh', headers: { 'x-moa-profile': viewer } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(reads.mock.calls[0].arguments, ['fixture', true]);
  assert.equal(result.json().detail.title, 'Saved title');
  assert.equal(result.json().detail.seasons[0].episodes[0].title, 'Saved episode');
  assert.deepEqual(result.json().errors, ['source']);
  const missing = await app.inject({ method: 'POST', url: '/api/media/missing/refresh', headers: { 'x-moa-profile': viewer } });
  assert.equal(missing.statusCode, 404);
});

test('My List new episodes follow actual watched episode order, remain profile-specific and sort by episode changes', async t => {
  const dir = await directory(t);
  const { app, db, catalog } = await buildApp({ dataDir: dir, mediaRoot: dir }, false, { tmdb: { token: '', key: '' } });
  t.after(() => app.close());
  const viewer = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
  const other = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Other' } })).json().id;
  for (const [id, type, metadata] of [['series', 'series', {}], ['old', 'series', {}], ['movie', 'movie', {}], ['live', 'series', { live: true }]] as const) {
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id, type, JSON.stringify(metadata), '2026');
    for (const profile of [viewer, other]) db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, id, id === 'old' ? '2026-11-18' : '2026-11-17');
    for (const [season, number] of [[1, 1], [1, 2], [1, 5], [2, 1], [2, 3]]) db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,NULL)', `${id}-${season}-${number}`, id, season, number, `${number}화`, 1200);
  }
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', viewer, 'series-1-5', 100, 1200, 0, '2026-11-01');
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', viewer, 'series-2-1', 1200, 1200, 1, '2026-11-02');
  // Resuming an older episode most recently must not revive already-passed episodes as new.
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', viewer, 'series-1-1', 100, 1200, 0, '2026-11-03');
  for (const [id, changed] of [['series', Date.parse('2026-11-18')], ['old', Date.parse('2026-11-01')]] as const) {
    const ids = db.all('SELECT id FROM episodes WHERE media_id=?', id).map(row => row.id);
    db.run('INSERT INTO source_detail_observations(media_id,fingerprint,episode_count,last_episode_id,changed_at,observed_at,completed,reset_until,episode_ids,episodes_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, id, 5, `${id}-2-3`, changed, Date.now(), 0, 0, JSON.stringify(ids), changed);
  }
  const read = (profile = viewer, suffix = '') => app.inject({ url: '/api/watchlist' + suffix, headers: { 'x-moa-profile': profile } });
  const cards = (await read()).json();
  assert.equal(cards.find((card: any) => card.id === 'series').unseenEpisodeCount, 1);
  assert.ok(!cards.find((card: any) => card.id === 'old').unseenEpisodeCount, 'unwatched saved titles have no new episode badge');
  assert.ok(!(await read(other)).json().find((card: any) => card.id === 'series').unseenEpisodeCount);
  for (const id of ['movie', 'live']) {
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', viewer, `${id}-1-1`, 1200, 1200, 1, '2026-11-02');
    assert.ok(!(await read()).json().find((card: any) => card.id === id).unseenEpisodeCount);
  }
  assert.equal((await read()).json()[0].id, 'old', 'default order remains the time saved');
  const updated = (await read(viewer, '?sort=updated')).json();
  assert.equal(updated[0].id, 'series');
  assert.equal(updated[0].episodesUpdatedAt, '2026-11-18T00:00:00.000Z');
  const status = await app.inject({ url: '/api/watchlist/refresh-status', headers: { 'x-moa-profile': viewer } });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(typeof status.json().running, 'boolean');
});
