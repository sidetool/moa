import type { BrowseSchema, BrowseSelection, MediaCard, Page } from '@moa/shared';
import { api } from '../../lib/api';
export function categorySelection(schema:BrowseSchema, category?:string):BrowseSelection|undefined {
  if (!category || !['movies','series'].includes(category)) return;
  const choices = category === 'movies' ? ['영화'] : ['드라마','시리즈'];
  const field = schema.filters.find(f => f.kind === 'select' && ['카테고리','콘텐츠 종류'].includes(f.label) && choices.some(c => f.options?.includes(c)));
  if (!field) return;
  const index = field.options!.findIndex(o => choices.includes(o));
  return { revision:schema.revision, filters:[{position:field.position,...(field.groupPosition === undefined ? {} : {groupPosition:field.groupPosition}),value:index}] };
}
export function sourcePage(id:string, mode:string, q='', page=1, selection?:BrowseSelection, signal?:AbortSignal) {
  return api<Page<MediaCard>>(`/sources/${encodeURIComponent(id)}/browse`,{method:'POST',body:{mode,q,page,...(selection ? {selection} : {})},signal});
}
export const sourceUrl = (id:string, selection?:BrowseSelection) => `/sources/${encodeURIComponent(id)}${selection ? '?filters='+encodeURIComponent(JSON.stringify(selection)) : ''}`;

export function parseSelection(raw:string|null):BrowseSelection|undefined {
  try {
    const v = raw ? JSON.parse(raw) : undefined;
    if (!v || typeof v.revision !== 'string' || !Array.isArray(v.filters) || v.filters.length>512 || v.filters.some((c:unknown)=>!c || typeof c !== 'object' || !('position' in c) || !Number.isInteger(c.position) || !('value' in c))) return;
    return v;
  } catch { return; }
}
