import type { Profile } from '@moa/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Catalog } from '../catalog/service.js';
import { episodeProgress } from '../catalog/service.js';
import type { TitleGroups } from '../catalog/title-groups.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { idParams, object, pageQuery, params, profile, query, string } from '../http.js';
import type { RemotePlayback } from '../playback/remote.js';
import type { Playback } from '../playback/service.js';
import type { Sources } from '../sources/service.js';
import type { OnlineSubtitles } from '../subtitles/online.js';
import type { Translations } from '../translation/service.js';
import { ApiFailure, now } from '../util.js';
import type { ProfilePins } from './pin.js';
import { hashPin } from './pin.js';
import { completion } from './progress.js';
import type { Recommendations } from './recommendations.js';

const COLORS = ['red', 'blue', 'green', 'amber', 'violet', 'teal'];
const profileFields = { pin: { type: ['string', 'null'], pattern: '^[0-9]{4,8}$' }, avatar: { type: ['string', 'null'], pattern: '^[a-z]+-[0-9]{1,2}$', maxLength: 64 }, name: { ...string, pattern: '\\S' }, color: { type: 'string', enum: COLORS }, kids: { type: 'boolean' } };
const toProfile = (p: Record<string, any>): Profile => ({ id: p.id, name: p.name, color: p.color, kids: Boolean(p.kids), createdAt: p.created_at, avatar: p.avatar ?? null, hasPin: Boolean(p.pin_hash) });

