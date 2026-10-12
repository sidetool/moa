import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('grouped continue keeps the representative card and the latest source progress without reviving finished sources', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-grouped-continue-'));
  const env = await buildApp({ dataDir: directory, mediaRoot: directory }, false, { tmdb: { token: '', key: '' } });
  const { app, db, catalog } = env;
  try {
    const profile = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
    const other = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Other' } })).json().id;
    const headers = { 'x-moa-profile': profile };
    for (const [id, lang] of [['a', 'ko'], ['b', 'en']]) {
      const entry = JSON.stringify({ id, name: id, lang, version: '1' });
      db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', id, 'fixture', entry, entry, 'fixture');
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id === 'a' ? '작품' : 'The Show', 'anime', JSON.stringify({ provider: { id, lang, name: id, kind: 'mangayomi-js' } }), '2026');
      db.run("INSERT INTO tmdb_links VALUES(?,'tv',100,1,'manual',100,?)", id, Date.now());
      for (const number of [1, 2]) db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,NULL)', id + number, id, 1, number, `${number}화`, 1200);
    }
    db.run("INSERT INTO tmdb_titles VALUES('tv',100,?,?,?)", JSON.stringify({ title: '작품', originalTitle: 'The Show' }), '{}', Date.now());
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, 'a1', 120, 1200, 0, '2026-10-01');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, 'b1', 360, 1200, 0, '2026-10-02');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', other, 'a1', 80, 1200, 0, '2026-10-03');
    const ongoing = async (query = '', who = profile) => {
      const result = await app.inject({ url: '/api/home?continueScope=all' + query, headers: { 'x-moa-profile': who } });
      assert.equal(result.statusCode, 200, result.body);
      return result.json().rows.find((row: any) => row.kind === 'continue')?.items ?? [];
    };
    let cards = await ongoing();
    assert.equal(cards.length, 1); assert.equal(cards[0].id, 'a'); assert.equal(cards[0].sourceCount, 2);
    assert.equal(cards[0].resume.episodeId, 'b1'); assert.equal(cards[0].resume.position, 360); assert.equal(cards[0].progress.ratio, 0.3);
    assert.equal((await ongoing('', other))[0].resume.position, 80);
    assert.equal((await ongoing('&titleGrouping=false')).length, 2);
    await app.inject({ method: 'PATCH', url: '/api/media/b/group', headers, payload: { action: 'separate' } });
    assert.equal((await ongoing()).length, 2);
    await app.inject({ method: 'PATCH', url: '/api/media/b/group', headers, payload: { action: 'reset' } });
    const tab = (await app.inject({ url: '/api/home?providers=a', headers })).json().rows.find((row: any) => row.kind === 'continue').items;
    assert.equal(tab[0].resume.episodeId, 'a1'); assert.equal(tab[0].sourceCount, 1);
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, 'b2', 1200, 1200, 1, '2026-10-04');
    assert.equal((await ongoing()).length, 0);
    db.run("DELETE FROM progress WHERE episode_id='b2'");
    db.transaction(() => { for (let i = 0; i < 5000; i++) db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'cached-' + i, 'Catalog item ' + i, 'anime', JSON.stringify({ provider: { id: 'a', name: 'a', kind: 'mangayomi-js' } }), '2026'); });
    const cardCalls = t.mock.method(catalog, 'card');
    const started = performance.now(); cards = await ongoing();
    assert.equal(cards.length, 1); assert.ok(cardCalls.mock.callCount() < 20, `hydrated ${cardCalls.mock.callCount()} cards`);
    t.diagnostic(`5000 cached titles: grouped Home ${Math.round(performance.now() - started)}ms, ${cardCalls.mock.callCount()} hydrated cards`);
    cardCalls.mock.resetCalls();
    assert.equal(catalog.search(profile, 'Catalog item 4999').groups.flatMap(group => group.items).length, 1);
    assert.equal(cardCalls.mock.callCount(), 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('search uses stored originals, aliases and confirmed TMDB identities while unmatched English queries reuse TMDB search', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-alias-search-'));
  const calls: string[] = [];
  const env = await buildApp({ dataDir: directory, mediaRoot: directory }, false, { tmdb: { token: 'fixture', fetch: async input => {
    const url = new URL(String(input)); calls.push(url.searchParams.get('query') || url.pathname);
    return Response.json({ results: [{ id: 100, media_type: 'tv', name: '작품', original_name: '日本語' }, { id: 999, media_type: 'tv', name: 'Not installed' }] });
  } } });
  const { app, db, catalog } = env;
  try {
    const profile = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
    for (const [id, title, metadata] of [['ko', '한국 제목', {}], ['en', 'English Title', {}], ['alias', '별명 작품', { altTitles: ['Alternate Name'] }], ['off', '다른 작품', {}]] as const) {
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, title, 'movie', JSON.stringify(metadata), '2026');
    }
    for (const [id, status] of [['ko', 'manual'], ['en', 'auto'], ['off', 'off']]) db.run('INSERT INTO tmdb_links VALUES(?,?,?,NULL,?,100,?)', id, 'tv', 100, status, Date.now());
    db.run("INSERT INTO tmdb_titles VALUES('tv',100,?,?,?)", JSON.stringify({ title: '작품', originalTitle: '日本語', aliases: ['Saved English Name'] }), '{}', Date.now());
    db.run('INSERT INTO media_titles VALUES(?,?,?,?,?)', 'alias', 1, 'Translated Original', '별명 작품', Date.now() + 100000);
    const ids = (query: string) => catalog.search(profile, query).groups.flatMap(group => group.items.map(item => item.id)).sort();
    assert.deepEqual(ids('English Title'), ['en', 'ko']);
    assert.deepEqual(ids('日本語'), ['en', 'ko']);
    assert.deepEqual(ids('Saved English Name'), ['en', 'ko']);
    assert.deepEqual(ids('Alternate Name'), ['alias']);
    assert.deepEqual(ids('Translated Original'), ['alias']);
    const result = await app.inject({ url: '/api/search?q=Different%20English%20Name', headers: { 'x-moa-profile': profile } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json().groups.flatMap((group: any) => group.items.map((item: any) => item.id)).sort(), ['en', 'ko']);
    assert.deepEqual(calls, ['Different English Name']);
    await app.inject({ url: '/api/search?q=Saved%20English%20Name', headers: { 'x-moa-profile': profile } });
    assert.equal(calls.length, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('source preload status, start and cancellation remain admin-only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-preload-access-'));
  const { app, db } = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false, { tmdb: { token: '', key: '' } });
  try {
    db.run("INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled,live) VALUES('source','fixture','{}','{}','fixture',1,1)");
    const url = '/api/admin/sources/source/preload';
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
      assert.equal((await app.inject({ method, url, headers: { 'x-moa-account': 'viewer', 'x-moa-role': 'member' } })).statusCode, 403);
    }
    const headers = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
    assert.equal((await app.inject({ url, headers })).json().state, 'idle');
    assert.equal((await app.inject({ method: 'POST', url, headers })).json().error, 'source-preload-live');
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).json().state, 'idle');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
