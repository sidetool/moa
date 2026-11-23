import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { runCommand } from '../src/playback/skip-markers/process.js';
import path from 'node:path';
import { Playback, type Session } from '../src/playback/service.js';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';

test('hover preview bounds work, coalesces frames and never moves playback cursor', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'episode.mp4'), ffmpeg = path.join(dir, 'ffmpeg'), calls = path.join(dir, 'calls.json');
  await writeFile(file, 'fixture');
  await writeFile(ffmpeg, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))); setTimeout(()=>process.stdout.write(Buffer.from([255,216,255,217])),100);`, { mode: 0o700 });
  const playback = new Playback(null as any, null as any, config({ dataDir: dir, mediaRoot: dir, ffmpeg }), () => {});
  t.after(() => playback.close());
  const session = { root: dir, file, probe: { duration: 20 }, cursor: 3, deleted: false } as Session;
  const [first, second] = await Promise.all([playback.preview(session, 4.1), playback.preview(session, 5.9)]);
  assert.deepEqual(first, Buffer.from([255, 216, 255, 217])); assert.equal(first, second);
  assert.equal(session.cursor, 3);
  await playback.preview(session, 8);
  assert.equal(await playback.preview(session, 4), first);
  for (const at of [0, 2, 6, 10, 12, 14, 16]) await playback.preview(session, at);
  assert.notEqual(await playback.preview(session, 4), first);
  const args = JSON.parse(await readFile(calls, 'utf8'));
  assert.equal(args[args.indexOf('-ss') + 1], '4'); assert.equal(args[args.indexOf('-i') + 1], file);
  for (const at of [-1, NaN, Infinity, 20, 100]) await assert.rejects(playback.preview(session, at), /invalid-preview-time/);
  await assert.rejects(playback.preview({ ...session, file: '/etc/passwd' }, 2), /path-outside-media-root/);
  await assert.rejects(playback.preview({ ...session, deleted: true }, 2), /session-expired/);
  const one = playback.preview({ ...session }, 2), two = playback.preview({ ...session }, 2);
  await assert.rejects(playback.preview({ ...session }, 2), /preview-busy/);
  await Promise.all([one, two]);

  const abort = new AbortController();
  const leaving = playback.preview(session, 4.375, true, abort.signal);
  const staying = playback.preview(session, 4.375, true);
  abort.abort();
  assert.deepEqual(await leaving, await staying);
  const last = new AbortController();
  const obsolete = playback.preview(session, 4.125, true, last.signal);
  last.abort();
  await assert.rejects(obsolete, /preview-unavailable/);
  assert.deepEqual(await playback.preview(session, 4.125, true), first);
});

test('preview requests retain account and profile authorization', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-preview-api-'));
  const { app, playback } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true }, false);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' }, other = { 'x-moa-account': 'other', 'x-moa-role': 'member' };
  const profile = (await app.inject({ method: 'POST', url: '/api/profiles', headers: owner, payload: { name: 'Preview' } })).json().id;
  const sessionDir = path.join(dir, 'session'); await mkdir(sessionDir);
  playback.sessions.set('preview-session', { profile, touched: Date.now(), deleted: false, dir: sessionDir, lock: Promise.resolve() } as Session);
  playback.preview = async () => Buffer.from([255,216,255,217]);
  const sibling = (await app.inject({ method: 'POST', url: '/api/profiles', headers: owner, payload: { name: 'Sibling' } })).json().id;
  const url = '/api/playback/preview-session/preview?at=2';
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ url, headers: owner })).statusCode, 200);
  assert.equal((await app.inject({ url: url.replace('at=2', 'at=-1'), headers: owner })).statusCode, 400);
  assert.equal((await app.inject({ url: url + '&exact=7', headers: owner })).statusCode, 400);
  let exactArgument = false;
  playback.preview = async (_s, at, exact) => { exactArgument = at === 1.125 && exact === true; return Buffer.from('jpeg'); };
  assert.equal((await app.inject({ url: url.replace('at=2', 'at=1.125&exact=1'), headers: owner })).statusCode, 200);
  assert.ok(exactArgument);

  playback.previewSheets.get = async () => Buffer.from('jpeg');
  const sheet = '/api/playback/preview-session/preview-sheet?index=0';
  assert.equal((await app.inject({ url: sheet })).statusCode, 401);
  assert.equal((await app.inject({ url: sheet, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ url: sheet, headers: { ...owner, 'x-moa-profile': sibling } })).statusCode, 403);
  const result = await app.inject({ url: sheet, headers: owner });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  for (const index of ['-1', '0.5', 'no']) assert.equal((await app.inject({ url: sheet.replace('index=0', 'index=' + index), headers: owner })).statusCode, 400);
  await playback.remove('preview-session');
  assert.equal((await app.inject({ url: sheet, headers: owner })).statusCode, 404);
});

test('file-version sheets coalesce, survive session changes, and reserve a precise decoder', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-sheets-'));
  const file = path.join(dir, 'episode.mp4'), calls = path.join(dir, 'calls'), ffmpeg = path.join(dir, 'ffmpeg');
  await writeFile(file, 'fixture');
  await writeFile(ffmpeg, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv;
const at = Number(args[args.indexOf('-ss')+1]);
const log = ${JSON.stringify(calls)};
fs.appendFileSync(log, at+'\\n');
if (fs.existsSync(log+'.replace')) {
  fs.unlinkSync(log+'.replace');
  fs.writeFileSync(args[args.indexOf('-i')+1], 'replaced during extraction');
}
setTimeout(() => process.stdout.write(args.includes('rawvideo') ? Buffer.alloc(160*90*3, at) : Buffer.from('jpeg')), 60);
`, { mode: 0o700 });
  const cfg = config({ dataDir: dir, mediaRoot: dir, ffmpeg });
  const create = () => new Playback(null as any, null as any, cfg, () => {});
  const playback = create();
  t.after(async () => { await playback.close(); await rm(dir, { recursive: true, force: true }); });
  const session = { root: dir, file, probe: { duration: 91 }, deleted: false, cursor: 7 } as Session;
  const sheets = playback.previewSheets;
  const [first, same] = await Promise.all([sheets.get(session, 1), sheets.get({ ...session }, 1)]);
  assert.deepEqual(first, same);
  assert.equal(await readFile(calls, 'utf8'), '80\n90\n');
  const metadata = await sharp(first).metadata();
  assert.equal(metadata.width, 640); assert.equal(metadata.height, 180);
  assert.equal(session.cursor, 7);
  const reopened = create();
  try { assert.deepEqual(await reopened.previewSheets.get({ ...session }, 1), first); }
  finally { await reopened.close(); }
  assert.equal(await readFile(calls, 'utf8'), '80\n90\n');

  await writeFile(file, 'replacement fixture');
  const work = sheets.get(session, 1);
  const waitForDecoder = async () => {
    for (let i = 0; !sheets.busy && i < 250; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(sheets.busy, 'expected a cold sheet to start');
  };
  await waitForDecoder();
  await assert.rejects(sheets.get(session, 0), /preview-busy/);
  const exact = playback.preview(session, 82.375, true);
  await assert.rejects(playback.preview(session, 83.375, true), /preview-busy/);
  await Promise.all([work, exact]);
  const times = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.deepEqual(times.slice(2).sort(), ['80', '82', '90']);
  const timestamp = new Date((await stat(file)).mtimeMs + 60_000);
  await utimes(file, timestamp, timestamp);
  await writeFile(calls + '.replace', '');
  await assert.rejects(sheets.get(session, 1), /preview-source-changed/);
  assert.equal((await stat(path.join(dir, 'preview-sheets'))).mode & 0o777, 0o700);
  for (const index of [-1, .5, 2, NaN]) await assert.rejects(sheets.get(session, index), /invalid-preview-sheet/);
  await assert.rejects(sheets.get({ ...session, deleted: true }, 1), /session-expired/);
  await assert.rejects(sheets.get({ ...session, file: '/etc/passwd' }, 1), /path-outside-media-root/);
});

