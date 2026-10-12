import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, chown, mkdir, readFile, writeFile, copyFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFeed, SERVICES, version, fail } from './release.mjs';
import { atomic, composeJSON, privateDirectory } from './update-files.mjs';
import { stageBundle } from './release-bundle.mjs';

const exec = promisify(execFile);
export async function adopt({ cwd = '/state', installation = '/installation', hostname = process.env.HOSTNAME, run = async (args) => (await exec('docker', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(), feed } = {}) {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(installation)) fail('update-layout-unsupported');
  const root = path.join(cwd, '.moa-release');
  try { await access(path.join(root, 'current.json')); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!hostname || !/^[a-zA-Z0-9_.-]+$/.test(hostname)) fail('update-not-installed');
  const parse = value => { try { return JSON.parse(value); } catch { fail('update-layout-unsupported'); } };
  const inspected = parse(await run(['inspect', hostname]));
  if (!Array.isArray(inspected) || inspected.length !== 1) fail('update-layout-unsupported');
  const [self] = inspected;
  const labels = self?.Config?.Labels ?? {}, project = labels['com.docker.compose.project'], hostDirectory = labels['com.docker.compose.project.working_dir'];
  const configFiles = labels['com.docker.compose.project.config_files'];
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(project) || typeof hostDirectory !== 'string' || !path.isAbsolute(hostDirectory) || typeof configFiles !== 'string' || !configFiles) fail('update-layout-unsupported');
  const files = configFiles.split(',').map(file => {
    if (!path.isAbsolute(file)) fail('update-layout-unsupported');
    const relative = path.relative(hostDirectory, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('update-layout-unsupported');
    return path.join(installation, relative);
  });
  const args = ['compose', '--project-name', project, '--project-directory', installation, ...files.flatMap(file => ['-f', file])];
  const config = parse(await run([...args, 'config', '--format', 'json']));
  if (!config || !config.services || typeof config.services !== 'object' || Array.isArray(config.services)) fail('update-layout-unsupported');
  for (const service of Object.values(config.services)) if (!service || typeof service !== 'object' || service.volumes !== undefined && (!Array.isArray(service.volumes) || service.volumes.some(mount => !mount || typeof mount !== 'object')) || service.environment !== undefined && (!service.environment || typeof service.environment !== 'object' || Array.isArray(service.environment))) fail('update-layout-unsupported');
  if (config.volumes !== undefined && (!config.volumes || typeof config.volumes !== 'object' || Array.isArray(config.volumes))) fail('update-layout-unsupported');
  const ids = (await run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/).filter(Boolean);
  if (!ids.length) fail('update-not-installed');
  const containers = parse(await run(['inspect', ...ids]));
  if (!Array.isArray(containers)) fail('update-layout-unsupported');
  const active = new Map();
  for (const container of containers.filter(c => c?.State?.Running)) {
    const name = container.Config?.Labels?.['com.docker.compose.service'];
    if (!name || active.has(name) || container.Config.Labels['com.docker.compose.project'] !== project || !Array.isArray(container.Config.Env) || container.Config.Env.some(value => typeof value !== 'string' || value.indexOf('=') < 1) || !Array.isArray(container.Mounts)) fail('update-layout-unsupported');
    active.set(name, container);
  }
  const app = active.get('moa');
  if (!app) fail('update-not-installed');
  const env = Object.fromEntries(app.Config.Env.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
  const currentVersion = env.MOA_VERSION || app.Config.Labels['org.opencontainers.image.version'];
  version(currentVersion);
  const trust = JSON.parse(await readFile(new URL('../deploy/release-trust.json', import.meta.url), 'utf8'));
  feed ??= new ReleaseFeed({ repository: env.MOA_REPOSITORY || 'sidetool/moa', publicKey: trust.publicKey });
  const release = (await feed.releases('beta')).find(item => item.tag_name === currentVersion);
  if (!release) fail('update-version-unknown');
  const { manifest } = await feed.manifest(release);
  if (manifest.version !== currentVersion) fail('update-version-unknown');
  const platform = `linux/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const services = SERVICES.filter(name => active.has(name) && config.services[name]);
  for (const name of services) {
    if (!manifest.services[name]?.platforms.includes(platform)) fail('update-platform-unsupported');
    const container = active.get(name), service = config.services[name];
    const runningEnv = Object.fromEntries(container.Config.Env.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
    if (['moa', 'moa-auth', 'moa-apk', 'moa-connector'].includes(name) && !container.Mounts.some(mount => mount.Destination === '/data') || name === 'moa' && runningEnv.MOA_DATA_DIR && runningEnv.MOA_DATA_DIR !== '/data' || name === 'moa-auth' && runningEnv.DATA_DIR && runningEnv.DATA_DIR !== '/data') fail('update-layout-unsupported');
    service.image = container.Config.Image; service.pull_policy = 'never'; delete service.build;
  }
  for (const [name, service] of Object.entries(config.services)) {
    const container = active.get(name);
    if (container) {
      const runningEnv = Object.fromEntries(container.Config.Env.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
      service.environment = composeJSON(Object.fromEntries(Object.keys(service.environment ?? {}).filter(key => Object.hasOwn(runningEnv, key)).map(key => [key, runningEnv[key]])));
    }
    for (const mount of service.volumes ?? []) {
      if (!mount || typeof mount !== 'object' || !['bind', 'volume', 'tmpfs'].includes(mount.type) || typeof mount.target !== 'string' || !path.isAbsolute(mount.target)) fail('update-layout-unsupported');
      if (mount.type === 'bind') {
        if (typeof mount.source !== 'string') fail('update-layout-unsupported');
        if (mount.source === installation || mount.source.startsWith(installation + '/')) mount.source = composeJSON(hostDirectory) + mount.source.slice(installation.length);
      }
    }
    for (const actual of container?.Mounts ?? []) {
      if (!['bind', 'volume', 'tmpfs'].includes(actual.Type) || typeof actual.Destination !== 'string' || !path.isAbsolute(actual.Destination)) fail('update-layout-unsupported');
      let mount = service.volumes?.find(value => value.target === actual.Destination);
      if (!mount) {
        if (actual.Type === 'tmpfs') continue;
        service.volumes ??= [];
        mount = { target: actual.Destination }; service.volumes.push(mount);
      }
      mount.type = actual.Type; mount.read_only = actual.RW === false;
      if (actual.Type === 'volume') {
        if (typeof actual.Name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(actual.Name)) fail('update-layout-unsupported');
        mount.source = actual.Name; delete mount.bind;
        config.volumes ??= {}; config.volumes[actual.Name] = { name: actual.Name, external: true };
      } else if (actual.Type === 'bind') {
        if (typeof actual.Source !== 'string' || !path.isAbsolute(actual.Source)) fail('update-layout-unsupported');
        mount.source = composeJSON(actual.Source); delete mount.volume;
      }
    }
  }
  if (typeof app.Id !== 'string' || !/^[a-f0-9]{64}$/.test(app.Id)) fail('update-layout-unsupported');
  let channel = currentVersion.includes('-beta.') ? 'beta' : 'stable';
  try {
    const selected = await run(['exec', app.Id, 'node', '-e', "try { const p = JSON.parse(require('node:fs').readFileSync('/data/update-policy.json', 'utf8')); if (!p || Object.keys(p).join() !== 'channel' || !['stable', 'beta'].includes(p.channel)) process.exit(1); process.stdout.write(p.channel); } catch (error) { if (error.code !== 'ENOENT') process.exit(1); }"]);
    if (selected) { if (!['stable', 'beta'].includes(selected)) fail('update-invalid-policy'); channel = selected; }
  } catch { fail('update-invalid-policy'); }
  await privateDirectory(root);
  const runtime = path.join(root, 'releases', currentVersion);
  await privateDirectory(runtime);
  await stageBundle(await feed.bundle(manifest), runtime);
  const compose = path.join(runtime, 'compose.json');
  await atomic(compose, config);
  await writeFile(path.join(root, 'trusted-key.pem'), trust.publicKey, { mode: 0o600 });
  await copyFile(new URL('./update-launcher.mjs', import.meta.url), path.join(root, 'launcher.mjs'));
  await atomic(path.join(root, 'installation.json'), { format: 1, repository: feed.repository, project, platform });
  await atomic(path.join(root, 'policy.json'), { channel });
  await atomic(path.join(root, 'current.json'), { version: currentVersion, schemaEpoch: manifest.schemaEpoch, services, compose, runtime });
}

async function main() {
  const cwd = '/state', dir = path.join(cwd, 'data/updater');
  await mkdir(dir, { recursive: true }); await chmod(dir, 0o770); await chown(dir, 0, 1000);
  await rm(path.join(dir, 'agent.lock'), { force: true });
  try { await adopt(); }
  catch (error) {
    const code = /^update-[a-z-]+$/.test(error.message) ? error.message : 'update-not-installed';
    await atomic(path.join(dir, 'status.json'), { configured: true, connected: true, heartbeat: Date.now(), mode: 'release', state: 'blocked', error: code, current: 'unknown' }, 0o640);
    throw new Error(code);
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(cwd, '.moa-release/launcher.mjs'), '--cwd', cwd], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
