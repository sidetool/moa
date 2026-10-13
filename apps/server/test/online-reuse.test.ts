import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('saved online subtitles avoid network and storage work across grouped sources and restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-online-reuse-'));
  let searches = 0, titles = 0;
  const content = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n재사용 자막\n';
  const services = {
    tmdb: { token: '', key: '' },
    subtitleClient: {
      async resolveKoreanTitle(title: string) { titles++; return title; },
      async searchSubtitles(query: { episode: number; season?: number }) {
        searches++;
        return [{ id: 'candidate', creatorId: 'creator', creatorName: '제작자', sourceUrl: 'https://example.com/sub', filename: '01.vtt', format: 'vtt' as const, content, title: '예제', season: query.season ?? 1, episode: query.episode, matchedEpisode: query.episode, confidence: 1 }];
      },
    },
    aniSkip: { async lookup() { return { match: null, intervals: [], markers: null }; } },
  };
  let server = await buildApp({ dataDir: directory, mediaRoot: directory }, false, services);
  try {
    const profile = (await server.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '시청자' } })).json().id;
    const other = (await server.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '다른 시청자' } })).json().id;
    const headers = { 'x-moa-profile': profile };
    server.db.run("INSERT INTO media VALUES('a',NULL,'원본 작품','anime','{}','2026'),('b',NULL,'다른 소스 2기','anime','{}','2026'),('c',NULL,'별개 작품','anime','{}','2026')");
    server.db.run("INSERT INTO episodes VALUES('a1','a',2,1,'1화',600,NULL),('b1','b',1,1,'1화',600,NULL),('b2','b',1,2,'2화',600,NULL),('c1','c',2,1,'1화',600,NULL)");
    server.db.run("INSERT INTO source_entries(id,repository,entry,enabled) VALUES('source','fixture','{}',1)");
    server.db.run("INSERT INTO source_media(media_id,source_id,url) VALUES('b','source','https://example.com/show')");
    assert.equal((await server.app.inject({ method: 'PATCH', url: '/api/media/a/group', headers, payload: { action: 'merge', otherId: 'b' } })).statusCode, 200);
    const search = async (id: string, suffix = '') => {
      const response = await server.app.inject({ url: `/api/episodes/${id}/subtitles/online${suffix}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const apply = (id: string, result: any, profileId = profile) => server.app.inject({ method: 'POST', url: `/api/episodes/${id}/subtitles/online`, headers: { 'x-moa-profile': profileId }, payload: { searchId: result.searchId, candidateId: result.candidates[0].id } });
    const first = await search('a1'), original = (await apply('a1', first)).json();
    assert.equal(searches, 1);
    const initialTitles = titles;
    for (const episode of ['a1', 'b1']) {
      const cached = await search(episode);
      assert.equal(cached.candidates[0].id, original.id);
      assert.equal(cached.candidates[0].content, undefined);
      assert.equal((await apply(episode, cached, other)).statusCode, 404);
      const response = await apply(episode, cached);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().id, original.id);
      assert.equal((await server.app.inject({ url: response.json().url, headers })).body, content);
    }
    assert.equal(searches, 1);
    assert.equal(titles, initialTitles);
    assert.equal(server.db.get('SELECT count(*) AS n FROM online_subtitles')!.n, 1);
    const refreshed = await search('b1', '?refresh=true');
    assert.equal(searches, 2);
    assert.equal((await apply('b1', refreshed)).json().id, original.id);
    assert.equal(server.db.get('SELECT count(*) AS n FROM online_subtitles')!.n, 1);
    await search('b1', '?title=새검색&season=2&episode=1');
    assert.equal(searches, 3);
    await search('b2'); await search('c1');
    assert.equal(searches, 5);
    await server.app.close();
    server = await buildApp({ dataDir: directory, mediaRoot: directory }, false, services);
    const restored = await search('b1');
    assert.equal(searches, 5);
    assert.equal((await apply('b1', restored)).json().id, original.id);
    assert.equal((await server.app.inject({ method: 'PATCH', url: '/api/media/b/group', headers, payload: { action: 'separate' } })).statusCode, 200);
    assert.equal((await apply('b1', restored)).statusCode, 404);
    await search('b1');
    assert.equal(searches, 6);
    const deleted = await search('a1');
    assert.equal((await server.app.inject({ method: 'DELETE', url: `/api/episodes/a1/subtitles/${original.id}`, headers })).statusCode, 204);
    assert.equal((await apply('a1', deleted)).statusCode, 404);
    assert.equal(server.db.get('SELECT count(*) AS n FROM online_subtitles')!.n, 0);
  } finally { await server.app.close(); await rm(directory, { recursive: true, force: true }); }
});
