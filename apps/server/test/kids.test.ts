import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kidsAllowed, selectCertification } from '../src/profiles/kids.js';
import { Tmdb } from '../src/metadata/tmdb.js';
import { Store } from '../src/db.js';
import { buildApp } from '../src/app.js';

test('kids rating policy: known ratings only, adult always denied, only unrated Family/Kids genres are exempt', () => {
  for (const certification of ['ALL', 'all', '7', '12', '전체관람가', '12세 이상 관람가', 'G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG']) {
    assert.equal(kidsAllowed({ certification }), true, certification);
    assert.equal(kidsAllowed({ certification, adult: true }), false, certification);
  }
  for (const certification of ['15', '19', '18', '청불', '청소년관람불가', 'PG-13', 'TV-14', 'R', 'NC-17', 'TV-MA', 'NR', 'UNKNOWN', '', undefined]) assert.equal(kidsAllowed({ certification }), false, certification);
  assert.equal(kidsAllowed(undefined), false);
  assert.equal(kidsAllowed({ genreIds: [16, 10751] }), true, 'unrated family');
  assert.equal(kidsAllowed({ genreIds: [10762] }), true, 'unrated kids');
  assert.equal(kidsAllowed({ genres: ['가족'] }), true, 'unrated family by cached name');
  assert.equal(kidsAllowed({ certification: '15', genreIds: [10751] }), false, 'explicit 15 beats family genre');
  assert.equal(kidsAllowed({ certification: 'UNKNOWN', genreIds: [10751] }), false, 'unmapped rating stays blocked');
  assert.equal(kidsAllowed({ genreIds: [10751], adult: true }), false, 'adult beats family genre');
  assert.equal(kidsAllowed({ genreIds: [16, 10759] }), false, 'unrated animation alone is blocked');
});

test('TMDB selects KR before US and supported foreign countries; conflicting ratings use strictest', () => {
  const tv = (results: any[]) => selectCertification('tv', { content_ratings: { results } });
  assert.equal(tv([{ iso_3166_1: 'US', rating: 'TV-MA' }, { iso_3166_1: 'KR', rating: '12' }]), '12');
  assert.equal(tv([{ iso_3166_1: 'KR', rating: '' }, { iso_3166_1: 'US', rating: 'TV-PG' }]), '12');
  assert.equal(tv([{ iso_3166_1: 'KR', rating: '미정' }, { iso_3166_1: 'US', rating: 'G' }]), 'UNKNOWN');
  for (const [country, rating, expected] of [['US','PG-13','15'], ['GB','12A','12'], ['DE','6','7'], ['JP','R15+','15'], ['AU','M','15'], ['XX','G',undefined]]) {
    assert.equal(tv([{ iso_3166_1: country, rating }]), expected);
  }
  assert.equal(selectCertification('movie', { release_dates: { results: [{ iso_3166_1: 'KR', release_dates: [{ certification: '' }, { certification: '12' }, { certification: '19' }] }] } }), '19');
});

