import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

test('API profile isolation, contract shapes, range streaming and SPA routing', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-api-'));
  const mediaRoot = path.join(temp, 'media'), webDir = path.join(temp, 'web');
  await mkdir(mediaRoot); await mkdir(webDir); await writeFile(path.join(webDir, 'index.html'), '<html>MOA</html>');
  const { app, db, playback } = await buildApp({ dataDir: path.join(temp, 'data'), mediaRoot, webDir }, false, { aniSkip: { async lookup() { return { match: null, intervals: [], markers: null }; } } });
  try {
    assert.deepEqual((await app.inject('/api/health')).json(), { ok: true, version: '0.1.0' });
    assert.equal((await app.inject({ url: '/api/profiles', headers: { 'x-moa-profile': 'deleted-profile' } })).statusCode, 200);
    for (const url of ['/api/home', '/api/media', '/api/library/folders', '/api/settings']) assert.deepEqual((await app.inject(url)).json(), { error: 'profile-required' });
    const p = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '테스트' } })).json();
    const other = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '두번째', kids: true } })).json();
    const headers = { 'x-moa-profile': p.id }, otherHeaders = { 'x-moa-profile': other.id };
    assert.deepEqual((await app.inject({ url: '/api/home', headers })).json().rows, []);
    assert.equal((await app.inject({ url: '/api/home', headers: { 'x-moa-profile': 'missing' } })).statusCode, 401);
    assert.deepEqual((await app.inject({ url: '/api/settings', headers })).json(), DEFAULT_SETTINGS);
    await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { autoplayDelay: 9 } });
    assert.equal((await app.inject({ url: '/api/settings', headers: otherHeaders })).json().autoplayDelay, 5);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { autoplayDelay: -1 } })).statusCode, 400);
    const style = { subtitleScale: 125, subtitleBackground: 'soft', subtitleShadow: 2.5, subtitleOutline: 1.2, subtitleHeight: 12, subtitlePadding: 8 };
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: style })).statusCode, 200);
    const savedStyle = (await app.inject({ url: '/api/settings', headers })).json();
    for (const [key, value] of Object.entries(style)) assert.equal(savedStyle[key], value);
    assert.equal((await app.inject({ url: '/api/settings', headers: otherHeaders })).json().subtitleShadow, undefined);
    for (const invalid of [{ subtitleScale: 0 }, { subtitleShadow: 11 }, { subtitleOutline: -1 }, { subtitleHeight: 41 }, { subtitlePadding: 21 }, { subtitleBackground: 'red' }]) {
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: invalid })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { subtitleShadow: null, subtitleOutline: 0 } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/settings', headers })).json().subtitleOutline, 0);
    const navigation = [{ id: 'home', name: '홈', sourceIds: ['remote-test'], includeLocal: false, sourceFilters: { 'remote-test': {revision:'test',filters:[{position:2,value:1},{position:3,value:false},{position:4,value:'123'},{position:5,value:{index:1,ascending:true}}]} } }, { id: 'local', name: '내 영상', sourceIds: [], includeLocal: true }];
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { navigation } })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/settings', headers })).json().navigation, navigation);
    assert.equal((await app.inject({ url: '/api/settings', headers: otherHeaders })).json().navigation, undefined);
    for (const bad of [[navigation[1]], [navigation[0],navigation[0]], [{ ...navigation[0], name: ' ' }]]) {
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { navigation: bad } })).statusCode, 400);
    }
    const folder = (await app.inject({ method: 'POST', url: '/api/library/folders', headers, payload: { path: mediaRoot, type: 'anime' } })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/api/library/folders', headers, payload: { path: temp, type: 'anime' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/library/folders', headers, payload: { path: mediaRoot, type: 'movie' } })).statusCode, 409);
    const file = path.join(mediaRoot, 'Show.S02E03.mp4'); await writeFile(file, '0123456789abcdef');
    db.run('INSERT INTO media VALUES(?,?,?,?,?,?)', 'media', folder.id, 'Show', 'anime', '{}', '2026-10-02');
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'ep', 'media', 2, 3, '3화', 1400, null);
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'next', 'media', 2, 4, '4화', 1400, null);
    db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', 'ep', file, 16, 0, '', JSON.stringify({ duration: 1400, container: 'mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }), '[]');
    const progress = await app.inject({ method: 'POST', url: '/api/progress', headers, payload: { episodeId: 'ep', position: 680, duration: 1400 } });
    assert.equal(progress.json().completed, false);
    const detail = (await app.inject({ url: '/api/media/media', headers })).json();
    assert.deepEqual(detail.playTarget, { episodeId: 'ep', position: 680, label: '이어보기 S2:E3' });
    const franchiseUrl = '/api/media/media/franchise';
    assert.equal((await app.inject(franchiseUrl)).statusCode, 401);
    const franchise = (await app.inject({ url: franchiseUrl, headers })).json();
    assert.equal(franchise.complete, true);
    assert.deepEqual(franchise.seasons.map((s: any) => [s.key, s.mediaId, s.seasonNumber, s.episodeCount, s.current]), [['s2', 'media', 2, 2, true]]);
    assert.equal((await app.inject({ url: '/api/media/missing/franchise', headers })).statusCode, 404);
    db.run('UPDATE profiles SET kids=1 WHERE id=?', other.id);
    assert.equal((await app.inject({ url: franchiseUrl, headers: otherHeaders })).statusCode, 403);
    db.run('UPDATE profiles SET kids=0 WHERE id=?', other.id);
    db.run('UPDATE profiles SET account_id=? WHERE id=?', 'different-account', other.id);
    assert.equal((await app.inject({ url: franchiseUrl, headers: otherHeaders })).statusCode, 401);
    db.run('UPDATE profiles SET account_id=? WHERE id=?', 'local', other.id);

    assert.equal(detail.progress.label, 'S2:E3 · 12분 남음');
    assert.equal((await app.inject({ url: '/api/media/media', headers: otherHeaders })).json().progress, undefined);
    await app.inject({ method: 'PUT', url: '/api/watchlist/media', headers });
    assert.equal((await app.inject({ url: '/api/watchlist', headers })).json().length, 1);
    assert.equal((await app.inject({ url: '/api/watchlist', headers: otherHeaders })).json().length, 0);
    assert.equal((await app.inject({ url: '/api/home?providers=local', headers })).json().rows[0].layout, 'landscape');
    assert.deepEqual((await app.inject({ url: '/api/home', headers })).json(), { hero: [], rows: [] }, 'default home excludes local media even from continue/watchlist');
    assert.deepEqual((await app.inject({ url: '/api/home?providers=other', headers })).json(), { hero: [], rows: [] }, 'unselected providers cannot leak into a tab');

    assert.equal((await app.inject({ url: '/api/search?q=s%20h%20o%20w', headers })).json().groups[0].items.length, 1);
    assert.equal((await app.inject({ url: '/api/history', headers })).json().items[0].episode.id, 'ep');
    const session = (await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'ep', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    assert.equal(session.mode, 'direct'); assert.equal(session.startPosition, 680); assert.equal(session.next.episodeId, 'next');
    assert.equal(session.mediaId, 'media'); assert.equal(session.mediaTitle, 'Show'); assert.equal(session.mediaType, 'anime');
    assert.equal(session.episodeLabel, 'S2:E3'); assert.equal(session.episodeTitle, '3화');
    // Media element requests cannot supply X-Moa-Profile; the session URL grants access.
    const partial = await app.inject({ url: session.url, headers: { range: 'bytes=3-6' } });
    assert.equal(partial.statusCode, 206); assert.equal(partial.body, '3456'); assert.equal(partial.headers['content-range'], 'bytes 3-6/16');
    assert.equal((await app.inject({ url: session.url, headers: { range: 'bytes=-4' } })).body, 'cdef');
    assert.equal((await app.inject({ url: session.url, headers: { range: 'bytes=16-' } })).statusCode, 416);
    assert.equal((await app.inject({ url: session.url, headers: otherHeaders })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/playback/${session.sessionId}`, headers })).statusCode, 204);
    assert.equal((await app.inject(session.url)).statusCode, 404);
    assert.equal(playback.sessions.size, 0);
    const hls = (await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'ep', startPosition: 200, capabilities: { h264: true, hevc: false, av1: false, vp9: false, audioCodecs: ['aac'], maxHeight: 720 } } })).json();
    assert.equal(hls.mode, 'transcode');
    const manifest = (await app.inject(hls.url)).body;
    assert.equal((manifest.match(/#EXT-X-MAP:/g) || []).length, 1);
    assert.match(manifest, /#EXT-X-MAP:URI="init\.mp4"/);
    assert.match(manifest, /#EXT-X-START:TIME-OFFSET=200\.000/);
    assert.equal((manifest.match(/^seg-\d+\.m4s$/gm) || []).length, 700);
    assert.ok(manifest.endsWith('#EXT-X-ENDLIST\n'));
    await playback.remove(hls.sessionId);
    db.run('UPDATE media SET type=? WHERE id=?', 'movie', 'media');
    const movie = (await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'ep', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    assert.equal(movie.mediaTitle, 'Show'); assert.equal(movie.mediaType, 'movie');
    assert.equal(movie.episodeTitle, undefined); assert.equal(movie.episodeLabel, undefined); assert.equal(movie.next, null);
    await playback.remove(movie.sessionId);
    assert.equal((await app.inject('/a/deep/spa/path')).body, '<html>MOA</html>');
    assert.equal((await app.inject({ url: '/api/missing', headers })).statusCode, 404);
    await app.inject({ method: 'DELETE', url: `/api/profiles/${p.id}` });
    assert.equal(db.get('SELECT 1 FROM progress WHERE profile_id=?', p.id), undefined);
  } finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
});

test('resolve API accepts query and serializes language preference, languages and season fields', async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'moa-resolve-api-'));
  const {app,db}=await buildApp({dataDir:temp,mediaRoot:temp,webDir:temp},false);
  try {
    const p=(await app.inject({method:'POST',url:'/api/profiles',payload:{name:'감사'}})).json();
    const headers={'x-moa-profile':p.id};
    for(const lang of ['en','ko']) {
      db.run('INSERT INTO source_entries(id,repository,entry,enabled) VALUES(?,?,?,1)',lang,'fixture',JSON.stringify({lang}));
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',lang,'작품 2기','anime',JSON.stringify({provider:{id:lang,name:lang,kind:'mangayomi-js'}}),'2026');
    }
    const response=await app.inject({method:'POST',url:'/api/media/groups/resolve',headers,payload:{ids:['en','ko'],query:'작품'}});
    assert.equal(response.statusCode,200);
    const [card]=response.json();assert.equal(card.id,'ko');assert.equal(card.provider.lang,'ko');assert.deepEqual(card.langs,['en','ko']);
    assert.equal(card.baseTitle,'작품');assert.equal(card.seasonInfo.label,'시즌 2');assert.equal(card.relevance,1);assert.equal(card.sourceCount,2);
    for(const id of ['en','ko']) await app.inject({method:'PUT',url:`/api/watchlist/${id}`,headers});
    const groupedHome=(await app.inject({url:'/api/home',headers})).json();
    const rawHome=(await app.inject({url:'/api/home?titleGrouping=false',headers})).json();
    assert.equal(groupedHome.rows.find((r:any)=>r.kind==='watchlist').items.length,1);
    assert.equal(rawHome.rows.find((r:any)=>r.kind==='watchlist').items.length,2);
    const detail=(await app.inject({url:'/api/media/ko',headers})).json();assert.equal(detail.provider.lang,'ko');assert.equal(detail.seasonInfo.label,'시즌 2');
    assert.equal((await app.inject({method:'POST',url:'/api/media/groups/resolve',headers,payload:{ids:['ko'],query:'x'.repeat(501)}})).statusCode,400);
  } finally {await app.close();await rm(temp,{recursive:true,force:true});}
});
