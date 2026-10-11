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
  await downloads.initialize(); downloads.configure(1024 ** 3);
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
