import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Updater } from './update.mjs';
import { DEFAULT_POLICY, SERVICES, compare, sha256 } from './release.mjs';
import { BUNDLE_FILES } from './release-bundle.mjs';
import { atomic, readJson, optionalJson } from './update-files.mjs';

const repository = 'fixture-owner/moa';
const trustedKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
function candidate(releaseVersion, changes = {}) {
  const manifest = {
    schemaVersion: 1, version: releaseVersion, revision: 'a'.repeat(40),
    channel: releaseVersion.includes('-beta.') ? 'beta' : 'stable',
    publishedAt: '2026-01-01T00:00:00Z',
    releaseNotesUrl: `https://github.com/${repository}/releases/tag/${releaseVersion}`,
    minimumUpdaterVersion: '1.0.0', minimumComposeVersion: '2.20.0', minimumVersion: '1.0.0',
    schemaEpoch: 1, rollbackSafe: true,
    services: Object.fromEntries(SERVICES.map(name => [name, {
      image: `ghcr.io/fixture-owner/${name}`, digest: `sha256:${'b'.repeat(64)}`,
      platforms: ['linux/amd64'],
    }])),
    bundle: { name: 'moa-release.json', sha256: sha256('{}'), size: 2 },
    ...changes,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, bytes, digest: sha256(bytes) };
}

async function fixture(t, currentVersion = 'v1.2.0') {
  const cwd = await mkdtemp(path.join(tmpdir(), 'moa-release-fixture-'));
  const root = path.join(cwd, '.moa-release'), dir = path.join(cwd, 'updater');
  await mkdir(root, { recursive: true }); await mkdir(dir);
  // A Git marker must not switch an explicit release installation into source mode.
  await mkdir(path.join(cwd, '.git'));
  const compose = {
    services: {
      moa: { image: `ghcr.io/fixture-owner/moa@sha256:${'a'.repeat(64)}`, build: '.',
        environment: { FIXTURE_LITERAL: 'cost$$5', MOA_VERSION: currentVersion },
        ports: ['127.0.0.1:9999:8795'], volumes: ['fixture-data:/data'] },
      'moa-auth': { image: `ghcr.io/fixture-owner/moa-auth@sha256:${'a'.repeat(64)}`, volumes: ['fixture-auth:/data'] },
      'moa-source-browser': { image: 'fixture-browser:disabled', profiles: ['browser'] },
      'moa-gateway': { image: 'fixture-gateway:fixed' },
    },
    volumes: { 'fixture-data': {}, 'fixture-auth': {} }, networks: { default: { name: 'fixture-network' } },
  };
  const previous = { version: currentVersion, schemaEpoch: 1, services: ['moa', 'moa-auth'], compose: path.join(root, 'previous-compose.json'), runtime: path.join(root, 'previous-runtime') };
  await atomic(previous.compose, compose);
  await atomic(path.join(root, 'installation.json'), { format: 1, project: 'fixture-project', platform: 'linux/amd64', repository });
  await atomic(path.join(root, 'current.json'), previous);
  await writeFile(path.join(root, 'trusted-key.pem'), trustedKey);
  const commands = [], phases = [], feedCalls = [];
  const faults = { pull: false, targetHealth: false, rollback: false };
  let activeCompose = previous.compose;
  const run = async (command, args) => {
    commands.push([command, ...args]);
    if (command === process.execPath && args.at(-1) === 'probe') return JSON.stringify({ protocol: 1, version: '1.0.0' });
    assert.equal(command, 'docker', `unexpected executable ${command}`);
    if (args[0] === 'inspect') return (await readJson(activeCompose)).services[args.at(-1)].image;
    if (args.join(' ') === 'compose version --short') return '2.30.0';
    if (args[0] === 'pull') {
      if (faults.pull) throw new Error('synthetic pull failure');
      return '';
    }
    assert.equal(args[0], 'compose');
    const fileIndex = args.indexOf('-f');
    assert.ok(fileIndex > 0, 'compose operations must pin a configuration');
    const file = args[fileIndex + 1], operation = args[fileIndex + 2];
    assert.equal(args[args.indexOf('--project-name') + 1], 'fixture-project');
    if (operation === 'ps') return JSON.stringify(previous.services.map(Service => ({
      Service, ID: Service, State: 'running', Health: faults.targetHealth && file !== previous.compose ? 'unhealthy' : 'healthy',
    })));
    if (operation === 'up' && file === previous.compose && faults.rollback) throw new Error('synthetic rollback failure');
    if (operation === 'exec') return '0';
    if (operation === 'up') activeCompose = file;
    assert.ok(['config', 'stop', 'cp', 'up', 'restart', 'exec'].includes(operation), `unexpected compose operation ${operation}`);
    return '';
  };
  const host = new Updater({ cwd, dir, mode: 'release', run });
  const persist = host.persist.bind(host);
  host.persist = async () => { phases.push(host.state.state); await persist(); };
  t.after(async () => {
    await host.release.releaseLease();
    await rm(cwd, { recursive: true, force: true });
  });
  await host.release.init();
  let releases = [candidate('v1.3.0')];
  const bundle = { format: 1, files: Object.fromEntries(BUNDLE_FILES.map(name => [name, name.endsWith('.mjs') ? 'export const fixture = true;\n' : 'synthetic fixture\n'])) };
  host.release.feed = {
    async releases(channel) {
      feedCalls.push(['releases', channel]);
      return releases.filter(c => channel === 'beta' || !c.manifest.version.includes('-beta.'))
        .sort((a, b) => compare(b.manifest.version, a.manifest.version))
        .map(c => ({ tag_name: c.manifest.version }));
    },
    async manifest(release) {
      feedCalls.push(['manifest', release.tag_name]);
      const value = releases.find(c => c.manifest.version === release.tag_name);
      if (value.error) throw new Error(value.error);
      return value;
    },
    async bundle(manifest) { feedCalls.push(['bundle', manifest.version]); return bundle; },
  };
  // Simulate the web process acknowledging the real lease file synchronously.
  const activity = host.release.activity.bind(host.release);
  host.release.activity = async () => {
    const lease = await optionalJson(path.join(dir, 'maintenance.json'), null);
    return lease ? { heartbeat: Date.now(), busy: false, leaseId: lease.id } : activity();
  };
  return { cwd, root, dir, host, manager: host.release, commands, phases, feedCalls, faults, previous, compose,
    setReleases(value) { releases = value; } };
}

