import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DEFAULT_POLICY, SERVICES, ReleaseFeed, compare, version, policy,
  sha256, verifiedManifest, download,
} from './release.mjs';

const repository = 'fixture-owner/moa';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trustedKey = publicKey.export({ type: 'spki', format: 'pem' });
function manifest(releaseVersion = 'v1.3.0') {
  return {
    schemaVersion: 1, version: releaseVersion, revision: 'a'.repeat(40),
    channel: releaseVersion.includes('-beta.') ? 'beta' : 'stable',
    publishedAt: '2026-01-01T00:00:00Z',
    releaseNotesUrl: `https://github.com/${repository}/releases/tag/${releaseVersion}`,
    minimumUpdaterVersion: '1.0.0', minimumComposeVersion: '2.20.0', minimumVersion: '1.0.0',
    schemaEpoch: 1, rollbackSafe: true,
    services: Object.fromEntries(SERVICES.map(name => [name, {
      image: `ghcr.io/fixture-owner/${name}`, digest: `sha256:${'b'.repeat(64)}`,
      platforms: name === 'moa-source-browser' ? ['linux/amd64'] : ['linux/amd64', 'linux/arm64'],
    }])),
    bundle: { name: 'moa-release.json', sha256: sha256('{}'), size: 2 },
  };
}
function signed(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: Buffer.from(sign(null, bytes, privateKey).toString('base64')) };
}
function release(tag_name, extra = {}) {
  return {
    tag_name, draft: false, prerelease: tag_name.includes('-beta.'),
    published_at: '2026-01-01T00:00:00Z',
    assets: ['release.json', 'release.json.sig', 'moa-release.json'].map(name => ({ name, state: 'uploaded' })),
    ...extra,
  };
}

test('SemVer compares numeric components and beta promotion, and rejects unsupported versions', () => {
  assert.equal(compare('v1.10.0', 'v1.9.9'), 1);
  assert.equal(compare('v1.3.0-beta.10', 'v1.3.0-beta.2'), 1);
  assert.equal(compare('v1.3.0', 'v1.3.0-beta.10'), 1);
  assert.equal(compare('v1.2.9', 'v1.3.0-beta.1'), -1);
  assert.equal(compare('v1.3.0', '1.3.0'), 0);
  for (const value of ['v01.2.0', 'v1.2', 'v1.2.0-rc.1', 'v1.2.0-beta.01', 'v9007199254740992.0.0', 'sha-example']) {
    assert.throws(() => version(value), /update-invalid-version/, value);
  }
});

test('manifest verification binds exact bytes to an Ed25519 key and validates signed content', () => {
  const good = signed(manifest());
  assert.equal(verifiedManifest(good.bytes, good.signature, trustedKey, repository).version, 'v1.3.0');
  const tampered = Buffer.from(good.bytes.toString().replace('v1.3.0', 'v1.4.0'));
  assert.throws(() => verifiedManifest(tampered, good.signature, trustedKey, repository), /update-signature-invalid/);
  const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifiedManifest(good.bytes, good.signature, wrongKey, repository), /update-signature-invalid/);
  assert.throws(() => verifiedManifest(good.bytes, Buffer.from('invalid'), trustedKey, repository), /update-signature-invalid/);
  for (const change of [
    m => { m.channel = 'beta'; },
    m => { m.services.moa.image = 'ghcr.io/other-owner/moa'; },
    m => { m.services.moa.digest = 'latest'; },
    m => { m.services.moa.platforms = ['linux/unsupported']; },
    m => { m.bundle.name = '../outside.json'; },
    m => { delete m.services['moa-auth']; },
  ]) {
    const value = manifest(); change(value);
    const bad = signed(value);
    assert.throws(() => verifiedManifest(bad.bytes, bad.signature, trustedKey, repository), /update-manifest-invalid/);
  }
  assert.throws(() => verifiedManifest(Buffer.alloc(65537), good.signature, trustedKey, repository), /update-manifest-invalid/);
  assert.throws(() => verifiedManifest(good.bytes, Buffer.alloc(257), trustedKey, repository), /update-manifest-invalid/);
});

