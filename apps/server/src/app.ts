import fastifyStatic from '@fastify/static';
import type { Account } from '@moa/shared';
import { ACCOUNT_PERMISSIONS } from '@moa/shared';
import Fastify from 'fastify';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Franchises } from './catalog/franchise.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { Catalog } from './catalog/service.js';
import { TitleGroups } from './catalog/title-groups.js';
import { config as makeConfig, type Config } from './config.js';
import { Store } from './db.js';
import { registerDownloadRoutes } from './downloads/routes.js';
import { Downloads } from './downloads/service.js';
import { params } from './http.js';
import { registerLibraryRoutes } from './library/routes.js';
import { Library } from './library/service.js';
import { AniListClient } from './metadata/anilist-client.js';
import { ImageCache } from './metadata/image-cache.js';
import { registerMetadataRoutes } from './metadata/routes.js';
import { Tmdb } from './metadata/tmdb.js';
import { YouTubeTrailers } from './metadata/youtube-trailers.js';
import { RemoteAccess, connectorRpc } from './network/remote-access.js';
import { registerNetworkRoutes } from './network/routes.js';
import { Casting } from './playback/casting.js';
import { Enrichment, type EnrichmentOptions } from './playback/enrichment.js';
import { GeneralMarkers } from './playback/general-markers.js';
import { RemotePlayback } from './playback/remote.js';
import { registerPlaybackRoutes } from './playback/routes.js';
import { Playback } from './playback/service.js';
import { PluginBoxOffice, type BoxOfficeOptions } from './plugins/boxoffice.js';
import { PluginDiscovery } from './plugins/discovery.js';
import { PluginNews } from './plugins/news.js';
import { PluginPeople } from './plugins/people.js';
import { PluginReviews, type ReviewOptions } from './plugins/reviews.js';
import { PluginSchedule, type ScheduleOptions } from './plugins/schedule.js';
import { registerWebsitePlugins } from './plugins/service.js';
import { AniListRecommendations } from './profiles/anilist-recommendations.js';
import { ProfilePins } from './profiles/pin.js';
import { Recommendations } from './profiles/recommendations.js';
import { registerProfileRoutes } from './profiles/routes.js';
import { registerSettingsRoutes } from './profiles/settings.js';
import { NativeShorts, ytDlpExtractor } from './shorts/native.js';
import { registerShortsRoutes } from './shorts/routes.js';
import { Shorts } from './shorts/service.js';
import { registerSourceRoutes } from './sources/routes.js';
import { Sources } from './sources/service.js';
import { SubtitleLibrary } from './subtitles/library.js';
import { OnlineSubtitles, type OnlineClient } from './subtitles/online.js';
import { registerSubtitleRoutes } from './subtitles/routes.js';
import { UpdateMaintenance } from './system/update-maintenance.js';
import { registerUpdates } from './system/updates.js';
import { TranslationClient } from './translation/client.js';
import { Jimaku } from './translation/jimaku.js';
import { registerTranslationRoutes } from './translation/routes.js';
import { Translations } from './translation/service.js';
import { ApiFailure } from './util.js';

