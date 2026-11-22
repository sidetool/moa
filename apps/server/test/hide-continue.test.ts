import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HomeResponse, PlaybackSession } from '@moa/shared';
import { buildApp } from '../src/app.js';

test('Continue visibility survives reload, follows the selected editions, and only clears on new playback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-hidden-continue-'));
  const open = () => buildApp({ dataDir: directory, mediaRoot: directory }, false, { tmdb: { token: '', key: '' } });
  let env = await open();
  try {
    const profile = async () => (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json().id;
    const who = await profile(), other = await profile();
    const headers = { 'x-moa-profile': who };
    const get = async (url: string, viewer = who) => {
      const result = await env.app.inject({ url, headers: { 'x-moa-profile': viewer } });
      assert.equal(result.statusCode, 200, result.body);
      return result.json();
    };
    const continued = async (query = 'continueScope=all', viewer = who) =>
      ((await get('/api/home?' + query, viewer) as HomeResponse).rows.find(row => row.kind === 'continue')?.items ?? []);
    const hide = (id: string, groupId?: string, resumeMediaId?: string) => env.app.inject({
      method: 'PUT', url: '/api/home/continue/' + id + '/hidden', headers,
      query: { ...(groupId && { groupId }), ...(resumeMediaId && { resumeMediaId }) },
    });
    const save = async (episodeId: string, position: number, session?: PlaybackSession) => {
      const response = await env.app.inject({ method: 'POST', url: '/api/progress', headers,
        payload: { episodeId, position, duration: 1200, continueVisibility: session?.continueVisibility } });
      assert.equal(response.statusCode, 200, response.body);
    };
    const play = async (episodeId: string): Promise<PlaybackSession> => {
      const response = await env.app.inject({ method: 'POST', url: '/api/playback', headers,
        payload: { episodeId, capabilities: { h264: true, hevc: false, av1: false } } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const db = env.db;
    for (const [id, title] of [['a', 'Series Season 1'], ['b', 'Series Season 1'], ['s2', 'Series Season 2']]) {
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, title, 'series', '{}', '2026');
      for (const n of [1, 2]) db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,NULL)', id + n, id, id === 's2' ? 2 : 1, n, String(n), 1200);
      db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', who, id + '1', id === 'b' ? 1200 : 105, 1200, Number(id === 'b'), id === 'b' ? '2026-10-10' : '2026-10-09');
    }
    for (const episode of ['b1', 'b2']) {
      const file = path.join(directory, episode + '.mp4');
      await writeFile(file, 'fixture');
      db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', episode, file, 7, 0, '', JSON.stringify({
        duration: 1200, container: 'mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }],
      }), '[]');
    }
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', other, 'a1', 220, 1200, 0, '2026');
    const saved = await env.app.inject({ method: 'PUT', url: '/api/watchlist/b', headers });
    assert.equal(saved.statusCode, 204);
    const before = await continued('providers=local'), grouped = before.find(card => card.resume?.kind === 'next')!;
    assert.ok(grouped.groupId);
    assert.equal(grouped.id, 'a');
    assert.equal(grouped.resumeMediaId, 'b');
    const old = await play('b1');
    assert.equal(old.continueVisibility, undefined);
    const history = await get('/api/history?groupHistory=false'), watchlist = await get('/api/watchlist'), detail = await get('/api/media/b');
    assert.equal(detail.playTarget.episodeId, 'b2');

    // An old rendered group must never change a newly separated edition.
    const changeGroup = (action: string) => env.app.inject({
      method: 'PATCH', url: '/api/media/b/group', headers, payload: { action },
    });
    assert.equal((await changeGroup('separate')).statusCode, 200);
    assert.equal((await get('/api/media/a/group')).id, grouped.groupId);
    for (const resumeId of [grouped.resumeMediaId, undefined]) {
      const stale = await hide(grouped.id, grouped.groupId, resumeId);
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, 'continue-group-changed');
    }
    assert.equal(db.get('SELECT COUNT(*) AS n FROM hidden_continue')?.n, 0);
    assert.equal((await changeGroup('reset')).statusCode, 200);
    assert.equal((await hide(grouped.id, 'stale-group', grouped.resumeMediaId)).statusCode, 409);
    assert.equal((await hide('missing')).statusCode, 404);
    assert.deepEqual(await continued('providers=local'), before);
    assert.deepEqual((await hide('a')).json().mediaIds, ['a']);
    assert.deepEqual((await continued('providers=local&titleGrouping=false')).map(card => card.id), ['b', 's2']);
    assert.equal((await continued('providers=local'))[0].resumeMediaId, 'b');
    const result = await hide(grouped.id, grouped.groupId, grouped.resumeMediaId);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json().mediaIds.sort(), ['a', 'b']);
    assert.deepEqual((await hide(grouped.id, grouped.groupId, grouped.resumeMediaId)).json().mediaIds.sort(), ['a', 'b']);
    for (const query of ['providers=local', 'providers=local&titleGrouping=false', 'continueScope=all&providers=unselected']) {
      assert.deepEqual((await continued(query)).map(card => card.id), ['s2']);
    }
    assert.equal((await continued('providers=local', other))[0].resume?.position, 220);
    assert.deepEqual(await get('/api/media/b'), detail);
    assert.deepEqual(await get('/api/history?groupHistory=false'), history);
    assert.deepEqual(await get('/api/watchlist'), watchlist);
    await save('b1', 1198, old);
    await env.app.close();
    env = await open();
    assert.deepEqual((await continued()).map(card => card.id), ['s2']);

    // Opening the next episode, including a stationary/one-frame teardown, does not restore the tile.
    const next = await play('b2');
    assert.equal(next.continueVisibility?.startPosition, 0);
    await save('b2', 0.04, next);
    assert.deepEqual((await continued()).map(card => card.id), ['s2']);
    await save('b2', 15, next);
    assert.equal((await continued())[0].resume?.episodeId, 'b2');
    assert.deepEqual((await continued('continueScope=all&titleGrouping=false')).map(card => card.id), ['b', 's2']);
    await hide('b');
    // A positive save from the previous hide/play cycle cannot undo a second hide.
    await save('b2', 25, next);
    const resumed = await play('b2');
    assert.equal(resumed.startPosition, 25);
    assert.notEqual(resumed.continueVisibility?.token, next.continueVisibility?.token);
    await save('b2', 25.3, resumed);
    assert.deepEqual((await continued()).map(card => card.id), ['s2']);
    await save('b2', 40, resumed);
    assert.equal((await continued())[0].resume?.position, 40);
    await save('b2', 1200, resumed);
    assert.deepEqual((await continued()).map(card => card.id), ['s2']);
  } finally {
    await env.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
