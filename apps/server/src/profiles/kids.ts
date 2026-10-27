import type { Store } from '../db.js';
import { ApiFailure } from '../util.js';

// Product policy, not a claim that national classification systems are equivalent.
const AGES: Record<string, number> = {
  ALL: 0, '전체관람가': 0, '전체': 0, '0': 0, '7': 7, '12': 12, '15': 15, '18': 19, '19': 19,
  '7세이상관람가': 7, '12세이상관람가': 12, '15세이상관람가': 15, '청소년관람불가': 19, '청불': 19,
  G: 0, PG: 12, 'TV-Y': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-G': 0, 'TV-PG': 12,
  'PG-13': 15, 'TV-14': 15, R: 19, 'NC-17': 19, 'TV-MA': 19,
};
export function certificationAge(value?: string): number | undefined {
  return value ? AGES[value.normalize('NFKC').toUpperCase().replace(/\s/g, '')] : undefined;
}
/** TMDB Family (10751) and Kids (10762); older caches only kept the localized names. */
const FAMILY_GENRES = new Set([10751, 10762]);
const FAMILY_NAMES = new Set(['가족', '키즈', 'Family', 'Kids']);
export function kidsAllowed(info: { certification?: string; adult?: boolean; genreIds?: number[]; genres?: string[] } | undefined): boolean {
  if (!info || info.adult) return false;
  const age = certificationAge(info.certification);
  if (age !== undefined) return age <= 12;
  // Unrated titles pass only when TMDB files them under Family/Kids. An unmapped explicit rating ('UNKNOWN') stays blocked.
  if (info.certification === 'UNKNOWN') return false;
  return Boolean(info.genreIds?.some(id => FAMILY_GENRES.has(id)) || info.genres?.some(name => FAMILY_NAMES.has(name)));
}

/** Prefer KR, then US. Other supported countries use explicit country-specific mappings. */
export function selectCertification(kind: 'tv' | 'movie', data: any): string | undefined {
  const rows: any[] = (kind === 'tv' ? data.content_ratings?.results : data.release_dates?.results) || [];
  const foreign: Record<string, Record<string, number>> = {
    GB: { U: 0, PG: 12, '12': 12, '12A': 12, '15': 15, '18': 19, R18: 19 },
    DE: { '0': 0, '6': 7, '12': 12, '16': 19, '18': 19 },
    JP: { G: 0, PG12: 12, 'R15+': 15, 'R18+': 19 },
    AU: { G: 0, PG: 12, M: 15, 'MA15+': 15, 'R18+': 19, 'X18+': 19 },
  };
  for (const country of ['KR', 'US', ...Object.keys(foreign)]) {
    const values = rows.filter(r => r.iso_3166_1 === country).flatMap(r => kind === 'tv' ? [r.rating] : (r.release_dates || []).map((d: any) => d.certification))
      .filter((v: unknown): v is string => typeof v === 'string' && !!v.trim());
    if (!values.length) continue;
    // Unknown explicit ratings do not become safe through another country's rating.
    const ages = values.map(v => country === 'KR' || country === 'US' ? certificationAge(v) : foreign[country][v.toUpperCase().replace(/\s/g, '')]);
    if (ages.some(a => a === undefined)) return 'UNKNOWN';
    const age = Math.max(...ages as number[]);
    return age === 0 ? 'ALL' : String(age);
  }
  return undefined;
}

export class KidsPolicy {
  constructor(private db: Store) {}
  active(profile: string): boolean { return Boolean(this.db.get('SELECT kids FROM profiles WHERE id=?', profile)?.kids); }
  filter<T extends Record<string, any>>(items: T[], profile: string): T[] {
    if (!this.active(profile) || !items.length) return items;
    const rows = this.db.all(`SELECT m.id,m.metadata,t.card FROM media m
      LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id
      WHERE m.id IN (SELECT value FROM json_each(?))`, JSON.stringify(items.map(i => i.id)));
    const allowed = new Set(rows.filter(r => !JSON.parse(r.metadata).adult && kidsAllowed(r.card ? JSON.parse(r.card) : undefined)).map(r => r.id));
    return items.filter(i => allowed.has(i.id));
  }
  assert(id: string, profile: string) {
    if (this.active(profile) && !this.filter([{ id }], profile).length) throw new ApiFailure(403, 'kids-restricted');
  }
  candidates<T extends { kind: string; id: number }>(items: T[], profile: string): T[] {
    if (!this.active(profile)) return items;
    return items.filter(item => {
      const row = this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?', item.kind, item.id);
      return kidsAllowed(row ? JSON.parse(row.card) : undefined);
    });
  }
}