export function registerProfileRoutes(app: FastifyInstance, { db, cfg, pins, online, translations, remotePlayback, playback, recommendations, catalog, groups, sources }: {
  db: Store; cfg: Config; pins: ProfilePins; online: OnlineSubtitles; translations: Translations; remotePlayback: RemotePlayback; playback: Playback; recommendations: Recommendations; catalog: Catalog; groups: TitleGroups; sources: Sources;
}) {
  app.get('/api/recommendations', async (req,reply) => reply.header('Cache-Control','private, no-store').send(recommendations.get(profile(req))));
  app.put('/api/recommendations/dismissals/:key', async req => { recommendations.dismiss(profile(req),params(req).key); return {ok:true}; });
  app.delete('/api/recommendations/dismissals/:key', async req => { recommendations.dismiss(profile(req),params(req).key,true); return {ok:true}; });
  app.delete('/api/recommendations/dismissals', async req => { recommendations.reset(profile(req)); return {ok:true}; });
  async function removeProfile(id: string) {
    pins.invalidate(id);
    // Delete the ownership row before awaiting process cleanup so concurrent asset requests fail closed.
    db.run('DELETE FROM profiles WHERE id=?', id);
    online.removeProfile(id);
    translations.removeProfile(id);
    for (const [sid, s] of remotePlayback.sessions) if (s.profile === id) remotePlayback.remove(sid);
    for (const [sid, s] of playback.sessions) if (s.profile === id) await playback.remove(sid);
  }
  app.delete('/api/admin/accounts/:id/data', { schema: { params: idParams() } }, async (req, reply) => {
    for (const row of db.all('SELECT id FROM profiles WHERE account_id=?', params(req).id)) await removeProfile(row.id);
    return reply.code(204).send();
  });
  app.get('/api/profiles', async req => db.all('SELECT * FROM profiles WHERE account_id=? ORDER BY created_at,id', req.moaAccount.id).map(toProfile));
  app.post('/api/profiles/lock', async (req, reply) => { pins.lock(req, reply); return reply.code(204).send(); });
  app.post('/api/profiles/:id/unlock', { schema: { params: idParams(), body: object({ pin: { type: 'string', pattern: '^[0-9]{4,8}$' } }, ['pin']) } }, async (req, reply) => {
    const id = params(req).id;
    if (!db.get('SELECT id FROM profiles WHERE id=? AND account_id=?', id, req.moaAccount.id)) throw new ApiFailure(404, 'profile-not-found');
    await pins.unlock(id, (req.body as { pin: string }).pin, req, reply);
    return reply.code(204).send();
  });
  app.post('/api/profiles', { schema: { body: object(profileFields, ['name']) } }, async (req, reply) => {
    const body = req.body as { name: string; color?: string; kids?: boolean; avatar?: string | null; pin?: string | null };
    const pinHash = body.pin ? await hashPin(body.pin) : null;
    const id = randomUUID();
    db.transaction(() => {
      const count = db.get('SELECT count(*) AS n FROM profiles WHERE account_id=?', req.moaAccount.id)!.n;
      if (count >= 5) throw new ApiFailure(409, 'profile-limit');
      db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id,avatar,pin_hash) VALUES(?,?,?,?,?,?,?,?)', id, body.name.trim(), body.color || COLORS[count % COLORS.length], body.kids ? 1 : 0, now(), req.moaAccount.id, body.avatar ?? null, pinHash);
      const navigation = db.defaultNavigation();
      if (navigation || cfg.shortsExtractor) db.run('INSERT INTO settings VALUES(?,?)', id, JSON.stringify({
        ...(navigation ? { navigation: db.availableNavigation(navigation) } : {}),
        ...(cfg.shortsExtractor ? { shortsPlayback: 'native' } : {}),
      }));
    });
    if (pinHash) pins.grant(id, req, reply);
    return reply.code(201).send(toProfile(db.get('SELECT * FROM profiles WHERE id=?', id)!));
  });
  app.patch('/api/profiles/:id', { schema: { params: idParams(), body: object(profileFields) } }, async (req, reply) => {
    const id = params(req).id, old = db.get('SELECT * FROM profiles WHERE id=? AND account_id=?', id, req.moaAccount.id); if (!old) throw new ApiFailure(404, 'profile-not-found');
    pins.assert(id, req);
    const body = req.body as Partial<Profile> & { pin?: string | null };
    const pinHash = body.pin === undefined ? old.pin_hash : body.pin === null ? null : await hashPin(body.pin);
    pins.assert(id, req);
    db.run('UPDATE profiles SET name=?,color=?,kids=?,avatar=?,pin_hash=? WHERE id=?', body.name?.trim() ?? old.name, body.color ?? old.color, body.kids !== undefined ? Number(body.kids) : old.kids, body.avatar === undefined ? old.avatar : body.avatar, pinHash, id);
    if (body.pin !== undefined) { pins.invalidate(id); pins.grant(id, req, reply); }
    return toProfile(db.get('SELECT * FROM profiles WHERE id=?', id)!);
  });
  app.delete('/api/profiles/:id', { schema: { params: idParams() } }, async (req, reply) => {
    if (!db.get('SELECT 1 FROM profiles WHERE id=? AND account_id=?', params(req).id, req.moaAccount.id)) throw new ApiFailure(404, 'profile-not-found');
    pins.assert(params(req).id, req);
    await removeProfile(params(req).id);
    return reply.code(204).send();
  });
  app.get('/api/watchlist', async req => groups.resolve(catalog.watchlist(profile(req)).map(c=>c.id),profile(req)));
  app.put('/api/watchlist/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    const id = params(req).mediaId; if (!db.get('SELECT id FROM media WHERE id=?', id)) throw new ApiFailure(404, 'media-not-found');
    db.run('INSERT OR IGNORE INTO watchlist VALUES(?,?,?)', profile(req), id, now()); return reply.code(204).send();
  });
  app.delete('/api/watchlist/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    db.run('DELETE FROM watchlist WHERE profile_id=? AND media_id=?', profile(req), params(req).mediaId); return reply.code(204).send();
  });
  app.get('/api/history', { schema: { querystring: object({ page: pageQuery }) } }, async req => catalog.history(profile(req), query(req).page));
  app.delete('/api/history/media/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    db.run('DELETE FROM progress WHERE profile_id=? AND episode_id IN (SELECT id FROM episodes WHERE media_id=?)', profile(req), params(req).mediaId);
    return reply.code(204).send();
  });
  app.delete('/api/history/:episodeId', { schema: { params: idParams('episodeId') } }, async (req, reply) => {
    db.run('DELETE FROM progress WHERE profile_id=? AND episode_id=?', profile(req), params(req).episodeId); return reply.code(204).send();
  });
  app.post('/api/progress', { schema: { body: object({ episodeId: string, position: { type: 'number', minimum: 0 }, duration: { type: 'number', exclusiveMinimum: 0 } }, ['episodeId', 'position', 'duration']) } }, async req => {
    const body = req.body as { episodeId: string; position: number; duration: number };
    if (!db.get('SELECT id FROM episodes WHERE id=?', body.episodeId)) throw new ApiFailure(404, 'episode-not-found');
    const remote = sources.remoteEpisode(body.episodeId);
    if (remote && sources.row(remote.source_id).live) throw new ApiFailure(400, 'live-progress-unavailable');
    const position = Math.min(body.position, body.duration);
    db.run('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)', profile(req), body.episodeId, position, body.duration, Number(completion(position, body.duration)), now());
    return episodeProgress(db.get('SELECT * FROM progress WHERE profile_id=? AND episode_id=?', profile(req), body.episodeId)!);
  });
}
