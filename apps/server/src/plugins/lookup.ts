import type { MetadataCandidate, MetadataLookupQuery } from '@moa/shared';
import type { Catalog } from '../catalog/service.js';
import type { TitleGroups } from '../catalog/title-groups.js';
import { parseSeasonInfo, seasonIdentity } from '../catalog/season-info.js';
import { normalize } from '../util.js';

const identity = (title: string, season?: number) => {
  const parsed = parseSeasonInfo(title, { season });
  return JSON.stringify([normalize(parsed.identityTitle), seasonIdentity(parsed)]);
};
const poster = (value: unknown) => typeof value === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w342|w500|original)\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(value)
  ? value.replace(/\/t\/p\/[^/]+\//, '/t/p/w342/') : undefined;

export function lookupCandidates(query: MetadataLookupQuery, candidates: MetadataCandidate[]) {
  const parsed = parseSeasonInfo(query.title), key = normalize(parsed.identityTitle);
  return candidates.filter(item => Number.isSafeInteger(item.id) && item.id > 0 && ['movie', 'tv'].includes(item.kind)
    && (query.type !== 'anime' || item.genreIds?.includes(16))
    && (query.type !== 'movie' || item.kind === 'movie') && (query.type !== 'series' || item.kind === 'tv')
    && (!parsed.season && !parsed.final || item.kind === 'tv')
    && (!parsed.movieIdentity || item.kind === 'movie')
    && [item.title, item.originalTitle].some(name => typeof name === 'string' && normalize(parseSeasonInfo(name).identityTitle) === key));
}

/** Resolve accepted identities without creating source entries or changing metadata links. */
export function lookupTitle(catalog: Catalog, groups: TitleGroups, profile: string, query: MetadataLookupQuery, candidates: MetadataCandidate[]) {
  const target = identity(query.title), parsed = parseSeasonInfo(query.title);
  const matched = lookupCandidates(query, candidates);
  const remote = new Set(matched.map(item => `${item.kind}:${item.id}`));
  const found = catalog.search(profile, parsed.identityTitle, matched).groups.flatMap(group => group.items);
  const ids = found.filter(card => {
    if (query.type && card.type !== query.type) return false;
    const row = catalog.db.get(`SELECT m.title,m.metadata,l.kind,l.tmdb_id,l.season,t.card FROM media m
      LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE m.id=?`, card.id)!;
    const info = JSON.parse(row.metadata), metadata = JSON.parse(row.card || '{}');
    const names = [row.title, info.originalTitle, ...(Array.isArray(info.altTitles) ? info.altTitles : []),
      ...catalog.db.all('SELECT title,original_title FROM media_titles WHERE media_id=?', card.id).flatMap(item => [item.title, item.original_title]),
      metadata.title, metadata.originalTitle, ...(Array.isArray(metadata.aliases) ? metadata.aliases : [])];
    const season = row.season ?? parseSeasonInfo(row.title).season;
    if (names.some(name => typeof name === 'string' && identity(name, season) === target)) return true;
    if (!remote.has(`${row.kind}:${row.tmdb_id}`)) return false;
    const source = parseSeasonInfo(row.title, { season });
    return JSON.stringify(seasonIdentity(source)) === JSON.stringify(seasonIdentity(parsed));
  }).map(card => card.id);
  const resolved = groups.resolve(ids, profile);
  const media = resolved.length === 1 ? resolved[0] : undefined;
  let image = media && poster(media.poster);
  if (!image) {
    const link = media && catalog.db.get("SELECT kind,tmdb_id FROM tmdb_links WHERE media_id=? AND status IN ('auto','manual')", media.id);
    const choices = link ? matched.filter(item => item.kind === link.kind && item.id === link.tmdb_id) : matched;
    if (new Set(choices.map(item => `${item.kind}:${item.id}`)).size === 1) image = poster(choices[0].poster);
  }
  return { ...(media ? { mediaId: media.id } : {}), ...(image ? { poster: image } : {}) };
}
