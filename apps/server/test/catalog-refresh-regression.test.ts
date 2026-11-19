import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { Catalog } from '../src/catalog/service.js';
import { TitleGroups } from '../src/catalog/title-groups.js';
import { Store } from '../src/db.js';
import { WatchlistRefresh } from '../src/profiles/watchlist-refresh.js';
import type { invokeMangayomi } from '../src/sources/extensions/index.js';
import { Sources } from '../src/sources/service.js';
import { setCatalogRefreshSettings } from '../src/system/catalog-refresh.js';

const workDirectory = () => mkdtemp(join(process.env.MOA_TEST_TMPDIR || tmpdir(), 'moa-refresh-regression-'));

function seedSource(db: Store, id: string) {
  const entry = JSON.stringify({ id, name: id, version: '1', format: 'mangayomi-js', baseUrl: 'https://fixture.invalid' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', id, 'https://fixture.invalid/index.json', entry, entry, 'fixture');
}

test('HTTP My List uses the watched edition’s observed additions and excludes withdrawn episodes', async t => {
  const dir = await workDirectory();
  const { app, db, sources } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: dir }, false, { tmdb: { token: '', key: '' } });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true });
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(base + path, init);
    if (!response.ok) assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  async function newProfile(name: string) {
    return request('/api/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  }

  const viewer = (await newProfile('Viewer')).id;
  const other = (await newProfile('Other')).id;
  const viewerHeaders = { 'x-moa-profile': viewer };
  let chapters = [1, 2];
  const list = (id: string) => ({ list: [{ name: id + ' Fixture Series', link: '/title/' + id }], hasNextPage: false });
  t.mock.method(sources as unknown as { runtime: typeof invokeMangayomi }, 'runtime', async input => {
    const id = input.entry.id;
    return { result: input.action === 'list' ? list(id) : { name: id + ' Fixture Series', chapters: chapters.map(number => ({ name: `${number}화`, number, url: '/episode/' + number })) }, changes: {} };
  });
  seedSource(db, 'saved');
  seedSource(db, 'watched');
  const saved = (await sources.browse('saved', viewer)).items[0].id;
  const watched = (await sources.browse('watched', viewer)).items[0].id;
  for (const profile of [viewer, other]) {
    for (const id of [saved, watched]) db.run('INSERT INTO title_group_overrides VALUES(?,?,?)', profile, id, 'manual:fixture');
    await request('/api/watchlist/' + saved, { method: 'PUT', headers: { 'x-moa-profile': profile } });
  }
  const refresh = (id: string) => request('/api/media/' + id + '/refresh', { method: 'POST', headers: viewerHeaders });
  await refresh(saved);
  const first = await refresh(watched);
  assert.deepEqual(first.errors, []);
  const watchedEpisode = first.detail.seasons[0].episodes.find(episode => episode.number === 2);
  await request('/api/progress', { method: 'POST', headers: { ...viewerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ episodeId: watchedEpisode.id, position: 1200, duration: 1200 }) });
  const myList = async (profile = viewer) => (await request('/api/watchlist?sort=updated', { headers: { 'x-moa-profile': profile } }))[0];
  const baseline = await myList();
  assert.equal(baseline.id, saved);
  assert.equal(baseline.resumeMediaId, watched, 'the fully watched edition remains the comparison and click target');
  assert.equal(baseline.watchlistMediaId, saved);
  assert.equal((await request('/api/media/' + watched, { headers: viewerHeaders })).inWatchlist, false);
  const groupedToggle = '/api/watchlist/' + watched + '/group?savedEdition=' + baseline.watchlistMediaId;
  assert.deepEqual(await request(groupedToggle, { headers: viewerHeaders }), { grouped: true, inWatchlist: true });
  await request('/api/watchlist/' + watched, { method: 'PUT', headers: viewerHeaders });
  assert.equal((await myList()).groupMemberIds.length, 2);
  await request(groupedToggle, { method: 'DELETE', headers: viewerHeaders });
  assert.deepEqual(await request(groupedToggle, { headers: viewerHeaders }), { grouped: true, inWatchlist: false });
  assert.equal(await myList(), undefined);
  assert.equal((await myList(other)).id, saved);
  await request(groupedToggle, { method: 'PUT', headers: viewerHeaders });
  assert.deepEqual((await myList()).groupMemberIds, [saved]);
  await request('/api/media/' + watched + '/group', { method: 'PATCH', headers: { 'x-moa-profile': other, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'separate' }) });
  assert.deepEqual(await request(groupedToggle, { headers: { 'x-moa-profile': other } }), { grouped: false, inWatchlist: false });
  const stale = await fetch(base + groupedToggle, { method: 'DELETE', headers: { 'x-moa-profile': other } });
  assert.equal(stale.status, 409);
  assert.equal((await myList(other)).id, saved);
  assert.equal(baseline.episodesUpdatedAt, undefined);
  assert.equal(baseline.unseenEpisodeCount, undefined);

  chapters = [1, 2, 3, 4];
  await refresh(saved);
  assert.equal((await myList()).episodesUpdatedAt, undefined, 'the saved edition must not supply the watched edition’s update timestamp');
  assert.equal((await myList()).unseenEpisodeCount, undefined);
  await refresh(watched);
  const added = await myList();
  assert.equal(added.unseenEpisodeCount, 2);
  assert.ok(added.episodesUpdatedAt);
  assert.equal((await myList(other)).unseenEpisodeCount, undefined);

  chapters = [1, 2, 4];
  await refresh(watched);
  const withdrawn = await myList();
  assert.equal(withdrawn.unseenEpisodeCount, 1);
  assert.equal(withdrawn.episodesUpdatedAt, added.episodesUpdatedAt, 'a removal does not move the title up the update sort');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM episodes WHERE media_id=?', watched)?.n, 4, 'withdrawn catalog rows can remain for playback history');
  await sources.diagnose('watched', viewer);
  assert.equal((await myList()).episodesUpdatedAt, added.episodesUpdatedAt);
  assert.equal((await myList()).unseenEpisodeCount, 1);
  await refresh(watched);
  assert.equal((await myList()).episodesUpdatedAt, added.episodesUpdatedAt, 'an unchanged recheck preserves update sort');
  chapters.push(5);
  // Use a fixed older instant to distinguish a real post-invalidation addition from a same-millisecond rewrite.
  db.run('UPDATE source_detail_observations SET episodes_updated_at=1 WHERE media_id=?', watched);
  sources.invalidate('watched');
  await refresh(watched);
  assert.notEqual((await myList()).episodesUpdatedAt, new Date(1).toISOString());
  assert.equal((await myList()).unseenEpisodeCount, 2);
  await sources.remove(['watched']);
  assert.equal(db.get('SELECT 1 FROM source_detail_observations WHERE media_id=?', watched), undefined);
});

