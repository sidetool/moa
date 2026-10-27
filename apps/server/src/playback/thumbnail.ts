import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Config } from '../config.js';
import { command } from '../util.js';
import { isHdr, videoStream, type Probe } from './probe.js';

export const THUMBNAIL_VERSION = 'crop-brightness-v2';
export interface Crop { width: number; height: number; left: number; top: number }
export function detectedCrop(metadata: string, width: number, height: number): Crop {
  const samples = metadata.split(/frame:/).flatMap(block => {
    const value = (key: string) => Number(block.match(new RegExp(`lavfi\\.cropdetect\\.${key}=(\\d+)`))?.[1]);
    const crop = { width: value('w'), height: value('h'), left: value('x'), top: value('y') };
    return crop.width >= width * .65 && crop.height >= height * .5 && crop.left >= 0 && crop.top >= 0 && crop.left + crop.width <= width && crop.top + crop.height <= height ? [crop] : [];
  });
  // Choose the largest stable rectangle; transient dark objects must not over-crop it.
  return samples.sort((a, b) => b.width * b.height - a.width * a.height)[0] || { width, height, left: 0, top: 0 };
}
export async function frameScore(file: string) {
  const { data, info } = await sharp(file).resize(96, 54, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, edges = 0, count = 0;
  for (let y = 8; y < info.height - 8; y++) for (let x = 8; x < info.width - 8; x++) {
    const index = y * info.width + x, value = data[index];
    sum += value; edges += Math.abs(value - data[index - 1]) + Math.abs(value - data[index - info.width]); count++;
  }
  const brightness = sum / count, detail = edges / count;
  return { brightness, detail, score: Math.min(brightness, 150) * .5 + detail * 2 - (brightness < 20 ? 100 : 0) };
}
export async function createThumbnail(config: Config, file: string, probe: Probe, output: string) {
  const scratch = `${output}.candidates`; await mkdir(scratch, { recursive: true });
  try {
    const candidates = [];
    const tone = isHdr(probe) ? 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,' : '';
    for (const [index, fraction] of [.12, .2, .35, .55].entries()) {
      const frame = path.join(scratch, `${index}.jpg`), position = probe.duration * fraction;
      await command(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', String(position), '-i', file, '-frames:v', '1', '-vf', `${tone}scale=960:-2`, '-y', frame]);
      candidates.push({ frame, position, ...await frameScore(frame) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0], video = videoStream(probe);
    const width = video.width || 1920, height = video.height || 1080;
    const metadata = await command(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', String(selected.position), '-i', file, '-an', '-sn', '-vf', 'cropdetect=limit=0.08:round=2:reset=0,metadata=mode=print:file=-', '-frames:v', '24', '-f', 'null', '-']);
    const crop = detectedCrop(metadata, width, height), frame = await sharp(selected.frame).metadata();
    const left = Math.round(crop.left * frame.width! / width), top = Math.round(crop.top * frame.height! / height);
    const scaled = { left, top, width: Math.min(frame.width! - left, Math.round(crop.width * frame.width! / width)), height: Math.min(frame.height! - top, Math.round(crop.height * frame.height! / height)) };
    await sharp(selected.frame).extract(scaled).resize(960, 540, { fit: 'cover', position: 'centre' }).webp({ quality: 82 }).toFile(output);
    const report = { version: THUMBNAIL_VERSION, position: selected.position, crop, candidates: candidates.map(({ frame: _frame, ...candidate }) => candidate), output: { width: 960, height: 540 } };
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2)); return report;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
