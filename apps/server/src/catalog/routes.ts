import type { FastifyInstance } from 'fastify';
import type { Store } from '../db.js';
import { idParams, object, pageQuery, params, profile, query, string, typeQuery } from '../http.js';
import type { Tmdb } from '../metadata/tmdb.js';
import type { YouTubeTrailers } from '../metadata/youtube-trailers.js';
import type { Sources } from '../sources/service.js';
import { ApiFailure } from '../util.js';
import type { Franchises } from './franchise.js';
import type { Catalog } from './service.js';
import type { TitleGroups } from './title-groups.js';

export function registerCatalogRoutes(app: FastifyInstance, { db, catalog, groups, tmdb, sources, franchises, youtube }: {
  db: Store; catalog: Catalog; groups: TitleGroups; tmdb: Tmdb; sources: Sources; franchises: Franchises; youtube: YouTubeTrailers;
}) {
  app.get('/api/home', { schema: { querystring: object({ type: typeQuery, providers: { type: 'string', maxLength: 4096 }, continueScope: { type: 'string', enum: ['tab', 'all'], default: 'tab' }, watchlistScope: { type: 'string', enum: ['tab', 'all'], default: 'tab' }, titleGrouping: { type: 'string', enum: ['true', 'false'], default: 'true' } }) } }, async req => { const homeForProfile = () => catalog.home(profile(req), query(req).type, query(req).providers?.split(',').filter(Boolean), query(req).continueScope, query(req).watchlistScope, query(req).titleGrouping === 'false' ? undefined : (recent, candidates) => groups.continueWatching(recent, candidates, profile(req))); let home=homeForProfile();
    const unlinked = [...new Set(home.rows.flatMap(r => r.items.map(c => c.id)))].filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
    if (tmdb.enabled && unlinked.length) { await tmdb.ensure(unlinked, 1500); home = homeForProfile(); } return {...home,rows:home.rows.map(row=>row.kind === 'watchlist' && query(req).titleGrouping !== 'false' ? {...row,items:groups.resolve(row.items.map(c=>c.id),profile(req))} : row)}; });
  app.get('/api/media', { schema: { querystring: object({ type: typeQuery, genre: string, provider: string, sort: { type: 'string', enum: ['recent', 'title', 'year'], default: 'recent' }, page: pageQuery }) } }, async req => {
    const q = query(req); let cards = catalog.cards(profile(req), q.type);
    if (q.genre) cards = cards.filter(c => c.genres?.includes(q.genre));
    if (q.provider) cards = cards.filter(c => c.provider.id === q.provider);
    if (q.sort === 'title') cards.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    if (q.sort === 'year') cards.sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
    return catalog.page(cards, q.page);
  });
  app.post('/api/media/popular', {schema:{body:object({lists:{type:'array',maxItems:32,items:object({sourceId:{type:'string',minLength:1,maxLength:128},ids:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:512}}},['sourceId','ids'])}},['lists'])}}, async req=>groups.popular((req.body as {lists:{sourceId:string;ids:string[]}[]}).lists,profile(req)));
  app.post('/api/media/groups/resolve', { schema: { body: object({ids:{type:'array',maxItems:1000,items:string},query:{type:'string',maxLength:500}},['ids']) } }, async req => groups.resolve((req.body as {ids:string[]}).ids,profile(req),(req.body as {query?:string}).query));
  app.get('/api/media/groups/candidates', { schema: {querystring:object({q:{type:'string',maxLength:200,default:''}})} }, async req => groups.candidates(query(req).q,profile(req)));
  app.get('/api/media/:id/group', {schema:{params:idParams()}}, async req => groups.group(params(req).id,profile(req)));
  app.patch('/api/media/:id/group', {schema:{params:idParams(),body:object({action:{type:'string',enum:['merge','separate','reset']},otherId:string},['action'])}}, async req => {
    const b = req.body as {action:string;otherId?:string}; return groups.change(params(req).id,profile(req),b.action,b.otherId);
  });
  app.get('/api/episodes/:id/context', {schema:{params:idParams()}}, async req=>{const e=db.get('SELECT media_id,season,number FROM episodes WHERE id=?',params(req).id);if(!e)throw new ApiFailure(404,'episode-not-found');return {mediaId:e.media_id,season:e.season,number:e.number};});
  app.get('/api/media/:id/franchise', { schema: { params: idParams() } }, async req => franchises.get(params(req).id, profile(req)));
  app.get('/api/media/:id', { schema: { params: idParams() } }, async req => { catalog.kids.assert(params(req).id, profile(req)); await sources.detail(params(req).id); await tmdb.ensureDetail(params(req).id, 5000); return catalog.detail(params(req).id, profile(req)); });
  app.get('/api/media/:id/trailers', { schema: { params: idParams() } }, async (req, reply) => {
    // Read existing metadata only; do not re-run source extraction or title matching for a precheck.
    const detail = catalog.detail(params(req).id, profile(req));
    return reply.header('Cache-Control', 'private, no-store').send(await youtube.check([...(detail.trailers ?? []), detail.trailer]));
  });
  app.get('/api/genres', { schema: { querystring: object({ type: typeQuery }) } }, async req => [...new Set(catalog.cards(profile(req), query(req).type).flatMap(c => c.genres || []))].sort());
  app.get('/api/search', { schema: { querystring: object({ q: { type: 'string', maxLength: 200, default: '' } }) } }, async req => {
    const q = query(req).q, found = catalog.search(profile(req), q);
    if (!tmdb.enabled || q.trim().length < 2 || found.groups.some(group => group.items.length)) return found;
    return catalog.search(profile(req), q, await tmdb.search(q).catch(() => []));
  });
}
