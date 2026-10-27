import { load } from 'cheerio';
import { randomUUID, createHash } from 'node:crypto';
import {
  createSubtitleClient,
  knownAnimeIdentity,
  normalizeTitle,
  parseEpisodes,
  parseSeason,
  convertSubtitle,
} from '../subtitles/korean/index.js';
import type { JimakuCandidate, JimakuSearch } from '@moa/shared';
import { Store } from '../db.js';
import { Catalog } from '../catalog/service.js';
import { ApiFailure } from '../util.js';
import { subtitleQuery } from '../subtitles/query.js';
import type { Translations } from './service.js';

const ORIGIN = 'https://jimaku.cc';
const key = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const baseName = (name: string) => {
  try {
    return normalizeTitle(name).baseTitle;
  } catch {
    return name.slice(0, 500);
  }
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
interface Entry {
  id: string;
  title: string;
  names: string[];
  tmdb?: string;
}
interface File {
  filename: string;
  url: string;
  format: JimakuCandidate['format'];
  size: number;
}
interface Search {
  profile: string;
  episode: string;
  expires: number;
  result: JimakuSearch;
  files: Map<string, File>;
}

export function jimakuEntries(html: string): Entry[] {
  const $ = load(html),
    result: Entry[] = [];
  $('.entry[data-extra]').each((_, node) => {
    try {
      const data = JSON.parse($(node).attr('data-extra')!),
        id = $(node)
          .find('a[href^="/entry/"]')
          .attr('href')
          ?.match(/^\/entry\/(\d+)$/)?.[1];
      if (!id || typeof data.name !== 'string') return;
      result.push({
        id,
        title: data.name,
        names: [data.name, data.english_name, data.japanese_name].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        ),
        ...(data.tmdb_id ? { tmdb: String(data.tmdb_id) } : {}),
      });
    } catch {
      /* Ignore malformed public rows. */
    }
  });
  return result;
}
export function jimakuFiles(html: string, entry: string): File[] {
  const $ = load(html),
    result: File[] = [];
  $('.entry[data-extra]').each((_, node) => {
    try {
      const data = JSON.parse($(node).attr('data-extra')!),
        filename = data.name;
      if (typeof filename !== 'string' || typeof data.url !== 'string') return;
      const ext = filename.split('.').at(-1)?.toLowerCase();
      if (!ext || !['ass', 'ssa', 'vtt', 'srt', 'smi', 'sami'].includes(ext)) return;
      const url = new URL(data.url, ORIGIN);
      if (
        url.origin !== ORIGIN ||
        url.username ||
        url.password ||
        !url.pathname.startsWith(`/entry/${entry}/download/`)
      )
        return;
      if (Number(data.size) > 1024 * 1024) return;
      result.push({
        filename,
        url: url.href,
        format: ext === 'ssa' ? 'ass' : ext === 'sami' ? 'smi' : (ext as File['format']),
        size: Number(data.size) || 0,
      });
    } catch {
      /* Ignore unsafe or malformed file links. */
    }
  });
  return result;
}
function decodeJapanese(buffer: Buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('shift_jis').decode(buffer);
  }
}

