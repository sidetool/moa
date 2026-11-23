import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Config } from '../config.js';
import { ImageCache } from '../metadata/image-cache.js';
import { ApiFailure, hash, safePath } from '../util.js';
import { runCommand } from './skip-markers/process.js';
import type { Session } from './service.js';

export const PREVIEW_SHEET = { interval: 10, columns: 4, rows: 2, width: 160, height: 90 } as const;
const { interval, columns, rows, width, height } = PREVIEW_SHEET;
const cells = columns * rows;
const raw = { width, height, channels: 3 } as const;
const cellBytes = width * height * raw.channels;
const deadlineMs = 12_000;
// Only the local library's video containers. Do not follow playlists or network URLs.
export const LOCAL_PREVIEW_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,mpegts', '-threads', '1', '-max_pixels', '36000000'];
// Preserve media-relative presentation timestamps across a coarse keyframe seek.
// Subtract the target after changing the filter timebase: subtracting it during the
// input seek rounds to a source tick and can show the next frame just before a cut.
export const previewSeek = (at: number) => ['-copyts', '-start_at_zero', '-noaccurate_seek', '-ss', String(Math.floor(at))];
export const frameAtTarget = (at: number) => {
  const nanoseconds = Math.round(at * 1e6) * 1000;
  // Collapse preroll to zero so fps emits its last frame. Flush at EOF with one clone.
  return `settb=1/1000000000,setpts='max(0,PTS-${nanoseconds})',tpad=stop_mode=clone:stop=1,fps=1:start_time=0:round=up:eof_action=pass`;
};
const fit = `scale=w='max(1,trunc(min(${width},${height}*dar)))':h='max(1,trunc(min(${height},${width}/dar)))':flags=fast_bilinear,format=rgb24,setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

export class PreviewSheets {
  private readonly cacheDir: string;
  private readonly cache: ImageCache;
  private readonly readers = new Map<string, Set<Session>>();
  private generation?: { key: string; abort: AbortController };

  constructor(private config: Config, private capacity: () => boolean) {
    this.cacheDir = path.join(config.dataDir, 'preview-sheets');
    this.cache = new ImageCache(this.cacheDir, 64 * 1024 * 1024);
  }

  get busy() { return !!this.generation; }

  async get(session: Session, index: number) {
    const start = index * cells * interval;
    if (!Number.isSafeInteger(index) || index < 0 || start >= session.probe.duration) throw new ApiFailure(400, 'invalid-preview-sheet');
    const file = await safePath(session.root, session.file);
    const info = await stat(file, { bigint: true });
    if (!info.isFile()) throw new ApiFailure(404, 'preview-unavailable');
    if (session.deleted) throw new ApiFailure(404, 'session-expired');
    const key = hash(JSON.stringify(['sheet-v1', file, String(info.size), String(info.mtimeNs), session.probe.duration, index])) + '.jpg';
    const readers = this.readers.get(key) ?? new Set<Session>();
    readers.add(session);
    this.readers.set(key, readers);
    try {
      const image = await this.cache.get(key, Infinity, async () => {
        const image = await this.generate(key, file, start, session.probe.duration);
        // A scanner or external file manager may replace the media between individual seeks.
        const current = await safePath(session.root, session.file);
        const after = await stat(current, { bigint: true });
        if (current !== file || after.mtimeNs !== info.mtimeNs || after.size !== info.size) throw new ApiFailure(409, 'preview-source-changed');
        await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        return image;
      });
      if (session.deleted) throw new ApiFailure(404, 'session-expired');
      return image;
    } finally {
      readers.delete(session);
      if (!readers.size) this.readers.delete(key);
    }
  }

  release(session: Session) {
    const job = this.generation;
    if (!job) return;
    const readers = this.readers.get(job.key);
    if (readers?.has(session) && ![...readers].some(reader => !reader.deleted)) job.abort.abort();
  }

  private async generate(key: string, file: string, start: number, duration: number) {
    if (![...(this.readers.get(key) ?? [])].some(reader => !reader.deleted)) throw new ApiFailure(404, 'session-expired');
    if (this.generation || !this.capacity()) throw new ApiFailure(429, 'preview-busy');
    const abort = new AbortController();
    this.generation = { key, abort };
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(deadlineMs)]);
    // Each input seek starts at the preceding keyframe. Process one cell at a time
    // so a distant hover cannot launch parallel decoders or decode a whole sheet's span.
    const frame = (at: number) => runCommand(this.config.ffmpeg, [
      '-v', 'error', '-nostdin', ...LOCAL_PREVIEW_INPUT, ...previewSeek(at), '-i', file,
      '-map', '0:V:0', '-an', '-sn', '-dn', '-frames:v', '1', '-filter_threads', '1', '-vf', `${frameAtTarget(at)},${fit}`,
      '-threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { signal, maxBytes: cellBytes, timeoutMs: deadlineMs });
    try {
      const overlays: sharp.OverlayOptions[] = [];
      let previous: Buffer | undefined;
      for (let i = 0; i < cells && start + i * interval < duration; i++) {
        const at = start + i * interval;
        let input = await frame(at);
        // Audio may outlast the final video frame, even at the first cell of a sheet.
        if (!input.length && at > 0) input = previous ?? await frame(Math.max(0, at - interval));
        if (input.length !== cellBytes) throw new Error('missing preview frame');
        overlays.push({ input, raw, left: i % columns * width, top: Math.floor(i / columns) * height });
        previous = input;
      }
      signal.throwIfAborted();
      return await sharp({ create: { width: columns * width, height: rows * height, channels: 3, background: 'black' } })
        .composite(overlays).jpeg({ quality: 74 }).toBuffer();
    } catch {
      throw new ApiFailure(502, 'preview-unavailable');
    } finally {
      this.generation = undefined;
    }
  }

  async close() {
    this.generation?.abort.abort();
    await this.cache.close();
  }
}
