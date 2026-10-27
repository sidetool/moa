import type { FastifyInstance } from 'fastify';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Catalog } from '../catalog/service.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { idParams, object, params, profile, query, string } from '../http.js';
import type { Sources } from '../sources/service.js';
import { ApiFailure, hash, safePath } from '../util.js';
import type { ImageCache } from './image-cache.js';
import { IMAGE_CACHE_TTL } from './image-cache.js';
import type { Tmdb } from './tmdb.js';
import type { YouTubeTrailers } from './youtube-trailers.js';

export function registerMetadataRoutes(app: FastifyInstance, { db, cfg, tmdb, youtube, catalog, imageCache, sources }: {
  db: Store; cfg: Config; tmdb: Tmdb; youtube: YouTubeTrailers; catalog: Catalog; imageCache: ImageCache; sources: Sources;
}) {
  app.get('/api/admin/tmdb/config', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(tmdb.status()));
  app.get('/api/admin/youtube/config', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(youtube.status()));
  app.patch('/api/admin/youtube/config', { schema: { body: object({
    apiKey: { type: 'string', minLength: 20, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' },
    regionCode: { type: 'string', pattern: '^[A-Z]{2}$' }, clear: { type: 'boolean' }
  }) } }, async (req, reply) => reply.header('Cache-Control', 'private, no-store').send(youtube.configure(req.body as Parameters<YouTubeTrailers['configure']>[0])));
  app.patch('/api/admin/tmdb/config', { schema: { body: object({
    token: { type: 'string', minLength: 16, maxLength: 4096, pattern: '^[A-Za-z0-9._-]+$' },
    apiKey: { type: 'string', pattern: '^[a-fA-F0-9]{32}$' }, clear: { type: 'boolean' }
  }) } }, async (req, reply) => {
    const status = tmdb.configure(req.body as Parameters<Tmdb['configure']>[0]);
    catalog.metadata = tmdb.enabled;
    return reply.header('Cache-Control', 'private, no-store').send(status);
  });
  app.get('/api/metadata/status', async () => ({ tmdb: tmdb.enabled }));
  app.get('/api/media/:id/metadata/search', { schema: { params: idParams(), querystring: object({ q: { ...string } }, ['q']) } }, async req => catalog.kids.candidates(await tmdb.search(query(req).q), profile(req)));
  app.patch('/api/media/:id/metadata', { schema: { params: idParams(), body: object({ action: { type: 'string', enum: ['link', 'off', 'auto'] }, kind: { type: 'string', enum: ['tv', 'movie'] }, tmdbId: { type: 'integer', minimum: 1 }, season: { type: 'integer', minimum: 1, maximum: 200 } }, ['action']) } }, async req => tmdb.change(params(req).id, req.body as any));
  app.get('/api/images/:id', { schema: { params: idParams(), querystring: object({ w: { type: 'integer', minimum: 32, maximum: 1920 } }) } }, async (req, reply) => {
    if (params(req).id.startsWith('source-')) {
      if (!db.get('SELECT 1 FROM source_images WHERE id=?', params(req).id)) throw new ApiFailure(404, 'image-not-found');
      const id = params(req).id, width = query(req).w || 960;
      const bytes = await imageCache.get(`${id}-${width}.webp`,IMAGE_CACHE_TTL,async()=> {
        const original = await imageCache.original(id,()=>sources.imageContent(id));
        return sharp(original,{limitInputPixels:40_000_000}).resize({width,withoutEnlargement:true}).webp({quality:82}).toBuffer();
      });
      if (!db.get('SELECT 1 FROM source_images WHERE id=?',id)) { await rm(path.join(cfg.dataDir,'images',`${id}-${width}.webp`),{force:true}); throw new ApiFailure(404,'image-not-found'); }
      return reply.header('Cache-Control','public, max-age=3600').type('image/webp').send(bytes);
    }
    const image = db.get('SELECT * FROM images WHERE id=?', params(req).id); if (!image) throw new ApiFailure(404, 'image-not-found');
    const source = image.local ? await safePath(cfg.mediaRoot, image.path) : image.path, info = await stat(source);
    const width = query(req).w || 960, etag = hash(`${image.id}:${info.mtimeMs}:${info.size}:${width}`);
    reply.header('ETag', `"${etag}"`).header('Cache-Control', 'public, max-age=3600');
    if (req.headers['if-none-match'] === `"${etag}"`) { await imageCache.touch(`${etag}.webp`); return reply.code(304).send(); }
    const bytes = await imageCache.get(`${etag}.webp`,Infinity,()=>sharp(source).resize({width,withoutEnlargement:true}).webp({quality:82}).toBuffer());
    return reply.type('image/webp').send(bytes);
  });
}
