import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { OnlineSubtitles, sqliteCache, type OnlineClient } from '../src/subtitles/online.js';
import { Enrichment, validMarkers } from '../src/playback/enrichment.js';
import { config } from '../src/config.js';
import { ANALYSIS_VERSION, type SeasonAnalysis, type SkipMarkers } from '../src/playback/skip-markers/index.js';

const candidate = { id: 'candidate', creatorId: 'creator', creatorName: '제작자', sourceUrl: 'https://example.org/post', filename: '14.ass', format: 'ass' as const, content: '[Script Info]\nTitle: Korean', episode: 3, matchedEpisode: 14, title: '구름 정원 2기', season: 2, confidence: .9 };
const client: OnlineClient = { async resolveKoreanTitle() { return '구름 정원 2기'; }, async searchSubtitles() { return [candidate]; } };
const noAni = { async lookup() { return { match: null, intervals: [], markers: null }; } };
async function populate(db: Store, root: string, count = 1, media = 'media') {
  db.run('INSERT OR IGNORE INTO folders(id,path,type,label) VALUES(?,?,?,?)', 'folder', root, 'anime', 'test');
  db.run('INSERT INTO media VALUES(?,?,?,?,?,?)', media, 'folder', 'Example TV', 'anime', '{}', '2026-10-02');
  for (let i = 1; i <= count; i++) {
    const id = `${media}-${i}`, file = path.join(root, `${id}.mp4`); await writeFile(file, 'test-video'); const s = await stat(file);
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', id, media, 2, i === 1 && count === 1 ? 3 : i, `${i}화`, 1500, null);
    db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', id, file, s.size, s.mtimeMs, '', JSON.stringify({ duration: 1500, container: 'mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }] }), '[]');
  }
}
test('online subtitles: profile/episode binding, expiry, deduplication, persisted content, deletion and settings', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-online-')), root = path.join(temp, 'media'); await mkdir(root);
  const overrides = { dataDir: path.join(temp, 'data'), mediaRoot: root, webDir: path.join(temp, 'web') };
  let env = await buildApp(overrides, false, { subtitleClient: client, aniSkip: noAni });
  try {
    await env.app.ready(); await populate(env.db, root);
    const p = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'P' } })).json();
    const p2 = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'P2' } })).json();
    const headers = { 'x-moa-profile': p.id }, url = '/api/episodes/media-1/subtitles/online';
    assert.equal((await env.app.inject(url)).statusCode, 401);
    assert.equal((await env.app.inject({ url: '/api/episodes/missing/subtitles/online', headers })).statusCode, 404);
    assert.equal((await env.app.inject({ url: '/api/settings', headers })).json().autoFetchSubtitles, true);
    assert.equal((await env.app.inject({url:'/api/settings',headers})).json().experimentalSubtitleSync,true);
    assert.equal((await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{experimentalSubtitleSync:false}})).json().experimentalSubtitleSync,false);
    assert.equal((await env.app.inject({url:'/api/settings',headers:{'x-moa-profile':p2.id}})).json().experimentalSubtitleSync,true);
    assert.equal((await env.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { autoFetchSubtitles: false } })).json().autoFetchSubtitles, false);
    assert.equal((await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{subtitleSize:'xlarge'}})).json().subtitleSize,'xlarge');
    const search = (await env.app.inject({ url, headers })).json();
    assert.equal(search.resolvedTitle, '구름 정원 2기'); assert.equal(search.partial, false); assert.equal(search.candidates[0].content, undefined);
    const payload = { searchId: search.searchId, candidateId: 'candidate' };
    assert.equal((await env.app.inject({ method: 'POST', url, headers: { 'x-moa-profile': p2.id }, payload })).statusCode, 404);
    env.db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'other', 'media', 2, 4, '4화', 1500, null);
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/episodes/other/subtitles/online', headers, payload })).statusCode, 404);
    assert.equal((await env.app.inject({ method: 'POST', url, headers, payload: { ...payload, candidateId: 'https://attacker' } })).statusCode, 404);
    const track = (await env.app.inject({ method: 'POST', url, headers, payload })).json();
    assert.equal(track.label, '제작자 · 한국어'); assert.equal(track.lang, 'ko'); assert.equal(track.source, 'online'); assert.deepEqual(track.provenance, { creatorName: candidate.creatorName, sourceUrl: candidate.sourceUrl });
    const duplicate = (await env.app.inject({ method: 'POST', url, headers, payload })).json();
    assert.equal(duplicate.id, track.id);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 30 * 60_000 + 1;
      assert.throws(() => env.online.asset(duplicate.url.split('/')[3], `${track.id}.ass`), (e: any) => e.error === 'session-expired');
    } finally { Date.now = clock; }
    assert.equal(env.db.get('SELECT COUNT(*) AS n FROM online_subtitles')!.n, 1);
    assert.equal((await env.app.inject(track.url)).body, candidate.content);
    assert.equal((await env.app.inject({ url: track.url, headers: { 'x-moa-profile': p2.id } })).statusCode, 403);
    assert.equal((await env.app.inject(track.url.replace('/subtitles/', '/subtitles/wrong-'))).statusCode, 404);
    assert.equal((await env.app.inject(`/api/episodes/media-1/subtitles/${track.id}/content`)).statusCode, 401);
    assert.equal((await env.app.inject({ url: `/api/episodes/media-1/subtitles/${track.id}/content`, headers })).body, candidate.content);
    env.online.searches.get(search.searchId)!.expiresAt = 0;
    assert.equal((await env.app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
    assert.equal((await env.app.inject({ url: '/api/home?providers=local', headers })).json().rows[0].items[0].title, '구름 정원 2기');
    assert.equal((await env.app.inject({ url: '/api/media/media', headers })).json().title, '구름 정원 2기');
    for (const q of ['example tv', '구름정원']) assert.equal((await env.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers })).json().groups[0].items.length, 1);
    assert.equal(env.db.get('SELECT title FROM media')!.title, 'Example TV');
    await env.app.close(); env = await buildApp(overrides, false, { subtitleClient: client, aniSkip: noAni });
    const session = (await env.app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'media-1', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    assert.equal(session.mediaTitle, '구름 정원 2기'); assert.equal(session.subtitles[0].source, 'online');
    assert.equal((await env.app.inject(session.subtitles[0].url)).body, candidate.content);
    assert.equal((await env.app.inject({ method: 'DELETE', url: `/api/episodes/media-1/subtitles/${track.id}`, headers })).statusCode, 204);
    assert.equal((await env.app.inject(session.subtitles[0].url)).statusCode, 404);
    assert.equal((await env.app.inject(track.url)).statusCode, 404);
    assert.equal(env.playback.sessions.get(session.sessionId)!.response.subtitles.length, 0);
  } finally { await env.app.close(); await rm(temp, { recursive: true, force: true }); }
});
test('Korean title/cache adapter preserve originals on failed resolution and ignore expired/corrupt cache', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-title-')), db = new Store(temp); await populate(db, temp);
  let calls = 0;
  const online = new OnlineSubtitles(db, () => {}, { async searchSubtitles() { return []; }, async resolveKoreanTitle() { calls++; return 'Example TV 2기'; } });
  try {
    assert.equal(await online.resolveTitle('media', 'Example TV', 2), 'Example TV');
    await online.resolveTitle('media', 'Example TV', 2); assert.equal(calls, 1);
    const cache = sqliteCache(db); await cache.set('expired', { value: [], expiresAt: 0 }); assert.equal(await cache.get('expired'), undefined);
    db.run('INSERT INTO enrichment_cache VALUES(?,?,?)', 'corrupt', '{', Date.now() + 10000); assert.equal(await cache.get('corrupt'), undefined);
    await cache.set('valid', { value: { test: 1 } }); assert.deepEqual((await cache.get('valid'))!.value, { test: 1 });
  } finally { online.close(); db.close(); await rm(temp, { recursive: true, force: true }); }
});
function result(db: Store, episodes: { id: string }[]): SeasonAnalysis {
  return { version: ANALYSIS_VERSION, cacheKey: 'test', elapsedMs: 10, cached: false, backend: 'chromaprint', episodes: episodes.map(e => {
    const file = db.get('SELECT * FROM files WHERE episode_id=?', e.id)!;
    return { id: e.id, file: { path: file.path, size: file.size, mtimeMs: file.mtime }, duration: 1500, markers: { introStart: 5, introEnd: 95, creditsStart: 1330, creditsEnd: 1420, source: 'fingerprint', confidence: .9 }, intro: null, credits: null };
  }) };
}
test('season queue is serial, survives restart, cancels stale revisions and preserves current results', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-queue-')), db = new Store(temp); await populate(db, temp, 3); await populate(db, temp, 3, 'second');
  const online = new OnlineSubtitles(db, () => {}, client);
  let active = 0, maximum = 0, calls = 0, cancelled = 0;
  const enrichment = new Enrichment(db, config({ dataDir: temp, mediaRoot: temp }), online, () => {}, { aniSkip: noAni, analyze: async (episodes, signal) => {
    active++; maximum = Math.max(maximum, active); calls++;
    try {
      if (calls === 1) await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => { cancelled++; reject(new Error('cancel')); }, { once: true }));
      return result(db, episodes);
    } finally { active--; }
  } });
  try {
    enrichment.schedule();
    const old = db.get('SELECT * FROM files WHERE episode_id=?', 'media-1')!;
    db.run('UPDATE files SET size=size+1 WHERE episode_id=?', 'media-1'); enrichment.schedule();
    await enrichment.pending;
    assert.equal(maximum, 1); assert.equal(cancelled, 1); assert.equal(calls, 3);
    assert.equal(db.all("SELECT * FROM skip_analysis_jobs WHERE status='complete'").length, 2);
    const marker = db.get('SELECT * FROM episode_skip_markers WHERE episode_id=?', 'media-1')!;
    assert.equal(marker.file_size, old.size + 1); assert.equal(validMarkers(marker, old), null);
    assert.equal((await enrichment.markers('media-1'))!.creditsEnd, 1420);
    enrichment.schedule(); await enrichment.pending; assert.equal(calls, 3);
    // Removing an episode changes season membership and invalidates every old season detection.
    db.run('DELETE FROM episodes WHERE id=?', 'media-3'); enrichment.schedule(); await enrichment.pending;
    assert.equal(db.all("SELECT * FROM episode_skip_markers WHERE episode_id LIKE 'media-%'").length, 0);
    db.run("UPDATE skip_analysis_jobs SET status='running' WHERE media_id='second'");
    await enrichment.close();
    const restarted = new Enrichment(db, config({ dataDir: temp, mediaRoot: temp }), online, () => {}, { aniSkip: noAni, analyze: async episodes => result(db, episodes) });
    assert.equal(db.get("SELECT status FROM skip_analysis_jobs WHERE media_id='second'")!.status, 'queued');
    restarted.schedule(); await restarted.pending; await restarted.close();
  } finally { online.close(); await enrichment.close(); db.close(); await rm(temp, { recursive: true, force: true }); }
});
test('AniSkip fills undetected intervals, creditsEnd reaches playback, manual wins and changed editions invalidate', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-markers-')), root = path.join(temp, 'media'); await mkdir(root);
  let queries = 0;
  const markers: SkipMarkers = { introStart: 5, introEnd: 95, creditsStart: 1320, creditsEnd: 1410, source: 'aniskip', confidence: .75 };
  const env = await buildApp({ dataDir: temp, mediaRoot: root }, false, { subtitleClient: client, aniSkip: { async lookup(q) { queries++; assert.equal(q.episodeLength, 1500); return { match: null, intervals: [], markers }; } } });
  try {
    await env.app.ready(); await populate(env.db, root);
    const p = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'P' } })).json();
    const session = (await env.app.inject({ method: 'POST', url: '/api/playback', headers: { 'x-moa-profile': p.id }, payload: { episodeId: 'media-1', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    assert.deepEqual(session.markers, { introStart: 5, introEnd: 95, creditsStart: 1320, creditsEnd: 1410, source: 'aniskip' });
    const f = env.db.get('SELECT * FROM files')!;
    env.db.run('INSERT INTO episode_skip_markers VALUES(?,?,?,?,?,?,?,?)', 'media-1', 'manual', JSON.stringify({ introStart: 10, introEnd: 100, source: 'manual', confidence: 1 }), f.path, f.size, f.mtime, null, Date.now());
    const combined = await env.enrichment.markers('media-1'); assert.equal(combined!.introStart, 10); assert.equal(combined!.creditsEnd, 1410); assert.equal(combined!.source, 'manual');
    env.db.run('UPDATE files SET mtime=mtime+1');
    assert.equal((await env.enrichment.markers('media-1'))!.introStart, 5);
    assert.ok(queries >= 2);
  } finally { await env.app.close(); await rm(temp, { recursive: true, force: true }); }
});

// The remaining known title tests the bundled episode-offset/alias policy; all responses are synthetic.
test('remote subtitles infer explicit seasons; title lookup cannot hold collection; AniSkip uses real duration, cache and aliases', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'moa-remote-enrichment-'));
  let collectionStarted = false, lookups = 0;
  const calls: any[] = [];
  const env = await buildApp({dataDir:temp,mediaRoot:temp,webDir:path.join(temp,'web')},false,{
    subtitleClient:{
      async resolveKoreanTitle() { await new Promise(r=>setTimeout(r,10)); assert.ok(collectionStarted); return '최애의 아이 2기'; },
      async searchSubtitles(query) { collectionStarted=true; calls.push(query); return [candidate]; }
    },
    aniSkip:{async lookup(query){lookups++; calls.push(query); return {match:null,intervals:[],markers:{introStart:12,introEnd:102,creditsStart:1300,creditsEnd:1390,source:'aniskip',confidence:.75}};}}
  });
  try {
    await env.app.ready();
    env.db.run("INSERT INTO source_entries(id,repository,entry,enabled,type) VALUES('source','https://example.org/index.json','{}',1,'anime')");
    env.db.run("INSERT INTO media VALUES('remote',NULL,'최애의 아이 2기','anime','{}','2026-10-02')");
    env.db.run("INSERT INTO source_media(media_id,source_id,url) VALUES('remote','source','https://example.org/show')");
    for(const n of Array.from({length:13},(_,i)=>12+i)) env.db.run('INSERT INTO episodes VALUES(?,?,1,?,?,0,NULL)',`remote-${n}`,'remote',n,`${n}화`);
    const p=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'Remote'}})).json();
    const headers={'x-moa-profile':p.id};
    const search=await env.app.inject({url:'/api/episodes/remote-14/subtitles/online',headers});
    assert.equal(search.statusCode,200); assert.equal(calls[0].season,2); assert.equal(calls[0].episode,3);
    env.db.run("DELETE FROM episodes WHERE id='remote-24'");
    await env.app.inject({url:'/api/episodes/remote-14/subtitles/online',headers});
    assert.equal(calls.pop().episode,14,'an incomplete list must not be guessed as absolute numbering');
    env.db.run("INSERT INTO episodes VALUES('remote-24','remote',1,24,'24화',0,NULL)");
    const url='/api/episodes/remote-14/markers?duration=1470';
    assert.equal((await env.app.inject(url)).statusCode,401);
    assert.equal((await env.app.inject({url:'/api/episodes/remote-14/markers?duration=0',headers})).statusCode,400);
    const result=(await env.app.inject({url,headers})).json();
    assert.equal(result.status,'matched');assert.equal(result.markers.creditsEnd,1390);
    assert.equal(calls[1].season,2);assert.equal(calls[1].episodeNumber,3);assert.equal(calls[1].episodeLength,1470);
    assert.ok(calls[1].aliases.includes('Oshi no Ko'));
    await env.app.inject({url,headers});assert.equal(lookups,1);
    await env.app.inject({url:url.replace('1470','1500'),headers});assert.equal(lookups,2,'edition duration is part of the cache identity');
    env.db.run("UPDATE source_entries SET live=1 WHERE id='source'");
    assert.equal((await env.app.inject({url,headers})).json().status,'unsupported');
    assert.equal(lookups,2);
    assert.equal(env.db.get("SELECT COUNT(*) n FROM episode_skip_markers")!.n,0,'remote cache never masquerades as local file analysis');
  } finally {await env.app.close(); await rm(temp,{recursive:true,force:true});}
});

