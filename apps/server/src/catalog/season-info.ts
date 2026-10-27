import type { MediaCard, SeasonInfo } from '@moa/shared';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export interface SeasonContext { season?: number | null; seasons?: number[]; kind?: string }
/** Parse source titles before localization; retain subtitle/edition text in identityTitle. */
export function parseSeasonInfo(raw: string, context: SeasonContext = {}) {
  const text = raw.normalize('NFKC');
  const audio = /더빙|\bdub(?:bed)?\b/i.test(text) ? 'dub' as const : /자막|\bsub(?:bed)?\b/i.test(text) ? 'sub' as const : undefined;
  const movie = /극장판|劇場版|더\s*무비|\b(?:the\s+)?movie\b/i.test(text);
  const ova = /\b(?:oad|ova)(?=\d|\b)/i.exec(text)?.[0];
  const special = /특별편|스페셜|\bspecials?\b/i.test(text);
  const final = /\b(?:the\s+)?final(?:\s+season\b|(?=\s*(?:part\b|완결편|[()[\]]|$)))|(?:더\s*)?파이널(?:\s*시즌)?|완결편/i.test(text);
  const seasonMatch = /(?:시즌|season)\s*(\d+)|(\d+)\s*기|\b(\d+)(?:st|nd|rd|th)\s+season\b/i.exec(text);
  const partMatch = /(?:part|파트)\s*(\d+)|(\d+)\s*(?:부|쿨)(?=$|[\s\p{P}])/iu.exec(text);
  const half = /(?:완결편\s*)?[([]?\s*(전편|후편)\s*[)\]]?/.exec(text)?.[1];
  const season = context.season ?? (seasonMatch ? Number(seasonMatch[1] || seasonMatch[2] || seasonMatch[3]) : final && context.seasons?.length ? Math.max(...context.seasons) : undefined);
  const part = partMatch ? Number(partMatch[1] || partMatch[2]) : final && half ? 3 : undefined;
  const identityTitle = text
    .replace(/(?:시즌|season)\s*\d+|\d+\s*기|\b\d+(?:st|nd|rd|th)\s+season\b/gi, ' ')
    .replace(/\b(?:the\s+)?final(?:\s+season\b|(?=\s*(?:part\b|완결편|[()[\]]|$)))|(?:더\s*)?파이널(?:\s*시즌)?|완결편/gi, ' ')
    .replace(/(?:part|파트)\s*\d+|\d+\s*(?:부|쿨)(?=$|[\s\p{P}])/giu, ' ')
    .replace(/극장판|劇場版|\b(?:the\s+)?movie\b|\b(?:oad|ova)(?=\d|\b)|특별편|스페셜|\bspecials?\b/gi, ' ')
    .replace(/전편|후편/g, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const baseTitle = identityTitle.split(/\s*[:：~〜]\s*/)[0].trim() || identityTitle;
  let seasonInfo: SeasonInfo | undefined;
  if (movie) seasonInfo = { kind: 'movie', label: '극장판' };
  else if (ova) seasonInfo = { kind: 'ova', label: ova.toUpperCase() };
  else if (special) seasonInfo = { kind: 'special', label: '특별편' };
  else if (final || part || season != null && (season > 1 || seasonMatch || (context.seasons?.length || 0) > 1)) {
    const label = final ? '파이널 시즌' : season != null ? `시즌 ${season}` : '';
    seasonInfo = { kind: final ? 'final' : part ? 'part' : 'season', ...(season != null ? { season } : {}), ...(part ? { part } : {}), label: label + (part ? `${label ? ' · ' : ''}파트 ${part}` : '') };
  }
  return { baseTitle, identityTitle, seasonInfo, half, final, season, part, audio, movieIdentity: movie || context.kind === 'movie' };
}

/** Numeric season makes 'Final Season' and 'Season 4' compatible only with metadata evidence. */
export function seasonIdentity(parsed: ReturnType<typeof parseSeasonInfo>, fallbackSeason = 1) {
  const kind = parsed.movieIdentity ? 'movie' : parsed.seasonInfo?.kind;
  return [kind === 'movie' || kind === 'ova' || kind === 'special' ? kind : 'tv', parsed.season ?? (parsed.final ? 'final' : parsed.part ? 'unknown' : fallbackSeason), parsed.part ?? null, parsed.half ?? null];
}
export function searchRelevance(card: MediaCard, query: string): number {
  const q = norm(query); if (!q) return 0;
  const title = norm(card.baseTitle || card.title);
  if (title === q) return 1;
  if (title.startsWith(q)) return 0.85;
  if (title.includes(q)) return 0.4;
  const original = norm(card.originalTitle || '');
  if (original === q) return 1;
  if (original.includes(q)) return 0.7;
  return 0;
}
