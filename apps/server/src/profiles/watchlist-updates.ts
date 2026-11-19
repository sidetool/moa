import type { MediaCard } from '@moa/shared';
import type { Store } from '../db.js';

/** Compare availability only with this profile's history on the same edition. */
export function watchlistUpdates(db: Store, cards: MediaCard[], profile: string): MediaCard[] {
  return cards.map(card => {
    const id = card.resumeMediaId ?? card.id;
    const observation = db.get(`SELECT o.episode_ids,o.episodes_updated_at FROM source_detail_observations o
      JOIN media m ON m.id=o.media_id
      WHERE o.media_id=? AND m.type!='movie' AND COALESCE(json_extract(m.metadata,'$.live'),0)=0`, id);
    if (!observation) return card;

    // The furthest watched ordinal survives rewatches. Retained catalog rows for
    // withdrawn episodes can mark progress but cannot count as available.
    const unseen = card.resumeMediaId && observation.episode_ids ? db.get(`
      SELECT COUNT(*) AS n FROM episodes e JOIN json_each(?) observed ON observed.value=e.id
      WHERE e.media_id=? AND (e.season,e.number) > (
        SELECT seen.season,seen.number FROM progress p JOIN episodes seen ON seen.id=p.episode_id
        WHERE p.profile_id=? AND seen.media_id=? AND (p.position>0 OR p.completed=1)
        ORDER BY seen.season DESC,seen.number DESC LIMIT 1
      )`, observation.episode_ids, id, profile, id)?.n : 0;
    return { ...card,
      ...(observation.episodes_updated_at != null ? { episodesUpdatedAt: new Date(observation.episodes_updated_at).toISOString() } : {}),
      ...(unseen ? { unseenEpisodeCount: unseen } : {}),
    };
  });
}
