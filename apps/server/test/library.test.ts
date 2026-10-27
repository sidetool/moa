import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from '../src/db.js';
import { Library } from '../src/library/service.js';
import { config } from '../src/config.js';

test('scanner groups seasons, auto-detects singleton movies, reuses probes and updates/deletes changed files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-scan-'));
  const root = path.join(temp, 'media'), season = path.join(root, '[Group] Show S2 (1080p)'), movie = path.join(root, 'Movie');
  await mkdir(season, { recursive: true }); await mkdir(movie);
  const videos = [path.join(season, '[Group] Show S2 - 01 (AT-X x265).mkv'), path.join(season, '[Group] Show S2 - 02 (AT-X x265).mkv'), path.join(movie, 'Movie.2024.1080p.mkv')];
  for (const file of videos) await writeFile(file, 'video');
  await writeFile(path.join(season, '[Group] Show S2 - 01 (BS11 x265).ass'), '[Script Info]');
  const jpeg = path.join(temp, 'frame.jpg'); await sharp({ create: { width: 16, height: 9, channels: 3, background: 'blue' } }).jpeg().toFile(jpeg);
  const fake = path.join(temp, 'fake-tools'), calls = path.join(temp, 'calls');
  await writeFile(fake, `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2);\nif(args.includes('-show_format')) { fs.appendFileSync(${JSON.stringify(calls)}, 'probe\\n'); process.stdout.write(JSON.stringify({format:{duration:'1400',format_name:'matroska'},streams:[{index:0,codec_type:'video',codec_name:'hevc',width:1920,height:1080}]})); }\nelse if(!args.includes('null')) fs.copyFileSync(${JSON.stringify(jpeg)},args.at(-1));\n`);
  await chmod(fake, 0o755);
  const db = new Store(path.join(temp, 'data')); db.run('INSERT INTO folders(id,path,type,label) VALUES(?,?,?,?)', 'folder', root, 'anime', 'test');
  const warnings: string[] = [], library = new Library(db, config({ dataDir: path.join(temp, 'data'), mediaRoot: root, ffprobe: fake, ffmpeg: fake }), m => warnings.push(m));
  const scan = async () => { library.start(); await library.pending; assert.equal(library.status.error, undefined, warnings.join('\n')); };
  try {
    await scan();
    assert.equal(db.get('SELECT COUNT(*) AS n FROM media')!.n, 2);
    assert.equal(db.get('SELECT type FROM media WHERE title=?', 'Movie')!.type, 'movie');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM episodes WHERE season=2')!.n, 2);
    assert.equal(JSON.parse(db.get('SELECT subtitles FROM files WHERE path=?', videos[0])!.subtitles).length, 1);
    const firstCalls = await readFile(calls, 'utf8'); assert.equal(firstCalls.split('\n').filter(Boolean).length, 3);
    await scan(); assert.equal(await readFile(calls, 'utf8'), firstCalls);
    await writeFile(path.join(season, 'tvshow.nfo'), '<tvshow><title>Show</title><genre>Drama</genre><plot>Overview</plot></tvshow>');
    await scan(); assert.equal(await readFile(calls, 'utf8'), firstCalls);
    assert.equal(JSON.parse(db.get('SELECT metadata FROM media WHERE title=?', 'Show')!.metadata).genres[0], 'Drama');
    await writeFile(videos[0], 'video changed'); await unlink(videos[1]);
    await scan(); assert.equal((await readFile(calls, 'utf8')).split('\n').filter(Boolean).length, 4);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM episodes')!.n, 2);
    await unlink(videos[2]); await scan(); assert.equal(db.get('SELECT COUNT(*) AS n FROM media')!.n, 1);
    assert.equal(library.folders()[0].itemCount, 1);
  } finally { db.close(); await rm(temp, { recursive: true, force: true }); }
});
