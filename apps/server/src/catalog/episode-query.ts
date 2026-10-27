import { parseSeason, knownAnimeIdentity } from '../subtitles/korean/index.js';
import type { Store } from '../db.js';

/** Preserve source IDs and numbering; normalize only enrichment queries. */
export function episodeQuery(db: Store, episode: Record<string, any>) {
  const title = episode.original_title ?? episode.title;
  const remote = Boolean(db.get('SELECT 1 FROM source_media WHERE media_id=?', episode.media_id));
  const season = remote ? parseSeason(title) ?? episode.season : episode.season;
  const known = knownAnimeIdentity(title, season);
  let number = episode.number;
  if (remote && known.episodeOffset > 0 && known.episodeCount) {
    const range = db.get('SELECT MIN(number) AS first,MAX(number) AS last,COUNT(DISTINCT number) AS count FROM episodes WHERE media_id=?', episode.media_id)!;
    // Require the whole verified absolute range. A partial listing beginning
    // with 12 must not be mistaken for season-relative episode 1.
    if (range.first === known.episodeOffset + 1 && range.last === known.episodeOffset + known.episodeCount && range.count === known.episodeCount) number -= known.episodeOffset;
  }
  return { title, season, episode: number, aliases: known.aliases };
}
