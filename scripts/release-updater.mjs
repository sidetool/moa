import { readFile, mkdir, rm, statfs, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReleaseFeed, DEFAULT_POLICY, UPDATER_VERSION, SERVICES, compare, version, policy, fail } from './release.mjs';
import { atomic, readJson, optionalJson, privateDirectory } from './update-files.mjs';
import { stageBundle } from './release-bundle.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = text => text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map(JSON.parse);
export class ReleaseUpdater {
  constructor(host) { this.host = host; this.root = path.join(host.cwd, '.moa-release'); this.failedVersion = null; }
  async init() {
    if (this.ready) return;
    this.install = await readJson(path.join(this.root, 'installation.json'));
    if (this.install.format !== 1 || !/^[a-z0-9][a-z0-9_-]*$/.test(this.install.project) || !['linux/amd64', 'linux/arm64'].includes(this.install.platform)) fail('update-not-installed');
    this.feed = new ReleaseFeed({ repository: this.install.repository, publicKey: await readFile(path.join(this.root, 'trusted-key.pem'), 'utf8') });
    this.current = await readJson(path.join(this.root, 'current.json'));
    version(this.current.version);
    this.policy = policy(await optionalJson(path.join(this.root, 'policy.json'), DEFAULT_POLICY));
    this.history = await optionalJson(path.join(this.root, 'history.json'), []);
    const prior = await optionalJson(path.join(this.root, 'schedule.json'), {});
    this.nextCheckAt = prior.nextCheckAt || 0; this.failedVersion = prior.failedVersion || null;
    this.ready = true;
    Object.assign(this.host.state, { mode: 'release', current: this.current.version, policy: this.policy, updaterVersion: UPDATER_VERSION, history: this.history, nextCheckAt: this.nextCheckAt });
    await this.recover();
    const last = this.history[0];
    if (this.host.state.state === 'idle' && last?.outcome === 'rolled-back') Object.assign(this.host.state, { state: 'rolled-back', error: 'update-rolled-back' });
  }
  async phase(state, extra = {}) { Object.assign(this.host.state, { state, ...extra }); await this.host.persist(); }
  async compose(file, args, timeout = 120000) {
    return this.host.run('docker', ['compose', '--project-name', this.install.project, '--project-directory', this.host.cwd, '-f', file, ...args], timeout);
  }
  async schedule() {
    await atomic(path.join(this.root, 'schedule.json'), { nextCheckAt: this.nextCheckAt, failedVersion: this.failedVersion });
    this.host.state.nextCheckAt = this.nextCheckAt;
  }
  async configure(settings) {
    await this.init(); this.policy = policy(settings);
    await atomic(path.join(this.root, 'policy.json'), this.policy);
    this.host.state.policy = this.policy; this.candidate = undefined; this.nextCheckAt = 0;
    this.host.state.latest = null;
    if (this.host.state.state !== 'recovery-required') { this.host.state.state = 'idle'; this.host.state.error = null; }
    await this.schedule();
  }
  compatible(m) {
    if (compare(this.current.version, m.minimumVersion) < 0 || m.schemaEpoch !== this.current.schemaEpoch || !m.rollbackSafe) fail('update-migration-required');
    for (const name of this.current.services) if (!m.services[name]?.platforms.includes(this.install.platform)) fail('update-platform-unsupported');
    if (compare(UPDATER_VERSION, m.minimumUpdaterVersion) < 0) fail('update-tool-required');
  }
  async check() {
    await this.init();
    if (this.host.state.state === 'recovery-required') fail('update-recovery-required');
    await this.phase('checking', { error: null, latest: null });
    this.candidate = undefined;
    try {
      const releases = await this.feed.releases(this.policy.channel);
      if (!releases.length) fail('update-no-releases');
      let incompatible = null;
      for (const release of releases) {
        if (compare(release.tag_name, this.current.version) <= 0) continue;
        let candidate;
        try { candidate = await this.feed.manifest(release); } catch (error) {
          if (error.message !== 'update-release-incomplete') throw error;
          incompatible ||= error; continue;
        }
        try { this.compatible(candidate.manifest); } catch (error) { incompatible ||= error; continue; }
        this.candidate = candidate; break;
      }
      if (!this.candidate && incompatible) throw incompatible;
      Object.assign(this.host.state, { current: this.current.version, latest: this.candidate?.manifest.version ?? this.current.version,
        notesUrl: this.candidate?.manifest.releaseNotesUrl ?? null, behind: this.candidate ? 1 : 0, checkedAt: Date.now(), state: this.candidate ? 'available' : 'current' });
      this.nextCheckAt = Date.now() + 6 * 3600000 * (0.9 + Math.random() * 0.2);
    } catch (error) {
      this.nextCheckAt = Date.now() + 60 * 60_000; throw error;
    } finally { await this.schedule(); }
  }
  async activity() {
    try {
      const value = await readJson(path.join(this.host.dir, 'activity.json'), 4096);
      if (!Number.isSafeInteger(value.heartbeat) || Math.abs(Date.now() - value.heartbeat) > 15000 || typeof value.busy !== 'boolean') return null;
      return value;
    } catch { return null; }
  }
  async lease() {
    const id = randomUUID(); this.leaseId = id;
    const write = () => atomic(path.join(this.host.dir, 'maintenance.json'), { id, expiresAt: Date.now() + 30000 }, 0o640);
    await write();
    this.leaseTimer = setInterval(() => void write().catch(() => { this.leaseLost = true; }), 5000);
    this.leaseLost = false;
    for (let i = 0; i < 15; i++) {
      const activity = await this.activity();
      if (activity?.leaseId === id && !activity.busy && !this.leaseLost) return;
      await sleep(1000);
    }
    fail('update-app-busy');
  }
  async releaseLease() { clearInterval(this.leaseTimer); await rm(path.join(this.host.dir, 'maintenance.json'), { force: true }); }
  async journal(value) { this.transaction = value; await atomic(path.join(this.root, 'journal.json'), value); }
  async record(outcome, target, previous) {
    this.history = [{ version: target, previous, at: Date.now(), outcome }, ...this.history].slice(0, 20);
    await atomic(path.join(this.root, 'history.json'), this.history); this.host.state.history = this.history;
  }
  async verify(file, services) {
    const expected = await readJson(file);
    const containers = lines(await this.compose(file, ['ps', '--format', 'json']));
    for (const name of services) {
      const rows = containers.filter(c => c.Service === name);
      if (rows.length !== 1 || rows[0].State !== 'running' || rows[0].Health && rows[0].Health !== 'healthy') fail('update-health-failed');
      const actual = await this.host.run('docker', ['inspect', '--format', '{{.Config.Image}}', rows[0].ID]);
      if (actual !== expected.services[name].image) fail('update-health-failed');
    }
    // Health is an application endpoint, not merely a running process.
    await this.compose(file, ['exec', '-T', 'moa', 'node', '-e', "fetch('http://127.0.0.1:8795/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
  }
  async rollback(transaction) {
    if (transaction.previous.schemaEpoch !== transaction.target.schemaEpoch) fail('update-recovery-required');
    await this.phase('rolling-back');
    await this.journal({ ...transaction, phase: 'rolling-back' });
    await this.compose(transaction.previous.compose, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', ...transaction.previous.services], 300000);
    await this.verify(transaction.previous.compose, transaction.previous.services);
    if (transaction.gateway) await this.compose(transaction.previous.compose, ['restart', 'moa-gateway']);
    await atomic(path.join(this.root, 'current.json'), transaction.previous); this.current = transaction.previous;
    await this.record('rolled-back', transaction.target.version, transaction.previous.version);
    await this.journal({ ...transaction, phase: 'rolled-back' });
    await this.phase('rolled-back', { current: this.current.version, error: 'update-rolled-back' });
  }
  async recover() {
    const transaction = await optionalJson(path.join(this.root, 'journal.json'), null);
    if (!transaction || ['complete', 'rolled-back', 'cancelled'].includes(transaction.phase)) return;
    this.failedVersion = transaction.target.version;
    // Never replay an interrupted installation automatically. A backward-compatible
    // deployment may restore images; database snapshots are never restored over writes.
    try {
      if (['prepared', 'stopped', 'backed-up', 'applying', 'verifying', 'rolling-back'].includes(transaction.phase)) await this.rollback(transaction);
      else fail('update-recovery-required');
    } catch { await this.phase('recovery-required', { error: 'update-recovery-required' }); }
    finally { await this.releaseLease(); await this.schedule(); }
  }
  async apply() {
    await this.init();
    if (this.host.state.state === 'recovery-required') fail('update-recovery-required');
    // Pin the candidate selected at check time; no refetch of a moving tag here.
    if (!this.candidate) await this.check();
    if (!this.candidate) return;
    const { manifest: m } = this.candidate;
    this.compatible(m);
    let transaction;
    try {
      await this.phase('preflight', { error: null });
      const composeVersion = (await this.host.run('docker', ['compose', 'version', '--short'])).trim();
      if (compare(composeVersion, m.minimumComposeVersion) < 0) fail('update-compose-required');
      const free = await statfs(this.root);
      if (free.bavail * free.bsize < 1024 ** 3) fail('update-space-required');
      const existing = await readJson(this.current.compose);
      const running = lines(await this.compose(this.current.compose, ['ps', '--format', 'json']));
      for (const name of this.current.services) {
        const rows = running.filter(c => c.Service === name && c.State === 'running');
        if (rows.length !== 1) fail('update-deployment-diverged');
        const actual = await this.host.run('docker', ['inspect', '--format', '{{.Config.Image}}', rows[0].ID]);
        if (actual !== existing.services[name].image) fail('update-deployment-diverged');
      }
      const targetDir = path.join(this.root, 'releases', m.version);
      await privateDirectory(targetDir);
      const sealFile = path.join(targetDir, 'manifest-seal.json');
      const seal = await optionalJson(sealFile, null);
      if (seal && seal.digest !== this.candidate.digest) fail('update-release-mutated');
      if (this.candidate.digest) await atomic(sealFile, { digest: this.candidate.digest });
      await stageBundle(await this.feed.bundle(m), targetDir);
      // Resolve imports and check the protocol before stopping anything.
      const probe = JSON.parse(await this.host.run(process.execPath, [path.join(targetDir, 'scripts/update.mjs'), 'probe']));
      if (probe.protocol !== 1 || compare(probe.version, m.minimumUpdaterVersion) < 0) fail('update-tool-required');
      await this.phase('downloading');
      for (const name of this.current.services) {
        const image = `${m.services[name].image}@${m.services[name].digest}`;
        await this.host.run('docker', ['pull', '--platform', this.install.platform, image], 20 * 60000);
        existing.services[name].image = image; delete existing.services[name].build;
        existing.services[name].pull_policy = 'never';
      }
      // Add an empty dedicated volume only; the app stays disabled until an admin sets a quota.
      // Preserve an explicitly configured root/mount. Never put video blobs in /data backups.
      const app = existing.services.moa;
      if (!app.environment?.MOA_DOWNLOAD_ROOT) {
        const mounts = app.volumes ?? [];
        const mounted = mounts.some(v => typeof v === 'string' ? v.split(':').slice(1).includes('/downloads') : v.target === '/downloads');
        if (!mounted) {
          existing.volumes ??= {};
          let name = 'moa-downloads';
          for (let n = 1; Object.hasOwn(existing.volumes, name); n++) name = `moa-downloads-${n}`;
          existing.volumes[name] = {};
          app.volumes = [...mounts, { type: 'volume', source: name, target: '/downloads' }];
        }
        app.environment = { ...app.environment, MOA_DOWNLOAD_ROOT: '/downloads' };
      }
      existing.services.moa.environment = { ...existing.services.moa.environment, MOA_VERSION: m.version, MOA_DEPLOYMENT: 'release' };
      const target = { version: m.version, manifestDigest: this.candidate.digest, schemaEpoch: m.schemaEpoch, services: this.current.services, compose: path.join(targetDir, 'compose.json'), runtime: targetDir, previousRuntime: this.current.runtime };
      // existing is already interpolation-escaped on disk, preserve it as-is.
      await atomic(target.compose, existing);
      await this.compose(target.compose, ['config', '--quiet']);
      await this.phase('preflight');
      let backupBytes = 0;
      const writers = this.current.services.filter(n => ['moa', 'moa-auth', 'moa-apk', 'moa-connector'].includes(n));
      for (const name of writers) {
        const measured = await this.compose(this.current.compose, ['exec', '-T', name, 'node', '-e',
          "const fs=require('node:fs');let bytes=0,q=['/data'];while(q.length){const p=q.pop(),s=fs.lstatSync(p);bytes+=Math.max(s.size,s.blocks*512,4096);if(s.isDirectory())for(const n of fs.readdirSync(p))q.push(p+'/'+n);}console.log(bytes)"]);
        if (!/^\d+$/.test(measured) || !Number.isSafeInteger(Number(measured))) fail('update-backup-unavailable');
        backupBytes += Number(measured);
      }
      const space = await statfs(this.root);
      if (space.bavail * space.bsize < Math.ceil(backupBytes * 1.1) + 1024 ** 3) fail('update-space-required');
      await this.lease();
      if (this.leaseLost) fail('update-app-busy');
      const backup = path.join(this.root, 'backups', `${Date.now()}-${m.version}`);
      await privateDirectory(backup);
      transaction = { phase: 'prepared', previous: this.current, target, backup, gateway: Boolean(existing.services['moa-gateway']) };
      await this.journal(transaction);
      await this.phase('backup');
      // Stop all managed writers before copying persistent data, including SQLite WAL.
      await this.compose(this.current.compose, ['stop', '--timeout', '30', ...this.current.services], 120000);
      await this.journal({ ...transaction, phase: 'stopped' });
      for (const name of writers) {
        await mkdir(path.join(backup, name), { mode: 0o700 });
        await this.compose(this.current.compose, ['cp', `${name}:/data/.`, path.join(backup, name)], 20 * 60000);
      }
      await atomic(path.join(backup, 'deployment.json'), transaction.previous);
      await this.journal({ ...transaction, phase: 'backed-up' });
      await this.phase('applying'); await this.journal({ ...transaction, phase: 'applying' });
      await this.compose(target.compose, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', ...target.services], 300000);
      await this.phase('verifying'); await this.journal({ ...transaction, phase: 'verifying' });
      await this.verify(target.compose, target.services);
      if (transaction.gateway) await this.compose(target.compose, ['restart', 'moa-gateway']);
      if (this.leaseLost) fail('update-lease-lost');
      await atomic(path.join(this.root, 'current.json'), target);
      this.current = target;
      await this.record('complete', target.version, transaction.previous.version);
      await this.journal({ ...transaction, phase: 'complete' });
      await this.phase('current', { current: target.version, latest: target.version, behind: 0, error: null });
      this.failedVersion = null; this.candidate = undefined;
      // Keep two most recent local backup sets. Never prune on failure/recovery.
      const backupNames = (await readdir(path.join(this.root, 'backups')).catch(() => [])).filter(n => /^\d+-v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(n)).sort().reverse();
      for (const name of backupNames.slice(2)) await rm(path.join(this.root, 'backups', name), { recursive: true, force: true }).catch(() => {});
      this.host.restartRequested = target.runtime !== transaction.previous.runtime;
    } catch (error) {
      this.failedVersion = m.version;
      if (transaction) {
        try { await this.rollback(transaction); } catch { await this.phase('recovery-required', { error: 'update-recovery-required' }); }
      } else {
        await this.record('failed', m.version, this.current.version);
        throw error;
      }
    } finally { await this.releaseLease(); await this.schedule(); }
  }
  async tick() {
    await this.init();
    if (this.host.state.state === 'recovery-required') return;
    // Background work only discovers releases. Applying always requires an explicit request.
    if (Date.now() >= this.nextCheckAt) await this.host.perform('check');
  }
}
