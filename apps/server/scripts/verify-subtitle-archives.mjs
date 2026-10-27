// Run inside the built image: node apps/server/scripts/verify-subtitle-archives.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSubtitleBuffer } from '../dist/subtitles/korean/archive.js';
const dir = await mkdtemp(join(tmpdir(), 'moa-archive-verify-'));
try {
  const filename = 'subtitle 03.srt';
  await writeFile(join(dir,filename), '1\n00:00:01,000 --> 00:00:02,000\n검증 자막\n');
  for (const format of ['7z','tar']) {
    const archive=join(dir,`test.${format}`);
    execFileSync(process.env.MOA_7ZIP || '7z',['a',`-t${format}`,archive,filename],{cwd:dir,stdio:'ignore'});
    const data=await readFile(archive);
    assert.ok((await extractSubtitleBuffer(data,archive,{episode:3}))?.content.includes('검증 자막'));
    assert.equal(await extractSubtitleBuffer(data,archive,{episode:4}),null);
  }
  // Self-authored RAR4 store fixture containing only the same synthetic SRT.
  const rar=Buffer.from('526172211a0700cf907300000d000000000000009d857400802f002e0000002e00000003297c04ad0000000014300f00a48100007375627469746c652030332e737274310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300aeab280eca69d20ec9e90eba7890a04b07b00000700','hex');
  assert.ok((await extractSubtitleBuffer(rar,'test.rar',{episode:3}))?.content.includes('검증 자막'));
  assert.equal(await extractSubtitleBuffer(rar,'test.rar',{episode:4}),null);
  console.log('7z, TAR, RAR: selected episode decoded; wrong episode rejected.');
} finally { await rm(dir,{recursive:true,force:true}); }
