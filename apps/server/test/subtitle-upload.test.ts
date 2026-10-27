import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importSubtitles } from '../src/subtitles/upload.js';
import { buildApp } from '../src/app.js';

const srt = '1\n00:00:01,000 --> 00:00:03,000\n안녕하세요\n';
const encode = (value: string) => Buffer.from(value).toString('base64');

test('imports subtitle formats and preserves ASS positions and VTT settings', async () => {
  const ass = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(200,100)}안녕하세요\n';
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 line:20%\n안녕하세요\n';
  assert.equal((await importSubtitles('한국어.srt', encode(srt)))[0].content, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n안녕하세요\n\n');
  for (const ext of ['ass', 'ssa']) assert.equal((await importSubtitles(`자막.${ext}`, encode(ass)))[0].content, ass);
  for (const ext of ['vtt', 'vvt']) assert.equal((await importSubtitles(`자막.${ext}`, encode(vtt)))[0].content, vtt);
  assert.match((await importSubtitles('자막.smi', encode('<SAMI><SYNC Start=1000><P>안녕하세요<SYNC Start=3000><P>&nbsp;</SAMI>')))[0].content, /안녕하세요/);
  const rar = 'UmFyIRoHAQDFGjMyAwEAAFEpQdsRAgImACYAAAAIdGVzdC5zcnQxCjAwOjAwOjAxLDAwMCAtLT4gMDA6MDA6MDMsMDAwCkhlbGxvChmyOjUDBQAA';
  assert.match((await importSubtitles('test.rar', rar))[0].content, /Hello/);
  await assert.rejects(importSubtitles('x.srt', '!!!!'), { error: 'invalid-subtitle-file' });
  await assert.rejects(importSubtitles('x.exe', encode(srt)), { error: 'unsupported-subtitle-file' });
  await assert.rejects(importSubtitles('x.ass', encode('<html>bad</html>')), { error: 'invalid-subtitle-file' });
  await assert.rejects(importSubtitles('x.srt', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')), { error: 'subtitle-file-too-large' });
});

test('reads ZIP and 7z subtitle entries without extracting paths, rejects invalid and oversized archives', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-upload-test-'));
  const previousLocale = process.env.LC_ALL;
  // Reproduce the Docker runtime's non-UTF-8 locale, even on a UTF-8 developer host.
  if (process.platform === 'linux') process.env.LC_ALL = 'C';
  try {
    const filename = '[한글] 자막.srt';
    await writeFile(path.join(directory, filename), srt);
    await writeFile(path.join(directory, 'other.srt'), srt.replace('안녕하세요', '다른 자막'));
    await writeFile(path.join(directory, 'ignore.txt'), 'not a subtitle');
    for (const [format, ext] of [['zip', 'zip'], ['7zip', '7z']]) {
      const archive = path.join(directory, `test.${ext}`);
      // Produce a valid Unicode archive independently of the reader's locale.
      execFileSync('bsdtar', ['-cf', archive, '--format', format, '-C', directory, filename, 'other.srt', 'ignore.txt'], {
        env: process.platform === 'linux' ? { ...process.env, LC_ALL: 'C.UTF-8' } : process.env,
      });
      const subtitles = await importSubtitles(`test.${ext}`, (await readFile(archive)).toString('base64'));
      assert.deepEqual(subtitles.map(item => item.filename.normalize('NFC')).sort(), [filename, 'other.srt'].sort());
      assert.ok(subtitles.every(item => item.format === 'vtt'));
    }
    const empty = path.join(directory, 'empty.zip');
    execFileSync('bsdtar', ['-cf', empty, '--format', 'zip', '-C', directory, 'ignore.txt']);
    await assert.rejects(importSubtitles('empty.zip', (await readFile(empty)).toString('base64')), { error: 'subtitle-archive-empty' });
    await assert.rejects(importSubtitles('bad.rar', encode('invalid archive')), { error: 'invalid-subtitle-archive' });
    await writeFile(path.join(directory, 'large.srt'), 'x'.repeat(4 * 1024 * 1024 + 1));
    execFileSync('bsdtar', ['-cf', empty, '--format', 'zip', '-C', directory, 'large.srt']);
    await assert.rejects(importSubtitles('large.zip', (await readFile(empty)).toString('base64')));
  } finally {
    if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale;
    await rm(directory, { recursive: true, force: true });
  }
});

test('subtitle import route requires a profile and validates the request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-upload-api-'));
  const { app, db } = await buildApp({ dataDir: directory, mediaRoot: directory }, false);
  try {
    const payload = { episodeId: 'e', filename: '한국어.srt', data: encode(srt) };
    assert.equal((await app.inject({ method: 'POST', url: '/api/subtitles/import', payload })).statusCode, 401);
    const profile = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '테스트', color: 'blue' } })).json();
    const headers = { 'x-moa-profile': profile.id };
    db.run("INSERT INTO media VALUES('m',NULL,'작품','movie','{}','2026')");
    db.run("INSERT INTO episodes VALUES('e','m',1,1,'회차',600,NULL)");
    const response = await app.inject({ method: 'POST', url: '/api/subtitles/import', payload, headers });
    assert.equal(response.statusCode, 200);
    assert.match((await app.inject(response.json()[0].url)).body, /안녕하세요/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/subtitles/import', payload: { ...payload, data: 'invalid!' }, headers })).statusCode, 400);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
