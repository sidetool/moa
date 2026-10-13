import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ReleaseUpdater } from './release-updater.mjs';
import { policy, UPDATER_VERSION } from './release.mjs';

const exec = promisify(execFile);
const blank = () => ({ configured: true, connected: true, state: 'idle', mode: null, current: 'unknown', latest: null, branch: null, behind: 0, ahead: 0, checkedAt: null, error: null });
const fail = code => { throw new Error(code); };
const errors = new Set(['update-dirty', 'update-diverged', 'update-deployment-diverged', 'update-version-unknown', 'update-no-upstream', 'update-not-installed', 'update-git-failed', 'update-docker-failed', 'update-build-failed', 'update-restart-failed', 'update-busy', 'update-request-invalid', 'update-invalid-options']);
for (const code of ['manifest-invalid','signature-invalid','invalid-version','invalid-policy','download-invalid','download-failed','rate-limited','response-limit','feed-truncated','release-incomplete','bundle-invalid','release-mutated','state-invalid','migration-required','platform-unsupported','tool-required','compose-required','no-releases','space-required','backup-unavailable','app-busy','health-failed','lease-lost','recovery-required','rolled-back','component-external','components-unsupported','layout-unsupported']) errors.add(`update-${code}`);
const publicError = error => errors.has(error?.message) ? error.message : 'update-failed';
const jsonLines = text => text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const atomic = async (file, value, mode) => {
  const temp = `${file}-${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode, flag: 'wx' });
  try { await rename(temp, file); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
};

export class Updater {
  constructor({ cwd = process.cwd(), dir = path.join(cwd, 'data/updater'), mode = 'auto', service = process.env.MOA_UPDATE_SERVICE, run } = {}) {
    if (!['auto', 'source', 'release', 'git', 'docker'].includes(mode) || service && !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(service)) fail('update-invalid-options');
    this.cwd = path.resolve(cwd);
    this.dir = path.resolve(dir);
    this.mode = mode === 'source' ? 'auto' : mode;
    this.sourceOnly = mode === 'source';
    if (mode === 'release') this.release = new ReleaseUpdater(this);
    this.service = service;
    this.run = run || (async (command, args, timeout = 120000) => (await exec(command, args, { cwd: this.cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim());
    this.state = blank();
    this.nextCheckAt = 0;
  }
  async persist() {
    await mkdir(this.dir, { recursive: true, mode: 0o770 });
    const snapshot = { ...this.state, heartbeat: Date.now() };
    this.persisting = (this.persisting ?? Promise.resolve()).catch(() => {}).then(() => atomic(path.join(this.dir, 'status.json'), snapshot, 0o640));
    await this.persisting;
  }
  async git(args) { try { return await this.run('git', args); } catch { fail('update-git-failed'); } }
  async docker(args, timeout) { try { return await this.run('docker', ['compose', ...args], timeout); } catch { fail('update-docker-failed'); } }
  async installation() {
    let git = false;
    try { git = await this.run('git', ['rev-parse', '--show-toplevel']) === await realpath(this.cwd); } catch {}
    let docker = this.mode === 'docker';
    if (this.mode === 'auto') {
      try { docker = Boolean(await this.run('docker', ['compose', 'ps', '--quiet', 'moa'])); } catch {}
    }
    if (this.mode === 'git') docker = false;
    if (this.sourceOnly && !git) fail('update-not-installed');
    if (!git && !docker) fail('update-not-installed');
    this.state.mode = docker ? 'docker' : 'git';
    return { git, docker };
  }
  async source() {
    let branch, remote, ref;
    try {
      branch = await this.run('git', ['symbolic-ref', '--short', 'HEAD']);
      remote = await this.run('git', ['config', `branch.${branch}.remote`]);
      ref = await this.run('git', ['config', `branch.${branch}.merge`]);
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(remote) || !ref.startsWith('refs/heads/')) fail('update-no-upstream');
      await this.run('git', ['check-ref-format', ref]);
    } catch { fail('update-no-upstream'); }
    const current = await this.git(['rev-parse', '--verify', 'HEAD']);
    await this.git(['fetch', '--no-tags', remote, ref]);
    const latest = await this.git(['rev-parse', '--verify', 'FETCH_HEAD']);
    const [ahead, behind] = (await this.git(['rev-list', '--left-right', '--count', `${current}...${latest}`])).split(/\s+/).map(Number);
    Object.assign(this.state, { current, latest, branch, ahead, behind });
    if (ahead && behind) fail('update-diverged');
    let pending;
    try {
      const file = path.join(this.dir, 'pending.json');
      const info = await lstat(file);
      if (!info.isFile() || info.size > 1024) fail('update-request-invalid');
      pending = JSON.parse(await readFile(file, 'utf8'));
      if (!/^[a-f0-9]{40}$/.test(pending.revision) || !/^(?:[a-f0-9]{40}|unknown)$/.test(pending.current)) fail('update-request-invalid');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.needsBuild = Boolean(pending && pending.revision === current);
    if (this.needsBuild) this.state.current = pending.current;
    if (this.state.mode === 'docker') {
      const id = await this.docker(['ps', '--quiet', 'moa']);
      if (id) {
        let revision;
        try { revision = await this.run('docker', ['inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', id]); }
        catch { fail('update-docker-failed'); }
        this.state.current = /^[a-f0-9]{40}$/.test(revision) ? revision : 'unknown';
        if (this.state.current === 'unknown') fail('update-version-unknown');
        try { await this.run('git', ['merge-base', '--is-ancestor', revision, behind ? latest : current]); }
        catch { fail('update-deployment-diverged'); }
        this.needsBuild ||= revision !== current;
      }
    }
    if ((behind || this.needsBuild) && await this.git(['status', '--porcelain', '--untracked-files=no'])) fail('update-dirty');
    if (this.needsBuild && !behind) this.state.latest = current;
    return behind > 0 || this.needsBuild;
  }
  async images() {
    const config = JSON.parse(await this.docker(['config', '--format', 'json']));
    const containers = jsonLines(await this.docker(['ps', '--format', 'json']));
    const services = Object.keys(config.services).filter(name => /^moa(?:-auth|-apk|-connector)?$/.test(name) && (!config.services[name].profiles?.length || containers.some(value => value.Service === name)));
    if (!services.includes('moa') || services.some(name => !config.services[name].image)) fail('update-not-installed');
    const current = [], latest = [];
    for (const name of services) {
      const container = containers.find(value => value.Service === name);
      let imageId = '';
      if (container) {
        try { imageId = await this.run('docker', ['inspect', '--format', '{{.Image}}', container.ID]); } catch { fail('update-docker-failed'); }
      }
      current.push(`${name}:${imageId}`);
    }
    await this.docker(['pull', ...services], 20 * 60_000);
    for (const name of services) {
      let imageId;
      try { imageId = await this.run('docker', ['image', 'inspect', '--format', '{{.Id}}', config.services[name].image]); } catch { fail('update-docker-failed'); }
      latest.push(`${name}:${imageId}`);
    }
    this.state.current = current.find(value => value.startsWith('moa:')).slice(4) || 'unknown';
    this.state.latest = latest.find(value => value.startsWith('moa:')).slice(4);
    this.state.behind = current.filter((value, index) => value !== latest[index]).length;
    return this.state.behind > 0;
  }
  async check() {
    if (this.release) return this.release.check();
    const restart = this.state.state === 'restart-required';
    this.state = { ...blank(), state: 'checking' };
    await this.persist();
    const installation = await this.installation();
    const available = installation.git ? await this.source() : await this.images();
    Object.assign(this.state, { state: available ? 'available' : restart ? 'restart-required' : 'current', checkedAt: Date.now() });
    return installation;
  }
  async apply() {
    if (this.release) return this.release.apply();
    const installation = await this.check();
    if (this.state.state !== 'available') return;
    this.state.state = 'updating';
    await this.persist();
    if (installation.git) {
      if (await this.git(['status', '--porcelain', '--untracked-files=no'])) fail('update-dirty');
      if (await this.git(['symbolic-ref', '--short', 'HEAD']) !== this.state.branch) fail('update-no-upstream');
      await atomic(path.join(this.dir, 'pending.json'), { revision: this.state.latest, current: this.state.current }, 0o600);
      await this.git(['merge', '--ff-only', '--no-overwrite-ignore', '--', this.state.latest]);
    }
    if (installation.docker) {
      if (installation.git) await this.docker(['build', '--build-arg', `MOA_REVISION=${this.state.latest}`], 30 * 60_000);
      await this.docker(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180'], 5 * 60_000);
      this.state.state = 'current';
    } else {
      try {
        await this.run('corepack', ['pnpm', 'install', '--frozen-lockfile'], 20 * 60_000);
        await this.run('corepack', ['pnpm', 'build'], 20 * 60_000);
      } catch { fail('update-build-failed'); }
      if (this.service) {
        try { await this.run('systemctl', ['restart', this.service]); } catch { fail('update-restart-failed'); }
        this.state.state = 'current';
      } else this.state.state = 'restart-required';
    }
    Object.assign(this.state, { current: this.state.latest, behind: 0, checkedAt: Date.now() });
    await rm(path.join(this.dir, 'pending.json'), { force: true });
  }
  async tick() {
    if (this.release) return this.release.tick();
    if (Date.now() >= this.nextCheckAt) await this.perform('check');
  }
  async perform(action) {
    if (!['check', 'apply'].includes(action)) fail('update-request-invalid');
    try { await this[action](); }
    catch (error) {
      const code = publicError(error);
      this.state.state = this.state.state === 'recovery-required' ? 'recovery-required' : ['update-dirty', 'update-diverged', 'update-no-upstream', 'update-deployment-diverged', 'update-version-unknown', 'update-migration-required', 'update-platform-unsupported', 'update-tool-required', 'update-compose-required', 'update-no-releases', 'update-release-incomplete'].includes(code) ? 'blocked' : 'failed';
      this.state.error = code;
      this.state.checkedAt = Date.now();
    }
    if (!this.release) this.nextCheckAt = Date.now() + (this.state.error ? 3600000 : 6 * 3600000);
    await this.persist();
    return this.state;
  }
  async performComponent(component) {
    try {
      if (!this.release) fail('update-components-unsupported');
      await this.release.changeComponent(component);
    } catch (error) {
      const code = publicError(error);
      this.state.state = code === 'update-recovery-required' ? 'recovery-required' : 'failed';
      this.state.error = code;
      this.state.componentOperation = { ...component, state: 'failed', error: code };
    }
    await this.persist();
  }
  async consume() {
    const file = path.join(this.dir, 'request.json');
    let request;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 4096) fail('update-request-invalid');
      request = JSON.parse(await readFile(file, 'utf8'));
      if (!['check', 'apply', 'configure', 'component'].includes(request.action) || !/^[a-f0-9-]{36}$/.test(request.id) || !Number.isSafeInteger(request.createdAt) || Math.abs(Date.now() - request.createdAt) > 60000 || Object.keys(request).some(key => !(request.action === 'configure' ? ['id', 'action', 'createdAt', 'policy'] : request.action === 'component' ? ['id', 'action', 'createdAt', 'component'] : ['id', 'action', 'createdAt']).includes(key))) fail('update-request-invalid');
      if (request.action === 'component' && (!request.component || !['apk','browser'].includes(request.component.id) || typeof request.component.enabled !== 'boolean' || Object.keys(request.component).length !== 2)) fail('update-request-invalid');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      await rm(file, { force: true }).catch(() => {});
      this.state = { ...this.state, state: 'failed', error: 'update-request-invalid' };
      await this.persist();
      return;
    }
    await rm(file);
    if (request.action === 'configure') {
      try { if (!this.release) fail('update-invalid-options'); await this.release.configure(policy(request.policy)); }
      catch { this.state.error = 'update-invalid-policy'; }
      await this.persist();
    } else if (request.action === 'component') await this.performComponent(request.component);
    else await this.perform(request.action);
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === 'probe') { const result = { protocol: 1, version: UPDATER_VERSION }; process.stdout.write(`${JSON.stringify(result)}\n`); return result; }
  const [action, ...flags] = args;
  if (!['check', 'apply', 'serve'].includes(action) || flags.length % 2) fail('update-invalid-options');
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--cwd', '--dir', '--mode'].includes(flags[i]) || !flags[i + 1]) fail('update-invalid-options');
    options[flags[i].slice(2)] = flags[i + 1];
  }
  const updater = new Updater(options);
  await mkdir(updater.dir, { recursive: true, mode: 0o770 });
  const lock = path.join(updater.dir, 'agent.lock');
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) fail('update-busy');
    try { process.kill(pid, 0); fail('update-busy'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    await rm(lock);
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  let heartbeat, running = true;
  const stop = () => { running = false; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (action !== 'serve') {
      const result = await updater.perform(action);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    }
    if (updater.release) await updater.release.init();
    heartbeat = setInterval(() => void updater.persist().catch(() => { running = false; }), 5000);
    if (updater.state.state !== 'recovery-required' && (!updater.release || Date.now() >= updater.release.nextCheckAt)) await updater.perform('check');
    while (running && !updater.restartRequested) { await updater.consume(); await updater.tick(); await new Promise(resolve => setTimeout(resolve, 1000)); }
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (updater.restartRequested) process.exitCode = 75;
    updater.state.connected = false;
    await updater.persist();
    await rm(lock, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(result => { if (result?.state === 'failed' || result?.state === 'blocked') process.exitCode = 1; }).catch(error => { process.stderr.write(`${publicError(error)}\n`); process.exitCode = 1; });
}