test('successful source listings drive detail, resume and playback while keeping history and saved media', async t => {
  const dir = await workDirectory();
  const downloadRoot = join(dir, 'downloads'), mediaRoot = join(dir, 'media');
  await Promise.all([downloadRoot, mediaRoot].map(path => mkdir(path)));
  const { app, db, sources, downloads } = await buildApp({ dataDir: join(dir, 'data'), downloadRoot, mediaRoot, webDir: dir }, false, { tmdb: { token: '', key: '' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  const profile = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
  const headers = { 'x-moa-profile': profile };
  let chapters: number[] | null = [1, 2, 3, 4];
  let invalidListing: unknown[] | undefined;
  t.mock.method(sources as unknown as { runtime: typeof invokeMangayomi }, 'runtime', async input => {
    if (input.action === 'list') return { result: { list: [{ name: 'Synthetic series', link: '/series' }], hasNextPage: false }, changes: {} };
    if (input.action === 'videos') return { result: [{ url: 'https://fixture.invalid/stream.mp4' }], changes: {} };
    return { result: { name: 'Synthetic series', chapters: invalidListing ?? chapters?.map(number => ({ number, name: number + '화', url: '/episode/' + number })) }, changes: {} };
  });
  seedSource(db, 'fixture');
  const id = (await sources.browse('fixture', profile)).items[0].id;
  const detail = () => app.inject({ url: '/api/media/' + id, headers }).then(r => r.json());
  const refresh = () => app.inject({ method: 'POST', url: '/api/media/' + id + '/refresh', headers }).then(r => r.json());
  const ongoing = async () => (await app.inject({ url: '/api/home', headers })).json().rows.find(row => row.id === 'continue')?.items[0]?.resume;
  const first = await detail(), [one, two, three, four] = first.seasons[0].episodes;
  const activity = (episodeId: string, position: number) => app.inject({ method: 'POST', url: '/api/progress', headers, payload: { episodeId, position, duration: 1200 } });
  assert.equal((await activity(two.id, 1200)).statusCode, 200);
  const job = randomUUID(), relative = 'job-' + job + '/video.mp4', bytes = 'synthetic saved media';
  const probe = { duration: 1200, container: 'mov,mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] };
  await mkdir(join(downloadRoot, 'job-' + job));
  await writeFile(join(downloadRoot, relative), bytes);
  db.run('INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    job, three.id, id, 'fixture', profile, 'ready', '720p', 'synthetic', '2026', '2026');
  db.run('INSERT INTO download_assets VALUES(?,?,?,?,?,?)', three.id, job, relative, bytes.length, JSON.stringify(probe), '[]');
  const observed = () => db.get('SELECT * FROM source_detail_observations WHERE media_id=?', id);
  const firstObservation = observed();
  const valid = { name: '1화', url: '/episode/1' };
  for (const partial of [[valid, null], [valid, { name: '2화', url: '  ' }], [valid, { url: 123 }], [valid, { url: 'x'.repeat(16_385) }], Array(10_001).fill(valid)]) {
    invalidListing = partial;
    const failed = await refresh();
    assert.deepEqual(failed.errors, ['source']);
    assert.deepEqual(failed.detail.seasons[0].episodes.map(ep => ep.id), [one.id, two.id, three.id, four.id]);
    assert.deepEqual(observed(), firstObservation);
  }
  invalidListing = undefined;
  chapters = [1, 2, 4];
  const removed = await refresh();
  assert.deepEqual(removed.errors, []);
  for (const title of [removed.detail, await detail()]) {
    assert.equal(title.episodeCount, 3);
    assert.deepEqual(title.seasons[0].episodes.map(ep => ep.id), [one.id, two.id, four.id]);
    assert.equal(title.playTarget.episodeId, four.id);
  }
  assert.equal((await ongoing()).episodeId, four.id);
  await downloads.configureSettings({ enabled: true, quotaBytes: 1024 ** 3 });
  const batch = await app.inject({ url: '/api/admin/downloads/batch?mediaId=' + id, headers });
  assert.deepEqual(batch.json(), { total: 3, eligible: 3, skipped: 0 });
  const play = (episodeId: string, location: string) => app.inject({ method: 'POST', url: '/api/playback', headers,
    payload: { episodeId, location, capabilities: { h264: true, hevc: false, av1: false } } });
  assert.equal((await play(two.id, 'source')).json().next.episodeId, four.id);
  assert.equal((await play(three.id, 'source')).statusCode, 404);
  const asset = (await play(three.id, 'saved')).json();
  assert.equal(asset.saved, true);
  assert.equal(asset.next.episodeId, four.id);
  assert.equal((await app.inject({ url: asset.url, headers })).body, bytes);
  assert.equal((await activity(three.id, 300)).statusCode, 200);
  assert.equal((await ongoing()).episodeId, four.id, 'a withdrawn episode can anchor the next available episode');
  const history = (await app.inject({ url: '/api/history', headers })).json();
  assert.equal(history.items[0].episode.id, three.id);
  assert.equal(history.items[0].episode.progress.position, 300);

  await sources.diagnose('fixture', profile);
  invalidListing = [{ name: '1화', url: '/episode/1' }, { name: '2화' }];
  const failed = await refresh();
  assert.deepEqual(failed.errors, ['source']);
  assert.deepEqual(failed.detail.seasons[0].episodes.map(ep => ep.id), [one.id, two.id, four.id]);
  const visitor = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Visitor' } })).json().id;
  const visitorHeaders = { 'x-moa-profile': visitor };
  const cached = await app.inject({ url: '/api/media/' + id, headers: visitorHeaders });
  assert.equal(cached.statusCode, 200);
  assert.deepEqual(cached.json().seasons[0].episodes.map(ep => ep.id), [one.id, two.id, four.id]);
  const playing = await app.inject({ method: 'POST', url: '/api/playback', headers: visitorHeaders,
    payload: { episodeId: two.id, location: 'source', capabilities: { h264: true, hevc: false, av1: false } } });
  assert.equal(playing.statusCode, 200, playing.body);
  invalidListing = undefined;
  chapters = [];
  const empty = await refresh();
  assert.deepEqual(empty.errors, []);
  for (const title of [empty.detail, await detail()]) {
    assert.equal(title.episodeCount, 0);
    assert.deepEqual(title.seasons, []);
    assert.equal(title.playTarget, null);
  }
  assert.equal(await ongoing(), undefined);
  assert.equal((await play(three.id, 'saved')).json().next, null);
  sources.invalidate('fixture');
  chapters = null;
  assert.deepEqual((await refresh()).errors, ['source']);
  const lastEmpty = await app.inject({ url: '/api/media/' + id, headers: visitorHeaders });
  assert.equal(lastEmpty.statusCode, 200);
  assert.deepEqual(lastEmpty.json().seasons, []);
  chapters = [1, 2, 3, 4];
  const restored = (await refresh()).detail;
  assert.equal(restored.playTarget.episodeId, three.id);
  assert.equal(restored.playTarget.position, 300);
});

test('existing listing snapshots restore availability on upgrade and survive restart', async t => {
  const dir = await workDirectory();
  let db = new Store(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true }); });
  db.db.exec(`CREATE TABLE source_detail_observations(media_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    episode_count INTEGER NOT NULL, last_episode_id TEXT, changed_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
    completed INTEGER NOT NULL, reset_until INTEGER DEFAULT 0, episode_ids TEXT, episodes_updated_at INTEGER)`);
  for (const id of ['partial', 'empty', 'unknown']) {
    db.run("INSERT INTO media VALUES(?,NULL,?,'series','{}','2026')", id, id);
    for (const number of [1, 2]) db.run("INSERT INTO episodes VALUES(?,?,1,?,'Fixture',1200,NULL)", id + number, id, number);
  }
  db.run("INSERT INTO source_detail_observations VALUES('partial','old',1,NULL,0,0,0,0,?,NULL)", '["partial2"]');
  db.run("INSERT INTO source_detail_observations VALUES('empty','old',0,NULL,0,0,0,0,'[]',NULL)");
  db.run("INSERT INTO source_detail_observations VALUES('unknown','old',1,NULL,0,0,0,0,NULL,NULL)");
  for (let i = 0; i < 2; i++) {
    const catalog = new Catalog(db);
    assert.deepEqual(catalog.episodes('partial', 'viewer').map(e => e.number), [2]);
    assert.deepEqual(catalog.episodes('empty', 'viewer'), []);
    assert.deepEqual(catalog.episodes('unknown', 'viewer').map(e => e.number), [1, 2]);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM episodes')?.n, 6);
    db.close();
    db = new Store(dir);
  }
});

test('catalog and search only report active TMDB work for eligible titles', async t => {
  const dir = await workDirectory();
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(done => { release = done; });
  const { app, db } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: dir }, false, { tmdb: { token: 'synthetic', fetch: async () => {
    calls++;
    await gate;
    return Response.json({ results: [] });
  } } });
  t.after(async () => { release(); await app.close(); await rm(dir, { recursive: true }); });
  const profile = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
  const read = async (path: string) => {
    const r = await app.inject({ url: path, headers: { 'x-moa-profile': profile } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  for (const [title, live] of [['Fixture live', true], ['Fixture truncated...', false], ['Fixture clipped…', false]]) {
    db.run("INSERT INTO media VALUES(?,NULL,?,'series',?,'2026')", title, title, JSON.stringify({ live }));
  }
  for (let i = 0; i < 2; i++) for (const path of ['/api/media', '/api/search?q=Fixture']) assert.equal((await read(path)).refreshing, false);
  assert.equal(calls, 0);
  db.run("INSERT INTO media VALUES('eligible',NULL,'Fixture eligible','series','{}','2026')");
  for (const path of ['/api/media', '/api/search?q=Fixture']) assert.equal((await read(path)).refreshing, true);
  assert.ok(calls > 0);
  assert.equal((await read('/api/search?q=truncated')).refreshing, false, 'unrelated pending work stays scoped to its media');
  release();
  for (let i = 0; i < 100 && !db.get("SELECT 1 FROM tmdb_links WHERE media_id='eligible'"); i++) await setTimeout(5);
  for (const path of ['/api/media', '/api/search?q=Fixture']) assert.equal((await read(path)).refreshing, false);
});

test('watchlist scheduler queues other profiles, skips removals and respects changed cooldowns', async t => {
  const dir = await workDirectory();
  const db = new Store(dir);
  const catalog = new Catalog(db);
  const sources = new Sources(db, catalog);
  const groups = new TitleGroups(catalog);
  let now = 6_000_000;
  const scheduler = new WatchlistRefresh(db, sources, groups, () => now);
  let release: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => {
    release();
    await scheduler.close();
    await sources.close();
    db.close();
    await rm(dir, { recursive: true });
  });

  seedSource(db, 'fixture');
  setCatalogRefreshSettings(db, 1);
  for (const profile of ['viewer', 'other']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,0,?)', profile, profile, 'blue', '2026');
  for (const [id, profile] of [['first', 'viewer'], ['removed', 'viewer'], ['retry', 'other']]) {
    db.run("INSERT INTO media VALUES(?,NULL,?,'series','{}','2026')", id, id);
    db.run('INSERT INTO source_media VALUES(?,?,?,?)', id, 'fixture', 'https://fixture.invalid/' + id, now - 120_000);
    db.run('INSERT INTO episodes VALUES(?,?,1,1,?,1200,NULL)', id + '-1', id, '1화');
    db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, id, '2026');
    db.run('INSERT INTO progress VALUES(?,?,1200,1200,1,?)', profile, id + '-1', '2026');
  }

  const started: string[] = [];
  t.mock.method(sources, 'detail', async (id: string, force: boolean) => {
    assert.equal(force, true);
    started.push(id);
    if (id === 'first') await held;
    if (id === 'retry') throw Error('fixture offline');
    db.run('UPDATE source_media SET detail_at=? WHERE media_id=?', now, id);
  });
  const viewerStart = scheduler.request('viewer');
  scheduler.request('viewer');
  await setImmediate();
  assert.deepEqual(started, ['first']);
  assert.equal(viewerStart.running, true);
  assert.deepEqual(scheduler.request('viewer'), viewerStart);
  const otherStart = scheduler.request('other');
  assert.equal(otherStart.running, true);
  db.run('DELETE FROM watchlist WHERE media_id=?', 'removed');
  release!();
  await setImmediate();
  assert.deepEqual(started, ['first', 'retry']);
  assert.equal(scheduler.request('viewer').running, false);
  assert.notEqual(scheduler.request('viewer').revision, viewerStart.revision, 'the visible saved title was removed');
  assert.deepEqual(scheduler.request('other'), { ...otherStart, running: false }, 'failures do not change the catalog token');

  now += 59_999;
  scheduler.request('other');
  await setImmediate();
  assert.deepEqual(started, ['first', 'retry']);
  now++;
  setCatalogRefreshSettings(db, 2);
  scheduler.request('other');
  await setImmediate();
  assert.deepEqual(started, ['first', 'retry']);
  now += 60_000;
  scheduler.request('other');
  await setImmediate();
  assert.deepEqual(started, ['first', 'retry', 'retry']);
  assert.deepEqual(scheduler.request('other'), { ...otherStart, running: false });
});

test('an open list detects another viewer’s shared episode changes, independently of batch ownership and restart', async t => {
  const dir = await workDirectory();
  let db = new Store(dir), now = Date.now();
  let chapters = [1], detailReads = 0;
  function open() {
    const catalog = new Catalog(db);
    const sources = new Sources(db, catalog, async input => {
      if (input.action === 'list') return { result: { list: [{ name: 'First', link: '/first' }, { name: 'Second', link: '/second' }], hasNextPage: false }, changes: {} };
      detailReads++;
      return { result: { chapters: chapters.map(number => ({ name: number + '화', url: '/e/' + number })) }, changes: {} };
    });
    return { sources, scheduler: new WatchlistRefresh(db, sources, new TitleGroups(catalog), () => now) };
  }
  let { sources, scheduler } = open();
  const close = async () => { await scheduler.close(); await sources.close(); db.close(); };
  t.after(async () => { await close(); await rm(dir, { recursive: true }); });
  seedSource(db, 'fixture');
  for (const id of ['alice', 'bob', 'other', 'kid', 'unwatched']) {
    db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', id, id, 'blue', Number(id === 'kid'), '2026');
  }
  const [first, second] = (await sources.browse('fixture', 'alice')).items.map(item => item.id);
  await sources.detail(first);
  await sources.detail(second);
  for (const profile of ['alice', 'bob', 'other', 'kid', 'unwatched']) {
    for (const id of [first, second]) db.run('INSERT INTO title_group_overrides VALUES(?,?,?)', profile, id, 'manual:group');
    db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, profile === 'unwatched' ? first : second, '2026');
    if (profile !== 'unwatched') {
      const edition = profile === 'other' ? second : first;
      const episode = db.get('SELECT id FROM episodes WHERE media_id=?', edition)!.id;
      db.run('INSERT INTO progress VALUES(?,?,300,1200,0,?)', profile, episode, '2026');
    }
  }
  // A legacy detail can already contain progress before a first complete observation.
  db.run('DELETE FROM source_detail_observations WHERE media_id=?', first);
  const poll = (profile: string) => scheduler.request(profile);
  const before = Object.fromEntries(['alice', 'bob', 'other', 'kid', 'unwatched'].map(id => [id, poll(id).revision]));
  db.run('UPDATE source_media SET detail_at=0 WHERE media_id=?', first);
  now += 60_001;
  chapters = [1, 2];
  assert.equal(poll('alice').running, true);
  await setImmediate();
  assert.equal(detailReads, 3);
  const bob = poll('bob');
  assert.equal(bob.running, false, 'the other viewer visits after the sole upstream check has finished');
  assert.notEqual(bob.revision, before.bob, 'a first complete baseline changes the visible badge');
  assert.notEqual(poll('unwatched').revision, before.unwatched, 'the saved representative is used without watch history');
  assert.equal(poll('other').revision, before.other, 'the same group with a different watched edition is independent');
  assert.equal(poll('kid').revision, before.kid);
  assert.equal(detailReads, 3, 'no duplicate read for observers');
  await sources.detail(first, true);
  assert.deepEqual(poll('bob'), bob, 'an identical manual recheck does not invalidate the list');
  chapters = [1];
  await sources.detail(first, true);
  const removed = poll('bob');
  assert.notEqual(removed.revision, bob.revision, 'withdrawals change the token even without a last-addition timestamp');
  assert.equal(poll('other').revision, before.other);
  assert.equal(poll('kid').revision, before.kid);
  await close();
  db = new Store(dir);
  ({ sources, scheduler } = open());
  assert.deepEqual(poll('bob'), removed, 'a tab can compare its prior token after a server restart');
  chapters = [1, 3];
  await sources.detail(first, true);
  assert.notEqual(poll('bob').revision, removed.revision);
  assert.equal(poll('kid').revision, before.kid);
});

