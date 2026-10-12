import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { adopt } from './container-updater.mjs';
import { BUNDLE_FILES } from './release-bundle.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'moa-container-updater-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, '.moa-release'), installation = '/installation', hostDirectory = '/srv/moa $safe', project = 'moa-fixture';
  const labels = { 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': hostDirectory, 'com.docker.compose.project.config_files': `${hostDirectory}/compose.yaml,${hostDirectory}/overrides/local.yaml` };
  const self = { Config: { Labels: labels } };
  const config = { name: project, services: {
    moa: { image: 'ghcr.io/sidetool/moa:latest', build: { context: installation }, environment: { TOKEN: 'stale$$token', MOA_REQUIRE_ACCOUNT: '1' }, volumes: [{ type: 'volume', source: 'moa-data', target: '/data' }, { type: 'bind', source: '/installation/media', target: '/media/library', read_only: true }] },
    'moa-auth': { image: 'ghcr.io/sidetool/moa-auth:latest', environment: { PUBLIC_ORIGIN: '' }, volumes: [{ type: 'bind', source: '/installation/data/auth', target: '/data', bind: { create_host_path: true } }] },
    'moa-gateway': { image: 'nginx:1.27-alpine', environment: { GATEWAY_CLIENT_IP: '$$remote_addr', FILTER: '^PUBLIC$$' }, volumes: [{ type: 'bind', source: '/installation/deploy/gateway/default.conf.template', target: '/etc/nginx/templates/default.conf.template' }] },
    'moa-source-browser': { image: 'browser:disabled', profiles: ['browser'], environment: { LITERAL: '$$untouched' }, volumes: [{ type: 'bind', source: '/installation/browser/cache$$key', target: '/cache' }] },
  }, volumes: { 'moa-data': {} }, networks: { default: { name: 'existing-network' } } };
  const container = (name, env, mounts) => ({ Id: Buffer.from(name).toString('hex').padEnd(64, '0'), Config: { Image: `ghcr.io/sidetool/${name}:v0.1.2-beta.2`, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': name }, Env: env }, Mounts: mounts, State: { Running: true } });
  const containers = [
    container('moa', ['MOA_VERSION=v0.1.2-beta.2', 'TOKEN=secret$literal=value', 'MOA_REQUIRE_ACCOUNT=1'], [{ Type: 'bind', Source: '/storage/live$data', Destination: '/data', RW: true }, { Type: 'bind', Source: '/media/existing', Destination: '/media/library', RW: false }, { Type: 'volume', Name: 'existing_extra', Destination: '/custom', RW: false }]),
    container('moa-auth', ['PUBLIC_ORIGIN=https://watch.example'], [{ Type: 'volume', Name: 'existing_auth', Destination: '/data', RW: true }]),
    container('moa-gateway', ['GATEWAY_CLIENT_IP=$remote_addr', 'FILTER=^PUBLIC$'], [{ Type: 'bind', Source: `${hostDirectory}/deploy/gateway/default.conf.template`, Destination: '/etc/nginx/templates/default.conf.template', RW: false }]),
  ];
  const calls = [], feedCalls = [], preference = {};
  const manifest = { version: 'v0.1.2-beta.2', schemaEpoch: 1, services: Object.fromEntries(['moa', 'moa-auth'].map(name => [name, { platforms: ['linux/amd64', 'linux/arm64'] }])) };
  const feed = { repository: 'sidetool/moa', async releases(channel) { feedCalls.push(['releases', channel]); return [{ tag_name: manifest.version }]; }, async manifest(release) { feedCalls.push(['manifest', release.tag_name]); return { manifest }; }, async bundle() { feedCalls.push(['bundle']); return { format: 1, files: Object.fromEntries(BUNDLE_FILES.map(file => [file, 'fixture'])) }; } };
  const run = async args => {
    calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify(args[1] === 'updater-host' ? [self] : containers);
    if (args[0] === 'compose') { assert.deepEqual(args, ['compose', '--project-name', project, '--project-directory', installation, '-f', '/installation/compose.yaml', '-f', '/installation/overrides/local.yaml', 'config', '--format', 'json']); return JSON.stringify(config); }
    if (args[0] === 'ps') return containers.map((_, index) => `container-${index}`).join('\n');
    if (args[0] === 'exec') {
      assert.deepEqual(args.slice(0, 4), ['exec', containers[0].Id, 'node', '-e']);
      let output = '';
      runInNewContext(args[4], {
        require: name => { assert.equal(name, 'node:fs'); return { readFileSync: (file, encoding) => {
          assert.equal(file, '/data/update-policy.json'); assert.equal(encoding, 'utf8');
          if (preference.content === undefined) throw Object.assign(new Error(), { code: 'ENOENT' });
          return preference.content;
        } }; },
        process: { stdout: { write: value => { output += value; } }, exit: () => { throw new Error('Read failed'); } },
      });
      return output;
    }
    throw new Error('Unexpected mutation');
  };
  return { cwd, root, config, self, containers, calls, feedCalls, manifest, feed, preference, options: { cwd, installation, hostname: 'updater-host', run, feed } };
}

test('container adoption preserves running mounts, Compose scope, literal dollars and permissions without deployment', async t => {
  const f = await fixture(t);
  await adopt(f.options);
  const current = JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8'));
  const config = JSON.parse(await readFile(current.compose, 'utf8'));
  assert.deepEqual(current.services, ['moa', 'moa-auth']);
  assert.equal(current.version, 'v0.1.2-beta.2');
  assert.equal(config.services.moa.image, f.containers[0].Config.Image);
  assert.equal(config.services.moa.build, undefined);
  assert.equal(config.services.moa.pull_policy, 'never');
  assert.equal(config.services.moa.environment.TOKEN, 'secret$$literal=value');
  assert.equal(config.services.moa.environment.MOA_VERSION, undefined);
  assert.deepEqual(config.services['moa-gateway'].environment, { GATEWAY_CLIENT_IP: '$$remote_addr', FILTER: '^PUBLIC$$' });
  assert.equal(config.services['moa-source-browser'].environment.LITERAL, '$$untouched');
  assert.equal(config.services['moa-source-browser'].volumes[0].source, '/srv/moa $$safe/browser/cache$$key');
  assert.deepEqual(config.services.moa.volumes, [
    { type: 'bind', source: '/storage/live$$data', target: '/data', read_only: false },
    { type: 'bind', source: '/media/existing', target: '/media/library', read_only: true },
    { type: 'volume', source: 'existing_extra', target: '/custom', read_only: true },
  ]);
  assert.deepEqual(config.services['moa-auth'].volumes, [{ type: 'volume', source: 'existing_auth', target: '/data', read_only: false }]);
  assert.deepEqual(config.volumes.existing_auth, { name: 'existing_auth', external: true });
  assert.deepEqual(config.volumes.existing_extra, { name: 'existing_extra', external: true });
  assert.deepEqual(config.networks, f.config.networks);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'policy.json'), 'utf8')), { channel: 'beta' });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'installation.json'), 'utf8')), { format: 1, repository: 'sidetool/moa', project: 'moa-fixture', platform: `linux/${process.arch === 'x64' ? 'amd64' : process.arch}` });
  assert.ok(f.calls.every(args => ['inspect', 'compose', 'ps', 'exec'].includes(args[0])));
  assert.deepEqual(f.feedCalls, [['releases', 'beta'], ['manifest', 'v0.1.2-beta.2'], ['bundle']]);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(current.compose)).mode & 0o777, 0o600);
  for (const file of await readdir(f.root)) if (file.endsWith('.json')) assert.ok(!(await readFile(path.join(f.root, file), 'utf8')).includes('secret'));
});

