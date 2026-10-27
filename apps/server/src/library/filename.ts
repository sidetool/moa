import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.webm', '.avi', '.mov', '.ts']);
export const SUBTITLE_EXTENSIONS = new Set(['.ass', '.ssa', '.srt', '.vtt', '.smi', '.sami']);
export interface ParsedName { title: string; season: number; episode?: number; year?: number }
function clean(s: string) {
  return s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*(?:\d{3,4}p|\d{3,4}x\d{3,4}|x26[45]|HEVC|AAC|BS11|AT-X|BluRay)[^)]*\)/gi, '')
    .replace(/[._]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
}
export function parseName(filename: string, folder = ''): ParsedName {
  const base = clean(path.basename(filename).replace(/\.(mkv|mp4|m4v|webm|avi|mov|ts|ass|ssa|srt|vtt|smi|sami)$/i, ''));
  const folderBase = clean(path.basename(folder));
  const seasonHint = folderBase.match(/(?:\bS(?:eason)?\s*|시즌\s*)(\d+)/i);
  const bare = base.match(/^(\d{1,3})(?:\s*(?:화|END))?$/i);
  if (bare && folderBase) {
    const title = clean(folderBase.replace(/\bS(?:eason)?\s*\d+\b/i, '')) || clean(path.basename(path.dirname(folder)));
    return { title, season: Number(seasonHint?.[1] || 1), episode: +bare[1] };
  }
  const series = base.match(/^(.*?)\bS(\d+)\s*E(\d+)/i);
  if (series) return { title: clean(series[1]) || clean(folderBase.replace(/\bS(?:eason)?\s*\d+.*/i, '')), season: +series[2], episode: +series[3] };
  const anime = base.match(/^(.*?)\s*(\d{1,3})\s*화(?:\s|$)/i) || base.match(/^(.*?)(?:\s+-\s*|\s+)(\d{1,3})(?:\s*화|\s*(?:END\b|$)|\s*\()/i);
  if (anime) {
    const titlePart = anime[1];
    const ownSeason = titlePart.match(/\bS(?:eason)?\s*(\d+)\b/i);
    let title = clean(titlePart.replace(/\bS(?:eason)?\s*\d+\b/i, ''));
    if (folderBase && seasonHint) title = clean(folderBase.replace(/\bS(?:eason)?\s*\d+\b/i, '')) || title;
    return { title, season: Number(ownSeason?.[1] || seasonHint?.[1] || 1), episode: +anime[2] };
  }
  const year = base.match(/(?:^|[\s(])((?:19|20)\d{2})(?:[\s)]|$)/);
  const title = year ? base.slice(0, year.index).replace(/[\s(]+$/g, '') : base.split(/\b(?:\d{3,4}p|BluRay|WEB[- ]?DL|HDRip|x26[45]|HEVC)\b/i)[0];
  return { title: clean(title) || base, season: Number(seasonHint?.[1] || 1), ...(year ? { year: +year[1] } : {}) };
}
export function matchSubtitles(video: string, candidates: string[]): string[] {
  const stem = path.basename(video, path.extname(video));
  const parsed = parseName(video, path.dirname(video));
  return candidates.filter(sub => {
    if (!SUBTITLE_EXTENSIONS.has(path.extname(sub).toLowerCase())) return false;
    const subStem = path.basename(sub, path.extname(sub));
    if (subStem === stem || subStem.startsWith(`${stem}.`)) return true;
    const other = parseName(sub, path.dirname(video));
    return parsed.episode !== undefined && parsed.episode === other.episode && parsed.season === other.season &&
      parsed.title.toLowerCase() === other.title.toLowerCase();
  });
}
