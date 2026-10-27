import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { convertSubtitle, decodeSubtitleBuffer, safeZipPath } from './korean/index.js';
import { ApiFailure } from '../util.js';

const run = promisify(execFile);
const MAX_FILE = 10 * 1024 * 1024;
const MAX_SUBTITLE = 4 * 1024 * 1024;
const subtitleName = /\.(?:srt|vtt|vvt|ass|ssa|smi|sami)$/i;

export async function importSubtitles(filename: string, data: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) throw new ApiFailure(400, 'invalid-subtitle-file');
  const input = Buffer.from(data, 'base64');
  if (input.length > MAX_FILE) throw new ApiFailure(413, 'subtitle-file-too-large');
  const convert = (name: string, content: Buffer) => {
    if (content.length > MAX_SUBTITLE) throw new ApiFailure(413, 'subtitle-file-too-large');
    try { return { filename: path.posix.basename(name.replace(/\\/g, '/')), ...convertSubtitle(decodeSubtitleBuffer(content)) }; }
    catch { throw new ApiFailure(400, 'invalid-subtitle-file'); }
  };
  if (subtitleName.test(filename)) return [convert(filename, input)];
  if (!/\.(?:zip|7z|rar)$/i.test(filename)) throw new ApiFailure(400, 'unsupported-subtitle-file');
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-subtitles-'));
  try {
    const archive = path.join(directory, 'archive');
    await writeFile(archive, input);
    // Debian's default C locale escapes non-ASCII names in listings and cannot
    // decode 7z UTF-16 paths. Both listing and extraction must use UTF-8.
    const env = process.platform === 'linux' ? { ...process.env, LC_ALL: 'C.UTF-8' } : process.env;
    const options = { env, encoding: 'buffer' as const, timeout: 5000, signal: AbortSignal.timeout(15000), maxBuffer: MAX_SUBTITLE };
    const listing = await run('bsdtar', ['-tf', archive], { ...options, maxBuffer: 256 * 1024 });
    const names = listing.stdout.toString('utf8').split('\n').filter(Boolean);
    if (names.length > 300) throw new ApiFailure(413, 'subtitle-archive-too-large');
    const selected = [...new Set(names.filter(name => safeZipPath(name) && subtitleName.test(name)))];
    if (!selected.length) throw new ApiFailure(400, 'subtitle-archive-empty');
    if (selected.length > 32) throw new ApiFailure(413, 'subtitle-archive-too-large');
    const subtitles = [];
    let total = 0;
    for (const name of selected) {
      const { stdout } = await run('bsdtar', ['-xOf', archive, '--', name.replace(/[\\*?\[]/g, '\\$&')], options);
      total += stdout.length;
      if (total > 16 * 1024 * 1024) throw new ApiFailure(413, 'subtitle-archive-too-large');
      subtitles.push(convert(name, stdout));
    }
    return subtitles;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiFailure(503, 'subtitle-archive-unavailable');
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new ApiFailure(413, 'subtitle-archive-too-large');
    throw new ApiFailure(400, 'invalid-subtitle-archive');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