test('container adoption resumes existing release state without Docker requests or reseeding', async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  const current = '{"version":"v0.1.9","runtime":"preserved"}';
  await writeFile(path.join(f.root, 'current.json'), current);
  await writeFile(path.join(f.root, 'policy.json'), '{"channel":"stable"}');
  await adopt({ ...f.options, hostname: undefined, run: async () => { throw new Error('Must not inspect again'); } });
  assert.equal(await readFile(path.join(f.root, 'current.json'), 'utf8'), current);
  assert.equal(await readFile(path.join(f.root, 'policy.json'), 'utf8'), '{"channel":"stable"}');
  assert.deepEqual(f.feedCalls, []);
});

test('container adoption preserves offline release channels and rejects invalid policy data', async t => {
  for (const channel of ['stable', 'beta']) {
    const f = await fixture(t);
    f.preference.content = JSON.stringify({ channel });
    await adopt(f.options);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'policy.json'), 'utf8')), { channel });
  }
  for (const content of ['SECRET', 'null', '{}', '{"channel":"nightly"}', '{"channel":"stable","secret":"hidden"}']) {
    const f = await fixture(t);
    f.preference.content = content;
    await assert.rejects(adopt(f.options), error => error.message === 'update-invalid-policy');
    await assert.rejects(readFile(path.join(f.root, 'current.json')), { code: 'ENOENT' });
  }
});

