import type { MediaType } from '@moa/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { idParams, object, params, query, string, typeQuery } from '../http.js';
import type { Playback } from '../playback/service.js';
import { ApiFailure, contained, safePath } from '../util.js';
import type { Library } from './service.js';

export function registerLibraryRoutes(app: FastifyInstance, { db, cfg, library, playback }: {
  db: Store; cfg: Config; library: Library; playback: Playback;
}) {
  app.get('/api/library/folders', async () => library.folders());
  app.post('/api/library/folders', { schema: { body: object({ path: { type: 'string', minLength: 1, maxLength: 4096 }, type: typeQuery, label: string }, ['path', 'type']) } }, async (req, reply) => {
    const body = req.body as { path: string; type: MediaType; label?: string }, safe = await safePath(cfg.mediaRoot, body.path, true);
    for (const folder of library.folders()) if (contained(folder.path, safe) || contained(safe, folder.path)) throw new ApiFailure(409, 'folder-overlap');
    const id = randomUUID(); db.run('INSERT INTO folders(id,path,type,label) VALUES(?,?,?,?)', id, safe, body.type, body.label || path.basename(safe));
    return reply.code(201).send(library.folders().find(f => f.id === id));
  });
  app.delete('/api/library/folders/:id', { schema: { params: idParams() } }, async (req, reply) => {
    const files = new Set(db.all('SELECT f.path FROM files f JOIN episodes e ON e.id=f.episode_id JOIN media m ON m.id=e.media_id WHERE m.folder_id=?', params(req).id).map(f => f.path));
    for (const [id, s] of playback.sessions) if (files.has(s.file)) await playback.remove(id);
    db.run('DELETE FROM folders WHERE id=?', params(req).id); return reply.code(204).send();
  });
  app.get('/api/library/browse', { schema: { querystring: object({ path: { type: 'string', maxLength: 4096 } }) } }, async req => {
    const safe = await safePath(cfg.mediaRoot, query(req).path || cfg.mediaRoot, true), dirs: string[] = [];
    for (const dir of await readdir(safe, { withFileTypes: true })) {
      if (dir.isDirectory() || dir.isSymbolicLink()) {
        try { dirs.push(await safePath(cfg.mediaRoot, path.join(safe, dir.name), true)); } catch {}
      }
    }
    return { path: safe, dirs: [...new Set(dirs)].sort() };
  });
  app.post('/api/library/scan', async () => library.start());
  app.get('/api/library/status', async () => library.status);
}
