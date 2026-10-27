import { mkdir, readFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { decodeSubtitleBuffer } from './korean/index.js';
import type { Config } from '../config.js';
import { command, hash } from '../util.js';

const timestamp = (ms: number) => {
  const seconds = Math.max(0, ms) / 1000;
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
};
export function smiToVtt(input: string) {
  const matches = [...input.matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|$)/gi)];
  const cues = matches.flatMap((m, i) => {
    const text = m[2].replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
    return text ? [`${timestamp(+m[1])} --> ${timestamp(matches[i + 1] ? +matches[i + 1][1] : +m[1] + 5000)}\n${text}`] : [];
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
export class SubtitleCache {
  pending = new Map<string, Promise<string>>();
  constructor(private config: Config) {}
  async get(file: string, stream: number | undefined, format: 'ass' | 'vtt'): Promise<string> {
    const info = await stat(file);
    const id = hash(`${file}:${info.size}:${info.mtimeMs}:${stream}:${format}`);
    const cached = path.join(this.config.dataDir, 'subtitles', `${id}.${format}`);
    try { if ((await stat(cached)).size) return cached; } catch {}
    const running = this.pending.get(id);
    if (running) return running;
    const promise = this.convert(file, stream, format, cached).finally(() => this.pending.delete(id));
    this.pending.set(id, promise);
    return promise;
  }
  private async convert(file: string, stream: number | undefined, format: 'ass' | 'vtt', cached: string) {
    await mkdir(path.dirname(cached), { recursive: true });
    const temporary = `${cached}.tmp`;
    try {
      if (stream === undefined && /\.sa?mi$/i.test(file)) {
        const input = decodeSubtitleBuffer(await readFile(file));
        const { writeFile } = await import('node:fs/promises'); await writeFile(temporary, smiToVtt(input));
      } else {
        const codec = format === 'ass' ? 'ass' : 'webvtt';
        const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', stream === undefined ? '0:0' : `0:${stream}`, '-c:s', codec, '-f', codec, '-y', temporary];
        try { await command(this.config.ffmpeg, args); }
        catch (e) {
          if (stream !== undefined) throw e;
          await command(this.config.ffmpeg, ['-sub_charenc', 'CP949', ...args]);
        }
      }
      await rename(temporary, cached); return cached;
    } catch (e) { await rm(temporary, { force: true }); throw e; }
  }
  async font(file: string, stream: number): Promise<string> {
    const info = await stat(file);
    const cached = path.join(this.config.dataDir, 'fonts', hash(`${file}:${info.size}:${info.mtimeMs}:${stream}`));
    try { if ((await stat(cached)).size) return cached; } catch {}
    const key = `font:${cached}`;
    if (this.pending.has(key)) return this.pending.get(key)!;
    const promise = (async () => {
      await mkdir(path.dirname(cached), { recursive: true });
      const temporary = `${cached}.tmp`;
      await command(this.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', `-dump_attachment:${stream}`, temporary, '-i', file, '-t', '0', '-f', 'null', '-']);
      await rename(temporary, cached); return cached;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
}