test('release checks honor channel changes, never downgrade a beta, and never pull or invoke Git', async t => {
  const f = await fixture(t, 'v1.3.0-beta.2');
  f.setReleases([candidate('v1.2.9'), candidate('v1.4.0-beta.1')]);
  assert.equal((await f.host.perform('check')).state, 'current');
  assert.equal(f.host.state.current, 'v1.3.0-beta.2');
  assert.equal(f.feedCalls.filter(c => c[0] === 'manifest').length, 0);
  f.setReleases([candidate('v1.3.0'), candidate('v1.4.0-beta.10')]);
  assert.equal((await f.host.perform('check')).latest, 'v1.3.0');
  await f.manager.configure({ ...DEFAULT_POLICY, channel: 'beta' });
  assert.equal(f.manager.candidate, undefined);
  assert.equal(f.host.state.latest, null);
  assert.equal((await f.host.perform('check')).latest, 'v1.4.0-beta.10');
  assert.deepEqual(f.commands, []);
  assert.equal(f.host.state.mode, 'release');
});

test('check skips incomplete and incompatible newer entries for the next complete compatible candidate', async t => {
  const f = await fixture(t);
  f.setReleases([
    candidate('v1.6.0', { minimumUpdaterVersion: '2.0.0' }),
    { ...candidate('v1.5.0'), error: 'update-release-incomplete' }, candidate('v1.3.0'),
  ]);
  const state = await f.host.perform('check');
  assert.equal(state.state, 'available');
  assert.equal(state.latest, 'v1.3.0');
  assert.deepEqual(f.commands, []);
});

test('all incomplete newer releases block instead of claiming the installation is current', async t => {
  const f = await fixture(t);
  f.setReleases(['v1.4.0', 'v1.3.0'].map(v => ({ ...candidate(v), error: 'update-release-incomplete' })));
  const state = await f.host.perform('check');
  assert.equal(state.error, 'update-release-incomplete');
  assert.equal(state.state, 'blocked');
  assert.equal(f.manager.candidate, undefined);
  assert.equal(state.current, 'v1.2.0');
  assert.deepEqual(f.commands, []);
});

test('signature and manifest failures abort candidate selection without falling back', async t => {
  const f = await fixture(t);
  for (const error of ['update-signature-invalid', 'update-manifest-invalid']) {
    f.feedCalls.length = 0;
    f.setReleases([{ ...candidate('v1.4.0'), error }, candidate('v1.3.0')]);
    assert.equal((await f.host.perform('check')).error, error);
    assert.equal(f.manager.candidate, undefined);
    assert.deepEqual(f.feedCalls.filter(c => c[0] === 'manifest'), [['manifest', 'v1.4.0']]);
  }
  assert.deepEqual(f.commands, []);
});