test('HTTP source browse and detail signal ongoing work while retaining the cached result', async t => {
  const dir = await workDirectory();
  const { app, db, sources } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: dir }, false, { tmdb: { token: '', key: '' } });
  let release = () => {};
  t.after(async () => {
    release();
    await app.close();
    await rm(dir, { recursive: true });
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const profile = await fetch(address + '/api/profiles', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Viewer' }) }).then(response => response.json());
  async function get(path: string) {
    const response = await fetch(address + path, { headers: { 'x-moa-profile': profile.id }, signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
    return response.json();
  }
  let gate: Promise<void> | undefined;
  let listCalls = 0;
  let detailCalls = 0;
  t.mock.method(sources as unknown as { runtime: typeof invokeMangayomi }, 'runtime', async input => {
    if (input.action === 'list') {
      listCalls++;
      await gate;
      return { result: { list: [{ name: gate ? 'Updated list' : 'Saved list', link: '/title' }], hasNextPage: false }, changes: {} };
    }
    assert.equal(input.action, 'detail');
    detailCalls++;
    await gate;
    const chapters = [{ name: '1화', url: '/episode/1' }, ...(gate ? [{ name: '2화', url: '/episode/2' }] : [])];
    return { result: { chapters }, changes: {} };
  });
  seedSource(db, 'fixture');
  const browse = '/api/sources/fixture/browse';
  const firstList = await get(browse);
  const detail = '/api/media/' + firstList.items[0].id;
  assert.equal(firstList.items[0].title, 'Saved list');
  assert.equal((await get(detail)).seasons[0].episodes.length, 1);
  db.run('UPDATE source_read_cache SET fetched=?', Date.now() - 10 * 86_400_000);

  gate = new Promise(resolve => { release = resolve; });
  const oldLists = await Promise.all(Array.from({ length: 6 }, () => get(browse)));
  assert.ok(oldLists.every(page => page.items[0].title === 'Saved list' && page.refreshing));
  const oldDetails = await Promise.all(Array.from({ length: 6 }, () => get(detail)));
  assert.ok(oldDetails.every(title => title.seasons[0].episodes.length === 1 && title.refreshing));
  assert.equal(listCalls, 2);

  release();
  for (let i = 0; i < 100 && sources.detailRefreshing(firstList.items[0].id); i++) await setTimeout(10);
  assert.equal(sources.detailRefreshing(firstList.items[0].id), false, 'stale detail refresh settled');
  const freshList = await get(browse);
  assert.equal(freshList.items[0].title, 'Updated list');
  assert.equal(freshList.refreshing, false);
  const freshDetail = await get(detail);
  assert.equal(freshDetail.seasons[0].episodes.length, 2);
  assert.equal(freshDetail.refreshing, false);
  assert.equal(listCalls, 2);
  assert.equal(detailCalls, 2);
});

test('watchlist checks use completed-title freshness and share the per-minute budget across profiles', async t => {
  const dir = await workDirectory(), db = new Store(dir), catalog = new Catalog(db);
  const sources = new Sources(db, catalog), groups = new TitleGroups(catalog);
  const now = Date.now(), hour = 3_600_000;
  const scheduler = new WatchlistRefresh(db, sources, groups, () => now);
  t.after(async () => {
    await scheduler.close();
    await sources.close();
    db.close();
    await rm(dir, { recursive: true });
  });
  seedSource(db, 'fixture');
  for (const profile of ['alice', 'bob']) {
    db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,0,?)', profile, profile, 'blue', '2026');
    for (let i = 0; i < 16; i++) {
      const id = profile + String(i).padStart(2, '0');
      db.run("INSERT INTO media VALUES(?,NULL,?,'series','{}','2026')", id, id);
      db.run('INSERT INTO source_media VALUES(?,?,?,?)', id, 'fixture', '/title/' + id, now - 2 * hour);
      db.run('INSERT INTO episodes VALUES(?,?,1,1,?,1200,NULL)', id + '-1', id, '1화');
      db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, id, '2026');
      db.run('INSERT INTO progress VALUES(?,?,1200,1200,1,?)', profile, id + '-1', '2026');
      if (i === 0) {
        db.run(`INSERT INTO source_detail_observations(media_id,fingerprint,episode_count,changed_at,observed_at,completed)
          VALUES(?,?,1,?,?,1)`, id, id, now - 30 * 24 * hour, now - 2 * hour);
      }
    }
  }
  const started: string[] = [];
  t.mock.method(sources, 'detail', async (id: string) => {
    started.push(id);
    db.run('UPDATE source_media SET detail_at=? WHERE media_id=?', now, id);
  });
  scheduler.request('alice');
  scheduler.request('bob');
  await setImmediate();
  assert.equal(started.length, 20);
  assert.equal(started.filter(id => id.startsWith('alice')).length, 10);
  assert.equal(started.filter(id => id.startsWith('bob')).length, 10);
  assert.ok(!started.some(id => id.endsWith('00')), 'stable completed shows are still fresh after two hours');
});
