import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlaybackSession } from '@moa/shared';
import type { Store } from '../db.js';
import { ApiFailure } from '../util.js';
import { rewritePlaylist } from './remote.js';
import { subtitleDocument } from '../translation/subtitle.js';

type Caption = { content: string; format: 'ass' | 'vtt'; offset?: number; label: string; lang?: string };
type Grant = { profile: string; sessionId: string; expiresAt: number; subtitle?: string };
const parameters = (req: FastifyRequest) => req.params as { sessionId: string; token: string };
const timestamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(value => String(value).padStart(2, '0')).join(':') + `.${String(ms % 1000).padStart(3, '0')}`;
};

export function castSubtitle(caption: Caption) {
  return 'WEBVTT\n\n' + subtitleDocument(caption.content, caption.format).lines
    .filter(line => line.end + (caption.offset ?? 0) > 0)
    .map(line => `${timestamp(line.start + (caption.offset ?? 0))} --> ${timestamp(line.end + (caption.offset ?? 0))}\n${line.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`).join('\n');
}

export class Casting {
  private grants = new Map<string, Grant>();
  constructor(private db: Store, private session: (id: string, profile?: string) => { profile: string; response: PlaybackSession }, private now = Date.now) {}
  authorize(req: FastifyRequest) {
    const { token, sessionId } = parameters(req), grant = this.grants.get(token);
    if (!grant || grant.sessionId !== sessionId || grant.expiresAt <= this.now() || !this.db.get('SELECT id FROM profiles WHERE id=?', grant.profile)) {
      if (grant?.expiresAt && grant.expiresAt <= this.now()) this.grants.delete(token);
      throw new ApiFailure(404, 'cast-expired');
    }
    this.session(sessionId, grant.profile);
    req.moaProfile = grant.profile;
    return grant;
  }
  register(app: FastifyInstance) {
    const timer = setInterval(() => {
      for (const [token, grant] of this.grants) {
        if (grant.expiresAt <= this.now()) { this.grants.delete(token); continue; }
        try { this.session(grant.sessionId, grant.profile); } catch { this.grants.delete(token); }
      }
    }, 60000);
    timer.unref();
    app.post('/api/playback/:sessionId/cast', { bodyLimit: 2 * 1024 * 1024, schema: { body: {
      type: 'object', additionalProperties: false, properties: { subtitle: {
        type: 'object', additionalProperties: false, required: ['content', 'format', 'label'], properties: {
          content: { type: 'string', maxLength: 1024 * 1024 }, format: { enum: ['ass', 'vtt'] },
          offset: { type: 'number', minimum: -600, maximum: 600 }, label: { type: 'string', maxLength: 200 }, lang: { type: 'string', maxLength: 32 }
        }
      } }
    } } }, async req => {
      const { sessionId } = parameters(req), profile = req.moaProfile!, { response } = this.session(sessionId, profile);
      const caption = (req.body as { subtitle?: Caption }).subtitle;
      const subtitle = caption ? castSubtitle(caption) : undefined;
      for (const [token, grant] of this.grants) if (grant.expiresAt <= this.now() || grant.profile === profile && grant.sessionId === sessionId) this.grants.delete(token);
      if (this.grants.size >= 256) throw new ApiFailure(429, 'cast-limit');
      const duration = Number.isFinite(response.duration) && response.duration > 0 ? response.duration : 5 * 3600;
      const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + Math.min(6 * 3600000, Math.max(3600000, (duration + 3600) * 1000));
      this.grants.set(token, { profile, sessionId, expiresAt, subtitle });
      const prefix = `/api/cast/${token}/${sessionId}`;
      if (!response.url.startsWith(`/api/playback/${sessionId}/`)) { this.grants.delete(token); throw new ApiFailure(422, 'cast-unavailable'); }
      return { token, expiresAt, url: response.url.replace(`/api/playback/${sessionId}`, prefix), mime: response.mime,
        hlsSegmentFormat: response.mode !== 'direct' && !response.url.includes('/remote/') ? 'fmp4' : undefined,
        subtitle: caption ? { url: `${prefix}/captions.vtt`, label: caption.label, lang: caption.lang } : undefined };
    });
    app.delete('/api/playback/:sessionId/cast/:token', async (req, reply) => {
      const { token, sessionId } = parameters(req), grant = this.grants.get(token);
      if (grant && (grant.profile !== req.moaProfile || grant.sessionId !== sessionId)) throw new ApiFailure(403, 'session-forbidden');
      this.grants.delete(token);
      return reply.code(204).send();
    });
    app.get('/api/cast/:token/:sessionId/captions.vtt', async (req, reply) => {
      const grant = this.authorize(req);
      if (!grant.subtitle) throw new ApiFailure(404, 'subtitle-not-found');
      return reply.type('text/vtt; charset=utf-8').send(grant.subtitle);
    });
    app.options('/api/cast/:token/:sessionId/*', async (_req, reply) => reply.code(204).send());
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.routeOptions.url?.startsWith('/api/cast/')) return payload;
      reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        .header('Access-Control-Allow-Private-Network', 'true')
        .header('Access-Control-Allow-Headers', 'Range, Content-Type').header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        .header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
      if (!/mpegurl/i.test(String(reply.getHeader('Content-Type'))) || typeof payload !== 'string') return payload;
      const { token, sessionId } = parameters(req), prefix = `/api/cast/${token}/${sessionId}`;
      const original = req.url.split('?')[0].replace(prefix, `/api/playback/${sessionId}`);
      reply.removeHeader('Content-Length');
      return rewritePlaylist(payload, `http://moa.local${original}`, url => {
        const target = new URL(url);
        if (target.origin !== 'http://moa.local' || !target.pathname.startsWith(`/api/playback/${sessionId}/`)) throw new ApiFailure(502, 'cast-invalid-asset');
        return target.pathname.replace(`/api/playback/${sessionId}`, prefix);
      });
    });
    app.addHook('onClose', async () => { clearInterval(timer); this.grants.clear(); });
  }
  asset(app: FastifyInstance, route: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown) {
    app.get(route, handler);
    app.get(route.replace('/api/playback/:sessionId/', '/api/cast/:token/:sessionId/'), handler);
  }
}