test('apply pins the checked candidate, backs up writers, and preserves user configuration', async t => {
  const f = await fixture(t);
  assert.equal((await f.host.perform('check')).state, 'available');
  const pinnedDigest = f.manager.candidate.digest;
  f.setReleases([candidate('v1.4.0')]);
  const result = await f.host.perform('apply');
  assert.equal(result.state, 'current');
  assert.equal(result.current, 'v1.3.0');
  assert.deepEqual(f.feedCalls.filter(c => c[0] === 'releases'), [['releases', 'stable']]);
  assert.deepEqual(f.feedCalls.filter(c => c[0] === 'manifest'), [['manifest', 'v1.3.0']]);
  assert.deepEqual(f.feedCalls.filter(c => c[0] === 'bundle'), [['bundle', 'v1.3.0']]);
  assert.equal(pinnedDigest, candidate('v1.3.0').digest);
  const current = await readJson(path.join(f.root, 'current.json'));
  const deployed = await readJson(current.compose);
  for (const name of f.previous.services) {
    assert.equal(deployed.services[name].image, `ghcr.io/fixture-owner/${name}@sha256:${'b'.repeat(64)}`);
    assert.equal(deployed.services[name].pull_policy, 'never');
    assert.equal(deployed.services[name].build, undefined);
  }
  assert.deepEqual(deployed.services.moa.ports, f.compose.services.moa.ports);
  assert.deepEqual(deployed.services.moa.volumes.slice(0,-1), f.compose.services.moa.volumes);
  assert.equal(deployed.services.moa.volumes.at(-1).target, '/downloads');
  assert.equal(deployed.services.moa.environment.MOA_DOWNLOAD_ROOT, '/downloads');
  assert.deepEqual(deployed.volumes[deployed.services.moa.volumes.at(-1).source], {});
  assert.equal(deployed.services.moa.environment.FIXTURE_LITERAL, 'cost$$5');
  assert.deepEqual(deployed.services['moa-source-browser'], f.compose.services['moa-source-browser']);
  assert.deepEqual(deployed.networks, f.compose.networks);
  const pulls = f.commands.filter(c => c[1] === 'pull');
  assert.equal(pulls.length, 2);
  assert.ok(pulls.every(c => c.includes('--platform') && c.at(-1).includes('@sha256:')));
  assert.ok(f.commands.every(c => !c.includes('down') && !c.includes('--volumes') && !c.includes('moa-source-browser')));
  const stopAt = f.commands.findIndex(c => c.includes('stop'));
  const backups = f.commands.map((c, i) => ({ c, i })).filter(({ c }) => c.includes('cp'));
  assert.equal(backups.length, 2);
  assert.ok(backups.every(({ i }) => i > stopAt));
  assert.ok(backups.every(({ i }) => i < f.commands.findIndex(c => c.includes('up'))));
  assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'complete');
  assert.equal((await readJson(path.join(f.root, 'history.json')))[0].outcome, 'complete');
  assert.equal(await optionalJson(path.join(f.dir, 'maintenance.json'), null), null);
  assert.equal(f.host.restartRequested, true);
});

test('pull failure leaves the installed pointer and running deployment intact', async t => {
  const f = await fixture(t);
  await f.host.perform('check'); f.faults.pull = true;
  const state = await f.host.perform('apply');
  assert.equal(state.state, 'failed');
  assert.deepEqual(await readJson(path.join(f.root, 'current.json')), f.previous);
  assert.ok(f.commands.every(c => !c.includes('stop') && !c.includes('cp') && !c.includes('up')));
  assert.equal(await optionalJson(path.join(f.root, 'journal.json'), null), null);
  assert.equal((await readJson(path.join(f.root, 'schedule.json'))).failedVersion, 'v1.3.0');
  assert.equal((await readJson(path.join(f.root, 'history.json')))[0].outcome, 'failed');
});

test('failed target health rolls back, releases maintenance, and suppresses automatic retry', async t => {
  const f = await fixture(t);
  await f.host.perform('check'); f.faults.targetHealth = true;
  assert.equal((await f.host.perform('apply')).state, 'rolled-back');
  assert.equal(f.host.state.error, 'update-rolled-back');
  assert.deepEqual(await readJson(path.join(f.root, 'current.json')), f.previous);
  assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'rolled-back');
  assert.equal((await readJson(path.join(f.root, 'history.json')))[0].outcome, 'rolled-back');
  assert.ok(f.phases.includes('rolling-back'));
  assert.ok(f.commands.some(c => c.includes(f.previous.compose) && c.includes('up')));
  assert.ok(f.commands.every(c => !c.includes('cp') || c.some(arg => arg.endsWith(':/data/.'))));
  assert.equal(await optionalJson(path.join(f.dir, 'maintenance.json'), null), null);
  f.manager.policy = DEFAULT_POLICY;
  f.manager.nextCheckAt = Date.now() + 3600000;
  const commandsBefore = f.commands.length;
  await f.manager.tick();
  assert.equal(f.commands.length, commandsBefore);
  assert.equal((await readJson(path.join(f.root, 'schedule.json'))).failedVersion, 'v1.3.0');
});

