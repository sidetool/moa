import { knownAnimeIdentity, normalizeTitle, parseSeason } from './korean/index.js';
import type { OnlineSubtitleQuery } from '@moa/shared';
import type { Store } from '../db.js';
import { ApiFailure } from '../util.js';
import { subtitleIdentity } from '../metadata/tmdb.js';

/** Subtitle seasons follow release seasons, not TMDB's sometimes merged TV seasons. */
export function subtitleQuery(db: Store, episode: Record<string, any>, override: Partial<OnlineSubtitleQuery> = {}) {
  if (override.title !== undefined) {
    try { normalizeTitle(override.title, override.season); }
    catch { throw new ApiFailure(400, 'invalid-subtitle-query'); }
  }
  const original = episode.original_title ?? episode.title;
  const identity = subtitleIdentity(db, episode.media_id);
  const remote = Boolean(db.get('SELECT 1 FROM source_media WHERE media_id=?', episode.media_id));
  let title = identity?.title ?? original;
  let season = (remote ? parseSeason(original) : undefined) ?? identity?.season ?? episode.season;
  const titan = /^(Attack on Titan|Shingeki no Kyojin|진격의 거인|進撃の巨人)(?:\s|$)/i.test(original);
  if (titan && /\bFinal Season\b/i.test(original)) { title = identity?.title ?? '진격의 거인'; season = 4; }
  if (titan && /\bPart\s+2$/i.test(original)) title = identity?.title ?? '진격의 거인';
  const known = knownAnimeIdentity(title, season);
  let number = episode.number;
  let mapping: OnlineSubtitleQuery['mapping'] = 'source';
  const warnings: string[] = [];
  const range = remote ? db.get('SELECT MIN(number) AS first,MAX(number) AS last,COUNT(DISTINCT number) AS count FROM episodes WHERE media_id=? AND season=?', episode.media_id, episode.season) : undefined;
  if (remote && known.episodeOffset && known.episodeCount && range?.first === known.episodeOffset + 1 && range.last === known.episodeOffset + known.episodeCount && range.count === known.episodeCount) {
    number -= known.episodeOffset; mapping = 'absolute-to-season';
  }
  if (remote && /\bpart\s*[2-9]|[2-9]\s*(?:부|쿨)/i.test(original)) {
    // AoT season 3 part 2 is the second ten episodes of a 22-episode season.
    if (titan && season === 3 && /\bPart\s+2$/i.test(original) && range?.first === 1 && range.last === 10 && range.count === 10) {
      number += 12; mapping = 'part-to-season';
    } else warnings.push('part-numbering-unverified');
  }
  if (remote && known.episodeCount && number > known.episodeCount) warnings.push('episode-numbering-unverified');
  const manual = Object.keys(override).length > 0;
  title = override.title ?? title;
  season = override.season ?? (override.title ? parseSeason(override.title) : undefined) ?? season;
  const normalized = normalizeTitle(title, season);
  const aliases = manual && override.title ? [] : [...new Set([...(identity?.aliases ?? []), ...known.aliases, normalizeTitle(original).baseTitle])];
  return {
    title: normalized.baseTitle, season, episode: override.episode ?? number,
    episodeOffset: override.episodeOffset ?? knownAnimeIdentity(title, season).episodeOffset,
    aliases, mapping: manual ? 'manual' as const : mapping, warnings,
  };
}
