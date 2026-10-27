import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';

const admin = { 'x-moa-account': 'admin', 'x-moa-role': 'admin' };
const member = { 'x-moa-account': 'member', 'x-moa-role': 'member' };
const tab = (ids = ['s']) => [{ id: 'home', name: '홈', sourceIds: ids, includeLocal: false }];
function seedSource(db: Store, id: string) {
  const entry = JSON.stringify({ id, name: id, version: '1', baseUrl: 'https://example.test' });
  db.run('INSERT OR IGNORE INTO source_repositories(url) VALUES(?)', 'https://repo.test/index.json');
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', id, 'https://repo.test/index.json', entry, entry, 'fixture');
}

test('admin removal: preview, all-or-nothing validation, FK cleanup, sessions, navigation and retained registry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-source-admin-'));
  const { app, db, sources, remotePlayback, online } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true }, false);
  try {
    const p = (await app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Admin' } })).json().id;
    const q = (await app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Member' } })).json().id;
    const h = { ...admin, 'x-moa-profile': p };
    seedSource(db, 's'); seedSource(db, 'other');
    for (const id of ['s', 'other', 'local']) {
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id, 'series', '{}', '2026');
      db.run('INSERT INTO episodes VALUES(?,?,1,1,?,100,NULL)', `e-${id}`, id, id);
      if (id !== 'local') {
        db.run('INSERT INTO source_media VALUES(?,?,?,0)', id, id, '/show');
        db.run('INSERT INTO source_episodes VALUES(?,?)', `e-${id}`, '/ep');
      }
      db.run('INSERT INTO progress VALUES(?,?,20,100,0,?)', q, `e-${id}`, '2026');
      db.run('INSERT INTO watchlist VALUES(?,?,?)', p, id, '2026');
      db.run('INSERT INTO title_group_overrides VALUES(?,?,?)', q, id, 'group');
      db.run("INSERT INTO tmdb_links(media_id,status,checked_at) VALUES(?,'none',0)", id);
      db.run('INSERT INTO tmdb_match_versions VALUES(?,1)', id);
      db.run('INSERT INTO online_subtitles VALUES(?,?,?,?,?,?,?,?,?)', id, `e-${id}`, 'test', 'https://test', 'vtt', 'WEBVTT', id, id, 0);
      db.run('INSERT INTO episode_skip_markers VALUES(?,?,?,?,?,?,?,?)', `e-${id}`, 'test', '[]', '', 0, 0, null, 0);
    }
    db.run('INSERT INTO source_backups VALUES(?,?,?,?,?)', 's', '{}', 'old', 'hash', '{}');
    db.run('INSERT INTO source_health VALUES(?,1,?,?,NULL)', 's', '2026', 'check');
    db.run("UPDATE source_entries SET preferences='{\"secret\":\"value\"}' WHERE id='s'");
    for (const id of [p, q]) db.run('INSERT INTO settings VALUES(?,?)', id, JSON.stringify({ autoplayDelay: 17, navigation: [{ ...tab(['s', 'other'])[0], sourceFilters: { s: { revision: '1', filters: [] } } }] }));
    db.saveDefaultNavigation(tab(['s', 'other']));
    db.run("INSERT INTO source_images VALUES('owned','https://test/owned','{}'),('shared','https://test/shared','{}')");
    db.run("INSERT INTO source_image_owners VALUES('s','owned'),('s','shared'),('other','shared')");
    await mkdir(path.join(dir, 'images'));
    await writeFile(path.join(dir, 'images', 'owned-960.webp'), 'cached');
    await writeFile(path.join(dir, 'images', 'shared-960.webp'), 'shared');
    const abort = new AbortController();
    remotePlayback.sessions.set('remote', { profile: q, abort, response: { episodeId: 'e-s' } } as any);
    (online as any).assets.set('asset', { profileId: q, episodeId: 'e-s' });
    (online as any).searches.set('search', { profileId: q, episodeId: 'e-s' });
    for (const [method, url] of [['GET', '/api/sources/s/removal-impact'], ['HEAD', '/api/sources/s/removal-impact'], ['DELETE', '/api/sources/s'], ['POST', '/api/sources/remove'], ['GET', '/api/admin/default-navigation'], ['HEAD', '/api/admin/default-navigation'], ['PUT', '/api/admin/default-navigation']]) {
      for (const headers of [member, { ...member, 'x-moa-profile': q }]) assert.equal((await app.inject({ method: method as 'GET', url, headers })).statusCode, 403, `${method} ${url}`);
    }
    const impact = { mediaCount: 1, episodeCount: 1, progressCount: 1, watchlistCount: 1, profilesAffected: 2 };
    assert.deepEqual((await app.inject({ url: '/api/sources/s/removal-impact', headers: h })).json(), impact);
    for (const ids of [['s', 'local'], ['s', 'missing'], []]) {
      const r = await app.inject({ method: 'POST', url: '/api/sources/remove', headers: h, payload: { ids } });
      assert.equal(r.statusCode, ids.includes('missing') ? 404 : 400);
      assert.ok(sources.row('s').code);
    }
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sources/local', headers: h })).statusCode, 400);
    sources.configure('s', { enabled: false });
    const removed = await app.inject({ method: 'POST', url: '/api/sources/remove', headers: h, payload: { ids: ['s', 's'] } });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(removed.json(), { removedIds: ['s'], impact });
    for (const table of ['media', 'episodes', 'progress', 'watchlist', 'title_group_overrides', 'tmdb_links', 'tmdb_match_versions', 'online_subtitles', 'episode_skip_markers']) assert.equal(db.get(`SELECT count(*) AS n FROM ${table}`)!.n, 2, table);
    for (const table of ['source_backups', 'source_health']) assert.equal(db.get(`SELECT count(*) AS n FROM ${table}`)!.n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM source_episodes')!.n, 1);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(abort.signal.aborted, true); assert.equal(remotePlayback.sessions.size, 0);
    assert.equal(online.assetProfile('asset'), undefined); assert.equal((online as any).searches.size, 0);
    assert.equal(db.get("SELECT 1 FROM source_images WHERE id='owned'"), undefined);
    assert.ok(db.get("SELECT 1 FROM source_images WHERE id='shared'"));
    await assert.rejects(access(path.join(dir, 'images', 'owned-960.webp')));
    await access(path.join(dir, 'images', 'shared-960.webp'));
    for (const id of [p, q]) {
      assert.deepEqual(db.settings(id).navigation![0].sourceIds, ['other']);
      assert.deepEqual(db.settings(id).navigation![0].sourceFilters, {});
      assert.equal(db.settings(id).autoplayDelay, 17);
    }
    assert.deepEqual(db.defaultNavigation(), tab(['other']));
    const uninstalled = sources.list().find(s => s.id === 's')!;
    assert.equal(uninstalled.installed, false); assert.equal(uninstalled.enabled, false);
    assert.equal(uninstalled.installedVersion, undefined); assert.equal(sources.row('s', false).preferences, '{}');
    assert.equal(sources.repositories().length, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sources/s', headers: h })).statusCode, 200);
    const bulk = await app.inject({ method: 'POST', url: '/api/sources/remove', headers: h, payload: { ids: ['s', 'other'] } });
    assert.equal(bulk.statusCode, 200); assert.equal(bulk.json().impact.mediaCount, 1);
    assert.ok(db.get("SELECT 1 FROM media WHERE id='local'"));
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('default navigation validation, account-wide new profile snapshots, copy ownership, disable cleanup and restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-default-nav-'));
  const cfg = { dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true };
  let instance = await buildApp(cfg, false);
  try {
    let { app, db, sources } = instance;
    const create = (headers: typeof admin) => app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Profile' } });
    const p = (await create(admin)).json().id;
    const q = (await create(member)).json().id;
    seedSource(db, 's');
    const put = (payload: unknown, headers = admin) => app.inject({ method: 'PUT', url: '/api/admin/default-navigation', headers, payload: payload as any });
    assert.deepEqual((await app.inject({ url: '/api/admin/default-navigation', headers: admin })).json(), { navigation: null });
    for (const navigation of [[], [{ ...tab()[0], id: 'wrong' }], [...tab(), ...tab()], [{ ...tab()[0], sourceIds: ['s', 's'] }], [{ ...tab()[0], name: ' ' }]]) {
      assert.equal((await put({ navigation })).statusCode, 400);
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...admin, 'x-moa-profile': p }, payload: { navigation } })).statusCode, 400);
    }
    for (const payload of [{}, { fromProfile: false }, { fromProfile: true, navigation: null }]) assert.equal((await put(payload)).statusCode, 400);
    assert.equal((await put({ fromProfile: true })).statusCode, 401);
    assert.equal((await put({ fromProfile: true }, { ...admin, 'x-moa-profile': q } as any)).statusCode, 401);
    assert.equal((await put({ navigation: tab(['s', 'missing']) })).statusCode, 200);
    assert.deepEqual(db.defaultNavigation(), tab());
    const r = (await create(member)).json().id;
    assert.deepEqual(db.settings(r).navigation, tab());
    assert.equal(db.settings(q).navigation, undefined);
    assert.equal(db.settings(p).navigation, undefined);
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...admin, 'x-moa-profile': p }, payload: { navigation: [{ ...tab()[0], name: '복사', includeLocal: true }] } });
    assert.equal((await put({ fromProfile: true }, { ...admin, 'x-moa-profile': p } as any)).json().navigation[0].name, '복사');
    assert.equal(db.settings(r).navigation![0].name, '홈');
    await app.close();
    instance = await buildApp(cfg, false); ({ app, db, sources } = instance);
    assert.equal(db.defaultNavigation()![0].name, '복사');
    sources.configure('s', { enabled: false });
    assert.deepEqual(db.defaultNavigation()![0].sourceIds, []);
    assert.deepEqual(db.settings(r).navigation![0].sourceIds, ['s'], 'disable preserves existing personal tabs');
    const newProfile = (await create(member)).json().id;
    assert.deepEqual(db.settings(newProfile).navigation![0].sourceIds, []);
    assert.equal((await put({ navigation: null })).statusCode, 200);
    const automatic = (await create(member)).json().id;
    assert.equal(db.settings(automatic).navigation, undefined);
  } finally { await instance.app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('removal drains in-flight source calls, rejects new calls, clears cache and allows reinstall', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-source-race-')), db = new Store(dir);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sources = new Sources(db, new Catalog(db), async input => {
    if (input.action === 'list') { started(); await gate; }
    return { changes: {}, result: input.action === 'list' ? { list: [{ name: 'Show', link: '/show', imageUrl: 'https://example.test/a.jpg' }], hasNextPage: false } : {} };
  }, async () => ({ source: 'reinstalled', sha256: 'new' }));
  try {
    seedSource(db, 's');
    const browse = sources.browse('s', 'p'); await entered;
    const removal = sources.remove(['s']);
    await assert.rejects(sources.browse('s', 'p'), /source-removing/);
    await assert.rejects(sources.install('s'), /source-removing/);
    await assert.rejects(sources.remove(['s']), /source-removing/);
    release(); await browse;
    assert.equal((await removal).impact.mediaCount, 1);
    assert.equal(db.get('SELECT count(*) AS n FROM media')!.n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM source_images')!.n, 0);
    await assert.rejects(sources.browse('s', 'p'), /source-unavailable/);
    assert.equal((await sources.install('s')).installed, true);
    assert.equal((await sources.browse('s', 'p')).items.length, 1);
  } finally { release(); await sources.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});
