import { compatibilityHttp } from '@moa/extensions';
import { safeZipPath } from '@moa/subtitles-ko';
import { PLUGIN_API_VERSION, type WebsitePlugin, type WebsitePluginPackage, type WebsitePluginRuntime } from '@moa/shared';
import type { FastifyInstance } from 'fastify';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { Store } from './db.js';
import { ApiFailure, hash } from './util.js';

const semver = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function pluginCompatibility(p: WebsitePluginPackage, current = process.env.MOA_VERSION): NonNullable<WebsitePlugin['compatibility']> {
  const actual = typeof current === 'string' && current.length <= 80 ? current.match(semver) : null;
  let supported = p.apiVersion <= PLUGIN_API_VERSION;
  if (p.minMoaVersion) {
    const minimum = p.minMoaVersion.match(semver)!;
    const compare = actual ? [1, 2, 3].map(i => BigInt(actual[i]) - BigInt(minimum[i])).find(value => value !== 0n) : undefined;
    if (!actual || compare !== undefined && compare < 0n) supported = false;
    else if (compare === undefined && actual[4]) {
      const left = actual[4].split('.'), right = minimum[4]?.split('.');
      if (!right) supported = false;
      else for (let i = 0; i < Math.max(left.length, right.length); i++) {
        if (left[i] === right[i]) continue;
        supported &&= right[i] === undefined || left[i] !== undefined && (/^\d+$/.test(left[i]) && /^\d+$/.test(right[i]) ? BigInt(left[i]) > BigInt(right[i]) : /^\d+$/.test(left[i]) ? false : /^\d+$/.test(right[i]) || left[i] > right[i]);
        break;
      }
    }
  }
  return { supported, apiVersion: PLUGIN_API_VERSION, moaVersion: actual ? current!.replace(/^v/, '') : null };
}

