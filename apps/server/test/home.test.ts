import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('home resumes unlisted sources while tab discovery, profiles and completion stay scoped', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-home-'));
  const { app, db } = await buildApp({ dataDir: temp, mediaRoot: temp, webDir: path.join(temp, 'web') }, false, { tmdb: { token: '', key: '' } });
  try {
    const createProfile = async () => (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Test' } })).json().id;
    const profile = await createProfile(), other = await createProfile();
    const headers = { 'x-moa-profile': profile };
    for (const id of ['source-a', 'source-b']) {
      const entry = JSON.stringify({ id, name: id, version: '1', baseUrl: 'https://source.test/' });
      db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', id, 'repo', entry, entry, 'fixture');
    }
    const add = (id: string, provider: string, watchedBy = profile, completed = false, position = 20) => {
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, id, 'anime', JSON.stringify({ backdrop: 'test.jpg', ...(provider === 'local' ? {} : { provider: { id: provider, name: provider, kind: 'extension' } }) }), '2026-10-03');
      if (provider !== 'local') db.run('INSERT INTO source_media VALUES(?,?,?,?)', id, provider, '/' + id, Date.now());
      db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', id + '-ep', id, 1, 1, 'Episode', 100, null);
      db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', watchedBy, id + '-ep', position, 100, Number(completed), '2026-10-03T10:00:00Z');
      db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, id, '2026-10-03');
    };
    add('listed', 'source-a');
    add('unlisted', 'source-b');
    add('local', 'local');
    add('finished', 'source-b', profile, true);
    add('not-started', 'source-b', profile, false, 0);
    add('other-profile', 'source-b', other);
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'unlisted-next', 'unlisted', 1, 2, 'Episode 2', 100, null);
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', profile, 'unlisted-next', 45, 100, 0, '2026-10-03T11:00:00Z');
    const get = async (query: string, who = profile) => {
      const response = await app.inject({ url: '/api/home?' + query, headers: { 'x-moa-profile': who } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const ids = (home: any, kind: string) => (home.rows.find((r: any) => r.kind === kind)?.items ?? []).map((c: any) => c.id);
    const global = await get('providers=source-a&continueScope=all');
    assert.deepEqual([...ids(global, 'continue')].sort(), ['listed', 'local', 'unlisted']);
    const resumed = global.rows.find((r: any) => r.kind === 'continue').items[0];
    assert.equal(resumed.id, 'unlisted');
    assert.equal(resumed.progress.episodeId, 'unlisted-next');
    assert.equal(resumed.progress.ratio, 0.45);
    assert.deepEqual(global.hero.map((c: any) => c.id), ['listed']);
    assert.deepEqual(ids(global, 'watchlist'), ['listed']);
    assert.deepEqual(ids(await get('providers=source-a'), 'continue'), ['listed']);
    assert.deepEqual(ids(await get('providers=local&continueScope=tab'), 'continue'), ['local']);
    assert.deepEqual([...ids(await get('providers=&continueScope=all'), 'continue')].sort(), ['listed', 'local', 'unlisted']);
    assert.deepEqual(ids(await get('providers=&continueScope=all', other), 'continue'), ['other-profile']);
    assert.deepEqual(ids(await get('providers=source-a&continueScope=all&type=movie'), 'continue'), []);
    assert.equal((await app.inject({ url: '/api/home?continueScope=invalid', headers })).statusCode, 400);
    const saved = await get('providers=source-a&continueScope=all&watchlistScope=all');
    assert.deepEqual([...ids(saved,'watchlist')].sort(), ['finished','listed','local','not-started','other-profile','unlisted']);
    assert.deepEqual(saved.hero.map((c:any)=>c.id),['listed'],'only personal rows ignore Home source selection');
    assert.deepEqual([...ids(await get('providers=&watchlistScope=all'),'watchlist')].sort(), [...ids(saved,'watchlist')].sort());
    assert.deepEqual(ids(await get('providers=source-a&watchlistScope=all',other),'watchlist'),[]);
    assert.deepEqual(ids(await get('providers=source-a&watchlistScope=all&type=movie'),'watchlist'),[]);
    assert.deepEqual(ids(await get('providers=source-a&watchlistScope=tab'),'watchlist'),['listed']);
    assert.deepEqual([...((await app.inject({url:'/api/watchlist',headers})).json()).map((c:any)=>c.id)].sort(), [...ids(saved,'watchlist')].sort());
    assert.equal((await app.inject({url:'/api/home?watchlistScope=invalid',headers})).statusCode,400);
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
