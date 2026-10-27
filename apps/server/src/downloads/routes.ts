import type { FastifyInstance } from 'fastify';
import { idParams, object, params, profile, query, string } from '../http.js';
import type { Downloads } from './service.js';

export function registerDownloadRoutes(app: FastifyInstance, { downloads }: {
  downloads: Downloads;
}) {
  app.get('/api/admin/downloads',{schema:{querystring:object({cursor:{type:'string',maxLength:2048},mediaId:{type:'string',minLength:1,maxLength:512}})}},async (req,reply)=>reply.header('Cache-Control','private, no-store').send(await downloads.status(query(req))));
  app.put('/api/admin/downloads/config',{schema:{body:{...object({enabled:{type:'boolean'},quality:{type:'string',enum:['best','1080p','720p','480p']},quotaBytes:{type:'integer',minimum:1,maximum:1099511627776000}}),minProperties:1}}},async req=>{await downloads.configureSettings(req.body as {enabled?:boolean;quality?:import('@moa/shared').DownloadQuality;quotaBytes?:number});return downloads.status();});
  app.get('/api/admin/downloads/choices',{schema:{querystring:object({episodeId:string},['episodeId'])}},async(req,reply)=>reply.header('Cache-Control','private, no-store').send(await downloads.choices(query(req).episodeId,profile(req))));
  app.get('/api/admin/downloads/batch',{schema:{querystring:object({mediaId:{type:'string',minLength:1,maxLength:512},season:{type:'integer',minimum:0,maximum:10000}},['mediaId'])}},async(req,reply)=>{const q=req.query as {mediaId:string;season?:number};return reply.header('Cache-Control','private, no-store').send(downloads.previewBatch(q.mediaId,profile(req),q.season));});
  app.post('/api/admin/downloads/batch',{schema:{body:object({mediaId:{type:'string',minLength:1,maxLength:512},season:{type:'integer',minimum:0,maximum:10000}},['mediaId'])}},async req=>{const b=req.body as {mediaId:string;season?:number};return downloads.createBatch(b.mediaId,profile(req),b.season);});
  app.post('/api/admin/downloads',{schema:{body:{...object({episodeId:string,selectionToken:string,choiceId:string},['episodeId']),dependencies:{selectionToken:['choiceId'],choiceId:['selectionToken']}}}},async req=>{const b=req.body as {episodeId:string;selectionToken?:string;choiceId?:string};return b.selectionToken!==undefined?downloads.create(b.episodeId,profile(req),b.selectionToken,b.choiceId!):downloads.createPreferred(b.episodeId,profile(req));});
  app.post('/api/admin/downloads/:id/cancel',{schema:{params:idParams()}},async req=>downloads.cancel(params(req).id));
  app.post('/api/admin/downloads/:id/retry',{schema:{params:idParams()}},async req=>downloads.retry(params(req).id,profile(req)));
  app.delete('/api/admin/downloads/:id',{schema:{params:idParams()}},async(req,reply)=>{await downloads.remove(params(req).id);return reply.code(204).send();});
  app.get('/api/episodes/:id/download',{schema:{params:idParams()}},async(req,reply)=>reply.header('Cache-Control','private, no-store').send(downloads.episode(params(req).id,profile(req))));
}