export function pluginPackage(value: unknown): WebsitePluginPackage {
  const p = value as WebsitePluginPackage;
  const list = (items: unknown, allowed: string[]) => Array.isArray(items) && items.length <= allowed.length && new Set(items).size === items.length && items.every(item => allowed.includes(item));
  if (!p || typeof p !== 'object' || Object.keys(p).some(key => !['apiVersion', 'minMoaVersion', 'hooks', 'id', 'name', 'version', 'description', 'placements', 'permissions', 'connect', 'html', 'script', 'actions'].includes(key)) ||
    !Number.isSafeInteger(p.apiVersion) || p.apiVersion < 1 || p.apiVersion > 1000 || p.minMoaVersion !== undefined && (typeof p.minMoaVersion !== 'string' || p.minMoaVersion.length > 80 || !semver.test(p.minMoaVersion)) || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 ||
    typeof p.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(p.version) || p.version.length > 40 ||
    typeof p.description !== 'string' || p.description.length > 500 || !list(p.placements, ['app', 'settings', 'player', 'home', 'detail']) || !p.placements.length ||
    !list(p.permissions, ['app.context', 'app.navigate', 'ui', 'player.context', 'player.control', 'subtitles.import', 'storage', 'notifications', 'catalog.modify']) || !Array.isArray(p.connect) || p.connect.length > 10 || new Set(p.connect).size !== p.connect.length ||
    p.hooks !== undefined && (!list(p.hooks, ['catalog.transform']) || !p.permissions.includes('catalog.modify') || !p.script || p.apiVersion < 2) || p.placements.includes('detail') && p.apiVersion < 2 ||
    (p.html !== undefined && typeof p.html !== 'string') || (p.script !== undefined && typeof p.script !== 'string') || (typeof p.html === 'string') === (typeof p.script === 'string') || typeof (p.html ?? p.script) !== 'string' || !(p.html ?? p.script)!.trim() || Buffer.byteLength((p.html ?? p.script)!) > 200 * 1024 ||
    p.actions !== undefined && (!p.script || !Array.isArray(p.actions) || p.actions.length > 8 || new Set(p.actions.map(action => action?.id)).size !== p.actions.length || p.actions.some(action => !action || Object.keys(action).some(key => !['id', 'label'].includes(key)) || typeof action.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(action.id) || typeof action.label !== 'string' || !action.label.trim() || action.label.length > 60))) throw new ApiFailure(400, 'invalid-plugin');
  for (const origin of p.connect) {
    try {
      const url = new URL(origin);
      if (typeof origin !== 'string' || origin.length > 250 || url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error();
    } catch { throw new ApiFailure(400, 'invalid-plugin-origin'); }
  }
  return p;
}

type PluginFile = { name: string; content: string };
const packageFile = /(?:^|\/)(?:manifest\.json|plugin\.js|index\.html)$|\.moa-plugin\.json$/i;
const packageLimit = 4 * 1024 * 1024;

export async function unpackPlugin(value: unknown): Promise<WebsitePluginPackage> {
  try {
    const input = value as { archive?: string; files?: PluginFile[] };
    let files: PluginFile[];
    if (typeof input?.archive === 'string' && input.files === undefined) {
      if (input.archive.length > Math.ceil(packageLimit / 3) * 4) throw new ApiFailure(413, 'plugin-package-too-large');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.archive) || input.archive.length % 4) throw new Error();
      const zip = await new Promise<ZipFile>((resolve, reject) => yauzl.fromBuffer(Buffer.from(input.archive!, 'base64'), { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error || !file ? reject(error) : resolve(file)));
      try {
        files = await new Promise<PluginFile[]>((resolve, reject) => {
          const found: PluginFile[] = [], names = new Set<string>();
          let count = 0, size = 0;
          zip.once('error', reject);
          zip.once('end', () => resolve(found));
          zip.on('entry', (entry: Entry) => {
            const name = entry.fileName;
            if (++count > 256 || (size += entry.uncompressedSize) > packageLimit) { reject(new ApiFailure(413, 'plugin-package-too-large')); return; }
            if (name.startsWith('__MACOSX/')) { zip.readEntry(); return; }
            if (!safeZipPath(name) || names.has(name) || entry.isEncrypted() || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) { reject(new Error()); return; }
            names.add(name);
            if (!packageFile.test(name)) { zip.readEntry(); return; }
            if (entry.uncompressedSize > 256 * 1024 || entry.uncompressedSize / Math.max(1, entry.compressedSize) > 250) { reject(new ApiFailure(413, 'plugin-package-too-large')); return; }
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) { reject(error); return; }
              const chunks: Buffer[] = [];
              let bytes = 0;
              stream.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > entry.uncompressedSize || bytes > 256 * 1024) stream.destroy(new Error());
                else chunks.push(chunk);
              });
              stream.once('error', reject);
              stream.once('end', () => {
                try { found.push({ name, content: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); zip.readEntry(); }
                catch (error) { reject(error); }
              });
            });
          });
          zip.readEntry();
        });
      } finally { zip.close(); }
    } else if (Array.isArray(input?.files) && input.archive === undefined) files = input.files;
    else throw new Error();
    if (!files.length || files.length > 256 || new Set(files.map(file => file?.name)).size !== files.length) throw new Error();
    let total = 0;
    for (const file of files) {
      if (!file || typeof file.name !== 'string' || file.name.length > 512 || !safeZipPath(file.name) || file.name.includes('\\') || typeof file.content !== 'string') throw new Error();
      if ((total += Buffer.byteLength(file.content)) > packageLimit || Buffer.byteLength(file.content) > 256 * 1024) throw new ApiFailure(413, 'plugin-package-too-large');
    }
    const manifests = files.filter(file => /(?:^|\/)manifest\.json$/i.test(file.name));
    const candidates = (manifests.length ? manifests : files.filter(file => /\.moa-plugin\.json$/i.test(file.name))).sort((a, b) => a.name.split('/').length - b.name.split('/').length);
    const manifest = candidates[0];
    if (!manifest || candidates[1]?.name.split('/').length === manifest.name.split('/').length) throw new ApiFailure(400, 'plugin-manifest-missing');
    const p = JSON.parse(manifest.content.replace(/^\uFEFF/, ''));
    if (p.script === undefined && p.html === undefined) {
      const root = manifest.name.slice(0, manifest.name.lastIndexOf('/') + 1);
      const sources = files.filter(file => file.name === `${root}plugin.js` || file.name === `${root}index.html`);
      if (sources.length !== 1) throw new ApiFailure(400, 'plugin-entry-missing');
      p[sources[0].name.endsWith('.js') ? 'script' : 'html'] = sources[0].content;
    }
    if (Buffer.byteLength(JSON.stringify(p)) > 256 * 1024) throw new ApiFailure(413, 'plugin-package-too-large');
    return pluginPackage(p);
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(400, 'invalid-plugin-package');
  }
}

