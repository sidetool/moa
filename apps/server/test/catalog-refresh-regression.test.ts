import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  scheduler.request('viewer');
  scheduler.request('viewer');
  await setImmediate();
  assert.deepEqual(started, ['first']);
  assert.deepEqual(scheduler.status('viewer'), { running: true, revision: 0 });
  scheduler.request('other');
  assert.deepEqual(scheduler.status('other'), { running: true, revision: 0 });
  db.run('DELETE FROM watchlist WHERE media_id=?', 'removed');
  release!();
  await setImmediate();
  assert.deepEqual(started, ['first', 'retry']);
  assert.deepEqual(scheduler.status('viewer'), { running: false, revision: 1 });
  assert.deepEqual(scheduler.status('other'), { running: false, revision: 1 });

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
  assert.deepEqual(scheduler.status('other'), { running: false, revision: 2 });
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
  const dir = await workDirectory(t), db = new Store(dir), catalog = new Catalog(db);
  const sources = new Sources(db, catalog), groups = new TitleGroups(catalog);
  const now = Date.now(), hour = 3_600_000;
  const scheduler = new WatchlistRefresh(db, sources, groups, () => now);
  t.after(async () => { await scheduler.close(); await sources.close(); db.close(); });
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
