// Opt-in: MOA_TEST_VIDEO and MOA_TEST_FFPROBE must refer to local synthetic media and a real probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';
import { Playback } from '../src/playback/service.js';
import { Downloads } from '../src/downloads/service.js';
import { readCheckpoint } from '../src/downloads/checkpoint.js';
import { config } from '../src/config.js';

test('real MP4 survives a broken local HTTP connection and same-job retry validates it with ffprobe', async t => {
  assert.ok(process.env.MOA_TEST_VIDEO, 'MOA_TEST_VIDEO must identify generated local media');
  assert.ok(process.env.MOA_TEST_FFPROBE, 'MOA_TEST_FFPROBE must identify a real local ffprobe executable');
  const original = await readFile(process.env.MOA_TEST_VIDEO);
  const cut = 64 * 1024; assert.ok(original.length > cut * 2);
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const etag = `"${digest(original)}"`;
  const requests: Array<{ range?: string; ifRange?: string }> = [];
  let sentBytes = 0;
  const http = createServer((request, response) => {
    const range = request.headers.range, ifRange = request.headers['if-range'] as string | undefined;
    requests.push({ range, ifRange }); response.on('error', () => {});
    if (requests.length === 1) {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': original.length, ETag: etag, 'Accept-Ranges': 'bytes' });
      response.write(original.subarray(0, cut)); sentBytes += cut;
      setTimeout(() => response.destroy(new Error('authored connection interruption')), 30);
      return;
    }
    const match = /^bytes=(\d+)-$/.exec(range || '');
    if (!match || ifRange !== etag) { response.writeHead(412); response.end(); return; }
    const offset = Number(match[1]), remaining = original.subarray(offset);
    response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': remaining.length, ETag: etag, 'Content-Range': `bytes ${offset}-${original.length - 1}/${original.length}` });
    sentBytes += remaining.length; response.end(remaining);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-real-download-'));
  const cfg = config({ dataDir: path.join(dir, 'data'), mediaRoot: path.join(dir, 'media'), downloadRoot: path.join(dir, 'downloads'), webDir: path.join(dir, 'web'), ffprobe: process.env.MOA_TEST_FFPROBE, requireAccount: false });
  await Promise.all([cfg.mediaRoot, cfg.downloadRoot!].map(target => mkdir(target, { recursive: true })));
  const db = new Store(cfg.dataDir, new DatabaseSync(':memory:')), catalog = new Catalog(db);
  const sources = new Sources(db, catalog), playback = new Playback(db, catalog, cfg, () => {});
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('viewer','Synthetic viewer','#fff',0,'2026')");
  const entry = JSON.stringify({ id: 'fixture', name: 'Synthetic source', version: '1', baseUrl: 'https://synthetic.invalid/' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'source', 'fixture', entry, entry, 'fixture');
  db.run("INSERT INTO media VALUES('media',NULL,'Synthetic Movie','movie','{}','2026')");
  db.run("INSERT INTO episodes VALUES('episode','media',1,1,'Synthetic episode',1440,NULL)");
  db.run("INSERT INTO source_media VALUES('media','source','/title',0)"); db.run("INSERT INTO source_episodes VALUES('episode','/episode')");
  sources.videos = async () => [{ url: 'https://synthetic.invalid/video.mp4', quality: '360p' }];
  sources.apk.release = async () => {};
  const downloads = new Downloads(db, cfg, sources, playback, async (url, headers, signal) => new Promise((resolve, reject) => {
    const request = httpGet(`http://127.0.0.1:${port}/video.mp4`, { headers, signal }, response => resolve({ url, response })); request.once('error', reject);
  }));
  t.after(async () => { await downloads.close(); await playback.close(); await sources.close(); db.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  await downloads.initialize(); await downloads.configureSettings({ quotaBytes: original.length, enabled: true });
  const choices = await downloads.choices('episode', 'viewer');
  const job = await downloads.create('episode', 'viewer', choices.selectionToken, choices.choices[0].id);
  const settle = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = (await downloads.status()).jobs.find(item => item.id === job.id)!;
      if (!downloads.busy && !['queued', 'resolving', 'downloading', 'finalizing'].includes(current.state)) return current;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('real synthetic media job did not settle');
  };
  assert.equal((await settle()).state, 'failed');
  assert.equal(await downloads.asset('episode'), undefined);
  const checkpoint = await readCheckpoint(path.join(cfg.downloadRoot!, `job-${job.id}`), job.id, 'episode');
  assert.equal(checkpoint?.confirmedOffset, cut); assert.equal((await downloads.status()).usedBytes, cut);
  downloads.retry(job.id, 'viewer'); const ready = await settle(); assert.equal(ready.state, 'ready', ready.error || '');
  const asset = await downloads.asset('episode'); assert.ok(asset);
  assert.equal(digest(await readFile(asset.path)), digest(original));
  const probe = JSON.parse(asset.probe);
  assert.ok(probe.streams.some((stream: { codec_type: string; width?: number; height?: number }) => stream.codec_type === 'video' && stream.width === 640 && stream.height === 360));
  assert.ok(probe.duration > 1); assert.equal((await downloads.status()).usedBytes, original.length);
  assert.deepEqual(requests, [{ range: undefined, ifRange: undefined }, { range: `bytes=${cut}-`, ifRange: etag }]);
  assert.equal(sentBytes, original.length);
  t.diagnostic(JSON.stringify({ originalBytes: original.length, retainedBytes: cut, retryBytes: original.length - cut, sentBytes, duration: probe.duration, sha256: digest(original) }));
});
