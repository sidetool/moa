import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Playback, type Session } from '../src/playback.js';
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
  const args = JSON.parse(await readFile(calls, 'utf8'));
  assert.equal(args[args.indexOf('-ss') + 1], '4'); assert.equal(args[args.indexOf('-i') + 1], file);
  for (const at of [-1, NaN, Infinity, 20, 100]) await assert.rejects(playback.preview(session, at), /invalid-preview-time/);
  await assert.rejects(playback.preview({ ...session, file: '/etc/passwd' }, 2), /path-outside-media-root/);
  await assert.rejects(playback.preview({ ...session, deleted: true }, 2), /session-expired/);
  const one = playback.preview({ ...session }, 2), two = playback.preview({ ...session }, 2);
  await assert.rejects(playback.preview({ ...session }, 2), /preview-busy/);
  await Promise.all([one, two]);
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
  const url = '/api/playback/preview-session/preview?at=2';
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ url, headers: owner })).statusCode, 200);
  assert.equal((await app.inject({ url: url.replace('at=2', 'at=-1'), headers: owner })).statusCode, 400);
});
