import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SourceVideo } from '@moa/extensions';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog.js';
import { Sources } from '../src/sources.js';
import { Playback } from '../src/playback.js';
import { Downloads } from '../src/downloads.js';
import { preferredQuality, qualityHeight } from '../src/download-quality.js';
import { transferVideo } from '../src/download-transfer.js';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';

const probe = { duration: 1200, startTime: 0, container: 'mov,mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] };
const caps = { h264: true, hevc: false, av1: false };
async function fakeProbe(executable: string, duration = 1200) {
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ format: { duration: String(duration), format_name: 'mov,mp4', start_time: '0' }, streams: probe.streams }))});\n`, { mode: 0o700 });
}
// No sockets are connected: this is the external HTTP transport boundary.
function incoming(body: string | Buffer, mime = 'video/mp4', statusCode = 200, extra: Record<string, string> = {}) {
  const response = new IncomingMessage(new Socket());
  response.statusCode = statusCode;
  const bytes = Buffer.from(body);
  response.headers = { 'content-type': mime, 'content-length': String(bytes.length), ...extra };
  let sent = false;
  response._read = () => { if (!sent) { sent = true; response.push(bytes); response.push(null); } };
  return response;
}
async function layout() {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-downloads-'));
  const dataDir = path.join(dir, 'data'), mediaRoot = path.join(dir, 'media'), downloadRoot = path.join(dir, 'downloads');
  await Promise.all([dataDir, mediaRoot, downloadRoot].map(p => mkdir(p)));
  // Lifecycle doubles only: these do NOT validate media or perform a real remux.
  const ffmpeg = path.join(dir, 'fake-ffmpeg'), ffprobe = path.join(dir, 'fake-ffprobe');
  await fakeProbe(ffprobe);
  await writeFile(ffmpeg, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),input=args[args.indexOf('-i')+1];
if(args.some(a=>/^https?:/.test(a)))process.exit(2);
const playlists=fs.readdirSync(path.dirname(input)).filter(n=>n.endsWith('.m3u8')).map(n=>fs.readFileSync(path.join(path.dirname(input),n),'utf8'));
if(playlists.some(s=>/https?:/.test(s)))process.exit(3);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'remux-call.json'))},JSON.stringify({args,playlists}));
fs.writeFileSync(args.at(-1),'synthetic remux output');\n`, { mode: 0o700 });
  return { dir, cfg: config({ dataDir, mediaRoot, downloadRoot, webDir: path.join(dir, 'web'), ffmpeg, ffprobe, requireAccount: false }) };
}
function seed(db: Store) {
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('viewer','Viewer','#fff',0,'2026')");
  const entry = JSON.stringify({ id: 'fixture', name: 'Synthetic source', version: '1', baseUrl: 'https://source.test/' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'source', 'fixture', entry, entry, 'fixture');
  db.run("INSERT INTO media VALUES('m',NULL,'Movie','movie','{}','2026')");
  db.run("INSERT INTO episodes VALUES('ep','m',1,1,'Episode',1200,NULL)");
  db.run("INSERT INTO source_media VALUES('m','source','/title',0)");
  db.run("INSERT INTO source_episodes VALUES('ep','/episode')");
}
type Transport = NonNullable<ConstructorParameters<typeof Downloads>[4]>;
async function fixture(t: TestContext, transport: Transport, item: SourceVideo = { url: 'https://source.test/video.mp4', quality: '720p' }) {
  const { dir, cfg } = await layout();
  const db = new Store(cfg.dataDir, new DatabaseSync(':memory:')), catalog = new Catalog(db);
  const sources = new Sources(db, catalog), playback = new Playback(db, catalog, cfg, () => {});
  seed(db);
  const released: Array<string | undefined> = []; let extractions = 0;
  // The synthetic extension extraction and APK control channel are external boundaries.
  sources.videos = async () => Object.assign([{ ...item }], { apkLease: `lease-${++extractions}` });
  sources.apk.release = async lease => { released.push(lease); };
  const downloads = new Downloads(db, cfg, sources, playback, transport);
  await downloads.initialize(); await downloads.configureSettings({quotaBytes:1024 ** 3,enabled:true});
  t.after(async () => { await downloads.close(); await playback.close(); await sources.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const create = async () => {
    const choices = await downloads.choices('ep', 'viewer');
    return downloads.create('ep', 'viewer', choices.selectionToken, choices.choices[0].id);
  };
  return { dir, cfg, db, sources, playback, downloads, released, create };
}
async function settled(downloads: Downloads, id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = (await downloads.status()).jobs.find(j => j.id === id)!;
    if (!downloads.busy && !['queued', 'resolving', 'downloading', 'finalizing'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('synthetic download did not settle within 5 seconds');
}
async function saved(db: Store, root: string, episode = 'ep', size = 16) {
  const id = randomUUID(), relative = `job-${id}/video.mp4`;
  await mkdir(path.join(root, `job-${id}`)); await writeFile(path.join(root, relative), '0123456789abcdef');
  db.run('INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, episode, 'm', 'source', 'viewer', 'ready', '720p', 'synthetic-selection', '2026', '2026');
  db.run('INSERT INTO download_assets VALUES(?,?,?,?,?,?)', episode, id, relative, size, JSON.stringify(probe), '[]');
  return id;
}

test('MP4 lifecycle registers one ready asset, releases APK leases and preserves IDs/history', async t => {
  const { downloads, db, cfg, released, create } = await fixture(t, async url => ({ url, response: incoming('synthetic MP4') }));
  db.run("INSERT INTO progress VALUES('viewer','ep',400,1200,0,'2026')");
  const job = await create(), done = await settled(downloads, job.id);
  assert.equal(done.state, 'ready', done.error || ''); assert.equal(done.bytes, Buffer.byteLength('synthetic MP4'));
  assert.deepEqual(released, ['lease-1', 'lease-2']);
  assert.deepEqual(await readdir(path.join(cfg.downloadRoot!, `job-${job.id}`)), ['video.mp4']);
  const asset = await downloads.asset('ep'); assert.ok(asset); assert.equal(await readFile(asset.path, 'utf8'), 'synthetic MP4');
  assert.equal(db.get('SELECT position FROM progress WHERE episode_id=?', 'ep')!.position, 400);
  const persisted = JSON.stringify(db.get('SELECT * FROM download_jobs WHERE id=?', job.id));
  assert.doesNotMatch(persisted, /https:|lease-|Cookie|Authorization/);
  const pick = await downloads.choices('ep', 'viewer');
  await assert.rejects(downloads.create('ep', 'viewer', pick.selectionToken, pick.choices[0].id), { error: 'download-already-exists' });
});

test('HLS VOD localizes relative map/key/ranges and strips credentials across origins before fake remux', async t => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/key",IV=0x00000000000000000000000000000001\n#EXTINF:10,\n#EXT-X-BYTERANGE:4@0\nsegments.bin\n#EXTINF:10,\n#EXT-X-BYTERANGE:4\nsegments.bin\n#EXT-X-ENDLIST\n';
  const transport: Transport = async (url, headers) => {
    const h = headers as Record<string, string>; requests.push({ url, headers: { ...h } });
    if (url.endsWith('index.m3u8')) return { url: 'https://source.test/vod/index.m3u8', response: incoming(manifest, 'application/vnd.apple.mpegurl') };
    if (url === 'https://keys.test/key') return { url, response: incoming(Buffer.alloc(16)) };
    if (url.endsWith('segments.bin')) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(h.Range)!;
      return { url, response: incoming('1234', 'video/mp2t', 206, { 'content-range': `bytes ${range[1]}-${range[2]}/8` }) };
    }
    return { url, response: incoming('init') };
  };
  const { downloads, dir, cfg, create, released } = await fixture(t, transport, { url: 'https://source.test/index.m3u8', quality: '720p', headers: { Cookie: 'session-secret', AUTHORIZATION: 'Bearer secret', Referer: 'https://source.test/watch' } });
  await fakeProbe(cfg.ffprobe, 20);
  const job = await create(), done = await settled(downloads, job.id);
  assert.equal(done.state, 'ready', done.error || ''); assert.deepEqual(released, ['lease-1', 'lease-2']);
  assert.ok(requests.some(r => r.url === 'https://source.test/vod/init.mp4'));
  assert.deepEqual(requests.filter(r => r.url.endsWith('segments.bin')).map(r => r.headers.Range), ['bytes=0-3', 'bytes=4-7']);
  assert.equal(requests[0].headers.Cookie, 'session-secret');
  const keyRequest = requests.find(r => r.url === 'https://keys.test/key')!;
  assert.equal(keyRequest.headers.Cookie, undefined); assert.equal(keyRequest.headers.AUTHORIZATION, undefined);
  assert.equal(keyRequest.headers.Referer, 'https://source.test/watch');
  const call = JSON.parse(await readFile(path.join(dir, 'remux-call.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(call), /https:|session-secret|Bearer secret/);
  assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file,crypto');
  assert.match(call.playlists.join('\n'), /METHOD=AES-128,URI="part-\d+\.bin"/);
  assert.match(call.playlists.join('\n'), /EXT-X-MAP:URI="part-\d+\.bin"/);
});

test('quota overflow during reception fails cleanly and releases the extraction lease', async t => {
  const { db, cfg, downloads, released, create } = await fixture(t, async url => ({ url, response: incoming('larger than remaining quota') }));
  db.run("INSERT INTO episodes VALUES('reserved','m',1,2,'Reserved',1200,NULL)");
  await saved(db, cfg.downloadRoot!, 'reserved', 1024 ** 3 - 2);
  const job = await create(), done = await settled(downloads, job.id);
  assert.equal(done.state, 'failed'); assert.equal(done.error, 'download-quota-exceeded');
  assert.equal(db.get("SELECT 1 FROM download_assets WHERE episode_id='ep'"), undefined);
  assert.ok(!(await readdir(cfg.downloadRoot!)).includes(`job-${job.id}`));
  assert.deepEqual(released, ['lease-1', 'lease-2']); assert.equal(downloads.busy, false);
});

test('cancel aborts an in-flight transport, cleans temporary files, releases lease and allows retry', async t => {
  let notify!: () => void; const started = new Promise<void>(resolve => { notify = resolve; }); let stall = true;
  const transport: Transport = async (url, _headers, signal) => {
    if (!stall) return { url, response: incoming('retry bytes') };
    const response = new IncomingMessage(new Socket()); response.statusCode = 200; response.headers = { 'content-type': 'video/mp4' }; response._read = () => {};
    response.on('error', () => {}); // Cancellation may race the consumer attaching its iterator.
    const abort = () => response.destroy(new Error('synthetic transport aborted'));
    signal?.addEventListener('abort', abort, { once: true }); response.once('close', () => signal?.removeEventListener('abort', abort));
    notify(); return { url, response };
  };
  const { downloads, cfg, released, create } = await fixture(t, transport);
  const job = await create(); await started;
  const cancelled = await downloads.cancel(job.id);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.error, 'download-cancelled');
  assert.deepEqual(released, ['lease-1', 'lease-2']); assert.deepEqual(await readdir(cfg.downloadRoot!), []);
  assert.equal(downloads.busy, false); stall = false;
  downloads.retry(job.id, 'viewer'); assert.equal((await settled(downloads, job.id)).state, 'ready');
  assert.deepEqual(released, ['lease-1', 'lease-2', 'lease-3']);
});

test('transfer rejects live HLS, DRM, truncated MP4 and invalid probe without ready output', async t => {
  const { dir, cfg } = await layout(); t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    { name: 'live', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:10,\nsegment.ts\n', error: 'download-live-unsupported' },
    { name: 'drm', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n', error: 'download-drm-unsupported' },
    { name: 'truncated', mime: 'video/mp4', body: '1234', error: 'download-truncated', headers: { 'content-length': '8' } },
  ];
  for (const c of cases) {
    const target = path.join(cfg.downloadRoot!, c.name); await mkdir(target);
    await assert.rejects(transferVideo(cfg, target, { url: 'https://source.test/video' }, async url => ({ url, response: incoming(c.body, c.mime, 200, c.headers) }), new AbortController().signal, async () => {}, () => {}), { error: c.error });
    assert.ok(!(await readdir(target)).includes('video.mp4'));
  }
  await writeFile(cfg.ffprobe, `#!${process.execPath}\nprocess.stdout.write('{"format":{"duration":"1200"},"streams":[]}');\n`, { mode: 0o700 });
  const target = path.join(cfg.downloadRoot!, 'bad-media'); await mkdir(target);
  await assert.rejects(transferVideo(cfg, target, { url: 'https://source.test/video.mp4' }, async url => ({ url, response: incoming('not valid media') }), new AbortController().signal, async () => {}, () => {}), { error: 'download-media-invalid' });
  assert.ok(!(await readdir(target)).includes('video.mp4'));
});

test('saved deletion guards opening sessions, escaped assets, symlinks and overlapping roots', async t => {
  const { db, cfg, downloads, dir } = await fixture(t, async url => ({ url, response: incoming('bytes') }));
  const id = await saved(db, cfg.downloadRoot!);
  await downloads.withSaved('ep', async asset => { assert.ok(asset); await assert.rejects(downloads.remove(id), { error: 'download-in-use' }); });
  const original = db.get('SELECT path FROM download_assets')!.path;
  const sentinel = path.join(dir, 'sentinel'); await mkdir(sentinel); await writeFile(path.join(sentinel, 'keep'), 'do not delete');
  db.run('UPDATE download_assets SET path=?', path.join(sentinel, 'keep'));
  await assert.rejects(downloads.asset('ep'), { error: 'path-outside-media-root' });
  db.run('UPDATE download_assets SET path=?', original);
  await rm(path.join(cfg.downloadRoot!, `job-${id}`), { recursive: true }); await symlink(sentinel, path.join(cfg.downloadRoot!, `job-${id}`));
  await assert.rejects(downloads.remove(id), { error: 'download-path-invalid' });
  assert.equal(await readFile(path.join(sentinel, 'keep'), 'utf8'), 'do not delete'); assert.ok(db.get('SELECT 1 FROM download_assets'));
  cfg.downloadRoot = cfg.dataDir; assert.equal((await downloads.status()).reason, 'download-storage-overlap');
});

test('startup interrupts queued work, cleans known partials, preserves unknown files and reconciles missing assets', async t => {
  const { db, cfg, downloads } = await fixture(t, async url => ({ url, response: incoming('bytes') }));
  const id = await saved(db, cfg.downloadRoot!);
  await rm(path.join(cfg.downloadRoot!, `job-${id}`, 'video.mp4'));
  db.run("INSERT INTO episodes VALUES('queued','m',1,2,'Queued',1200,NULL)");
  const queued = randomUUID();
  db.run('INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', queued, 'queued', 'm', 'source', 'viewer', 'queued', '720p', 'fixture', '2026', '2026');
  const partial = `job-${queued}`; await mkdir(path.join(cfg.downloadRoot!, partial));
  await writeFile(path.join(cfg.downloadRoot!, partial, 'input.part'), 'partial');
  const untracked = `job-${randomUUID()}`; await mkdir(path.join(cfg.downloadRoot!, untracked));
  await writeFile(path.join(cfg.downloadRoot!, untracked, 'video.mp4'), 'preserve after metadata restore');
  await mkdir(path.join(cfg.downloadRoot!, 'keep-this-folder'));
  await downloads.initialize();
  assert.equal(db.get('SELECT state FROM download_jobs WHERE id=?', queued)!.state, 'interrupted');
  assert.equal(db.get('SELECT error FROM download_jobs WHERE id=?', id)!.error, 'download-file-missing');
  assert.equal(db.get('SELECT 1 FROM download_assets'), undefined);
  assert.ok(!(await readdir(cfg.downloadRoot!)).includes(partial)); assert.ok((await readdir(cfg.downloadRoot!)).includes('keep-this-folder'));
  assert.equal(await readFile(path.join(cfg.downloadRoot!, untracked, 'video.mp4'), 'utf8'), 'preserve after metadata restore');
  assert.equal(downloads.used(), Buffer.byteLength('preserve after metadata restore'), 'untracked saved bytes still count against quota');
});

test('saved playback API works with source offline, resumes existing history and guards active deletion/source removal', async t => {
  const { dir, cfg } = await layout();
  const store = new Store(cfg.dataDir, new DatabaseSync(':memory:'));
  const { app, db, sources, playback } = await buildApp(cfg, false, { store, tmdb: { token: '', key: '' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  seed(db); const id = await saved(db, cfg.downloadRoot!);
  db.run("INSERT INTO progress VALUES('viewer','ep',400,1200,0,'2026')");
  let remoteCalls = 0; sources.videos = async () => { remoteCalls++; throw Error('synthetic source offline'); };
  const headers = { 'x-moa-profile': 'viewer' };
  const opened = await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'ep', capabilities: caps, location: 'auto' } });
  assert.equal(opened.statusCode, 200, opened.body); const session = opened.json();
  assert.equal(session.saved, true); assert.equal(session.episodeId, 'ep'); assert.equal(session.startPosition, 400); assert.equal(remoteCalls, 0);
  assert.equal(playback.get(session.sessionId).root, cfg.downloadRoot);
  const markerUrl=`/api/episodes/ep/markers?duration=1200&sessionId=${session.sessionId}`;
  assert.equal((await app.inject({url:markerUrl,headers})).statusCode,200);
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('other','Other','#fff',0,'2026')");
  db.run("UPDATE profiles SET account_id='local' WHERE id='other'");
  assert.equal((await app.inject({url:markerUrl,headers:{'x-moa-profile':'other'}})).statusCode,403);
  db.run("INSERT INTO episodes VALUES('other-episode','m',1,2,'Other episode',1200,NULL)");
  assert.equal((await app.inject({url:markerUrl.replace('/ep/','/other-episode/'),headers})).statusCode,400);

  const ranged = await app.inject({ url: session.url, headers: { range: 'bytes=3-6' } });
  assert.equal(ranged.statusCode, 206); assert.equal(ranged.body, '3456');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/downloads/${id}` })).json().error, 'download-in-use');
  const removal = await app.inject({ method: 'DELETE', url: '/api/sources/source', headers });
  assert.equal(removal.statusCode, 409); assert.equal(removal.json().error, 'source-has-downloads');
  db.run("UPDATE profiles SET kids=1 WHERE id='viewer'");
  const denied = await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { episodeId: 'ep', capabilities: caps, location: 'saved' } });
  assert.equal(denied.json().error, 'kids-restricted'); assert.equal(remoteCalls, 0);
  db.run("UPDATE profiles SET kids=0 WHERE id='viewer'");
  await playback.remove(session.sessionId);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/downloads/${id}` })).statusCode, 204);
  assert.ok(db.get("SELECT 1 FROM episodes WHERE id='ep'")); assert.equal(db.get("SELECT position FROM progress WHERE episode_id='ep'")!.position, 400);
});


test('deleting an externally removed saved directory reconciles metadata without deleting history', async t => {
  const { db, cfg, downloads } = await fixture(t, async url => ({url,response:incoming('bytes')}));
  const id=await saved(db,cfg.downloadRoot!);
  db.run("INSERT INTO progress VALUES('viewer','ep',400,1200,0,'2026')");
  await rm(path.join(cfg.downloadRoot!,`job-${id}`),{recursive:true});
  await downloads.remove(id);
  assert.equal(db.get('SELECT 1 FROM download_assets'),undefined);
  assert.equal(db.get('SELECT 1 FROM download_jobs'),undefined);
  assert.equal(db.get("SELECT position FROM progress WHERE episode_id='ep'")!.position,400);
});


test('disabled saving retains saved playback assets while denying new jobs', async t => {
  const { db, cfg, downloads } = await fixture(t, async url => ({url,response:incoming('bytes')}));
  await saved(db,cfg.downloadRoot!);cfg.downloadsEnabled=false;
  assert.equal((await downloads.status()).reason,'download-disabled');
  await assert.rejects(downloads.choices('ep','viewer'),{error:'download-disabled'});
  assert.ok(await downloads.asset('ep'));
});

test('saved list pages remain reachable across deletes and progress updates and can filter one title',async t=>{
  const {db,downloads}=await fixture(t,async url=>({url,response:incoming('bytes')}));
  db.transaction(()=>{
    for(let i=0;i<205;i++){
      const id=String(i).padStart(3,'0');
      db.run("INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,'ep','m','source','viewer','failed','720p','fixture','2026',?)",id,`2026-${id}`);
    }
    db.run("INSERT INTO media VALUES('second',NULL,'Same display title','movie','{}','2026')");
    db.run("INSERT INTO episodes VALUES('second-ep','second',1,1,'Episode',1200,NULL)");
    db.run("INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES('other','second-ep','second','source','viewer','failed','720p','fixture','2025','2025')");
  });
  // Retrying an old job must remain visible to the global OFF confirmation, even off-page.
  db.run("UPDATE download_jobs SET state='resolving' WHERE id='other'");
  const first=await downloads.status();assert.equal(first.activeJobs,1);assert.ok(first.jobs.every(job=>job.state==='failed'));assert.equal(first.jobs.length,200);assert.equal(first.totalJobs,206);assert.ok(first.nextCursor);
  const boundary=first.jobs.at(-1)!;
  await downloads.remove(boundary.id);
  db.run("UPDATE download_jobs SET updated_at='2099' WHERE id='002'");
  const next=await downloads.status({cursor:first.nextCursor!});
  assert.equal(next.jobs.length,6);assert.equal(next.totalJobs,205);assert.equal(next.nextCursor,null);
  assert.ok(next.jobs.every(j=>!first.jobs.some(p=>p.id===j.id)));
  assert.equal(new Set([...first.jobs,...next.jobs].map(j=>j.id)).size,206);
  const second=await downloads.status({mediaId:'second'});assert.deepEqual(second.jobs.map(j=>j.id),['other']);assert.equal(second.totalJobs,1);
  assert.equal((await downloads.status({mediaId:'m'})).activeJobs,1);
  db.run("UPDATE download_jobs SET state='failed' WHERE id='other'");
  assert.equal((await downloads.status()).activeJobs,0);
  await assert.rejects(downloads.status({mediaId:'second',cursor:first.nextCursor!}),{error:'download-query-invalid'});
  await assert.rejects(downloads.status({cursor:'not a cursor'}),{error:'download-query-invalid'});
});

test('selected removals can succeed independently while a playing copy stays protected',async t=>{
  const {db,cfg,downloads,playback}=await fixture(t,async url=>({url,response:incoming('bytes')}));
  const playing=await saved(db,cfg.downloadRoot!);
  db.run("INSERT INTO episodes VALUES('another','m',1,2,'Another',1200,NULL)");
  const removable=await saved(db,cfg.downloadRoot!,'another');
  playback.sessions.set('active',{response:{saved:true,episodeId:'ep'}} as never);
  try{
    const outcomes=[];
    for(const id of [playing,removable])try{await downloads.remove(id);outcomes.push('removed');}catch(e){outcomes.push((e as {error:string}).error);}
    assert.deepEqual(outcomes,['download-in-use','removed']);
    assert.ok(db.get('SELECT 1 FROM download_assets WHERE job_id=?',playing));
    assert.equal(db.get('SELECT 1 FROM download_jobs WHERE id=?',removable),undefined);
  }finally{playback.sessions.delete('active');}
});

test('saving stays opt-in even with an existing quota; enable validates storage, preserves assets and respects host override',async t=>{
  const {db,cfg,downloads}=await fixture(t,async url=>({url,response:incoming('bytes')}));
  db.run("DELETE FROM admin_settings WHERE key='downloadEnabled'");
  const status=await downloads.status();assert.equal(status.enabled,false);assert.equal(status.storageReady,true);assert.equal(status.configured,false);assert.equal(status.quality,'1080p');
  await assert.rejects(downloads.createPreferred('ep','viewer'),{error:'download-disabled'});
  await downloads.configureSettings({quality:'720p'});assert.equal(downloads.enabled(),false);
  const root=cfg.downloadRoot;cfg.downloadRoot=undefined;
  await assert.rejects(downloads.configureSettings({enabled:true}),{error:'download-storage-unconfigured'});
  assert.equal(downloads.enabled(),false);cfg.downloadRoot=root;
  cfg.downloadsEnabled=false;await assert.rejects(downloads.configureSettings({enabled:true}),{error:'download-disabled'});cfg.downloadsEnabled=true;
  await downloads.configureSettings({enabled:true});assert.equal((await downloads.status()).configured,true);
  await saved(db,root!);await downloads.configureSettings({enabled:false});assert.ok(await downloads.asset('ep'));
  await assert.rejects(downloads.configureSettings({enabled:true,quotaBytes:-1,quality:'best'}),{error:'download-quota-invalid'});
  assert.equal(downloads.enabled(),false);assert.equal(downloads.quality(),'720p');
});

test('preferred quality handles ceilings, source-order ties and unknown labels',()=>{
  const values=['server 2160p','720p first','1080p','720p second'];
  assert.equal(preferredQuality(values,'720p',qualityHeight),'720p first');
  assert.equal(preferredQuality(values,'best',qualityHeight),'server 2160p');
  assert.equal(preferredQuality(['1080p','2160p'],'480p',qualityHeight),'1080p');
  assert.equal(preferredQuality(['Auto','Default'],'720p',qualityHeight),'Auto');
  assert.equal(qualityHeight('1920x1080'),1080);assert.equal(qualityHeight('4K'),2160);assert.equal(qualityHeight('FHD'),1080);
});

test('one-click queues before extraction, uses one APK lease and captures preference for that job',async t=>{
  const fetched:string[]=[];const f=await fixture(t,async url=>{fetched.push(url);return{url,response:incoming('auto bytes')};});
  let finish!:()=>void,notify!:()=>void;const started=new Promise<void>(r=>notify=r),hold=new Promise<void>(r=>finish=r);t.after(()=>finish());let extractions=0;
  f.sources.videos=async()=>{extractions++;notify();await hold;return Object.assign([{url:'https://source.test/high.mp4',quality:'1080p'},{url:'https://source.test/low.mp4',quality:'720p'}],{apkLease:'auto-lease'});};
  await f.downloads.configureSettings({quality:'720p'});
  const job=await f.downloads.createPreferred('ep','viewer');assert.ok(['queued','resolving'].includes(job.state));await started;
  await f.downloads.configureSettings({quality:'best'});
  await assert.rejects(f.downloads.createPreferred('ep','viewer'),{error:'download-already-exists'});
  finish();const done=await settled(f.downloads,job.id);assert.equal(done.state,'ready');assert.equal(done.quality,'360p'); // Probe reports the saved file, not the source's 720p label.
  assert.equal(extractions,1);assert.deepEqual(fetched,['https://source.test/low.mp4']);assert.deepEqual(f.released,['auto-lease']);
});

test('turning off interrupts active and queued jobs without auto-resuming or deleting saved copies',async t=>{
  let notify!:()=>void;const started=new Promise<void>(r=>notify=r);
  const f=await fixture(t,async(url,_headers,signal)=>{
    const response=new IncomingMessage(new Socket());response.statusCode=200;response.headers={'content-type':'video/mp4','content-length':'1024'};response._read=()=>{};response.on('error',()=>{});
    const abort=()=>response.destroy(new Error('abort'));signal?.addEventListener('abort',abort,{once:true});response.once('close',()=>signal?.removeEventListener('abort',abort));notify();return{url,response};
  });
  const job=await f.downloads.createPreferred('ep','viewer');await started;
  for(const [id,n] of [['queued',2],['saved',3]] as const){f.db.run("INSERT INTO episodes VALUES(?,'m',1,?,'Episode',1200,NULL)",id,n);f.db.run('INSERT INTO source_episodes VALUES(?,?)',id,'/'+id);}
  await saved(f.db,f.cfg.downloadRoot!,'saved');const waiting=await f.downloads.createPreferred('queued','viewer');
  // MP4 publishes content length before any bytes arrive, without inventing a total for HLS.
  assert.equal((await f.downloads.status()).jobs.find(j=>j.id===job.id)!.totalBytes,1024);
  await f.downloads.configureSettings({enabled:false});
  const jobs=(await f.downloads.status()).jobs;assert.equal(jobs.find(j=>j.id===job.id)!.state,'interrupted');assert.equal(jobs.find(j=>j.id===waiting.id)!.state,'interrupted');
  assert.ok(await f.downloads.asset('saved'));assert.equal(f.downloads.busy,false);assert.deepEqual(f.released,['lease-1']);
  await assert.rejects(f.downloads.createPreferred('ep','viewer'),{error:'download-disabled'});
  await f.downloads.configureSettings({enabled:true});assert.equal(f.downloads.busy,false);
});

test('automatic quality applies inside HLS master playlists too',async t=>{
  const {dir,cfg}=await layout();t.after(()=>rm(dir,{recursive:true,force:true}));
  const fetched:string[]=[];const out=path.join(cfg.downloadRoot!,'hls');await mkdir(out);
  const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1280x720\nlow.m3u8\n';
  await transferVideo(cfg,out,{url:'https://source.test/master.m3u8'},async url=>{fetched.push(url);return{url,response:incoming(url.endsWith('master.m3u8')?master:url.endsWith('low.m3u8')?'#EXTM3U\n#EXTINF:1200,\nsegment.ts\n#EXT-X-ENDLIST\n':'segment',url.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t')};},new AbortController().signal,async()=>{},()=>{},'720p');
  assert.deepEqual(fetched,['https://source.test/master.m3u8','https://source.test/low.m3u8','https://source.test/segment.ts']);
});

test('config and one-click HTTP contracts retain explicit selection compatibility and reject partial selections',async t=>{
  const {dir,cfg}=await layout();const {app,db,downloads}=await buildApp(cfg,false,{tmdb:{token:'',key:''}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});seed(db);
  const before=(await app.inject('/api/admin/downloads')).json();assert.equal(before.enabled,false);assert.equal(before.allowed,true);assert.equal(before.storageReady,true);
  const headers={'x-moa-profile':'viewer'};
  assert.equal((await app.inject({method:'POST',url:'/api/admin/downloads',headers,payload:{episodeId:'ep'}})).json().error,'download-disabled');
  const enabled=await app.inject({method:'PUT',url:'/api/admin/downloads/config',payload:{enabled:true,quality:'720p',quotaBytes:1024**3}});assert.equal(enabled.statusCode,200,enabled.body);assert.equal(enabled.json().configured,true);
  for(const payload of [{},{quality:'4k'},{enabled:'maybe'},{quotaBytes:0}])assert.equal((await app.inject({method:'PUT',url:'/api/admin/downloads/config',payload})).statusCode,400);
  let preferred=0,manual=0;downloads.createPreferred=async()=>{preferred++;return{} as never;};downloads.create=async()=>{manual++;return{} as never;};
  assert.equal((await app.inject({method:'POST',url:'/api/admin/downloads',headers,payload:{episodeId:'ep'}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/downloads',headers,payload:{episodeId:'ep',selectionToken:'t',choiceId:'c'}})).statusCode,200);
  for(const key of ['selectionToken','choiceId'])assert.equal((await app.inject({method:'POST',url:'/api/admin/downloads',headers,payload:{episodeId:'ep',[key]:'partial'}})).statusCode,400);
  assert.equal(preferred,1);assert.equal(manual,1);
});