test('container adoption rejects unsupported layouts and malformed metadata before writing a current release', async t => {
  const patches = [
    f => delete f.self.Config.Labels['com.docker.compose.project'],
    f => f.self.Config.Labels['com.docker.compose.project'] = '../escape',
    f => f.self.Config.Labels['com.docker.compose.project.working_dir'] = 'relative',
    f => delete f.self.Config.Labels['com.docker.compose.project.config_files'],
    f => f.self.Config.Labels['com.docker.compose.project.config_files'] = '/elsewhere/compose.yaml',
    f => f.self.Config.Labels['com.docker.compose.project.config_files'] = '/srv/moa $safe/../compose.yaml',
    f => f.self.Config.Labels['com.docker.compose.project.config_files'] = 'compose.yaml',
    f => f.config.services = [],
    f => f.config.services.moa = null,
    f => f.config.services.moa.volumes = 'moa-data:/data',
    f => f.config.services.moa.volumes[0].target = '../data',
    f => f.config.services.moa.environment = [],
    f => f.config.volumes = [],
    f => f.containers.push(structuredClone(f.containers[0])),
    f => f.containers[0].Config.Env = ['MALFORMED'],
    f => f.containers[0].Id = '--privileged',
    f => f.containers[0].Mounts = [],
    f => f.containers[0].Config.Env.push('MOA_DATA_DIR=/unbacked-data'),
    f => f.containers[1].Config.Env.push('DATA_DIR=/unbacked-auth'),
    f => f.containers[0].Config.Labels['com.docker.compose.project'] = 'different-project',
    f => f.containers[1].Mounts[0].Name = '../volume',
    f => f.containers[0].Mounts[0].Source = 'relative/data',
    f => f.options.run = async () => '{"SECRET":"unparseable',
  ];
  for (const patch of patches) {
    const f = await fixture(t); patch(f);
    await assert.rejects(adopt(f.options), error => error.message === 'update-layout-unsupported');
    await assert.rejects(readFile(path.join(f.root, 'current.json')), { code: 'ENOENT' });
  }
});

test('container adoption requires an available signed-release identity and compatible platform', async t => {
  const unknown = await fixture(t);
  unknown.feed.releases = async () => [];
  await assert.rejects(adopt(unknown.options), /update-version-unknown/);
  const unsupported = await fixture(t);
  unsupported.manifest.services.moa.platforms = [];
  await assert.rejects(adopt(unsupported.options), /update-platform-unsupported/);
  const mismatch = await fixture(t);
  mismatch.feed.manifest = async () => ({ manifest: { ...mismatch.manifest, version: 'v9.0.0' } });
  await assert.rejects(adopt(mismatch.options), /update-version-unknown/);
});
