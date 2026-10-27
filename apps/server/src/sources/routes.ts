import type { FastifyInstance } from 'fastify';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog } from '../catalog/service.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { idParams, object, pageQuery, params, profile, query, string, typeQuery } from '../http.js';
import type { Tmdb } from '../metadata/tmdb.js';
import type { RemotePlayback } from '../playback/remote.js';
import type { Playback } from '../playback/service.js';
import type { OnlineSubtitles } from '../subtitles/online.js';
import { browseSelection } from './schema.js';
import type { Sources } from './service.js';

export function registerSourceRoutes(app: FastifyInstance, { db, cfg, sources, online, remotePlayback, playback, tmdb, catalog }: {
  db: Store; cfg: Config; sources: Sources; online: OnlineSubtitles; remotePlayback: RemotePlayback; playback: Playback; tmdb: Tmdb; catalog: Catalog;
}) {
  /** Give TMDB a moment to link new titles so first visits already show its artwork. */
  const withMetadata = async <T extends { items: { id: string }[] }>(page: T, profileId: string): Promise<T> => {
    const unlinked = page.items.map(c => c.id).filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
    if (!tmdb.enabled || !unlinked.length) return page;
    await tmdb.ensure(unlinked, 1500);
    return { ...page, items: page.items.map(c => { const row = db.get('SELECT * FROM media WHERE id=?', c.id); return row ? { ...catalog.card(row, profileId), ...('sourceCount' in c ? { sourceCount: c.sourceCount } : {}) } : c; }) };
  };
  app.get('/api/admin/apk/status', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(await sources.apk.status()));
  app.get('/api/admin/cache-stats', async (_req,reply) => reply.header('Cache-Control','private, no-store').send(sources.stats.snapshot()));
  app.get('/api/sources', async () => sources.list());
  const removeSources = (ids: string[]) => sources.remove(ids, async (episodeIds, imageIds) => {
    online.removeEpisodes(episodeIds);
    for (const [sid, s] of remotePlayback.sessions) if (episodeIds.has(s.response.episodeId)) remotePlayback.remove(sid);
    await Promise.all([...playback.sessions].filter(([, s]) => episodeIds.has(s.response.episodeId)).map(([sid]) => playback.remove(sid)));
    if (imageIds.size) {
      const dir = path.join(cfg.dataDir, 'images');
      const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      await Promise.all(files.filter(file => imageIds.has(file.replace(/-\d+\.webp$/, ''))).map(file => rm(path.join(dir, file), { force: true })));
    }
  });
  app.get('/api/sources/:id/removal-impact', { schema: { params: idParams() } }, async req => sources.removalImpact([params(req).id]));
  app.delete('/api/sources/:id', { schema: { params: idParams() } }, async req => removeSources([params(req).id]));
  app.post('/api/sources/remove', { schema: { body: object({ ids: { type: 'array', minItems: 1, maxItems: 1000, items: string } }, ['ids']) } }, async req => removeSources((req.body as { ids: string[] }).ids));
  app.get('/api/source-repositories',async()=>sources.repositories());
  app.delete('/api/source-repositories',{schema:{body:object({url:{type:'string',maxLength:4096}},['url'])}},async req=>sources.removeRepository((req.body as {url:string}).url));
  app.post('/api/sources/refresh', { schema: { body: object({ url: { type: 'string', maxLength: 4096 }, kind: { type:'string',enum:['mangayomi-js','aniyomi-apk'] } }, ['url']) } }, async req => sources.refresh((req.body as { url: string }).url,(req.body as {kind?:'mangayomi-js'|'aniyomi-apk'}).kind));
  app.post('/api/sources/:id/install', { schema: { params: idParams() } }, async req => sources.install(params(req).id));
  app.post('/api/sources/:id/rollback', {schema:{params:idParams()}},async req=>sources.rollback(params(req).id));
  app.post('/api/sources/:id/check', {schema:{params:idParams()}},async req=>sources.diagnose(params(req).id,profile(req)));
  app.patch('/api/sources/:id', { schema: { params: idParams(), body: object({ enabled: { type: 'boolean' }, type: typeQuery, live: { type: 'boolean' } }) } }, async req => sources.configure(params(req).id, req.body as any));
  app.get('/api/sources/:id/preferences', { schema: { params: idParams() } }, async req => sources.preferences(params(req).id));
  app.patch('/api/sources/:id/preferences', { schema: { params: idParams(), body: { type: 'object', maxProperties: 128 } } }, async req => sources.preferences(params(req).id, req.body as Record<string,unknown>));
  app.get('/api/sources/:id/filters', { schema: { params: idParams() } }, async req => sources.capabilities(params(req).id));
  app.get('/api/admin/sources/:id/preload', { schema: { params: idParams() } }, async req => sources.preloadStatus(params(req).id));
  app.post('/api/admin/sources/:id/preload', { schema: { params: idParams() } }, async req => sources.preload(params(req).id));
  app.delete('/api/admin/sources/:id/preload', { schema: { params: idParams() } }, async req => sources.cancelPreload(params(req).id));
  app.post('/api/sources/:id/browse', { schema: { params: idParams(), body: object({ mode: {type:'string',enum:['popular','latest','search'],default:'popular'}, page:pageQuery, q:{type:'string',maxLength:200,default:''}, selection:browseSelection }) } }, async req => {
    const b = req.body as any; return withMetadata(await sources.browse(params(req).id, profile(req), b.mode, b.page, b.q, b.selection), profile(req));
  });
  app.get('/api/sources/:id/browse', { schema: { params: idParams(), querystring: object({ mode: { type: 'string', enum: ['popular','latest','search'], default: 'popular' }, page: pageQuery, q: { type: 'string', maxLength: 200, default: '' } }) } }, async req => {
    const q = query(req); return withMetadata(await sources.browse(params(req).id, profile(req), q.mode, q.page, q.q), profile(req));
  });
}
