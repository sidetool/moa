import { mkdir, readdir, stat, readFile, writeFile, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const IMAGE_CACHE_LIMIT = 256 * 1024 * 1024;
export const IMAGE_CACHE_TTL = 30 * 86400_000;
const imageKey = /^[\w-]+\.(?:webp|jpg|png)$/;
/** Disk cache shared by local and remote variants. Responses own buffers, so eviction cannot break a send. */
export class ImageCache {
  private flights = new Map<string, Promise<Buffer>>();
  private originals = new Map<string, Promise<Buffer>>();
  private accessed = new Map<string, number>();
  private maintenance?: Promise<void>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private dir: string, private limit = IMAGE_CACHE_LIMIT, private clock = Date.now,
    private onError: () => void = () => {}) {
    this.timer = setInterval(() => this.schedule(), 60_000); this.timer.unref();
    this.schedule();
  }
  /** URL + headers identity comes from source_images.id; widths share the source download while in flight. */
  original(key: string, load: () => Promise<Buffer>) {
    const existing = this.originals.get(key); if (existing) return existing;
    const work = Promise.resolve().then(load).finally(() => this.originals.delete(key));
    this.originals.set(key, work); return work;
  }
  get(key: string, ttl: number, generate: () => Promise<Buffer>): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('image-cache-closed'));
    if (!imageKey.test(key)) return Promise.reject(new Error('invalid-image-key'));
    const pending = this.flights.get(key); if (pending) return pending;
    const work = this.read(key, ttl, generate).finally(() => { this.flights.delete(key); });
    this.flights.set(key, work); return work;
  }
  private async read(key: string, ttl: number, generate: () => Promise<Buffer>) {
    const file = path.join(this.dir,key);
    let bytes: Buffer | undefined;
    try {
      const info = await stat(file);
      if (info.size && this.clock()-info.mtimeMs <= ttl) bytes = await readFile(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(); }
    if (!bytes) {
      bytes = await generate();
      // A response may exceed the cache budget; serve it without retaining it.
      if (bytes.length <= this.limit) {
        await mkdir(this.dir,{recursive:true});
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await writeFile(temporary,bytes); await rename(temporary,file); }
        finally { await rm(temporary,{force:true}); }
      } else { await rm(file,{force:true}); }
      this.schedule();
    }
    await this.touch(key);
    return bytes;
  }
  async touch(key: string) {
    if (!imageKey.test(key)) throw new Error('invalid-image-key');
    const now = this.clock(), file = path.join(this.dir,key); this.accessed.set(key,now);
    // Persist access independently of mtime, which is the freshness timestamp.
    try { const info = await stat(file); await utimes(file,new Date(now),info.mtime); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(); }
  }
  private schedule() {
    if (this.closed || this.scheduled || this.maintenance) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.prune().catch(() => this.onError());
    }, 250);
    this.scheduled.unref();
  }
  /** Filesystem work is asynchronous and never awaited by the response path. */
  prune(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const work = this.sweep().finally(() => { this.maintenance = undefined; });
    this.maintenance = work; return work;
  }
  private async sweep() {
    let names: string[];
    try { names = await readdir(this.dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    const rows: { key: string; size: number; access: number }[] = [];
    for (const key of names) {
      if (!imageKey.test(key)) continue;
      try { const info = await stat(path.join(this.dir,key)); if (info.isFile()) rows.push({key,size:info.size,access:this.accessed.get(key) ?? info.atimeMs}); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    let bytes = rows.reduce((n,r)=>n+r.size,0);
    if (bytes > this.limit) for (const row of rows.sort((a,b)=>a.access-b.access || a.key.localeCompare(b.key))) {
      if (bytes <= this.limit * .9) break;
      // A request may have touched the entry since the directory scan.
      if (this.flights.has(row.key) || (this.accessed.get(row.key) ?? row.access) > row.access) continue;
      await rm(path.join(this.dir,row.key),{force:true}); bytes -= row.size; this.accessed.delete(row.key);
    }
    const present = new Set(rows.map(r=>r.key));
    for (const key of this.accessed.keys()) if (!present.has(key) && !this.flights.has(key)) this.accessed.delete(key);
  }
  async close() {
    this.closed = true; clearInterval(this.timer); if (this.scheduled) clearTimeout(this.scheduled);
    await Promise.allSettled([...this.flights.values(),...this.originals.values()]);
    if (this.maintenance) await this.maintenance;
  }
}
