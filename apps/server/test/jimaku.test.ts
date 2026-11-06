import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { jimakuEntries, jimakuFiles } from '../src/translation/jimaku.js';
const entry = (data: unknown, href: string) =>
  `<div class="entry" data-extra="${JSON.stringify(data).replace(/"/g, '&quot;')}"><a href="${href}">test</a></div>`;
const index = entry(
  { name: 'Starlight Academy', english_name: 'STARLIGHT ACADEMY', japanese_name: '星の学校' },
  '/entry/9001',
);
const file = (name: string, url = '/entry/9001/download/' + encodeURIComponent(name)) =>
  entry({ name, url, size: 100 }, url);
const files =
  file('Starlight Academy - 01.ja.srt') +
  file('Starlight Academy - 02.srt') +
  file('Starlight Academy S02E01.ass') +
  file('Starlight Academy - 01.en.srt') +
  file('all.zip') +
  file('evil.ass', 'http://127.0.0.1/secret');
test('Jimaku page parsing only accepts fixed-origin text subtitle files', () => {
  assert.equal(jimakuEntries(index)[0].title, 'Starlight Academy');
  const parsed = jimakuFiles(files, '9001');
  assert.equal(parsed.length, 4);
  assert.ok(parsed.every((f) => f.url.startsWith('https://jimaku.cc/entry/9001/download/')));
  assert.equal(jimakuFiles(file('x.ass', 'https://evil.example/entry/9001/download/x.ass'), '9001').length, 0);
});

test('Jimaku applies file-only release tokens after removing language suffixes without certifying ambiguous files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moa-jimaku-release-'));
  const valid = ['Starlight Academy [03].ja.srt', 'Starlight Academy - 03Group.ja.srt', 'Starlight_Academy_03_1080p_x264.ja.srt'];
  const names = [...valid, 'Starlight Academy [03] [04].ja.srt', 'Starlight Academy S02 [03].ja.srt', 'Starlight Academy [04].ja.srt'];
  const env = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web') }, false, {
    jimakuFetch: async url => new Response(String(url).endsWith('/') ? index : names.map(name => file(name)).join('')),
  });
  try {
    const profile = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Synthetic' } })).json();
    env.db.run("INSERT INTO media VALUES('release',NULL,'Starlight Academy','anime','{}','2026')");
    env.db.run("INSERT INTO episodes VALUES('release-3','release',1,3,'3화',100,NULL)");
    const response = await env.app.inject({ url: '/api/episodes/release-3/subtitles/jimaku', headers: { 'x-moa-profile': profile.id } });
    assert.equal(response.statusCode, 200, response.body);
    const candidates = response.json().candidates;
    assert.deepEqual(candidates.filter((candidate: { match: string }) => candidate.match === 'episode').map((candidate: { filename: string }) => candidate.filename).sort(), [...valid].sort());
    assert.ok(!candidates.some((candidate: { filename: string }) => /S02|\[04\]/.test(candidate.filename)));
  } finally { await env.app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Jimaku aliases, episode/season filtering, source cache, ownership and Japanese-to-Korean handoff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moa-jimaku-'));
  let requests = 0,
    gemini = 0;
  const env = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web') }, false, {
    jimakuFetch: async (url, init) => {
      requests++;
      assert.equal(init?.redirect, 'error');
      return new Response(
        String(url).endsWith('/')
          ? index
          : String(url).endsWith('/9001')
            ? files
            : '1\n00:00:01,000 --> 00:00:03,000\nこんにちは',
      );
    },
    translationFetch: async (_url, init) => {
      gemini++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      assert.equal(data.lines[0].text, 'こんにちは');
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify({ lines: [{ id: 0, text: '안녕하세요' }] }) }] },
          },
        ],
      });
    },
  });
  try {
    const p = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'P' } })).json();
    const q = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Q' } })).json();
    const headers = { 'x-moa-profile': p.id };
    env.db.run('INSERT INTO media VALUES(?,?,?,?,?,?)', 'm', null, '별빛 학교', 'anime', '{}', '2026');
    env.db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'e', 'm', 1, 1, '1화', 100, null);
    env.db.run("INSERT INTO tmdb_links VALUES('m','tv',9002,NULL,'manual',100,0)");
    env.db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)','tv',9002,JSON.stringify({originalTitle:'星の学校'}),'{}',0);
    const first = await env.app.inject({ url: '/api/episodes/e/subtitles/jimaku', headers });
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json();
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].match, 'episode');
    assert.equal(result.candidates[0].filename, 'Starlight Academy - 01.ja.srt');
    assert.equal(gemini, 0);
    await env.app.inject({ url: '/api/episodes/e/subtitles/jimaku', headers });
    assert.equal(requests, 2);
    env.db.run('UPDATE media SET title=? WHERE id=?', '알 수 없는 한국어 표시 제목', 'm');
    env.db.run('INSERT OR REPLACE INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,?,?,?,?)', 'm', 'tv', 9002, 'manual', Date.now());
    env.db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)', 'tv', 9002, JSON.stringify({originalTitle:'星の学校'}), '{}', Date.now());
    const linked = await env.app.inject({url:'/api/episodes/e/subtitles/jimaku',headers});
    assert.equal(linked.json().candidates[0].title, 'Starlight Academy');
    assert.equal(requests, 2, 'TMDB original-title lookup reuses the shared Jimaku cache');

    await env.app.inject({
      method: 'PATCH',
      url: '/api/admin/translation/config',
      payload: { apiKey: 'test-api-key-not-real', enabled: true },
    });
    const payload = { searchId: result.searchId, candidateId: result.candidates[0].id },
      url = '/api/episodes/e/subtitles/jimaku/translate';
    assert.equal(
      (await env.app.inject({ method: 'POST', url, headers: { 'x-moa-profile': q.id }, payload })).statusCode,
      409,
    );
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, candidateId: 'https://evil.example' },
        })
      ).statusCode,
      404,
    );
    const started = await env.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(started.statusCode, 200, started.body);
    let job = started.json();
    for (let n = 0; n < 100 && job.state !== 'completed'; n++) {
      await new Promise((r) => setTimeout(r, 5));
      job = env.translations.get(job.id, p.id);
    }
    assert.equal(job.state, 'completed');
    assert.equal(gemini, 1);
    assert.match((await env.app.inject(job.track.url)).body, /안녕하세요/);
  } finally {
    await env.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
