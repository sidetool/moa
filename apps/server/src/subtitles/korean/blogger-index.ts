import { abortable, deadline } from './async.js';
import { PublicHttpClient, validatePublicUrl } from './http.js';

interface Post { title: string; url: string }
interface Entry { posts: Post[]; expires: number; retryAt: number }
/** Small, shared discovery index. Contents and subtitle files are fetched only after matching. */
export class BloggerIndex {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Promise<Post[]>>();
  constructor(private readonly http: PublicHttpClient) {}
  async posts(origin: string, signal: AbortSignal): Promise<Post[]> {
    const host = validatePublicUrl(origin);
    if (!host.hostname.endsWith('.blogspot.com')) return [];
    origin = host.origin;
    const cached = this.cache.get(origin);
    if (cached && (cached.expires > Date.now() || cached.retryAt > Date.now())) return cached.posts;
    let pending = this.pending.get(origin);
    if (!pending) {
      pending = this.refresh(origin).catch(error => {
        if (cached) { cached.retryAt = Date.now() + 60_000; return cached.posts; }
        throw error;
      }).finally(() => this.pending.delete(origin));
      this.pending.set(origin, pending);
    }
    // One caller leaving must not cancel the index another viewer is waiting for.
    return abortable(pending, signal);
  }
  private async refresh(origin: string): Promise<Post[]> {
    const scope = deadline({ timeoutMs: 10_000 });
    try {
      const page = async (start: number) => {
        const response = await this.http.get(`${origin}/feeds/posts/default?alt=json&max-results=150&start-index=${start}`, {signal: scope.signal, maxBytes: 3 * 1024 * 1024});
        return JSON.parse(response.body.toString('utf8')).feed;
      };
      const first = await page(1);
      const total = Number(first?.openSearch$totalResults?.$t);
      if (!Number.isInteger(total) || total < 0 || total > 1200 || !Array.isArray(first.entry ?? [])) throw new Error('Unsupported Blogger index size');
      const feeds = [first];
      for (let start = 151; start <= total; start += 300) {
        feeds.push(...await Promise.all([start, start + 150].filter(n => n <= total).map(page)));
      }
      const posts: Post[] = [];
      for (const feed of feeds) for (const entry of feed.entry ?? []) {
        const title = entry.title?.$t, url = entry.link?.find((link: {rel?: string}) => link.rel === 'alternate')?.href;
        if (typeof title !== 'string' || title.length > 500 || typeof url !== 'string' || url.length > 2048) continue;
        try { if (validatePublicUrl(url).origin === origin) posts.push({ title, url }); } catch { /* Invalid link. */ }
      }
      if (total && !posts.length) throw new Error('Empty Blogger index');
      if (this.cache.size >= 16 && !this.cache.has(origin)) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(origin, {posts, expires: Date.now() + 86_400_000, retryAt: 0});
      return posts;
    } finally { scope.dispose(); }
  }
}