test('in-memory kids API covers home, lists, genres, search, groups, similar, history, browse and direct playback', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-kids-'));
  const store = new Store(temp, new DatabaseSync(':memory:'));
  const { app, db, sources, playback, remotePlayback } = await buildApp({ dataDir: temp, mediaRoot: temp, webDir: path.join(temp, 'web') }, false, { store, tmdb: { token: '', key: '' } });
  try {
    const create = async (kids: boolean) => (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: kids ? 'Kids' : 'Normal', kids } })).json().id;
    const kid = await create(true), normal = await create(false);
    const headers = { 'x-moa-profile': kid }, regular = { 'x-moa-profile': normal };
    const entry = JSON.stringify({ id: 'fixture', name: 'Source', version: '1', baseUrl: 'https://source.test/' });
    db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'source', 'repo', entry, entry, 'fixture');
    const fixtures = [
      ['safe', '12', false, false], ['blocked', '15', false, false], ['unrated', undefined, false, false],
      ['adult', 'ALL', true, false], ['remote-safe', 'PG', false, true], ['remote-blocked', 'TV-MA', false, true],
      ['unlinked', 'ALL', false, true],
    ] as const;
    for (const [i, [id, certification, adult, remote]] of fixtures.entries()) {
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id, 'movie', JSON.stringify({ backdrop: 'art', certification: 'ALL', genres: [id === 'blocked' ? '공포' : '가족'], ...(remote ? { provider: { id: 'source', name: 'Source', kind: 'extension' } } : {}) }), '2026');
      db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', id + '-ep', id, 1, 1, 'Episode', 100, null);
      if (id !== 'unlinked') {
        db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)', 'movie', i + 1, JSON.stringify({ title: id, certification, adult, genreIds: id === 'unrated' ? [16, 10759] : [10751, 10762, 16] }), JSON.stringify({ people: [], similar: [{ kind: 'movie', id: 1, title: 'safe' }, { kind: 'movie', id: 2, title: 'blocked' }, { kind: 'movie', id: 999, title: 'unknown' }] }), Date.now());
        db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'movie',?,'manual',?)", id, i + 1, Date.now());
      }
      if (remote) {
        db.run('INSERT INTO source_media VALUES(?,?,?,?)', id, 'source', '/' + id, Date.now());
        db.run('INSERT INTO source_episodes VALUES(?,?)', id + '-ep', '/' + id + '/ep');
      }
      for (const p of [kid, normal]) {
        db.run('INSERT INTO watchlist VALUES(?,?,?)', p, id, '2026');
        db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', p, id + '-ep', 10, 100, 0, '2026');
      }
    }
    const ids = (cards: any[]) => cards.map(c => c.id).sort();
    const get = async (url: string, h = headers) => { const r = await app.inject({ url, headers: h }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
    const expected = ['remote-safe', 'safe'];
    assert.deepEqual(ids((await get('/api/media')).items), expected);
    assert.equal((await get('/api/media', regular)).total, 7);
    assert.deepEqual(await get('/api/genres'), ['가족']);
    assert.equal((await get('/api/media?genre=%EA%B3%B5%ED%8F%AC')).total, 0);
    assert.deepEqual(ids((await get('/api/search?q=')).groups.flatMap((g: any) => g.items)), expected);
    assert.deepEqual(ids(await get('/api/watchlist')), expected);
    assert.deepEqual(ids((await get('/api/history')).items.map((i: any) => i.media)), expected);
    assert.equal((await get('/api/history')).total, 2);
    const home = await get('/api/home?providers=local,source');
    assert.deepEqual(ids(home.hero), expected);
    const globalHome = await get('/api/home?providers=&continueScope=all&watchlistScope=all');
    assert.deepEqual(ids(globalHome.rows.find((r: any) => r.kind === 'continue').items), expected);
    assert.deepEqual(globalHome.hero, []);
    assert.deepEqual(ids(globalHome.rows.find((r:any)=>r.kind==='watchlist').items),expected);
    assert.ok(home.rows.some((r: any) => r.kind === 'continue'));
    for (const row of home.rows) assert.ok(row.items.every((c: any) => expected.includes(c.id)));
    assert.deepEqual((await get('/api/media/safe')).similar.map((c: any) => c.id), [1]);
    assert.equal((await get('/api/media/safe', regular)).similar.length, 3);
    assert.deepEqual(ids(await get('/api/media/groups/candidates?q=blocked')), []);
    const resolved = await app.inject({ method: 'POST', url: '/api/media/groups/resolve', headers, payload: { ids: fixtures.map(f => f[0]) } });
    assert.deepEqual(ids(resolved.json()), expected);
    assert.equal((await app.inject({ url: '/api/media/blocked/group', headers })).statusCode, 404);
    for (const id of ['blocked', 'unrated', 'adult', 'remote-blocked', 'unlinked']) {
      for (const request of [{ url: '/api/media/' + id }, { method: 'POST' as const, url: '/api/playback', payload: { episodeId: id + '-ep', capabilities: { h264: true, hevc: false, av1: false } } }]) {
        const response = await app.inject({ ...request, headers });
        assert.equal(response.statusCode, 403, id); assert.deepEqual(response.json(), { error: 'kids-restricted' });
      }
      assert.equal((await app.inject({ url: '/api/media/' + id, headers: regular })).statusCode, 200);
    }
    let localCalls = 0, remoteCalls = 0;
    playback.create = (async () => { localCalls++; return { ok: true, subtitles: [] }; }) as any;
    remotePlayback.create = (async () => { remoteCalls++; return { ok: true, subtitles: [] }; }) as any;
    for (const [h, id] of [[headers, 'safe'], [headers, 'remote-safe'], [regular, 'blocked'], [regular, 'remote-blocked']] as const) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/playback', headers: h, payload: { episodeId: id + '-ep', capabilities: { h264: true, hevc: false, av1: false } } })).statusCode, 200);
    }
    assert.equal(localCalls, 2); assert.equal(remoteCalls, 2);
    let calls = 0;
    (sources as any).call = async () => { calls++; return { list: [{ name: 'new', link: 'https://source.test/new' }], hasNextPage: true }; };
    for (const method of ['GET', 'POST'] as const) {
      const request = method === 'GET' ? { url: '/api/sources/source/browse' } : { method, url: '/api/sources/source/browse', payload: { mode: 'popular', page: 1 } };
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().items, []); assert.equal(response.json().hasNextPage, true);
    }
    const browse = await get('/api/sources/source/browse', regular);
    assert.equal(browse.items.length, 1); assert.equal(calls, 1);
    const mid = browse.items[0].id;
    db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'movie',1,'manual',?)", mid, Date.now());
    assert.equal((await get('/api/sources/source/browse')).items.length, 1, 'cached browse rechecks current profile and TMDB links');
    (sources as any).call = async () => ({ list: [{ name: 'new', link: 'https://source.test/new', adult: true }], hasNextPage: false });
    sources.invalidate('source');
    assert.equal((await get('/api/sources/source/browse')).items.length, 0, 'source adult overrides safe TMDB rating');
    assert.equal((await get('/api/sources/source/browse?mode=search&q=new')).items.length, 0);
    assert.equal((await get('/api/sources/source/browse?mode=search&q=new', regular)).items.length, 1);
    assert.deepEqual(await get('/api/settings'), await get('/api/settings', regular), 'navigation/settings remain unchanged');
  } finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
});


test('TMDB fetch persists adult flag and fallback certification for kids decisions', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-kids-tmdb-'));
  const db = new Store(temp, new DatabaseSync(':memory:'));
  const tmdb = new Tmdb(db, () => {}, { key: 'test', fetch: (async () => new Response(JSON.stringify({
    title: 'Adult animation', adult: true, genres: [{ id: 16, name: '애니메이션' }],
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G' }] }] },
  }), { status: 200 })) as typeof fetch });
  try {
    db.run("INSERT INTO media VALUES('m',NULL,'Adult animation','movie','{}','2026')");
    await tmdb.change('m', { action: 'link', kind: 'movie', tmdbId: 1 });
    const info = JSON.parse(db.get('SELECT card FROM tmdb_titles')!.card);
    assert.equal(info.certification, 'ALL'); assert.equal(info.adult, true);
    assert.deepEqual(info.genreIds, [16]); assert.equal(kidsAllowed(info), false);
  } finally { tmdb.close(); db.close(); await rm(temp, { recursive: true, force: true }); }
});
