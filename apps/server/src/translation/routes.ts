import { TRANSLATION_MAX_KEYS } from '@moa/shared';
import type { FastifyInstance } from 'fastify';
import { idParams, object, params, profile, query, string } from '../http.js';
import type { SubtitleLibrary } from '../subtitles/library.js';
import type { Jimaku } from './jimaku.js';
import type { Translations } from './service.js';

export function registerTranslationRoutes(app: FastifyInstance, { jimaku, translations, subtitleLibrary }: {
  jimaku: Jimaku; translations: Translations; subtitleLibrary: SubtitleLibrary;
}) {
  app.get('/api/episodes/:id/subtitles/jimaku', { schema: { params: idParams(), querystring: object({ title: { type: 'string', minLength: 1, maxLength: 300 }, season: { type: 'integer', minimum: 1, maximum: 99 }, episode: { type: 'number', minimum: 0, maximum: 10000 } }) } }, async req => jimaku.search(params(req).id, profile(req), query(req)));
  app.post('/api/episodes/:id/subtitles/jimaku/translate', { schema: { params: idParams(), body: object({ searchId: string, candidateId: string, startAt: {type: 'number', minimum: 0, maximum: 864000} }, ['searchId','candidateId']) } }, async req => { const body = req.body as { searchId: string; candidateId: string; startAt?: number }; return jimaku.translate(params(req).id, profile(req), body.searchId, body.candidateId, translations, body.startAt); });
  app.get('/api/translation/config', async () => translations.config());
  app.patch('/api/admin/translation/config', { schema: { body: object({ provider: { type: 'string', enum: ['gemini', 'openai'] }, baseUrl: { type: 'string', maxLength: 2048 }, apiKey: { type: 'string', minLength: 1, maxLength: 512 }, model: { type: 'string', maxLength: 200 }, enabled: { type: 'boolean' }, clearKey: { type: 'boolean' }, batchSize: { type: 'integer', minimum: 10, maximum: 300 }, requestIntervalMs: { type: 'integer', minimum: 0, maximum: 60000 }, retryCount: { type: 'integer', minimum: 0, maximum: 5 }, addKeys: { type: 'array', maxItems: TRANSLATION_MAX_KEYS, items: { type: 'string', minLength: 1, maxLength: 512 } }, removeKeyIds: { type: 'array', maxItems: TRANSLATION_MAX_KEYS, items: { type: 'string', pattern: '^[a-f0-9]{16}$' } } }) } }, async req => translations.configure(req.body as Parameters<Translations['configure']>[0]));
  app.get('/api/admin/translation/models', async () => translations.models());
  app.post('/api/admin/translation/keys/:id/test', { schema: { params: object({ id: { type: 'string', pattern: '^[a-f0-9]{16}$' } }, ['id']) } }, async req => translations.testKey(params(req).id));
  app.post('/api/episodes/:id/subtitles/translate', { bodyLimit: 2 * 1024 * 1024, schema: { params: idParams(), body: object({ content: { type: 'string', minLength: 1, maxLength: 1024 * 1024 }, format: { type: 'string', enum: ['ass','vtt','srt','smi'] }, sourceLabel: { type: 'string', maxLength: 200 }, sourceLanguage: { type: 'string', maxLength: 32 }, startAt: {type: 'number', minimum: 0, maximum: 864000} }, ['content','format','sourceLabel']) } }, async req => translations.start(params(req).id, profile(req), req.body as Parameters<Translations['start']>[2]));
  app.get('/api/episodes/:id/subtitles/translations', { schema: { params: idParams() } }, async req => subtitleLibrary.tracks(params(req).id, profile(req), 'translation'));
  app.get('/api/translations/:id', { schema: { params: idParams() } }, async req => translations.get(params(req).id, profile(req)));
  app.post('/api/translations/:id/priority', {schema: {params: idParams(), body: object({startAt: {type: 'number', minimum: 0, maximum: 864000}}, ['startAt'])}}, async (req, reply) => { translations.priority(params(req).id, profile(req), (req.body as {startAt: number}).startAt); return reply.code(204).send(); });
  app.delete('/api/translations/:id', { schema: { params: idParams() } }, async (req, reply) => { translations.cancel(params(req).id, profile(req)); return reply.code(204).send(); });
}
