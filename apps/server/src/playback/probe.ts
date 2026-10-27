import type { Config } from '../config.js';
import { command } from '../util.js';

export interface StreamInfo {
  index: number; codec_type: string; codec_name?: string; width?: number; height?: number;
  pix_fmt?: string; color_transfer?: string; color_primaries?: string; avg_frame_rate?: string;
  has_b_frames?: number;
  channels?: number; profile?: string; tags?: Record<string, string>; disposition?: { default?: number };
}
export interface Probe { duration: number; startTime?: number; container: string; streams: StreamInfo[] }
export async function probe(config: Config, file: string): Promise<Probe> {
  const raw = JSON.parse(await command(config.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  const duration = Number(raw.format?.duration);
  if (!(duration > 0) || !raw.streams?.some((s: StreamInfo) => s.codec_type === 'video')) throw new Error('No playable video/duration');
  return { duration, startTime: Number(raw.format.start_time) || 0, container: raw.format.format_name, streams: raw.streams };
}
export function videoStream(probe: Probe): StreamInfo { return probe.streams.find(s => s.codec_type === 'video')!; }
export const isHdr = (p: Probe) => ['smpte2084', 'arib-std-b67'].includes(videoStream(p).color_transfer || '');
export const isAss = (s: StreamInfo) => s.codec_name === 'ass' || s.codec_name === 'ssa';
export const textSubtitle = (s: StreamInfo) => ['ass', 'ssa', 'subrip', 'webvtt', 'mov_text', 'text', 'sami'].includes(s.codec_name || '');
