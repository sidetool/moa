import { DEFAULT_DEVICE_SETTINGS, isPlayerShortcuts, type DefaultNavigationUpdate, type NavigationTab, type Settings } from '@moa/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../db.js';
import { object, profile } from '../http.js';
import { browseSelection } from '../sources/schema.js';
import { ApiFailure } from '../util.js';

const settingsFields = { shortsQuality: {type:'string',enum:['auto','360p','480p','720p']}, shortsPlayback: {type:'string',enum:['embed','native']}, shortsCategories: {type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',enum:['movie','series','anime']}}, shortsEnabled: {type:'boolean'}, shortsScreenFit: {type:'boolean'}, shortsMode: {type:'string',enum:['mixed','personal','popular']}, shortsHideWatched: {type:'boolean'}, shortsRepeatDays: {type:'integer',enum:[0,1,7,30]}, recommendationsEnabled: {type:'boolean'}, anilistRecommendationsEnabled: {type:'boolean'}, generalSkipEnabled: {type:'boolean'}, groupHistory: { type: 'boolean' }, navigation: { type: "array", minItems: 1, maxItems: 12, items: object({ id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" }, name: { type: "string", minLength: 1, maxLength: 24, pattern: "\\S" }, sourceIds: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } }, sourceFilters: { type: "object", maxProperties:32, additionalProperties: browseSelection }, includeLocal: { type: "boolean" } }, ["id", "name", "sourceIds", "includeLocal"]) }, autoplayNext: { type: 'boolean' }, autoplayDelay: { type: 'number', minimum: 0 }, nextEpisodeLeadSeconds: { type: 'integer', minimum: 0, maximum: 600 }, defaultSubtitleLang: { type: 'string', maxLength: 32 }, subtitleSize: { type: 'string', enum: ['small', 'medium', 'large', 'xlarge'] }, subtitleScale: { type: ['number', 'null'], minimum: 50, maximum: 250 }, subtitleBackground: { type: 'string', enum: ['original', 'none', 'soft', 'solid'] }, subtitleShadow: { type: ['number', 'null'], minimum: 0, maximum: 10 }, subtitleOutline: { type: ['number', 'null'], minimum: 0, maximum: 6 }, subtitleHeight: { type: 'number', minimum: 0, maximum: 40 }, subtitlePadding: { type: 'number', minimum: 0, maximum: 20 }, subtitlePreserveAss: { type: 'boolean' }, subtitleStep: { type: 'integer', enum: [1, 5, 10] }, preferredQuality: { type: 'string', enum: ['auto', '1080', '720', '480'] }, hardwareTranscoding: { type: 'boolean' }, autoFetchSubtitles: { type: 'boolean' }, experimentalSubtitleSync: { type: 'boolean' }, translationMode: { type: 'string', enum: ['manual','ask','auto'] }, translationSourcePriority: { type: 'string', enum: ['site','jimaku'] }, skipSubtitleSearchWithSiteTrack: { type: 'boolean' }, skipTranslationWithoutSubtitles: { type: 'boolean' } };
const validateNavigation = (tabs: NavigationTab[] | null | undefined) => {
  if (tabs && (tabs[0]?.id !== 'home' || new Set(tabs.map(t => t.id)).size !== tabs.length)) throw new ApiFailure(400, 'invalid-navigation');
};

export function registerSettingsRoutes(app: FastifyInstance, { db }: {
  db: Store;
}) {
  app.get('/api/admin/default-navigation', async () => ({ navigation: db.defaultNavigation() }));
  app.put('/api/admin/default-navigation', { schema: { body: { oneOf: [
    object({ navigation: { anyOf: [settingsFields.navigation, { type: 'null' }] } }, ['navigation']),
    object({ fromProfile: { const: true } }, ['fromProfile'])
  ] } } }, async req => {
    const body = req.body as DefaultNavigationUpdate;
    if ('fromProfile' in body && !req.moaProfile) throw new ApiFailure(401, 'profile-required');
    const tabs = 'fromProfile' in body ? db.settings(profile(req)).navigation ?? null : body.navigation;
    validateNavigation(tabs);
    const navigation = tabs === null ? null : db.availableNavigation(tabs);
    db.saveDefaultNavigation(navigation);
    return { navigation };
  });
  app.get('/api/settings', async req => db.settings(profile(req)));
  const deviceFields = { playerShortcuts: { type: 'object' }, ...Object.fromEntries(Object.keys(DEFAULT_DEVICE_SETTINGS).filter(key => key in settingsFields).map(key => [key, settingsFields[key as keyof typeof settingsFields]])), shortsScreenFit: { type: ['boolean', 'null'] }, fullscreenOnPlay: { type: 'boolean' }, autoSkip: { type: 'boolean' }, seekStep: { type: 'integer', enum: [5, 10, 15, 30] }, holdSpeed: { type: 'number', enum: [1.25, 1.5, 2, 2.5, 3] }, videoFill: { type: 'boolean' }, seasonSwitcher: { type: 'boolean' }, titleGrouping: { type: 'boolean' } };
  const deviceScope = (req: FastifyRequest) => {
    const id = req.headers['x-moa-device'];
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ApiFailure(400, 'invalid-device');
    return [req.moaAccount.id, profile(req), id.toLowerCase()] as const;
  };
  app.get('/api/settings/device', async (req, reply) => {
    const row = db.get('SELECT value FROM device_settings WHERE account_id=? AND profile_id=? AND device_id=?', ...deviceScope(req));
    return reply.header('Cache-Control', 'private, no-store').send({ settings: row ? JSON.parse(row.value) : null });
  });
  app.patch('/api/settings/device', { preValidation: async req => {
    const value = (req.body as { settings?: { playerShortcuts?: unknown } } | null)?.settings;
    if (value && Object.hasOwn(value, 'playerShortcuts') && !isPlayerShortcuts(value.playerShortcuts)) throw new ApiFailure(400, 'invalid-player-shortcuts');
  }, schema: { body: object({ settings: object(deviceFields), migrate: { type: 'boolean' } }, ['settings']) } }, async (req, reply) => {
    const scope = deviceScope(req), body = req.body as { settings: Partial<import('@moa/shared').DeviceSettings>; migrate?: boolean };
    const row = db.get('SELECT value FROM device_settings WHERE account_id=? AND profile_id=? AND device_id=?', ...scope);
    const settings = row && body.migrate ? JSON.parse(row.value) : { ...DEFAULT_DEVICE_SETTINGS, ...JSON.parse(row?.value || '{}'), ...body.settings };
    db.run('INSERT OR REPLACE INTO device_settings VALUES(?,?,?,?)', ...scope, JSON.stringify(settings));
    return reply.header('Cache-Control', 'private, no-store').send({ settings });
  });
  app.patch('/api/settings', { preValidation: async req => {
    const body = req.body as Partial<Settings> | null;
    if (body && Object.hasOwn(body, 'nextEpisodeLeadSeconds') && !Number.isInteger(body.nextEpisodeLeadSeconds)) throw new ApiFailure(400, 'invalid-next-episode-lead');
  }, schema: { body: object(settingsFields) } }, async req => {
    const tabs = (req.body as Partial<Settings>).navigation;
    validateNavigation(tabs);
    const updated: Settings = { ...db.settings(profile(req)), ...req.body as Partial<Settings> };
    db.run('INSERT OR REPLACE INTO settings VALUES(?,?)', profile(req), JSON.stringify(updated)); return updated;
  });
}
