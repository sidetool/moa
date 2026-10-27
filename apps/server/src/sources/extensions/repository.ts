import { createHash } from 'node:crypto';
import { compatibilityHttp } from './http.js';
import type { MangayomiEntry } from './types.js';

export function publicUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('repository-url-invalid');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('repository-url-invalid');
  return url.href;
}
export function parseRepository(value: unknown): MangayomiEntry[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('repository-format-invalid');
  const ids = new Set<string>();
  return value.filter(row => row?.itemType === 1 && row?.sourceCodeLanguage === 1).map(row => {
    const id = String(row.id ?? '');
    const lang = typeof row.lang === 'string' ? row.lang.slice(0,20).trim() || 'all' : 'all';
    const identity = JSON.stringify([id,lang]);
    if (!id || id.length > 128 || ids.has(identity) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || typeof row.version !== 'string' || row.version.length > 64) throw new Error('repository-entry-invalid');
    ids.add(identity);
    const text = (v: unknown, maximum = 2048) => typeof v === 'string' ? v.slice(0, maximum) : undefined;
    let iconUrl: string | undefined;
    try { if(row.iconUrl) iconUrl=publicUrl(row.iconUrl); } catch { /* Optional artwork must not reject a usable source. */ }
    return { id, name: row.name, version: row.version, lang, format: 'mangayomi-js', itemType: 1, baseUrl: publicUrl(row.baseUrl), sourceCodeUrl: publicUrl(row.sourceCodeUrl), ...(iconUrl ? { iconUrl } : {}), apiUrl: text(row.apiUrl), additionalParams: text(row.additionalParams, 16384), dateFormat: text(row.dateFormat), dateFormatLocale: text(row.dateFormatLocale), typeSource: text(row.typeSource), appMinVerReq: text(row.appMinVerReq), notes: text(row.notes), isManga: false, isNsfw: row.isNsfw === true, hasCloudflare: row.hasCloudflare === true };
  });
}
export async function fetchRepository(url: string, signal = AbortSignal.timeout(20_000), proxy?: string) {
  const response = await compatibilityHttp({ url: publicUrl(url), options: { timeout: 20 } }, signal, [], 4 * 1024 * 1024, proxy);
  if (response.statusCode !== 200) throw new Error(`repository-http-${response.statusCode}`);
  return parseRepository(JSON.parse(response.bytes.toString('utf8')));
}
export async function fetchExtension(entry: MangayomiEntry, signal = AbortSignal.timeout(20_000), proxy?: string) {
  const response = await compatibilityHttp({ url: publicUrl(entry.sourceCodeUrl), options: { timeout: 20 } }, signal, [], 1024 * 1024, proxy);
  if (response.statusCode !== 200) throw new Error(`extension-http-${response.statusCode}`);
  const source = response.bytes.toString('utf8');
  if (!source.includes('DefaultExtension') || /^\s*</.test(source)) throw new Error('extension-source-invalid');
  return { source, sha256: createHash('sha256').update(source).digest('hex') };
}