export function registerWebsitePlugins(app: FastifyInstance, db: Store) {
  db.db.exec('CREATE TABLE IF NOT EXISTS website_plugins(id TEXT PRIMARY KEY,package TEXT NOT NULL,enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS website_plugin_data(plugin_id TEXT REFERENCES website_plugins(id) ON DELETE CASCADE,profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,value TEXT NOT NULL,PRIMARY KEY(plugin_id,profile_id))');
  const metadata = (row: Record<string, any>): WebsitePlugin => { const { html, script, ...p } = JSON.parse(row.package) as WebsitePluginPackage; return { ...p, kind: script === undefined ? 'html' : 'script', revision: hash(row.package), enabled: Boolean(row.enabled), compatibility: pluginCompatibility(p) }; };
  const get = (id: string, enabled = true) => {
    const row = db.get('SELECT * FROM website_plugins WHERE id=?', id);
    if (!row || enabled && !row.enabled) throw new ApiFailure(404, 'plugin-not-found');
    if (enabled && !pluginCompatibility(JSON.parse(row.package)).supported) throw new ApiFailure(409, 'plugin-update-required');
    return row;
  };
  const pending = new Set<string>(), abort = new AbortController();
  app.addHook('onClose', async () => abort.abort());
  app.get('/api/plugins', async () => db.all('SELECT * FROM website_plugins ORDER BY id').map(metadata));
  app.get('/api/plugin-runtime', async (): Promise<WebsitePluginRuntime[]> => db.all('SELECT * FROM website_plugins WHERE enabled=1 ORDER BY id').map(metadata).filter(p => p.compatibility!.supported).map(({ id, name, revision, kind, placements, permissions, actions, hooks, enabled }) => ({ id, name, revision, kind, placements, permissions, actions, hooks, enabled })));
  app.get('/api/plugins/:id', async req => { const row = get((req.params as { id: string }).id); return { ...JSON.parse(row.package), revision: hash(row.package) }; });
  app.get('/api/plugin-runtime/:id', async req => { const row = get((req.params as { id: string }).id), p = JSON.parse(row.package) as WebsitePluginPackage; return { html: p.html, script: p.script, revision: hash(row.package) }; });
  app.post('/api/admin/plugins/preview', { bodyLimit: 6 * 1024 * 1024 }, async req => unpackPlugin(req.body));
  app.post('/api/admin/plugins', { bodyLimit: 256 * 1024 }, async req => {
    const p = pluginPackage(req.body);
    if (!db.get('SELECT 1 FROM website_plugins WHERE id=?', p.id) && db.get('SELECT count(*) AS n FROM website_plugins')!.n >= 32) throw new ApiFailure(409, 'plugin-limit');
    db.run('INSERT INTO website_plugins VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET package=excluded.package', p.id, JSON.stringify(p));
    return metadata(get(p.id, false));
  });
  app.patch('/api/admin/plugins/:id', { schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } }, async req => {
    const id = (req.params as { id: string }).id; get(id, false);
    db.run('UPDATE website_plugins SET enabled=? WHERE id=?', Number((req.body as { enabled: boolean }).enabled), id);
    return metadata(get(id, false));
  });
  app.delete('/api/admin/plugins/:id', async (req, reply) => { db.run('DELETE FROM website_plugins WHERE id=?', (req.params as { id: string }).id); return reply.code(204).send(); });
  for (const base of ['/api/plugins', '/api/plugin-runtime']) {
    app.post(`${base}/:id/storage`, { bodyLimit: 20 * 1024, schema: { body: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'string', pattern: '^[a-f0-9]{32}$' }, value: { type: 'object', maxProperties: 128 } } } } }, async req => {
      const id = (req.params as { id: string }).id, row = get(id), p = JSON.parse(row.package) as WebsitePluginPackage;
      const body = req.body as { revision: string; value?: Record<string, unknown> };
      if (body.revision !== hash(row.package)) throw new ApiFailure(409, 'plugin-updated');
      if (!p.permissions.includes('storage')) throw new ApiFailure(403, 'plugin-permission-denied');
      if (body.value !== undefined) {
        const value = JSON.stringify(body.value);
        if (Buffer.byteLength(value) > 16 * 1024) throw new ApiFailure(413, 'plugin-storage-too-large');
        db.run('INSERT INTO website_plugin_data VALUES(?,?,?) ON CONFLICT(plugin_id,profile_id) DO UPDATE SET value=excluded.value', id, req.moaProfile!, value);
      }
      return JSON.parse(db.get('SELECT value FROM website_plugin_data WHERE plugin_id=? AND profile_id=?', id, req.moaProfile!)?.value || '{}');
    });
    app.post(`${base}/:id/request`, { schema: { body: { type: 'object', additionalProperties: false, required: ['url', 'revision'], properties: { url: { type: 'string', maxLength: 2048 }, revision: { type: 'string', pattern: '^[a-f0-9]{32}$' } } } } }, async req => {
      const id = (req.params as { id: string }).id, row = get(id), p = JSON.parse(row.package) as WebsitePluginPackage;
      const { url: raw, revision } = req.body as { url: string; revision: string };
      if (hash(row.package) !== revision) throw new ApiFailure(409, 'plugin-updated');
      let url: URL;
      try { url = new URL(raw); } catch { throw new ApiFailure(400, 'plugin-url-invalid'); }
      if (url.username || url.password || !p.connect.includes(url.origin)) throw new ApiFailure(403, 'plugin-origin-denied');
      const key = `${req.moaProfile}:${id}`;
      if (pending.has(key) || pending.size >= 4) throw new ApiFailure(429, 'plugin-busy');
      pending.add(key);
      try {
        const result = await compatibilityHttp({ url: url.href, method: 'GET', options: { timeout: 15, followRedirects: false } }, abort.signal, [], 4 * 1024 * 1024, undefined, false);
        if (result.statusCode < 200 || result.statusCode >= 300) throw new ApiFailure(502, 'plugin-fetch-failed');
        if (hash(get(id).package) !== revision) throw new ApiFailure(409, 'plugin-updated');
        return { base64: Buffer.from(result.bytes).toString('base64') };
      } catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure(502, 'plugin-fetch-failed'); }
      finally { pending.delete(key); }
    });
  }
}
