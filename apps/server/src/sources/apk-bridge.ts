import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { compatibilityHttp, publicUrl, type SourceItem, type SourceVideo } from './extensions/index.js';
import type { SourcePreference } from '@moa/shared';
import { ApiFailure } from '../util.js';

/** Aniyomi repositories store package artwork next to apk/ under icon/. */
export function apkIconUrl(repository: string, pkg: string, declared?: unknown): string | undefined {
  try { return publicUrl(new URL(typeof declared === 'string' && declared ? declared : `icon/${encodeURIComponent(pkg)}.png`, repository).href); } catch { return undefined; }
}
export const APK_RELAY = 'https://moa-apk.invalid';
export interface ApkEntry {
  id: string; name: string; lang: string; version: string; baseUrl: string; iconUrl?: string; format: 'aniyomi-apk';
  package: { pkg: string; code: number; version: string; apkUrl: string }; supportsLatest?: boolean;
}
export type ExtractedVideos = SourceVideo[] & { apkLease?: string };
export class ApkBridge {
  private endpoint?: URL;
  private secret?: string;
  constructor(endpoint = process.env.MOA_APK_URL, secret = process.env.MOA_APK_SECRET_FILE ? readFileSync(process.env.MOA_APK_SECRET_FILE, 'utf8').trim() : undefined) {
    if (!endpoint && !secret) return;
    const url = new URL(endpoint || '');
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !secret || secret.length < 32) throw new Error('invalid-apk-bridge-config');
    this.endpoint = url; this.secret = secret;
  }
  async status(): Promise<{ available: boolean; state: 'disabled' | 'ready' | 'unreachable'; workers: number | null }> {
    if (!this.endpoint) return { available: false, state: 'disabled', workers: null };
    try {
      const runtime = await this.rpc<{ workers: number }>('status', {}, AbortSignal.timeout(3000));
      return { available: true, state: 'ready', workers: runtime.workers };
    } catch { return { available: false, state: 'unreachable', workers: null }; }
  }
  private async request(path: string, signal: AbortSignal, body?: Buffer, range?: string) {
    if (!this.endpoint || !this.secret) throw new ApiFailure(503, 'apk-bridge-unavailable');
    const url = new URL(path, this.endpoint);
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: body ? 'POST' : 'GET', signal, headers: { Authorization: `Bearer ${this.secret}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}), ...(range ? { Range: range } : {}) } }, resolve);
      req.setTimeout(125_000, () => req.destroy(new Error('apk_timeout'))); req.on('error', reject); req.end(body);
    });
  }
  async rpc<T = any>(method: string, params: Record<string, unknown> = {}, signal = AbortSignal.timeout(120_000)): Promise<T> {
    const response = await this.request('/rpc', signal, Buffer.from(JSON.stringify({ ...params, method })));
    try {
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of response) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new ApiFailure(502, 'apk-response-limit'); parts.push(Buffer.from(chunk)); }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (response.statusCode !== 200 || data.error) throw new ApiFailure(response.statusCode === 409 ? 409 : 502, /^apk_[a-z_]+$/.test(data.error) ? data.error : 'apk-request-failed');
      return data.result;
    } finally { response.destroy(); }
  }
  async registry(url: string, signal: AbortSignal, proxy?: string): Promise<ApkEntry[]> {
    const r = await compatibilityHttp({ url, headers: { 'User-Agent': 'Mozilla/5.0' } }, signal, [], 4 * 1024 * 1024, proxy);
    if (r.statusCode !== 200) throw new ApiFailure(502, 'apk-repository-unavailable');
    const packages = await this.rpc<any[]>('repository', { repository: url, index: r.bytes.toString('base64') }, signal);
    return packages.filter(p => p.supportedVersion).flatMap(p => p.sources.map((s: any) => ({ id: s.id, name: s.name, lang: s.lang, version: p.version, baseUrl: s.baseUrl || '', iconUrl: apkIconUrl(url,p.pkg,p.icon), format: 'aniyomi-apk', package: { pkg: p.pkg, code: p.code, version: p.version, apkUrl: p.apkUrl } })));
  }
  async install(entry: ApkEntry, repository: string, signal: AbortSignal, proxy?: string) {
    const r = await compatibilityHttp({ url: entry.package.apkUrl, headers: { 'User-Agent': 'Mozilla/5.0' } }, signal, [], 32 * 1024 * 1024, proxy);
    if (r.statusCode !== 200) throw new ApiFailure(502, 'apk-download-failed');
    return this.rpc('install', { repository, advertised: { ...entry.package, requiredSource: { id:entry.id, name:entry.name, lang:entry.lang } }, apk: r.bytes.toString('base64') }, signal);
  }
  remove(packageId: string) { return this.rpc('remove', { packageId }); }
  async call(packageId: string, entry: ApkEntry, action: string, params: Record<string, unknown>, proxy: string | undefined, signal: AbortSignal) {
    // Keep the host proxy authoritative; unsupported proxy schemes fail before any source request.
    if (proxy) { const p = new URL(proxy); if (!['http:', 'socks5:'].includes(p.protocol) || p.username || p.password) throw new ApiFailure(400, 'apk-proxy-unsupported'); }
    await this.rpc('preferences-save', { packageId, params: { values: { __moa_outbound_proxy: proxy || '' } } }, signal);
    const invoke = (method: string, more = params) => this.rpc(method, { packageId, params: { ...more, sourceId: entry.id } }, signal);
    const item = (v: any): SourceItem => ({ name: v.title, link: v.url, imageUrl: v.cover, description: v.description, genre: typeof v.genre === 'string' ? v.genre.split(',').map((s: string) => s.trim()).filter(Boolean) : [], author: v.author, status: v.status });
    if (action === 'list') { const r = await invoke('list'); return { list: r.items.map(item), hasNextPage: r.hasNextPage }; }
    if (action === 'detail') { const r = await invoke('detail'), episodes = await invoke('episodes'); return { ...item(r), chapters: episodes.map((e: any) => ({ name: e.title, url: e.url, number: e.number })) }; }
    if (action === 'filters') return { browse: { filters: await invoke('filters'), availableModes: entry.supportsLatest ? ['popular', 'latest', 'search'] : ['popular', 'search'] } };
    if (action === 'videos') {
      const r = await invoke('extract');
      const videos: ExtractedVideos = r.videos.map((v: any) => ({ url: v.url, quality: v.quality, headers: v.headers, subtitles: v.subtitles?.map((t: any) => ({ file: t.url, label: t.label })), audios: v.audio?.map((t: any) => ({ file: t.url, label: t.label })) }));
      videos.apkLease = r.lease; return videos;
    }
    throw new ApiFailure(400, 'apk-action-unsupported');
  }
  async preferences(packageId: string, entry: ApkEntry, changes?: Record<string, unknown>): Promise<SourcePreference[]> {
    const read = async () => {
      const r = await this.rpc('preferences', { packageId, params: {} });
      return r.fields.filter((p: any) => p.group === entry.id) as SourcePreference[];
    };
    const fields = await read();
    if (!changes) return fields;
    if (Object.keys(changes).some(k => !fields.some(p => p.key === k))) throw new ApiFailure(400, 'invalid-source-preference');
    await this.rpc('preferences-save', { packageId, params: { values: changes } });
    return read();
  }
  release(lease?: string): void | Promise<void> {
    if(!lease)return;
    return (async()=>{ for(let attempt=0;attempt<3;attempt++) {
      try { await this.rpc('release',{lease},AbortSignal.timeout(5000)); return; }
      catch { if(attempt<2)await delay(attempt?1000:250,undefined,{ref:false}); }
    } })();
  }
  renew(lease: string) { return this.rpc('renew', { lease }, AbortSignal.timeout(5000)); }
  async stream(url: string, lease: string | undefined, range: string | undefined, signal: AbortSignal) {
    const u = new URL(url), match = /^\/([\w-]{32})\/assets\/([\w-]{32})$/.exec(u.pathname);
    if (u.origin !== APK_RELAY || !match || match[1] !== lease || u.search || u.hash) throw new ApiFailure(502, 'apk-stream-forbidden');
    return { response: await this.request(`/leases${u.pathname}`, signal, undefined, range), url };
  }
}