const ffmpegBin = process.env.MOA_FFMPEG || 'ffmpeg';
test('long GOP and variable frame durations produce the displayed frame across a cut and at EOF', {
  skip: spawnSync(ffmpegBin, ['-version']).status !== 0 && 'FFmpeg unavailable',
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-pts-preview-')), file = path.join(dir, 'fixture.mp4');
  const playback = new Playback(null as any, null as any, config({ dataDir: dir, ffmpeg: ffmpegBin }), () => {});
  t.after(async () => { await playback.close(); await rm(dir, { recursive: true, force: true }); });
  await runCommand(ffmpegBin, [
    '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=red:s=60x100:r=2:d=91',
    '-vf', "drawbox=color=blue:t=fill:enable='gte(t,10.5)',drawbox=color=lime:t=fill:enable='gte(t,80)',settb=1/90000,setpts='PTS+if(eq(N,21),36,0)',select='not(mod(n,2))+eq(n,21)'",
    '-fps_mode', 'vfr', '-enc_time_base', '1:90000', '-video_track_timescale', '90000', '-c:v', 'libx264', '-g', '60', '-sc_threshold', '0', '-threads', '1', '-output_ts_offset', '2', file,
  ]);
  const session = { root: dir, file, probe: { duration: 91 }, deleted: false } as Session;
  const color = async (image: Buffer, left?: number, top?: number) => {
    const data = sharp(image);
    const pixel = await (left === undefined ? data.resize(1, 1) : data.extract({ left, top: top!, width: 1, height: 1 })).removeAlpha().raw().toBuffer();
    const max = Math.max(...pixel);
    return max < 25 ? 'black' : ['red','green','blue'][pixel.indexOf(max)];
  };
  for (const [at, expected] of [[0, 'red'], [10.500399, 'red'], [10.5004, 'blue'], [10.500401, 'blue'], [70.125, 'blue'], [79.999999, 'blue'], [80, 'green'], [91, 'green']] as const)
    assert.equal(await color(await playback.preview(session, at, true)), expected, String(at));
  await assert.rejects(playback.preview(session, 91.01, true), /invalid-preview-time/);
  const first = await playback.previewSheets.get(session, 0), last = await playback.previewSheets.get(session, 1);
  assert.equal(await color(first, 240, 45), 'red'); // tile 1 = 10s
  assert.equal(await color(first, 400, 45), 'blue'); // tile 2 = 20s
  assert.equal(await color(first, 1, 45), 'black'); // portrait padding
  assert.equal(await color(last, 80, 45), 'green'); // tile 8 = 80s
  assert.equal(await color(last, 240, 45), 'green'); // tile 9 = 90s
  assert.equal(await color(last, 400, 45), 'black'); // outside duration
});