test('policy accepts only the release channel; automatic installation is not configurable', () => {
  assert.deepEqual(policy(DEFAULT_POLICY), { channel: 'stable' });
  assert.deepEqual(policy({ channel: 'beta' }), { channel: 'beta' });
  for (const patch of [{ channel: 'invalid' }, { autoApply: true }, { autoCheck: false }, { windowStart: '03:00' }, { command: 'ignored' }])
    assert.throws(() => policy({ ...DEFAULT_POLICY, ...patch }), /update-invalid-policy/);
});

test('release feed selects published stable/beta versions using SemVer and reuses ETags', async () => {
  const entries = [
    release('v1.9.0'), release('v1.10.0-beta.2'), release('v1.10.0-beta.10'), release('v1.10.0'),
    release('v99.0.0', { draft: true }), release('v98.0.0', { published_at: null }),
    release('v97.0.0', { prerelease: true }), release('sha-example'),
  ];
  const requests = [];
  const feed = new ReleaseFeed({ repository, publicKey: trustedKey, fetcher: async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    if (options.headers['If-None-Match'] === '"fixture-etag"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify(entries), { headers: { etag: '"fixture-etag"' } });
  } });
  assert.deepEqual((await feed.releases('stable')).map(r => r.tag_name), ['v1.10.0', 'v1.9.0']);
  assert.deepEqual((await feed.releases('beta')).map(r => r.tag_name), ['v1.10.0-beta.10', 'v1.10.0-beta.2']);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['If-None-Match'], '"fixture-etag"');
  assert.ok(requests.every(r => r.url.includes('/releases?per_page=100&page=1')));
});

test('release feed bounds pagination and refuses oversized, rate-limited and unsafe responses', async () => {
  const pages = [];
  const feed = new ReleaseFeed({ repository, publicKey: trustedKey, fetcher: async url => {
    pages.push(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(Array.from({ length: 100 }, () => release('v1.3.0'))));
  } });
  await assert.rejects(feed.releases('stable'), /update-feed-truncated/);
  assert.deepEqual(pages, ['1', '2', '3', '4', '5']);
  await assert.rejects(download('https://api.github.com/fixture', { limit: 3, fetcher: async () => new Response('four') }), /update-response-limit/);
  await assert.rejects(download('https://api.github.com/fixture', { fetcher: async () => new Response(null, { status: 429 }) }), /update-rate-limited/);
  let calls = 0;
  await assert.rejects(download('https://github.com/fixture', { fetcher: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/asset' } });
  } }), /update-download-invalid/);
  assert.equal(calls, 1);
});

test('feed requires complete assets and binds signed manifest version and bundle digest', async () => {
  const value = manifest();
  const good = signed(value);
  const requested = [];
  let badBundle = false;
  const feed = new ReleaseFeed({ repository, publicKey: trustedKey, fetcher: async url => {
    requested.push(url);
    if (url.endsWith('/release.json')) return new Response(good.bytes);
    if (url.endsWith('/release.json.sig')) return new Response(good.signature);
    if (url.endsWith('/moa-release.json')) return new Response(badBundle ? '[]' : '{}');
    throw new Error(`unexpected fixture URL: ${url}`);
  } });
  await assert.rejects(feed.manifest(release('v1.3.0', { assets: [] })), /update-release-incomplete/);
  assert.equal(requested.length, 0);
  const candidate = await feed.manifest(release('v1.3.0'));
  assert.equal(candidate.digest, sha256(good.bytes));
  assert.deepEqual(await feed.bundle(candidate.manifest), {});
  badBundle = true;
  await assert.rejects(feed.bundle(candidate.manifest), /update-bundle-invalid/);
  await assert.rejects(feed.manifest(release('v1.4.0')), /update-manifest-invalid/);
});
