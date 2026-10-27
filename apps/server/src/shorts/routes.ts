import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../db.js';
import { object, params, profile, query } from '../http.js';
import type { ProfilePins } from '../profiles/pin.js';
import type { Sources } from '../sources/service.js';
import type { Translations } from '../translation/service.js';
import { ApiFailure } from '../util.js';
import type { NativeShorts } from './native.js';
import type { Shorts } from './service.js';

export function registerShortsRoutes(app: FastifyInstance, { db, shorts, nativeShorts, sources, pins, translations }: {
  db: Store; shorts: Shorts; nativeShorts: NativeShorts; sources: Sources; pins: ProfilePins; translations: Translations;
}) {
  app.get('/api/shorts', {schema:{querystring:object({cursor:{type:'string',pattern:'^[0-9]{1,3}$'},replay:{type:'string',enum:['1']}})}}, async (req, reply) =>
    reply.header('Cache-Control','private, no-store').send(await shorts.feed(profile(req),query(req).cursor,query(req).replay==='1')));
  const shortsKey = object({key:{type:'string',pattern:'^(tv|movie):[1-9][0-9]{0,14}$'}},['key']);
  app.get('/api/shorts/:key/trailers', {schema:{params:shortsKey}}, async (req,reply) =>
    reply.header('Cache-Control','private, no-store').send(await shorts.trailers(profile(req),(req.params as {key:string}).key)));
  app.get('/api/shorts/native',async (_req,reply)=>reply.header('Cache-Control','private, no-store').send({available:nativeShorts.available}));
  app.post('/api/shorts/:key/native',{schema:{params:shortsKey,body:object({})}},async(req,reply)=>{
    const owner=profile(req),abort=new AbortController();
    if(!req.moaAccount.permissions.includes('video.watch'))throw new ApiFailure(403,'permission-denied');
    if(db.settings(owner).shortsPlayback!=='native')throw new ApiFailure(403,'shorts-native-disabled');
    if(!nativeShorts.available)throw new ApiFailure(503,'shorts-native-unconfigured');
    const disconnect=()=>{if(!reply.raw.writableEnded)abort.abort();};
    req.raw.once('aborted',disconnect);reply.raw.once('close',disconnect);
    let lease:string|undefined;
    try{
      const {trailers}=await shorts.trailers(owner,params(req).key);
      abort.signal.throwIfAborted();
      const prepared=await nativeShorts.prepare(owner,trailers,abort.signal,sources.proxy());lease=prepared.sessionId;
      const row=db.get('SELECT kids,account_id FROM profiles WHERE id=?',owner),settings=db.settings(owner);
      if(!row||row.kids||row.account_id!==req.moaAccount.id||!settings.shortsEnabled||settings.shortsPlayback!=='native')throw new ApiFailure(403,'shorts-native-disabled');
      pins.assert(owner,req);abort.signal.throwIfAborted();
      return reply.header('Cache-Control','private, no-store').send(prepared);
    }catch(error){if(lease)nativeShorts.release(lease);throw error;}
    finally{req.raw.off('aborted',disconnect);reply.raw.off('close',disconnect);}
  });
  const assertNativeShort=(req:FastifyRequest,id:string,scoped=true)=>{
    const owner=nativeShorts.owner(id);
    if(!owner)throw new ApiFailure(410,'shorts-native-expired');
    if(scoped&&owner!==profile(req))throw new ApiFailure(403,'session-profile-mismatch');
    if(!req.moaAccount.permissions.includes('video.watch'))throw new ApiFailure(403,'permission-denied');
    const settings=db.settings(owner),row=db.get('SELECT kids FROM profiles WHERE id=?',owner);
    if(!row||row.kids||!settings.shortsEnabled||settings.shortsPlayback!=='native'){nativeShorts.release(id);throw new ApiFailure(403,'shorts-native-disabled');}
    return owner;
  };
  app.post('/api/shorts/native/:sessionId/warm',{schema:{body:object({})}},async(req,reply)=>{
    const id=params(req).sessionId,owner=assertNativeShort(req,id),abort=new AbortController();
    const disconnect=()=>{if(!reply.raw.writableEnded)abort.abort();};reply.raw.once('close',disconnect);
    try{return reply.header('Cache-Control','private, no-store').send(await nativeShorts.warm(id,owner,abort.signal,db.settings(owner).shortsQuality??'auto'));}
    finally{reply.raw.off('close',disconnect);}
  });
  app.get('/api/playback/:sessionId/shorts-captions/:trackId',async(req,reply)=>{
    const id=params(req).sessionId,owner=assertNativeShort(req,id,false);
    const result=await nativeShorts.caption(id,params(req).trackId,owner,AbortSignal.timeout(16_000));
    return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type('text/vtt; charset=utf-8').send(result.content);
  });
  app.post('/api/shorts/native/:sessionId/subtitles/:trackId/translate',{schema:{body:object({})}},async(req,reply)=>{
    const id=params(req).sessionId,owner=assertNativeShort(req,id);
    if(!req.moaAccount.permissions.includes('subtitles.translate'))throw new ApiFailure(403,'permission-denied');
    const abort=new AbortController(),disconnect=()=>{if(!reply.raw.writableEnded)abort.abort();};reply.raw.once('close',disconnect);
    try{
      const source=await nativeShorts.caption(id,params(req).trackId,owner,abort.signal);
      assertNativeShort(req,id);abort.signal.throwIfAborted();
      const job=translations.startPreview(id,owner,source.title,source);
      nativeShorts.onRelease(id,owner,job.id,()=>translations.cancel(job.id,owner));
      return reply.header('Cache-Control','private, no-store').send(job);
    }finally{reply.raw.off('close',disconnect);}
  });
  app.delete('/api/shorts/native/:sessionId',async req=>{nativeShorts.release(params(req).sessionId,profile(req));return {ok:true};});
  app.get('/api/playback/:sessionId/shorts/:assetId',async(req,reply)=>{
    const id=params(req).sessionId,owner=nativeShorts.owner(id);
    if(!owner)throw new ApiFailure(410,'shorts-native-expired');
    const settings=db.settings(owner),row=db.get('SELECT kids FROM profiles WHERE id=?',owner);
    if(!row||row.kids||!settings.shortsEnabled||settings.shortsPlayback!=='native'){nativeShorts.release(id);throw new ApiFailure(403,'shorts-native-disabled');}
    return nativeShorts.stream(req,reply,id,params(req).assetId);
  });
  app.post('/api/shorts/:key/seen', {schema:{params:shortsKey}}, async req => { shorts.seen(profile(req),(req.params as {key:string}).key); return {ok:true}; });
  app.post('/api/shorts/:key/skip', {schema:{params:shortsKey}}, async req => { shorts.skip(profile(req),(req.params as {key:string}).key); return {ok:true}; });
  app.post('/api/shorts/:key/failed', {schema:{params:shortsKey,body:object({reason:{type:'string',enum:['unavailable','temporary']}},['reason'])}}, async req => { shorts.failed(profile(req),params(req).key,(req.body as {reason:'unavailable'|'temporary'}).reason); return {ok:true}; });
  app.delete('/api/shorts/seen', async req => { shorts.reset(profile(req)); return {ok:true}; });
}
