import type { ClientCapabilities } from '@moa/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Catalog } from '../catalog/service.js';
import type { Store } from '../db.js';
import type { Downloads } from '../downloads/service.js';
import { idParams, object, params, profile, query, sendFile, string } from '../http.js';
import type { Sources } from '../sources/service.js';
import type { SubtitleLibrary } from '../subtitles/library.js';
import type { OnlineSubtitles } from '../subtitles/online.js';
import type { Translations } from '../translation/service.js';
import { ApiFailure, safePath } from '../util.js';
import type { Casting } from './casting.js';
import type { Enrichment } from './enrichment.js';
import type { GeneralMarkers } from './general-markers.js';
import type { RemotePlayback } from './remote.js';
import type { Playback } from './service.js';

export function registerPlaybackRoutes(app: FastifyInstance, { db, catalog, sources, playback, remotePlayback, downloads, subtitleLibrary, online, translations, casting, enrichment, generalMarkers }: {
  db: Store; catalog: Catalog; sources: Sources; playback: Playback; remotePlayback: RemotePlayback; downloads: Downloads; subtitleLibrary: SubtitleLibrary; online: OnlineSubtitles; translations: Translations; casting: Casting; enrichment: Enrichment; generalMarkers: GeneralMarkers;
}) {
  app.get('/api/episodes/:id/markers', { schema: { params: idParams(), querystring: object({ duration: {type:'number',minimum:60,maximum:21600},sessionId:string }, ['duration']) } }, async (req,reply) => {
    reply.header('Cache-Control','private, no-store');
    const episode=db.get('SELECT e.media_id,m.type FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?',params(req).id);
    if(!episode)throw new ApiFailure(404,'episode-not-found');
    catalog.kids.assert(episode.media_id,profile(req));
    const {duration,sessionId}=req.query as {duration:number;sessionId?:string};
    if(sessionId){
      const s=remotePlayback.sessions.has(sessionId)?remotePlayback.get(sessionId,profile(req)):playback.get(sessionId,profile(req));
      if(s.response.episodeId!==params(req).id||s.response.live)throw new ApiFailure(400,'marker-session-mismatch');
    }
    if(episode.type==='anime')return enrichment.remoteMarkers(params(req).id,duration);
    if(!sessionId||db.settings(profile(req)).generalSkipEnabled===false)return {markers:null,status:'unsupported'};
    const markers=await generalMarkers.get(params(req).id,sessionId,duration);
    return {markers,status:markers?'matched':'unavailable'};
  });
  app.post('/api/playback', { schema: { body: object({ episodeId: string, location: {type:'string',enum:['auto','saved','source']}, capabilities: object({ h264: { type: 'boolean' }, hevc: { type: 'boolean' }, av1: { type: 'boolean' }, vp9: { type: 'boolean' }, audioCodecs: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 32 }, maxHeight: { type: 'integer', minimum: 2 } }, ['h264', 'hevc', 'av1']), audioTrackId: string, streamId: string, startPosition: { type: 'number', minimum: 0 } }, ['episodeId', 'capabilities']) } }, async req => {
    const body = req.body as { episodeId: string; capabilities: ClientCapabilities; location?:'auto'|'saved'|'source'; audioTrackId?: string; streamId?: string; startPosition?: number };
    const episode = db.get('SELECT media_id FROM episodes WHERE id=?', body.episodeId);
    if (episode) catalog.kids.assert(episode.media_id, profile(req));
    const openSource=()=>sources.remoteEpisode(body.episodeId)
      ? remotePlayback.create(profile(req), body.episodeId, body.startPosition, body.streamId)
      : playback.create(profile(req), body.episodeId, body.capabilities, body.audioTrackId, body.startPosition);
    const result=body.location==='source'?await openSource():await downloads.withSaved(body.episodeId,async asset=>{
      if(asset)return playback.create(profile(req),body.episodeId,body.capabilities,body.audioTrackId,body.startPosition,asset);
      if(body.location==='saved')throw new ApiFailure(404,'download-file-missing');
      return openSource();
    });
    const saved = subtitleLibrary.tracks(body.episodeId, profile(req));
    result.subtitles.push(...saved.filter(track => !result.subtitles.some(existing => existing.id === track.id)));
    return result;
  });
  app.post('/api/playback/:sessionId/heartbeat', { schema: { params: idParams('sessionId') } }, async (req, reply) => {
    remotePlayback.heartbeat(params(req).sessionId, profile(req));
    return reply.code(204).send();
  });
  app.delete('/api/playback/:sessionId', { schema: { params: idParams('sessionId') } }, async (req, reply) => {
    if (remotePlayback.sessions.has(params(req).sessionId)) { remotePlayback.get(params(req).sessionId, profile(req)); await remotePlayback.remove(params(req).sessionId); return reply.code(204).send(); }
    if (online.removeAsset(params(req).sessionId, profile(req))) return reply.code(204).send();
    playback.get(params(req).sessionId, profile(req)); await playback.remove(params(req).sessionId); return reply.code(204).send();
  });
  casting.asset(app, '/api/playback/:sessionId/remote/:asset', async (req, reply) => remotePlayback.proxy(req, reply, params(req).sessionId, params(req).asset));
  const session = (req: FastifyRequest) => playback.get(params(req).sessionId, req.moaProfile);
  app.get('/api/playback/:sessionId/preview', { schema: { params: idParams('sessionId'), querystring: object({ at: { type: 'number', minimum: 0, maximum: 864000 } }, ['at']) } }, async (req, reply) => {
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=1800').send(await playback.preview(session(req), query(req).at));
  });
  casting.asset(app, '/api/playback/:sessionId/index.m3u8', async (req, reply) => {
    const s = session(req); if (s.response.mode === 'direct') throw new ApiFailure(404, 'not-hls');
    return reply.type('application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(playback.playlist(s));
  });
  casting.asset(app, '/api/playback/:sessionId/original', async (req, reply) => {
    const s = session(req); if (s.response.mode !== 'direct') throw new ApiFailure(404, 'not-direct');
    const safe = await safePath(s.root, s.file); return sendFile(reply, safe, s.response.mime, req.headers.range);
  });
  casting.asset(app, '/api/playback/:sessionId/:asset', async (req, reply) => {
    const s = session(req), asset = params(req).asset, match = /^(seg-(\d+)\.m4s|init\.mp4)$/.exec(asset);
    if (!match || s.response.mode === 'direct') throw new ApiFailure(404, 'not-found');
    const file = asset === 'init.mp4' ? await playback.initialization(s) : await playback.segment(s, Number(match[2]));
    return sendFile(reply.header('Cache-Control', 'private, max-age=1800'), file, 'video/mp4');
  });
  app.get('/api/playback/:sessionId/subtitles/:track', async (req, reply) => {
    const uploaded = subtitleLibrary.asset(params(req).sessionId, params(req).track, req.moaProfile);
    if (uploaded) return reply.type(uploaded.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(uploaded.content);
    const translated = translations.asset(params(req).sessionId, params(req).track, req.moaProfile);
    if (translated) return reply.type(translated.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(translated.content);
    if (remotePlayback.sessions.has(params(req).sessionId)) {
      const row = remotePlayback.savedSubtitle(params(req).sessionId,params(req).track,req.moaProfile);
      return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control','private, no-store').send(row.content);
    }
    const applied = online.asset(params(req).sessionId, params(req).track, req.moaProfile);
    if (applied) return reply.type(applied.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(applied.content);
    const s = session(req), track = params(req).track, source = s.subtitleSources.get(track.replace(/\.(ass|vtt)$/, ''));
    if (!source || !track.endsWith(`.${source.format}`)) throw new ApiFailure(404, 'subtitle-not-found');
    if (source.onlineId) {
      const row = online.content(s.response.episodeId, source.onlineId, undefined, s.profile);
      return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(row.content);
    }
    const safe = await safePath(s.root, source.file);
    // Preserve external ASS exactly, including styles, embedded drawings, and timing.
    if (source.stream === undefined && source.format === 'ass') return sendFile(reply, safe, 'text/x-ssa; charset=utf-8');
    if (source.stream === undefined && /\.vtt$/i.test(safe)) return sendFile(reply, safe, 'text/vtt; charset=utf-8');
    const cached = await playback.subtitleCache.get(safe, source.stream, source.format);
    return sendFile(reply, cached, source.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8');
  });
  app.get('/api/playback/:sessionId/fonts/:font', async (req, reply) => {
    const s = session(req), index = s.fontSources.get(params(req).font); if (index === undefined) throw new ApiFailure(404, 'font-not-found');
    const file = await playback.subtitleCache.font(await safePath(s.root, s.file), index);
    return sendFile(reply, file, 'application/octet-stream');
  });
}