test('rollback failure requires recovery and prevents subsequent deployment attempts', async t => {
  const f = await fixture(t);
  await f.host.perform('check'); f.faults.targetHealth = true; f.faults.rollback = true;
  assert.equal((await f.host.perform('apply')).state, 'recovery-required');
  assert.equal(f.host.state.error, 'update-recovery-required');
  assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'rolling-back');
  assert.equal(await optionalJson(path.join(f.dir, 'maintenance.json'), null), null);
  const before = f.commands.length;
  assert.equal((await f.host.perform('apply')).state, 'recovery-required');
  await f.manager.tick();
  assert.equal(f.commands.length, before);
});

test('a fresh updater recovers an interrupted journal and persists the failed target', async t => {
  const f = await fixture(t);
  const target = { ...f.previous, version: 'v1.3.0', compose: path.join(f.root, 'interrupted-compose.json') };
  await atomic(path.join(f.root, 'journal.json'), { phase: 'applying', previous: f.previous, target, gateway: true });
  const rebooted = new Updater({ cwd: f.cwd, dir: f.dir, mode: 'release', run: f.host.run });
  await rebooted.release.init();
  assert.equal(rebooted.state.state, 'rolled-back');
  assert.equal(rebooted.state.current, f.previous.version);
  assert.equal(rebooted.release.failedVersion, target.version);
  assert.deepEqual(await readJson(path.join(f.root, 'current.json')), f.previous);
  assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'rolled-back');
  assert.equal((await readJson(path.join(f.root, 'schedule.json'))).failedVersion, target.version);
  assert.ok(f.commands.every(c => !c.includes('pull') && !c.includes('stop') && !c.includes('cp')));
  const before = f.commands.length;
  const again = new Updater({ cwd: f.cwd, dir: f.dir, mode: 'release', run: f.host.run });
  await again.release.init();
  assert.equal(f.commands.length, before, 'terminal journals must not replay rollback');
});

test('unrecognized interrupted journal phases fail closed without host commands', async t => {
  const f = await fixture(t);
  await atomic(path.join(f.root, 'journal.json'), { phase: 'unknown-phase', previous: f.previous, target: { version: 'v1.3.0' } });
  const rebooted = new Updater({ cwd: f.cwd, dir: f.dir, mode: 'release', run: f.host.run });
  await rebooted.release.init();
  assert.equal(rebooted.state.state, 'recovery-required');
  assert.deepEqual(f.commands, []);
});

test('background ticks check every six hours but never apply an available release', async t => {
  const f = await fixture(t);
  await f.manager.tick();
  assert.equal(f.host.state.state, 'available');
  assert.deepEqual(f.commands, []);
  assert.ok(f.manager.nextCheckAt > Date.now() + 5 * 3600000);
  const count = f.feedCalls.length;
  await f.manager.tick();
  assert.equal(f.feedCalls.length, count);
  f.manager.nextCheckAt = 0;
  await f.manager.tick();
  assert.ok(f.feedCalls.length > count);
  assert.deepEqual(f.commands, []);
  await assert.rejects(f.manager.configure({ channel: 'stable', autoApply: true }), /update-invalid-policy/);
});

test('a release upgrade retains enabled runtimes and disabled runtime connections', async t => {
  const f = await fixture(t);
  f.previous.services.push('moa-apk');
  f.previous.componentConnections = {browser:{url:'http://moa-source-browser:8799',secret:'/run/custom/token'}};
  f.compose.services['moa-apk'] = {image:'fixture-old-apk',volumes:['fixture-apk-data:/data']};
  f.compose.services.moa.environment.MOA_APK_URL = 'http://moa-apk:8797';
  f.compose.services.moa.environment.MOA_SOURCE_BROWSER_URL = '';
  await atomic(f.previous.compose,f.compose);
  f.manager.current = f.previous;
  await atomic(path.join(f.root,'current.json'),f.previous);
  await f.host.perform('check');
  assert.equal((await f.host.perform('apply')).state,'current');
  assert.deepEqual(f.manager.current.services,f.previous.services);
  assert.deepEqual(f.manager.current.componentConnections,f.previous.componentConnections);
  const deployed=await readJson(f.manager.current.compose);
  assert.equal(deployed.services['moa-apk'].image,`ghcr.io/fixture-owner/moa-apk@sha256:${'b'.repeat(64)}`);
  assert.deepEqual(deployed.services['moa-source-browser'],f.compose.services['moa-source-browser']);
  assert.equal(deployed.services.moa.environment.MOA_SOURCE_BROWSER_URL,'');
});
