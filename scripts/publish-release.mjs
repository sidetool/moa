// CI-only publisher preparation. Creates artifacts, never calls GitHub or publishes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import path from 'node:path';
import { BUNDLE_FILES } from './release-bundle.mjs';
import { SERVICES, UPDATER_VERSION, version, sha256, validateManifest } from './release.mjs';
const tag = process.env.RELEASE_TAG;
const channel = version(tag)[3] === Infinity ? 'stable' : 'beta';
const repository = process.env.GITHUB_REPOSITORY || 'sidetool/moa';
const policy = JSON.parse(await readFile('deploy/release-policy.json', 'utf8'));
if (policy.version !== tag || typeof policy.rollbackSafe !== 'boolean') throw new Error('Set and review deploy/release-policy.json for this exact release');
const output = path.resolve(process.env.RELEASE_OUTPUT || 'release-output');
await mkdir(output, { recursive: true });
const publicKey = process.env.RELEASE_PUBLIC_KEY;
const trust = JSON.parse(await readFile('deploy/release-trust.json', 'utf8'));
if (trust.algorithm !== 'Ed25519' || createPublicKey(publicKey).export({ type: 'spki', format: 'pem' }) !== createPublicKey(trust.publicKey).export({ type: 'spki', format: 'pem' })) throw new Error('Configured public key differs from reviewed release trust key');
const key = createPrivateKey(process.env.RELEASE_PRIVATE_KEY);
if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== createPublicKey(publicKey).export({ type: 'spki', format: 'pem' })) throw new Error('Release signing key mismatch');
const files = {};
for (const name of BUNDLE_FILES) files[name] = name === 'trusted-key.pem' ? publicKey : await readFile(name, 'utf8');
// Compose files already use published images; optional runtime selection is installer-owned.
const bundle = Buffer.from(JSON.stringify({ format: 1, files }));
await writeFile(path.join(output, 'moa-release.json'), bundle);
const services = {};
for (const name of SERVICES) {
  const digest = (await readFile(path.join('release-digests', `${name}.txt`), 'utf8')).trim();
  services[name] = { image: `ghcr.io/${repository.split('/')[0].toLowerCase()}/${name}`, digest, platforms: name === 'moa-source-browser' ? ['linux/amd64'] : ['linux/amd64', 'linux/arm64'] };
}
const manifest = validateManifest({ schemaVersion: 1, version: tag, revision: process.env.GITHUB_SHA, channel, publishedAt: new Date().toISOString(),
  releaseNotesUrl: `https://github.com/${repository}/releases/tag/${tag}`, minimumUpdaterVersion: UPDATER_VERSION,
  minimumComposeVersion: '2.24.0', minimumVersion: policy.minimumVersion, schemaEpoch: policy.schemaEpoch, rollbackSafe: policy.rollbackSafe,
  services, bundle: { name: 'moa-release.json', sha256: sha256(bundle), size: bundle.length } }, repository);
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'release.json'), bytes);
await writeFile(path.join(output, 'release.json.sig'), sign(null, bytes, key).toString('base64') + '\n');
// A fixed allowlist only: no working tree archive, DB, .env, fixtures or user extensions.
const install = path.join(output, 'moa-install');
for (const [name, content] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(install, name)), { recursive: true });
  await writeFile(path.join(install, name), content);
}

await promisify(execFile)('tar', ['-C', output, '-czf', path.join(output, 'moa-install.tar.gz'), 'moa-install'], { timeout: 30000 });
await writeFile(path.join(output, 'moa-install.tar.gz.sig'), sign(null, await readFile(path.join(output, 'moa-install.tar.gz')), key));
