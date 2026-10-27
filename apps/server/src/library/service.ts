import { mkdir, readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { LibraryFolder, ScanStatus, MediaType } from '@moa/shared';
import type { Config } from '../config.js';
import { Store } from '../db.js';
import { hash, safePath, now, normalize } from '../util.js';
import { parseName, VIDEO_EXTENSIONS, matchSubtitles } from './filename.js';
import { probe } from '../playback/probe.js';
import { THUMBNAIL_VERSION, createThumbnail } from '../playback/thumbnail.js';

export class Library {
  status: ScanStatus = { running: false, done: 0, total: 0 };
  pending?: Promise<void>;
  constructor(public db: Store, public config: Config, private log: (message: string) => void, private onScanned: () => void = () => {}) {}
  folders(): LibraryFolder[] {
    return this.db.all('SELECT f.*,COUNT(DISTINCT m.id) AS count FROM folders f LEFT JOIN media m ON m.folder_id=f.id GROUP BY f.id ORDER BY f.path')
      .map(f => ({ id: f.id, path: f.path, type: f.type, label: f.label, itemCount: f.count, ...(f.last_scan_at ? { lastScanAt: f.last_scan_at } : {}) }));
  }
  start(): ScanStatus {
    if (this.status.running) return this.status;
    this.status = { running: true, phase: 'listing', done: 0, total: 0, startedAt: now() };
    this.pending = this.scan().catch(e => { this.status.error = String(e); this.log(String(e)); }).finally(() => { this.status.running = false; delete this.status.phase; this.onScanned(); });
    return this.status;
  }
  async list(root: string): Promise<string[]> {
    const result: string[] = [];
    const visited = new Set<string>();
    const walk = async (directory: string) => {
      const safe = await safePath(this.config.mediaRoot, directory, true);
      if (visited.has(safe)) return;
      visited.add(safe);
      for (const entry of await readdir(safe, { withFileTypes: true })) {
        const full = path.join(safe, entry.name);
        // Do not follow directory symlinks (cycles, duplicate files, and escape attempts).
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(await safePath(this.config.mediaRoot, full));
      }
    };
    await walk(root);
    return result.sort();
  }
  async image(source: string, local = true): Promise<string> {
    const id = hash(source);
    this.db.run('INSERT OR REPLACE INTO images VALUES(?,?,?)', id, source, local ? 1 : 0);
    return `/api/images/${id}`;
  }
  async metadata(dir: string, file: string): Promise<Record<string, any>> {
    const names = await readdir(dir);
    const meta: Record<string, any> = {};
    const find = (pattern: RegExp) => names.find(n => pattern.test(n));
    const poster = find(/^(poster|folder)\.(jpg|jpeg|png|webp)$/i);
    const fanart = find(/^fanart\.(jpg|jpeg|png|webp)$/i);
    if (poster) meta.poster = await this.image(await safePath(this.config.mediaRoot, path.join(dir, poster)));
    if (fanart) meta.backdrop = await this.image(await safePath(this.config.mediaRoot, path.join(dir, fanart)));
    const ownNfo = `${path.basename(file, path.extname(file))}.nfo`;
    const nfo = names.find(n => n === ownNfo) || find(/^(tvshow|movie)\.nfo$/i) || find(/\.nfo$/i);
    if (nfo) {
      try {
        const nfoPath = await safePath(this.config.mediaRoot, path.join(dir, nfo));
        if ((await stat(nfoPath)).size < 2 * 1024 * 1024) {
          const raw = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(await readFile(nfoPath, 'utf8'));
          const info = raw.movie || raw.tvshow || raw.episodedetails || {};
          if (typeof info.title === 'string' && !raw.episodedetails) meta.title = info.title;
          if (typeof info.plot === 'string') meta.overview = info.plot;
          if (Number(info.year) > 1800) meta.year = Number(info.year);
          if (Number(info.rating) > 0) meta.rating = Number(info.rating);
          meta.genres = [info.genre || []].flat().filter((g: unknown) => typeof g === 'string');
          meta.cast = [info.actor || []].flat().map(a => a?.name).filter((v: unknown) => typeof v === 'string');
        }
      } catch (e) { this.log(`NFO: ${e}`); }
    }
    return meta;
  }
  async scan() {
    await mkdir(path.join(this.config.dataDir, 'thumbnails'), { recursive: true });
    const folders = this.folders();
    const batches: { folder: LibraryFolder; files: string[] }[] = [];
    for (const folder of folders) {
      // A failed folder listing must never remove a library's existing records.
      try { batches.push({ folder, files: await this.list(folder.path) }); }
      catch (e) { this.status.error = String(e); this.log(`Listing ${folder.path}: ${e}`); }
    }
    this.status.total = batches.reduce((sum, b) => sum + b.files.length, 0);
    for (const { folder, files } of batches) {
      const perDir = new Map<string, number>();
      for (const file of files) perDir.set(path.dirname(file), (perDir.get(path.dirname(file)) || 0) + 1);
      for (const file of files) {
        try { await this.scanFile(folder, file, perDir.get(path.dirname(file))!); }
        catch (e) { this.status.error = String(e); this.log(`Scanning ${file}: ${e}`); }
        this.status.done++;
      }
      if (!this.db.get('SELECT id FROM folders WHERE id=?', folder.id)) continue;
      const existing = this.db.all('SELECT e.id,f.path FROM episodes e JOIN media m ON m.id=e.media_id JOIN files f ON f.episode_id=e.id WHERE m.folder_id=?', folder.id);
      const present = new Set(files);
      this.db.transaction(() => {
        for (const item of existing) if (!present.has(item.path)) this.db.run('DELETE FROM episodes WHERE id=?', item.id);
        this.db.run('DELETE FROM media WHERE folder_id=? AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.media_id=media.id)', folder.id);
        this.db.run('UPDATE folders SET last_scan_at=? WHERE id=?', now(), folder.id);
      });
    }
  }
  private async scanFile(folder: LibraryFolder, file: string, siblingCount: number) {
    const dir = path.dirname(file);
    const parsed = parseName(file, dir);
    // Episode-less singleton directories are movies even inside an anime collection.
    const type: MediaType = parsed.episode === undefined && siblingCount === 1 ? 'movie' : folder.type;
    const names = await readdir(dir);
    const subtitles = matchSubtitles(file, names.map(n => path.join(dir, n)));
    const auxiliary = names.filter(n => /\.(nfo|ass|ssa|srt|vtt|smi|sami)$/i.test(n) || /^(poster|folder|fanart)\./i.test(n));
    const signatures = await Promise.all(auxiliary.map(async n => {
      const p = await safePath(this.config.mediaRoot, path.join(dir, n)); const s = await stat(p); return `${n}:${s.size}:${s.mtimeMs}`;
    }));
    const fingerprint = hash(`${THUMBNAIL_VERSION}:${signatures.sort().join('|')}`);
    const info = await stat(await safePath(this.config.mediaRoot, file));
    const previous = this.db.get('SELECT * FROM files WHERE path=?', file);
    if (previous?.size === info.size && previous.mtime === info.mtimeMs && previous.fingerprint === fingerprint) return;
    const unchanged = previous?.size === info.size && previous.mtime === info.mtimeMs;
    this.status.phase = 'probing';
    const technical = unchanged ? JSON.parse(previous.probe) : await probe(this.config, file);
    const meta = await this.metadata(dir, file);
    const title = meta.title || parsed.title;
    const mediaId = hash(`${folder.id}:${type}:${normalize(title)}:${parsed.year || ''}`);
    const season = type === 'movie' ? 1 : parsed.season;
    const number = parsed.episode ?? (type === 'movie' ? 1 : Math.max(1, names.filter(n => VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase())).sort().indexOf(path.basename(file)) + 1));
    const episodeId = hash(`${mediaId}:${season}:${number}`);
    const thumbFile = path.join(this.config.dataDir, 'thumbnails', `${hash(`${THUMBNAIL_VERSION}:${file}:${info.mtimeMs}:${info.size}`)}.webp`);
    let thumb: string | undefined;
    this.status.phase = 'thumbnails';
    try {
      try { await stat(thumbFile); } catch { await createThumbnail(this.config, file, technical, thumbFile); }
      if ((await stat(thumbFile)).size) thumb = await this.image(thumbFile, false);
    } catch (e) { this.log(`Thumbnail: ${e}`); }
    if (parsed.year && !meta.year) meta.year = parsed.year;
    if (!meta.backdrop && thumb) meta.backdrop = thumb;
    delete meta.title;
    this.db.transaction(() => {
      if (!this.db.get('SELECT id FROM folders WHERE id=?', folder.id)) return;
      if (previous && previous.episode_id !== episodeId) this.db.run('DELETE FROM episodes WHERE id=?', previous.episode_id);
      this.db.run('INSERT INTO media VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,metadata=excluded.metadata', mediaId, folder.id, title, type, JSON.stringify(meta), this.db.get('SELECT added_at FROM media WHERE id=?', mediaId)?.added_at || now());
      this.db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET duration=excluded.duration,thumb=excluded.thumb,title=excluded.title', episodeId, mediaId, season, number, type === 'movie' ? title : `${number}화`, technical.duration, thumb || null);
      this.db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?) ON CONFLICT(episode_id) DO UPDATE SET path=excluded.path,size=excluded.size,mtime=excluded.mtime,fingerprint=excluded.fingerprint,probe=excluded.probe,subtitles=excluded.subtitles', episodeId, file, info.size, info.mtimeMs, fingerprint, JSON.stringify(technical), JSON.stringify(subtitles));
      if (!unchanged) this.db.run('DELETE FROM episode_skip_markers WHERE episode_id=?', episodeId);
    });
  }
}
