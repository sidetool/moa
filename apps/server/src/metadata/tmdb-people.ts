import type { DiscoveryItem, PersonCredit, TitlePeople } from '@moa/shared';

const text = (value: unknown, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const image = (size: string, value: unknown) => typeof value === 'string' && /^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(value) ? `https://image.tmdb.org/t/p/${size}${value}` : undefined;
/** Preserve source role labels, including voice tags; they do not identify dubbing language. */
export function tmdbPeople(data: any, kind: 'movie' | 'tv'): TitlePeople {
  if (!data || !Array.isArray(data.cast) || !Array.isArray(data.crew)) throw new Error('invalid-credits');
  let truncated = false;
  const list = (rows: any[], cast: boolean): PersonCredit[] => {
    const people = new Map<string, PersonCredit>();
    if (rows.length > 1000) truncated = true;
    for (const row of rows.slice(0, 1000)) {
      if (!validId(row?.id) || !text(row.name) || row.adult === true) continue;
      const id = String(row.id);
      if (!people.has(id)) {
        if (people.size >= 60) { truncated = true; continue; }
        people.set(id, {provider:'tmdb', id, name:text(row.name), photo:image('w185', row.profile_path), roles:[]});
      }
      const person = people.get(id)!;
      const raw = kind === 'tv' ? (cast ? row.roles : row.jobs) : [{character:row.character, job:row.job}];
      if (!Array.isArray(raw)) continue;
      if (raw.length > 100) truncated = true;
      for (const r of raw.slice(0,100)) {
        const role = text(cast ? r?.character : r?.job);
        if (!role || person.roles.includes(role)) continue;
        if (person.roles.length >= 8) { truncated = true; continue; }
        person.roles.push(role);
      }
    }
    return [...people.values()];
  };
  const cast = list(data.cast, true), crew = list(data.crew, false);
  return {cast, crew, truncated};
}
export function tmdbPersonWorks(data: any): {items: DiscoveryItem[]; truncated: boolean} {
  if (!data || !Array.isArray(data.cast) || !Array.isArray(data.crew)) throw new Error('invalid-person-credits');
  const items: DiscoveryItem[] = [], seen = new Set<string>();
  const rows = [...data.cast.slice(0,2000), ...data.crew.slice(0,2000)];
  let truncated = data.cast.length > 2000 || data.crew.length > 2000;
  for (const r of rows) {
    if (!validId(r?.id) || !['movie','tv'].includes(r.media_type) || r.adult !== false) continue;
    const kind = r.media_type as 'movie'|'tv', title = text(kind === 'movie' ? r.title : r.name);
    const key = `${kind}:${r.id}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    if (items.length >= 40) {truncated = true;continue;}
    const date = kind === 'movie' ? r.release_date : r.first_air_date;
    const year = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0,4)) : undefined;
    items.push({provider:'tmdb',kind,id:String(r.id),title,originalTitle:text(kind === 'movie' ? r.original_title : r.original_name)||undefined,
      year,poster:image('w342',r.poster_path),overview:text(r.overview,2000)||undefined});
  }
  return {items,truncated};
}