export async function buildApp(overrides: Partial<Config> = {}, logger = true, services: EnrichmentOptions & { reviews?: ReviewOptions; boxoffice?:BoxOfficeOptions; schedule?:ScheduleOptions; downloadTransport?: typeof import('./sources/extensions/index.js').publicStream; generalMarkerFetch?:typeof fetch; store?: Store; subtitleClient?: OnlineClient; translationFetch?: typeof fetch; jimakuFetch?: typeof fetch; youtube?: { apiKey?: string; fetch?: typeof fetch }; tmdb?: { token?: string; key?: string; fetch?: typeof fetch } } = {}) {
  const cfg = makeConfig(overrides);
  const app = Fastify({ logger: logger ? { serializers: { req: req => {
    let url: string;
    try { url = decodeURIComponent(req.url).replace(/(\/cast\/)[^/?]+/g, '$1[redacted]'); } catch { url = '[invalid-url]'; }
    return { method: req.method, url, hostname: req.hostname, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
  } } } : false, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allowUnionTypes: true } } });
  const db = services.store ?? new Store(cfg.dataDir), catalog = new Catalog(db);
  const pins = new ProfilePins(db);
  const sources = new Sources(db, catalog);
  await sources.startNetwork();
  const connectorSecret = process.env.MOA_CONNECTOR_SECRET_FILE || '/run/moa-connector/token';
  const remoteAccess = new RemoteAccess(cfg.dataDir, process.env.MOA_CONNECTOR_URL ? connectorRpc(process.env.MOA_CONNECTOR_URL, connectorSecret) : null, async () => {
    if (!cfg.requireAccount) return false;
    try {
      const token = (await readFile(connectorSecret, 'utf8')).trim();
      const [auth, gate] = await Promise.all([
        fetch('http://moa-auth:8789/internal/remote-access-safety', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }),
        fetch('http://moa-gateway:8080/api/me', { redirect: 'manual', signal: AbortSignal.timeout(3000) }),
      ]);
      return auth.ok && (await auth.json() as { adminExists: boolean }).adminExists && gate.status === 401;
    } catch { return false; }
  }, process.env.MOA_REMOTE_EXTERNALLY_MANAGED === '1');

  const imageCache = new ImageCache(path.join(cfg.dataDir,'images'),undefined,Date.now,()=>app.log.warn({event:'image-cache-io-error'}));
  const cacheStatsTimer = setInterval(()=>app.log.info({event:'cache-stats',...sources.stats.snapshot()}),5*60_000); cacheStatsTimer.unref();
  const tmdb = new Tmdb(db, value => app.log.info(value), services.tmdb);
  const youtube = new YouTubeTrailers(db, services.youtube);
  const nativeShorts = new NativeShorts(cfg.shortsExtractor ? ytDlpExtractor(cfg.shortsExtractor) : undefined);
  catalog.metadata = tmdb.enabled;
  const anilist = new AniListClient(services.reviews?.fetch);
  const recommendations = new Recommendations(db, tmdb, Date.now, new AniListRecommendations(q=>tmdb.search(q),undefined,Date.now,anilist));
  const groups = new TitleGroups(catalog);
  const franchises = new Franchises(catalog, groups, sources, tmdb);
  // Session tokens live only in memory. Remove their obsolete segments after a restart.
  await rm(path.join(cfg.dataDir, 'sessions'), { recursive: true, force: true });
  const online = new OnlineSubtitles(db, value => app.log.info(value), services.subtitleClient, groups);
  const jimaku = new Jimaku(db, catalog, services.jimakuFetch);
  const translations = new Translations(db, catalog, cfg.dataDir, new TranslationClient(services.translationFetch));
  const subtitleLibrary = new SubtitleLibrary(db, catalog, translations, online, groups);
  const subtitleMemoryTimer = setInterval(() => subtitleLibrary.memory(), 60 * 60_000); subtitleMemoryTimer.unref();
  const remotePlayback = new RemotePlayback(db, catalog, sources, undefined, online);
  const generalMarkers = new GeneralMarkers(db,services.generalMarkerFetch);
  const enrichment = new Enrichment(db, cfg, online, value => app.log.info(value), services);
  const library = new Library(db, cfg, message => app.log.warn(message), () => enrichment.schedule());
  const playback = new Playback(db, catalog, cfg, value => app.log.info(value), online, enrichment);
  const downloads = new Downloads(db,cfg,sources,playback,services.downloadTransport);
  await downloads.initialize();
  const casting = new Casting(db, (id, profile) => remotePlayback.sessions.has(id) ? remotePlayback.get(id, profile) : playback.get(id, profile));
  const updateMaintenance = new UpdateMaintenance(process.env.MOA_UPDATER_DIR, () =>
    nativeShorts.busy || downloads.busy || playback.sessions.size > 0 || remotePlayback.sessions.size > 0 || library.status.running || translations.updaterBusy ||
    Boolean(db.get("SELECT 1 FROM skip_analysis_jobs WHERE status='running' LIMIT 1")));
  updateMaintenance.register(app);
  app.addHook('onReady',async()=>{await updateMaintenance.tick();downloads.start(()=>!updateMaintenance.paused);});
  app.decorateRequest('moaProfile', undefined);
  app.decorateRequest('moaAccount');
  app.setErrorHandler((err, _request, reply) => {
    const error = err as Error & { validation?: unknown; statusCode?: number };
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.error });
    if (error.validation) return reply.code(400).send({ error: 'invalid-request', message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.statusCode === 404 ? 'not-found' : 'invalid-request' });
    app.log.error(error); return reply.code(500).send({ error: 'internal-error' });
  });
  app.addHook('onRequest', async req => {
    // The router decodes static path segments; authorize its matched route, not the raw URL.
    const url = req.routeOptions.url ?? req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/health') return;
    if (url.startsWith('/api/cast/') && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { casting.authorize(req); return; }
    const id = req.headers['x-moa-account'], role = req.headers['x-moa-role'];
    if (id === undefined && role === undefined && !cfg.requireAccount) req.moaAccount = { id: 'local', username: 'local', role: 'admin', permissions: [...ACCOUNT_PERMISSIONS] };
    else {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['admin', 'member'].includes(String(role))) throw new ApiFailure(401, 'login-required');
      let username = '';
      try { username = decodeURIComponent(String(req.headers['x-moa-username'] ?? '')); } catch { throw new ApiFailure(401, 'login-required'); }
      const raw = req.headers['x-moa-permissions'];
      if (raw !== undefined && (typeof raw !== 'string' || raw.split(',').some(value => value && !ACCOUNT_PERMISSIONS.includes(value as Account['permissions'][number])))) throw new ApiFailure(401, 'login-required');
      const permissions = role === 'admin' ? [...ACCOUNT_PERMISSIONS] : ACCOUNT_PERMISSIONS.filter(value => typeof raw === 'string' && raw.split(',').includes(value));
      req.moaAccount = { id, username, role: role as Account['role'], permissions };
    }
    if (req.moaAccount.role === 'admin') db.claimProfiles(req.moaAccount.id);
    const route = url;
    const admin = route.startsWith('/api/admin/') || route === '/api/plugins' || route.startsWith('/api/plugins/') || route.startsWith('/api/network') || route.startsWith('/api/library/') ||
      route.startsWith('/api/source-repositories') || route === '/api/sources/refresh' || route === '/api/sources/remove' ||
      route === '/api/sources/:id/removal-impact' || req.method === 'DELETE' && route === '/api/sources/:id' ||
      /^\/api\/sources\/:id\/(install|rollback|check|preferences)$/.test(route) ||
      req.method === 'PATCH' && (route === '/api/sources/:id' || route === '/api/media/:id/metadata') ||
      req.method === 'DELETE' && route === '/api/episodes/:id/subtitles/:subtitleId';
    if (admin && req.moaAccount.role !== 'admin') throw new ApiFailure(403, 'admin-required');
    const permission = req.method !== 'DELETE' && (route.startsWith('/api/playback') || route === '/api/episodes/:id/subtitles/preference') ? 'video.watch'
      : req.method === 'POST' && (route.endsWith('/translate') || route === '/api/translations/:id/priority') ? 'subtitles.translate'
      : req.method === 'POST' && (route === '/api/subtitles/import' || route === '/api/episodes/:id/subtitles/online') ? 'subtitles.add' : null;
    if (permission && !req.moaAccount.permissions.includes(permission)) throw new ApiFailure(403, 'permission-denied');
    const sessionAsset = ['GET','HEAD'].includes(req.method) && /^\/api\/playback\/[^/]+\//.test(url);
    const scoped = !(/^\/api\/(me$|profiles(?:\/|$)|admin\/|images\/)/.test(url)) && !sessionAsset;
    const header = req.headers['x-moa-profile'];
    const downloadProfile = route === '/api/admin/downloads/batch' || route === '/api/admin/downloads/choices' || route === '/api/admin/downloads' && req.method === 'POST' || route === '/api/admin/downloads/:id/retry';
    const copyNavigation = route === '/api/admin/default-navigation' && req.method === 'PUT' && header !== undefined;
    if (scoped || downloadProfile || copyNavigation || sessionAsset && header !== undefined) {
      if (typeof header !== 'string' || !db.get('SELECT id FROM profiles WHERE id=? AND account_id=?', header, req.moaAccount.id)) throw new ApiFailure(401, 'profile-required');
      req.moaProfile = header;
      pins.assert(header, req);
    }
    if (sessionAsset) {
      const sessionId = params(req).sessionId;
      const owner = playback.sessions.get(sessionId)?.profile ?? remotePlayback.sessions.get(sessionId)?.profile ?? online.assetProfile(sessionId) ?? translations.assetProfile(sessionId) ?? subtitleLibrary.assetProfile(sessionId) ?? nativeShorts.owner(sessionId);
      if (owner && !db.get('SELECT 1 FROM profiles WHERE id=? AND account_id=?', owner, req.moaAccount.id)) throw new ApiFailure(403, 'session-account-mismatch');
      if (owner) pins.assert(owner, req);
    }
  });
  registerProfileRoutes(app, { db, cfg, pins, online, translations, remotePlayback, playback, recommendations, catalog, groups, sources });
  const discovery = new PluginDiscovery(db, tmdb);
  const shorts = new Shorts(db, tmdb, recommendations, youtube);
  registerShortsRoutes(app, { db, shorts, nativeShorts, sources, pins, translations });
  registerWebsitePlugins(app, db, discovery, new PluginPeople(db, tmdb, Date.now, { catalog, groups }), new PluginSchedule(db,tmdb,services.schedule),new PluginNews(db,tmdb,services.schedule?.now),new PluginBoxOffice(db,services.boxoffice),new PluginReviews(db,tmdb,{...services.reviews,anilist}),undefined,imageCache);
  registerUpdates(app, { prepareComponent:()=>{if(downloads.busy)throw new ApiFailure(409,'update-app-busy');return downloads.suspend();}, prepare:()=>downloads.suspend(), resume:()=>downloads.resume(), canResume:()=>!updateMaintenance.paused });
  casting.register(app);
  registerSourceRoutes(app, { db, cfg, sources, online, remotePlayback, playback, tmdb, catalog });
  registerMetadataRoutes(app, { db, cfg, tmdb, youtube, catalog, imageCache, sources });
  registerNetworkRoutes(app, { remoteAccess, sources });
  app.get('/api/me', async req => req.moaAccount);
  registerTranslationRoutes(app, { jimaku, translations, subtitleLibrary });

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  registerSettingsRoutes(app, { db });
  registerCatalogRoutes(app, { db, catalog, groups, tmdb, sources, franchises, youtube });
  registerLibraryRoutes(app, { db, cfg, library, playback });
  registerPlaybackRoutes(app, { db, catalog, sources, playback, remotePlayback, downloads, subtitleLibrary, online, translations, casting, enrichment, generalMarkers });
  registerSubtitleRoutes(app, { subtitleLibrary, online, playback });
  registerDownloadRoutes(app, { downloads });
  let web = false;
  try { await access(path.join(cfg.webDir, 'index.html')); web = true; } catch {}
  if (web) await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false });
  app.setNotFoundHandler(async (req, reply) => {
    if (web && ['GET', 'HEAD'].includes(req.method) && req.url.split('?')[0] !== '/api' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not-found' });
  });
  // Periodic scans reuse the same incremental scan path; disabled with 0 for tests.
  const interval = Math.max(0, Number(process.env.MOA_SCAN_INTERVAL_MS ?? 6 * 60 * 60 * 1000));
  const scanTimer = interval > 0 ? setInterval(() => { if (!updateMaintenance.paused) library.start(); }, interval) : undefined; scanTimer?.unref();
  app.addHook('onReady', async () => { await remoteAccess.init(); enrichment.schedule(); void tmdb.backfill().catch(error => app.log.warn({ event: 'tmdb-backfill-error', error: String(error) })); });
  app.addHook('onClose', async () => { recommendations.close(); anilist.close(); nativeShorts.close(); shorts.close(); youtube.close(); generalMarkers.close(); remoteAccess.close(); clearInterval(cacheStatsTimer); clearInterval(subtitleMemoryTimer); await imageCache.close(); if (scanTimer) clearInterval(scanTimer); await franchises.close(); tmdb.close(); await jimaku.close(); await translations.close(); online.close(); remotePlayback.close(); await downloads.close(); await sources.close(); await library.pending; await enrichment.close(); await playback.close(); db.close(); });
  return { app, db, downloads, sources, remotePlayback, catalog, library, playback, online, translations, jimaku, enrichment, config: cfg };
}