export class Jimaku {
  private searches = new Map<string, Search>();
  private pending = new Map<string, Promise<Buffer>>();
  private requests = 0;
  private failures = new Map<string, number>();
  private metadata = createSubtitleClient({ requestTimeoutMs: 4000 });
  private aliasPending = new Map<string, Promise<string[]>>();
  private closed = new AbortController();
  constructor(
    private db: Store,
    private catalog: Catalog,
    private transport: typeof fetch = fetch,
  ) {
    db.db.exec(
      'CREATE TABLE IF NOT EXISTS jimaku_cache(key TEXT PRIMARY KEY,content BLOB NOT NULL,expires INTEGER NOT NULL,touched INTEGER NOT NULL)',
    );
    this.prune();
  }
  private prune() {
    for (const [url, until] of this.failures) if (until <= Date.now()) this.failures.delete(url);
    this.db.run('DELETE FROM jimaku_cache WHERE expires<?', Date.now());
    let bytes = Number(this.db.get('SELECT COALESCE(SUM(length(content)),0) AS n FROM jimaku_cache')?.n || 0);
    for (const row of this.db.all('SELECT key,length(content) AS n FROM jimaku_cache ORDER BY touched')) {
      if (bytes <= 32 * 1024 * 1024) break;
      this.db.run('DELETE FROM jimaku_cache WHERE key=?', row.key);
      bytes -= row.n;
    }
    for (const [id, search] of this.searches) if (search.expires < Date.now()) this.searches.delete(id);
  }
  private async fetch(url: string, maxBytes: number, ttl: number): Promise<Buffer> {
    const cacheKey = hash(url),
      cached = this.db.get('SELECT content FROM jimaku_cache WHERE key=? AND expires>?', cacheKey, Date.now());
    if (cached) {
      this.db.run('UPDATE jimaku_cache SET touched=? WHERE key=?', Date.now(), cacheKey);
      return Buffer.from(cached.content);
    }
    if ((this.failures.get(url) || 0) > Date.now()) throw new ApiFailure(502, 'jimaku-unavailable');
    const existing = this.pending.get(url);
    if (existing) return existing;
    if (this.requests >= 4) throw new ApiFailure(429, 'jimaku-unavailable');
    const task = (async () => {
      this.requests++;
      try {
        const response = await this.transport(url, {
          redirect: 'error',
          headers: { 'User-Agent': 'MOA/0.1 (subtitle lookup)', Accept: 'text/html,text/plain,*/*' },
          signal: AbortSignal.any([this.closed.signal, AbortSignal.timeout(20000)]),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ApiFailure(502, 'jimaku-unavailable');
        }
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel();
            throw new ApiFailure(413, 'jimaku-file-too-large');
          }
          chunks.push(value);
        }
        const bytes = Buffer.concat(chunks);
        this.db.run(
          'INSERT OR REPLACE INTO jimaku_cache VALUES(?,?,?,?)',
          cacheKey,
          bytes,
          Date.now() + ttl,
          Date.now(),
        );
        this.prune();
        return bytes;
      } catch (error) {
        if (this.failures.size >= 200) this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(url, Date.now() + 60000);
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure(502, 'jimaku-unavailable');
      } finally {
        this.requests--;
      }
    })();
    this.pending.set(url, task);
    try {
      return await task;
    } finally {
      this.pending.delete(url);
    }
  }
  private async aliases(title: string, season: number): Promise<string[]> {
    const cacheKey = hash(`aliases:${title}:${season}`);
    const cached = this.db.get('SELECT content FROM jimaku_cache WHERE key=? AND expires>?', cacheKey, Date.now());
    if (cached) return JSON.parse(Buffer.from(cached.content).toString('utf8'));
    const pending = this.aliasPending.get(cacheKey);
    if (pending) return pending;
    if (this.aliasPending.size >= 4) return [];
    const task = this.metadata
      .animeAliases(title, { season, signal: this.closed.signal, timeoutMs: 6000 })
      .catch(() => [])
      .then((names) => {
        const safe = names.slice(0, 8).map((name) => name.slice(0, 500));
        this.db.run(
          'INSERT OR REPLACE INTO jimaku_cache VALUES(?,?,?,?)',
          cacheKey,
          Buffer.from(JSON.stringify(safe)),
          Date.now() + (safe.length ? 6 * 3600000 : 10 * 60000),
          Date.now(),
        );
        return safe;
      });
    this.aliasPending.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.aliasPending.delete(cacheKey);
    }
  }
  private episode(id: string, profile: string) {
    const row = this.db.get(
      'SELECT e.*,m.title,m.type,m.metadata FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?',
      id,
    );
    if (!row) throw new ApiFailure(404, 'episode-not-found');
    this.catalog.kids.assert(row.media_id, profile);
    return row;
  }
  async search(
    id: string,
    profile: string,
    override: { title?: string; season?: number; episode?: number } = {},
  ): Promise<JimakuSearch> {
    const row = this.episode(id, profile),
      identity = subtitleQuery(this.db, row, override);
    const query = { title: identity.title, season: identity.season, episode: identity.episode };
    const names = [
      query.title,
      ...identity.aliases,
      ...(override.title ? [] : [row.title]),
      ...knownAnimeIdentity(query.title, query.season).aliases,
    ];
    const linked = this.db.get(
      'SELECT l.kind,l.tmdb_id,t.card FROM tmdb_links l JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE l.media_id=?',
      row.media_id,
    );
    if (linked && !override.title) {
      const card = JSON.parse(linked.card);
      if (card.originalTitle) names.push(card.originalTitle);
    }
    if (names.every((name) => /[가-힣]/.test(name))) names.push(...(await this.aliases(query.title, query.season)));
    const bases = [...new Set(names.map((name) => key(baseName(name))).filter(Boolean))];
    const entries = jimakuEntries((await this.fetch(ORIGIN + '/', 6 * 1024 * 1024, 6 * 3600000)).toString('utf8'));
    if (!entries.length) throw new ApiFailure(502, 'jimaku-invalid-response');
    const ranked = entries
      .map((entry) => {
        let score = 0;
        for (const name of entry.names) {
          const normalized = { baseTitle: baseName(name), season: parseSeason(name) ?? 1 },
            base = key(normalized.baseTitle);
          if (bases.includes(base)) score = Math.max(score, normalized.season === query.season ? 100 : 45);
          else if (bases.some((b) => b.length >= 4 && (base.startsWith(b) || b.startsWith(base))))
            score = Math.max(score, normalized.season === query.season ? 55 : 25);
        }
        // Jimaku's TMDB IDs use tv:123 / movie:123. Series entries may cover all seasons.
        if (!override.title && linked && entry.tmdb === `${linked.kind}:${linked.tmdb_id}`) score = Math.max(score, 95);
        return { entry, score };
      })
      .filter((item) => item.score >= 45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    const candidates: JimakuCandidate[] = [],
      files = new Map<string, File>();
    for (const { entry, score } of ranked) {
      let found: File[];
      try {
        found = jimakuFiles(
          (await this.fetch(`${ORIGIN}/entry/${entry.id}`, 6 * 1024 * 1024, 30 * 60000)).toString('utf8'),
          entry.id,
        );
      } catch (error) {
        if (ranked.length === 1 || (!candidates.length && entry.id === ranked.at(-1)!.entry.id)) throw error;
        continue;
      }
      for (const file of found) {
        if (/[._](?:en|eng|english|ko|kor|korean|zh|chs|cht)\.(?:ass|ssa|srt|vtt|smi)$/i.test(file.filename)) continue;
        const episodeName = file.filename.replace(
          /[._](?:ja|jpn|jp|japanese|furigana)(?=\.(?:ass|ssa|srt|vtt|smi)$)/i,
          '',
        );
        const numbers = parseEpisodes(episodeName),
          season = parseSeason(file.filename);
        if (season && season !== query.season) continue;
        if (numbers.length && (numbers.length !== 1 || numbers[0] !== query.episode)) continue;
        const match =
          row.type === 'movie' && !numbers.length
            ? 'movie'
            : numbers.length === 1 && score >= 95
              ? 'episode'
              : 'unverified';
        const candidateId = hash(file.url).slice(0, 24);
        if (files.has(candidateId)) continue;
        files.set(candidateId, file);
        candidates.push({
          id: candidateId,
          title: entry.title,
          filename: file.filename,
          format: file.format,
          language: 'ja',
          sourceUrl: `${ORIGIN}/entry/${entry.id}`,
          ...(numbers.length ? { episode: numbers[0] } : {}),
          match,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        Number(a.match === 'unverified') - Number(b.match === 'unverified') ||
        Number(b.format === 'ass') - Number(a.format === 'ass') ||
        a.filename.localeCompare(b.filename),
    );
    const result: JimakuSearch = {
      searchId: randomUUID(),
      query,
      candidates: candidates.slice(0, 80),
      warning: candidates.length ? '같은 회차라도 영상 판본에 따라 자막 싱크가 다를 수 있습니다.' : ranked.length ? '이 회차의 단일 텍스트 자막을 찾지 못했습니다. ZIP 묶음은 지원하지 않습니다.' : '일치하는 작품을 찾지 못했습니다. 원제나 영문 제목으로 다시 검색해 보세요.',
    };
    this.prune();
    if (this.searches.size >= 200) this.searches.delete(this.searches.keys().next().value!);
    this.searches.set(result.searchId, {
      profile,
      episode: id,
      expires: Date.now() + 30 * 60000,
      result,
      files: new Map(result.candidates.map((c) => [c.id, files.get(c.id)!])),
    });
    return result;
  }
  async translate(id: string, profile: string, searchId: string, candidateId: string, translations: Translations, startAt = 0) {
    this.episode(id, profile);
    const search = this.searches.get(searchId);
    if (!search || search.expires < Date.now() || search.profile !== profile || search.episode !== id)
      throw new ApiFailure(409, 'jimaku-search-expired');
    const config = translations.config();
    if (!config.configured) throw new ApiFailure(400, 'translation-not-configured');
    if (!config.enabled) throw new ApiFailure(409, 'translation-disabled');
    const file = search.files.get(candidateId);
    if (!file) throw new ApiFailure(404, 'jimaku-file-not-found');
    const bytes = await this.fetch(file.url, 1024 * 1024, 24 * 3600000);
    let normalized;
    try {
      normalized = convertSubtitle(decodeJapanese(bytes), file.format);
    } catch {
      throw new ApiFailure(502, 'jimaku-invalid-response');
    }
    return translations.start(id, profile, {
      startAt,
      content: normalized.content,
      format: normalized.format,
      sourceLabel: file.filename,
      sourceLanguage: 'ja',
      sourceUrl: search.result.candidates.find((candidate) => candidate.id === candidateId)?.sourceUrl,
    });
  }
  async close() {
    this.closed.abort();
    await Promise.allSettled([...this.pending.values(), ...this.aliasPending.values()]);
  }
}