test('subtitle diagnostics distinguish access denial and stay isolated between simultaneous searches', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-sub-diagnostics-'));
  const env = await buildApp({ dataDir:temp, mediaRoot:temp, analyzeOnScan:false, logger:false, aniClient:noAni });
  const {db, online} = env; await populate(db,temp);
  const client = online.client as any;
  client.resolveKoreanTitle = async (title:string) => title;
  client.searchSubtitles = async (query:any) => {
    await new Promise(resolve=>setTimeout(resolve,query.title==='차단작품'?10:2));
    client.options.onDiagnostic({stage:'page',code:query.title==='차단작품'?'error':'not-found',creatorName:'제작자',message:query.title==='차단작품'?'HTTP 403 from example.org/private?token=secret':'No matching attachment'});
    return [];
  };
  try {
    const [blocked,missing] = await Promise.all([
      online.search('media-1','p',undefined,{title:'차단작품'}),
      online.search('media-1','p2',undefined,{title:'없는작품'})
    ]);
    assert.deepEqual(blocked.issues,[{kind:'access-denied',creatorName:'제작자'}]);
    assert.equal(blocked.partial,true);
    assert.deepEqual(missing.issues,[{kind:'not-found',creatorName:'제작자'}]);
    assert.equal(missing.partial,false);
    assert.ok(!JSON.stringify(blocked).includes('secret'));
  } finally {await env.app.close();await rm(temp,{recursive:true,force:true});}
});
