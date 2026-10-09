import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { Casting, castSubtitle } from '../src/casting.js';

test('cast capabilities serve only their session, preserve Range and rewrite HLS without account cookies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-cast-')), mediaRoot = path.join(dir, 'media');
  await mkdir(mediaRoot);
  const { app, db, remotePlayback } = await buildApp({ dataDir: dir, mediaRoot, webDir: path.join(dir, 'web'), requireAccount: true }, false,
    { aniSkip: { async lookup() { return { match: null, intervals: [], markers: null }; } } });
  const account = { 'x-moa-account': 'cast-owner', 'x-moa-role': 'member', 'x-moa-permissions': 'video.watch,subtitles.add,subtitles.translate' };
  const other = { 'x-moa-account': 'other', 'x-moa-role': 'member', 'x-moa-permissions': 'video.watch,subtitles.add,subtitles.translate' };
  try {
    const profile = (await app.inject({ method: 'POST', url: '/api/profiles', headers: account, payload: { name: 'Cast' } })).json().id;
    const second = (await app.inject({ method: 'POST', url: '/api/profiles', headers: other, payload: { name: 'Other' } })).json().id;
    const headers = { ...account, 'x-moa-profile': profile }, foreign = { ...other, 'x-moa-profile': second };
    db.run("INSERT INTO media VALUES('m',NULL,'Show','movie','{}','2026')");
    db.run("INSERT INTO episodes VALUES('e','m',1,1,'Episode',1400,NULL)");
    const file = path.join(mediaRoot, 'test.mp4'); await writeFile(file, 'test-video');
    db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', 'e', file, 10, 0, '', JSON.stringify({ duration: 1400, container: 'mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] }), '[]');
    const session = (await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'e', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    const endpoint = `/api/playback/${session.sessionId}/cast`;
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: foreign, payload: {} })).statusCode, 403);
    const cast = (await app.inject({ method: 'POST', url: endpoint, headers, payload: { subtitle: { content: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n안녕 &amp; 세계\n', format: 'vtt', label: '한국어', offset: 2 } } })).json();
    assert.match(cast.token, /^[\w-]{43}$/);
    const video = await app.inject({ url: cast.url, headers: { range: 'bytes=1-4', origin: 'https://www.gstatic.com' } });
    assert.equal(video.statusCode, 206); assert.equal(video.body, 'est-');
    assert.equal(video.headers['access-control-allow-origin'], '*'); assert.equal(video.headers['content-range'], 'bytes 1-4/10');
    assert.equal((await app.inject({ method: 'HEAD', url: cast.url })).statusCode, 200);
    assert.equal((await app.inject({ method: 'OPTIONS', url: cast.url })).statusCode, 204);
    assert.equal((await app.inject(session.url)).statusCode, 401);
    const subtitle = await app.inject(cast.subtitle.url);
    assert.equal(subtitle.statusCode, 200); assert.match(subtitle.body, /00:00:03.000 --> 00:00:06.000\n안녕 &amp; 세계/);
    assert.equal((await app.inject(cast.url.replace(session.sessionId, 'another-session'))).statusCode, 404);
    assert.equal((await app.inject(cast.url.replace(cast.token, 'invalid'))).statusCode, 404);
    assert.equal((await app.inject(cast.url.replace('/original', '/fonts/0'))).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}/${cast.token}`, headers: foreign })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}/${cast.token}`, headers })).statusCode, 204);
    assert.equal((await app.inject(cast.url)).statusCode, 404);
    const id = 'remote-cast';
    remotePlayback.sessions.set(id, { profile, touched: Date.now(), abort: new AbortController(), assets: new Map([
      ['master', { url: '', headers: {}, playlist: `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/api/playback/${id}/remote/text"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/api/playback/${id}/remote/child\n` }],
      ['child', { url: '', headers: {}, playlist: `#EXTM3U\n#EXT-X-MAP:URI="/api/playback/${id}/remote/init"\n#EXTINF:10,\n/api/playback/${id}/remote/segment\n#EXT-X-ENDLIST\n` }]
    ]), reverse: new Map(), response: { ...session, sessionId: id, mode: 'remux', mime: 'application/vnd.apple.mpegurl', url: `/api/playback/${id}/remote/master` } } as any);
    const hls = (await app.inject({ method: 'POST', url: `/api/playback/${id}/cast`, headers, payload: {} })).json();
    const master = await app.inject(hls.url);
    assert.equal(master.statusCode, 200); assert.ok(!master.body.includes('/api/playback/')); assert.match(master.body, new RegExp(`/api/cast/${hls.token}/${id}/remote/child`));
    const playlist = await app.inject(hls.url.replace('master', 'child'));
    assert.equal(playlist.statusCode, 200); assert.ok(!playlist.body.includes('/api/playback/')); assert.ok(playlist.body.includes(`/api/cast/${hls.token}/${id}/remote/init`));
    await app.inject({ method: 'DELETE', url: `/api/playback/${id}`, headers });
    assert.equal((await app.inject(hls.url)).statusCode, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('cast expiry and ASS captions retain timing and escape text', async () => {
  const subtitle = castSubtitle({ format: 'ass', label: 'ASS', offset: -1, content: '[Script Info]\nTitle: Cast\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.50,0:00:02.00,Default,{\\an8}한글 <b> & 日本語\\N둘째 줄\nDialogue: 0,0:00:00.00,0:00:02.00,Default,{\\p1}m 0 0 l 10 10' });
  assert.match(subtitle, /00:00:00.000 --> 00:00:01.000\n한글 &lt;b&gt; &amp; 日本語\n둘째 줄/);
  assert.ok(!subtitle.includes('m 0 0'));
  const casting = new Casting({ get: () => ({ id: 'p' }) } as any, () => ({ profile: 'p', response: {} as any }), () => 2000);
  (casting as any).grants.set('t', { profile: 'p', sessionId: 's', expiresAt: 1999 });
  assert.throws(() => casting.authorize({ params: { token: 't', sessionId: 's' } } as any), /cast-expired/);
});
