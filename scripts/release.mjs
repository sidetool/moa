// Dependency-free contract shared by the host updater and release publisher.
import { createHash, createPublicKey, verify } from 'node:crypto';
export const UPDATER_VERSION = '1.0.0';
export const SERVICES = ['moa', 'moa-auth', 'moa-apk', 'moa-connector', 'moa-source-browser'];
export const DEFAULT_POLICY = Object.freeze({ channel: 'stable' });
export const fail = code => { throw new Error(code); };
export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function version(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(value);
  if (!m || m.slice(1).some(n => n !== undefined && !Number.isSafeInteger(Number(n)))) fail('update-invalid-version');
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}
export function compare(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function policy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'channel' || !['stable', 'beta'].includes(value.channel)) fail('update-invalid-policy');
  return { channel: value.channel };
}
export function validateManifest(value, repository = 'sidetool/moa') {
  const owner = repository.split('/')[0].toLowerCase();
  if (value?.schemaVersion !== 1 || !/^v/.test(value.version)) fail('update-manifest-invalid');
  const parsed = version(value.version);
  if (value.channel !== (parsed[3] === Infinity ? 'stable' : 'beta') || !/^[a-f0-9]{40}$/.test(value.revision) || !Number.isFinite(Date.parse(value.publishedAt)) ||
      value.releaseNotesUrl !== `https://github.com/${repository}/releases/tag/${value.version}`) fail('update-manifest-invalid');
  version(value.minimumUpdaterVersion); version(value.minimumComposeVersion); version(value.minimumVersion);
  if (!Number.isSafeInteger(value.schemaEpoch) || value.schemaEpoch < 1 || typeof value.rollbackSafe !== 'boolean') fail('update-manifest-invalid');
  if (Object.keys(value.services ?? {}).sort().join() !== [...SERVICES].sort().join()) fail('update-manifest-invalid');
  for (const name of SERVICES) {
    const service = value.services[name];
    if (service.image !== `ghcr.io/${owner}/${name}` || !/^sha256:[a-f0-9]{64}$/.test(service.digest) ||
        !Array.isArray(service.platforms) || !service.platforms.length || service.platforms.some(p => !['linux/amd64', 'linux/arm64'].includes(p))) fail('update-manifest-invalid');
  }
  if (value.bundle?.name !== 'moa-release.json' || !/^sha256:[a-f0-9]{64}$/.test(value.bundle.sha256) || !Number.isSafeInteger(value.bundle.size) || value.bundle.size < 1 || value.bundle.size > 2 * 1024 * 1024) fail('update-manifest-invalid');
  return value;
}
export function verifiedManifest(bytes, signature, publicKey, repository) {
  if (bytes.length > 64 * 1024 || signature.length > 256) fail('update-manifest-invalid');
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(signature.toString().trim(), 'base64'))) fail('update-signature-invalid');
  } catch { fail('update-signature-invalid'); }
  return validateManifest(JSON.parse(bytes), repository);
}
// Bounded downloads; redirects are permitted only to GitHub's release asset CDN.
export async function download(url, { fetcher = fetch, limit = 65536, headers = {} } = {}) {
  for (let hops = 0; hops < 5; hops++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname)) fail('update-download-invalid');
    const response = await fetcher(u.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get('location'), u).href;
      headers = {}; await response.body?.cancel(); continue;
    }
    if (response.status === 304) return { status: 304 };
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 403 || response.status === 429 ? 'update-rate-limited' : 'update-download-failed'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) fail('update-response-limit'); chunks.push(chunk); }
    return { status: response.status, bytes: Buffer.concat(chunks), etag: response.headers.get('etag') };
  }
  fail('update-download-invalid');
}
export class ReleaseFeed {
  constructor({ repository = 'sidetool/moa', publicKey, fetcher = fetch } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('update-invalid-options');
    this.repository = repository; this.publicKey = publicKey; this.fetcher = fetcher; this.cache = new Map();
  }
  async releases(channel) {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${this.repository}/releases?per_page=100&page=${page}`;
      const cached = this.cache.get(url);
      const result = await download(url, { fetcher: this.fetcher, limit: 2 * 1024 * 1024, headers: { Accept: 'application/vnd.github+json', ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) } });
      const data = result.status === 304 ? cached?.data : JSON.parse(result.bytes);
      if (!Array.isArray(data)) fail('update-manifest-invalid');
      if (result.status !== 304) this.cache.set(url, { data, etag: result.etag });
      all.push(...data);
      if (data.length < 100) break;
      if (page === 5) fail('update-feed-truncated');
    }
    return all.filter(r => {
      try { return !r.draft && r.published_at && r.prerelease === (channel === 'beta') && (version(r.tag_name)[3] !== Infinity) === r.prerelease; } catch { return false; }
    }).sort((a, b) => compare(b.tag_name, a.tag_name));
  }
  asset(version, name) { return `https://github.com/${this.repository}/releases/download/${version}/${name}`; }
  async manifest(release) {
    for (const name of ['release.json', 'release.json.sig', 'moa-release.json']) if (!release.assets?.some(a => a.name === name && a.state === 'uploaded')) fail('update-release-incomplete');
    const bytes = (await download(this.asset(release.tag_name, 'release.json'), { fetcher: this.fetcher })).bytes;
    const signature = (await download(this.asset(release.tag_name, 'release.json.sig'), { fetcher: this.fetcher, limit: 256 })).bytes;
    const manifest = verifiedManifest(bytes, signature, this.publicKey, this.repository);
    if (manifest.version !== release.tag_name) fail('update-manifest-invalid');
    return { manifest, bytes, signature, digest: sha256(bytes) };
  }
  async bundle(manifest) {
    const bytes = (await download(this.asset(manifest.version, manifest.bundle.name), { fetcher: this.fetcher, limit: manifest.bundle.size })).bytes;
    if (bytes.length !== manifest.bundle.size || sha256(bytes) !== manifest.bundle.sha256) fail('update-bundle-invalid');
    return JSON.parse(bytes);
  }
}
