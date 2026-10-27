import type { FastifyInstance } from 'fastify';
import { idParams, object, params, profile, query, string } from '../http.js';
import type { Playback } from '../playback/service.js';
import type { SubtitleLibrary } from './library.js';
import type { OnlineSubtitles } from './online.js';

export function registerSubtitleRoutes(app: FastifyInstance, { subtitleLibrary, online, playback }: {
  subtitleLibrary: SubtitleLibrary; online: OnlineSubtitles; playback: Playback;
}) {
  app.post('/api/subtitles/import', { bodyLimit: 14 * 1024 * 1024, schema: { body: object({ episodeId: string, filename: { type: 'string', minLength: 1, maxLength: 255 }, data: { type: 'string', minLength: 4, maxLength: 14 * 1024 * 1024 } }, ['episodeId', 'filename', 'data']) } }, async req => {
    const body = req.body as { episodeId: string; filename: string; data: string };
    return subtitleLibrary.import(body.episodeId, profile(req), body.filename, body.data);
  });
  app.get('/api/episodes/:id/subtitles/uploads', { schema: { params: idParams() } }, async req => subtitleLibrary.tracks(params(req).id, profile(req), 'upload'));
  app.get('/api/episodes/:id/subtitles/preference', { schema: { params: idParams() } }, async (req, reply) => reply.header('Cache-Control', 'private, no-store').send(subtitleLibrary.preference(params(req).id, profile(req))));
  app.put('/api/episodes/:id/subtitles/preference', { schema: { params: idParams(), body: object({ migrate: { type: 'boolean' }, choice: { anyOf: [{ type: 'null' }, object({
    id: string, episodeId: string, label: { type: 'string', maxLength: 1000 }, lang: { type: 'string', maxLength: 32 },
    format: { type: 'string', enum: ['ass', 'vtt'] }, source: { type: 'string', enum: ['embedded', 'local', 'extension', 'upload', 'online', 'translation'] },
  }, ['id', 'episodeId', 'label', 'format'])] } }, ['choice']) } }, async (req, reply) => reply.header('Cache-Control', 'private, no-store').send(subtitleLibrary.remember(params(req).id, profile(req), (req.body as { choice: import('@moa/shared').SubtitlePreference | null }).choice, (req.body as { migrate?: boolean }).migrate)));
  app.get('/api/admin/subtitles', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(subtitleLibrary.list()));
  app.get('/api/admin/subtitle-memory', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(subtitleLibrary.memory()));
  app.patch('/api/admin/subtitle-memory', { schema: { body: object({ retentionDays: { type: 'integer', minimum: 1, maximum: 3650 } }, ['retentionDays']) } }, async req => subtitleLibrary.memory((req.body as { retentionDays: number }).retentionDays));
  app.delete('/api/admin/subtitle-memory', async () => subtitleLibrary.memory(undefined, true));
  const savedSubtitleParams = object({ kind: { type: 'string', enum: ['upload', 'translation', 'online'] }, id: string }, ['kind', 'id']);
  app.get('/api/admin/subtitles/:kind/:id/content', { schema: { params: savedSubtitleParams } }, async (req, reply) => {
    const row = subtitleLibrary.content(params(req).kind as 'upload' | 'translation' | 'online', params(req).id);
    return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name.replace(/\.[^.]+$/, '') + '.' + row.format)}`).send(row.content);
  });
  app.delete('/api/admin/subtitles/:kind/:id', { schema: { params: savedSubtitleParams } }, async (req, reply) => {
    subtitleLibrary.remove(params(req).kind as 'upload' | 'translation' | 'online', params(req).id);
    return reply.code(204).send();
  });
  app.get('/api/episodes/:id/subtitles/online', { schema: { params: idParams(), querystring: object({ title: {type:'string',minLength:1,maxLength:500,pattern:'\\S'}, season: {type:'integer',minimum:1,maximum:99}, episode: {type:'number',minimum:0,maximum:10000}, episodeOffset: {type:'integer',minimum:0,maximum:10000}, refresh: {type:'boolean'} }) } }, async (req, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    req.raw.once('aborted', abort); reply.raw.once('close', close);
    const { refresh, ...override } = req.query as Partial<import('@moa/shared').OnlineSubtitleQuery> & { refresh?: boolean };
    try { return await online.search(params(req).id, profile(req), controller.signal, override, refresh); }
    finally { req.raw.off('aborted', abort); reply.raw.off('close', close); }
  });
  app.post('/api/episodes/:id/subtitles/online', { schema: { params: idParams(), body: object({ searchId: string, candidateId: string }, ['searchId', 'candidateId']) } }, async req => {
    const body = req.body as { searchId: string; candidateId: string };
    return online.apply(params(req).id, profile(req), body.searchId, body.candidateId);
  });
  app.get('/api/episodes/:id/subtitles/:subtitleId/content', async (req, reply) => {
    const row = online.content(params(req).id, params(req).subtitleId, query(req).token, req.moaProfile);
    return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(row.content);
  });
  app.delete('/api/episodes/:id/subtitles/:subtitleId', { schema: { params: object({ id: string, subtitleId: string }, ['id', 'subtitleId']) } }, async (req, reply) => {
    online.remove(params(req).id, params(req).subtitleId);
    for (const s of playback.sessions.values()) if (s.response.episodeId === params(req).id) {
      s.subtitleSources.delete(params(req).subtitleId);
      s.response.subtitles = s.response.subtitles.filter(t => t.id !== params(req).subtitleId);
    }
    return reply.code(204).send();
  });
}
