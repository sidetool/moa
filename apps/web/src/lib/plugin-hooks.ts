import type { MediaCard } from '@moa/shared';

type Card = Pick<MediaCard, 'id' | 'title' | 'type' | 'year' | 'genres' | 'overview' | 'badge'>;
type Hook = { profile: string; run: (value: { path: string; items: Card[] }, signal: AbortSignal) => Promise<unknown> };
const hooks = new Map<string, Hook>();
export function registerCatalogHook(id: string, hook: Hook) {
  hooks.set(id, hook);
  return () => { if (hooks.get(id) === hook) hooks.delete(id); };
}

export async function transformPluginCatalog<T>(path: string, value: T, profile: string | null): Promise<T> {
  if (!profile || !/^\/api\/(?:home(?:\?|$)|media(?:\/|\?|$)|search(?:\?|$)|watchlist(?:\?|$)|sources\/[^/]+\/(?:popular|latest|search|browse)(?:\?|$))/.test(path)) return value;
  const active = [...hooks].filter(([, hook]) => hook.profile === profile).sort(([a], [b]) => a.localeCompare(b));
  if (!active.length) return value;
  const cards = new Map<string, Card>();
  const walk = (item: any, patches?: Map<string, object>): any => {
    if (Array.isArray(item)) return item.map(entry => walk(entry, patches));
    if (!item || typeof item !== 'object') return item;
    const card = typeof item.id === 'string' && typeof item.title === 'string' && ['movie', 'series', 'anime'].includes(item.type) && item.provider;
    if (card) cards.set(item.id, { id: item.id, title: item.title.slice(0, 500), type: item.type, year: item.year, genres: item.genres?.slice(0, 16), overview: item.overview?.slice(0, 1000), badge: item.badge?.slice(0, 80) });
    const result = Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry, patches)]));
    return card && patches?.has(item.id) ? { ...result, ...patches.get(item.id) } : result;
  };
  walk(value);
  if (!cards.size || cards.size > 128) return value;
  const patches = new Map<string, object>();
  const results = await Promise.all(active.map(async ([id, hook]) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1200);
    try {
      const result = await Promise.race([hook.run({ path, items: [...cards.values()] }, controller.signal), new Promise<undefined>(resolve => controller.signal.addEventListener('abort', () => resolve(undefined), { once: true }))]);
      if (controller.signal.aborted || hooks.get(id) !== hook || !Array.isArray(result) || result.length > cards.size || JSON.stringify(result).length > 65536) return [];
      const ids = new Set();
      for (const patch of result) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !cards.has(patch.id) || ids.has(patch.id) || Object.keys(patch).some(key => !['id', 'title', 'overview', 'badge', 'genres'].includes(key))) return [];
        ids.add(patch.id);
        for (const [key, limit] of [['title', 500], ['overview', 4000], ['badge', 80]] as const) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key].length > limit || key === 'title' && !patch[key].trim())) return [];
        if (patch.genres !== undefined && (!Array.isArray(patch.genres) || patch.genres.length > 16 || patch.genres.some((genre: unknown) => typeof genre !== 'string' || genre.length > 80))) return [];
      }
      return result;
    } catch { return []; }
    finally { clearTimeout(timer); }
  }));
  for (const result of results) for (const { id, ...patch } of result) patches.set(id, { ...patches.get(id), ...patch });
  return patches.size ? walk(value, patches) : value;
}
