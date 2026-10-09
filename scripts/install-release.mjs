import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFeed, SERVICES, DEFAULT_POLICY, UPDATER_VERSION, version, compare, fail } from './release.mjs';
import { stageBundle } from './release-bundle.mjs';
import { atomic, privateDirectory } from './update-files.mjs';
const exec = promisify(execFile);
const jsonLines = text => text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map(JSON.parse);

export async function startUpdater(unitPath, run) {
  try {
    const existing = (await run('systemctl', ['--user', 'show', path.basename(unitPath), '--property=FragmentPath', '--value'], 10000)).trim();
    if (existing && path.resolve(existing) !== path.resolve(unitPath)) return { started: false, error: 'update-service-conflict' };
    await run('systemctl', ['--user', 'enable', '--now', unitPath], 30000);
    await run('systemctl', ['--user', 'is-active', '--quiet', path.basename(unitPath)], 10000);
    return { started: true, error: null };
  } catch { return { started: false, error: 'updater-unavailable' }; }
}

export async function install(args = process.argv.slice(2), dependencies = {}) {
  const [action, ...flags] = args;
  if (action !== 'install' || flags.length % 2) fail('update-invalid-options');
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--cwd', '--version', '--key', '--browser', '--project'].includes(flags[i]) || flags[i + 1] === undefined) fail('update-invalid-options');
    options[flags[i].slice(2)] = flags[i + 1];
  }
  if (!options.cwd || !options.version || !options.key || options.browser && !['true', 'false'].includes(options.browser)) fail('update-invalid-options');
  version(options.version);
  if (Number(process.versions.node.split('.')[0]) < 22 || process.platform !== 'linux') fail('update-runtime-required');
  const cwd = path.resolve(options.cwd), root = path.join(cwd, '.moa-release');
  const publicKey = await readFile(path.resolve(options.key), 'utf8');
  const feed = dependencies.feed ?? new ReleaseFeed({ publicKey });
  const release = (await feed.releases('beta')).find(r => r.tag_name === options.version);
  if (!release) fail('update-no-releases');
  const { manifest: m } = await feed.manifest(release);
  if (compare(UPDATER_VERSION, m.minimumUpdaterVersion) < 0) fail('update-tool-required');
  const run = dependencies.run ?? (async (command, argv, timeout = 120000) => (await exec(command, argv, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim());
  const platform = process.arch === 'x64' ? 'linux/amd64' : process.arch === 'arm64' ? 'linux/arm64' : fail('update-platform-unsupported');
  let config, services;
  await mkdir(cwd, { recursive: true });
  try { await access(path.join(root, 'installation.json')); fail('update-already-installed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await privateDirectory(root);
  const runtime = path.join(root, 'releases', m.version);
  await privateDirectory(runtime);
  await stageBundle(await feed.bundle(m), runtime);
  const shared = path.join(cwd, 'data/updater');
  await mkdir(shared, { recursive: true, mode: 0o770 }); await chmod(shared, 0o770);
  const project = options.project || 'moa';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail('update-invalid-options');
  {
    // A fresh folder only. Existing user .env is preserved; existing deployments keep their current updater.
    if ((await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim()) fail('update-already-installed');
    try { await copyFile(path.join(runtime, '.env.example'), path.join(cwd, '.env'), 1); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const files = ['-f', path.join(runtime, 'compose.yaml')];
    if (options.browser === 'true') files.push('-f', path.join(runtime, 'compose.source-browser.yaml'));
    config = JSON.parse(await run('docker', ['compose', '--project-name', project, '--project-directory', cwd, ...files, 'config', '--format', 'json']));
    services = SERVICES.filter(n => config.services[n] && !config.services[n].profiles?.length);
    for (const mount of config.services['moa-gateway']?.volumes ?? []) if (mount.target === '/etc/nginx/templates/default.conf.template') mount.source = path.join(runtime, 'deploy/gateway/default.conf.template');
  }
  await atomic(path.join(root, 'original-compose.json'), config);
  for (const name of services) {
    if (!m.services[name].platforms.includes(platform)) fail('update-platform-unsupported');
    config.services[name].image = `${m.services[name].image}@${m.services[name].digest}`;
    delete config.services[name].build; config.services[name].pull_policy = 'never';
  }
  for (const name of services) {
    const env = config.services[name].environment ?? {};
    if ((name === 'moa' && env.MOA_DATA_DIR && env.MOA_DATA_DIR !== '/data') || (name === 'moa-auth' && env.DATA_DIR && env.DATA_DIR !== '/data')) fail('update-layout-unsupported');
  }
  const app = config.services.moa;
  app.environment = { ...app.environment, MOA_DEPLOYMENT: 'release', MOA_VERSION: m.version, MOA_UPDATER_DIR: '/run/moa-updater' };
  app.group_add = [...new Set([...(app.group_add ?? []), String(process.getgid())])];
  app.volumes = [...(app.volumes ?? []).filter(v => v.target !== '/run/moa-updater'), { type: 'bind', source: shared, target: '/run/moa-updater' }];
  // Preserve the original resolved deployment; no environment or user override is overwritten.
  const compose = path.join(runtime, 'compose.json');
  await atomic(compose, config);
  await writeFile(path.join(root, 'trusted-key.pem'), publicKey, { mode: 0o600 });
  await copyFile(path.join(runtime, 'scripts/update-launcher.mjs'), path.join(root, 'launcher.mjs'));
  const argv = ['compose', '--project-name', project, '--project-directory', cwd, '-f', compose];
  const composeVersion = await run('docker', ['compose', 'version', '--short']);
  if (compare(composeVersion, m.minimumComposeVersion) < 0) fail('update-compose-required');
  await run('docker', [...argv, 'config', '--quiet']);
  for (const name of services) await run('docker', ['pull', '--platform', platform, config.services[name].image], 20 * 60000);
  if (action === 'install') for (const [name, service] of Object.entries(config.services)) {
    if (!services.includes(name) && !service.profiles?.length && service.image) await run('docker', ['pull', '--platform', platform, service.image], 20 * 60000);
  }
  await run('docker', [...argv, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180'], 300000);
  await atomic(path.join(root, 'installation.json'), { format: 1, repository: 'sidetool/moa', project, platform });
  await atomic(path.join(root, 'current.json'), { version: m.version, schemaEpoch: m.schemaEpoch, services, compose, runtime });
  await atomic(path.join(root, 'policy.json'), DEFAULT_POLICY);
  const quote = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const unit = `[Unit]\nDescription=MOA release updater\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(cwd)}\nExecStart=${quote(process.execPath)} ${quote(path.join(root, 'launcher.mjs'))} --cwd ${quote(cwd)}\nRestart=on-failure\nRestartSec=10\nUMask=0007\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(path.join(cwd, 'moa-updater.service'), unit, { mode: 0o600 });
  const updater = await startUpdater(path.join(cwd, 'moa-updater.service'), run);
  process.stdout.write(updater.started ? 'Release installed. Update service started; updates are available in Settings > About.\n' : `Release installed. Update service could not start (${updater.error}); release checks are available, but installation from the app is unavailable.\n`);
  return updater;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) install().catch(error => {
  process.stderr.write(`${/^update-[a-z-]+$/.test(error.message) ? error.message : 'update-install-failed'}\n`); process.exitCode = 1;
});
