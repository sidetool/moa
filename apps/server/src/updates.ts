import { readFile, writeFile, link, rm, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { UpdateStatus, UpdatePolicy, ReleaseDiscovery, SystemInfo } from '@moa/shared';
import { ApiFailure } from './util.js';

export function validatePolicy(value: unknown): UpdatePolicy {
  const p = value as UpdatePolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).join() !== 'channel' || !['stable', 'beta'].includes(p.channel)) throw new ApiFailure(400, 'update-invalid-policy');
  return { channel: p.channel };
}
function releaseFields(data: Record<string, any>): Partial<UpdateStatus> {
  if (data.mode !== 'release') return {};
  let policy: UpdatePolicy | undefined;
  try { policy = validatePolicy(data.policy); } catch {}
  return {
    policy, updaterVersion: typeof data.updaterVersion === 'string' && /^\d+\.\d+\.\d+$/.test(data.updaterVersion) ? data.updaterVersion : undefined,
    nextCheckAt: Number.isSafeInteger(data.nextCheckAt) ? data.nextCheckAt : null,
    notesUrl: typeof data.notesUrl === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/v[0-9.]+(?:-beta\.\d+)?$/.test(data.notesUrl) ? data.notesUrl : null,
    history: Array.isArray(data.history) ? data.history.slice(0,20).filter(h => typeof h.version === 'string' && h.version.length < 80 && typeof h.previous === 'string' && h.previous.length < 80 && Number.isSafeInteger(h.at) && ['complete','rolled-back','failed'].includes(h.outcome)).map(h => ({ version: h.version, previous: h.previous, at: h.at, outcome: h.outcome })) : [],
  };
}

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const versionParts = (value: string) => {
  if (value.length > 80) return;
  const parts = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(value)?.slice(1).map(value => value === undefined ? Infinity : Number(value));
  return parts?.every((value, i) => Number.isSafeInteger(value) || i === 3 && value === Infinity) ? parts : undefined;
};
const compareVersions = (a: string, b: string) => {
  const first = versionParts(a)!, second = versionParts(b)!;
  for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) return first[i] > second[i] ? 1 : -1;
  return 0;
};

export async function installationInfo(env = process.env, cwd = root) {
  const git = async (...args: string[]) => { try { return (await exec('git', args, { cwd, timeout: 3000, maxBuffer: 4096 })).stdout.trim(); } catch { return ''; } };
  const declared = env.MOA_VERSION && versionParts(env.MOA_VERSION) ? env.MOA_VERSION : '';
  const revision = env.MOA_REVISION && env.MOA_REVISION !== 'unknown' ? env.MOA_REVISION : await git('rev-parse', 'HEAD');
  const tag = declared || (!env.MOA_DEPLOYMENT || env.MOA_DEPLOYMENT === 'git' ? await git('describe', '--tags', '--exact-match', 'HEAD') : '');
  const remote = env.MOA_REPOSITORY || await git('remote', 'get-url', 'upstream') || await git('remote', 'get-url', 'origin');
  const repository = remote.replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
  return { version: versionParts(tag) ? tag : null, revision: revision || 'unknown', repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : 'sidetool/moa', mode: (['git', 'docker', 'release'].includes(env.MOA_DEPLOYMENT || '') ? env.MOA_DEPLOYMENT : revision ? 'git' : null) as UpdateStatus['mode'] };
}

export class Updates {
  private installed?: ReturnType<typeof installationInfo>;
  private discovery?: ReleaseDiscovery;
  private pending?: Promise<ReleaseDiscovery>;
  private generation = 0;
  private nextCheck = 0;
  private channel?: UpdatePolicy;
  constructor(private dir = process.env.MOA_UPDATER_DIR, private fetcher = fetch, private env = process.env, private cwd = root) {}
  private installation() { return this.installed ??= installationInfo(this.env, this.cwd); }
  private async policy(): Promise<UpdatePolicy> {
    if (!this.channel) {
      try {
        const saved = await readFile(path.join(this.env.MOA_DATA_DIR || path.join(this.cwd, 'data'), 'update-policy.json'), 'utf8');
        this.channel ??= validatePolicy(JSON.parse(saved));
      } catch {
        const installed = await this.installation();
        this.channel ??= { channel: installed.version?.includes('-beta.') ? 'beta' : 'stable' };
      }
    }
    return this.channel;
  }
  private async github(endpoint: string) {
    const installed = await this.installation();
    const response = await this.fetcher(`https://api.github.com/repos/${installed.repository}/${endpoint}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new ApiFailure(response.status === 404 ? 404 : 502, response.status === 403 || response.status === 429 ? 'update-rate-limited' : 'update-check-failed'); }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiFailure(502, 'update-check-failed');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new ApiFailure(502, 'update-response-limit'); chunks.push(value); }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async notes(tag: string) {
    if (!versionParts(tag)) throw new ApiFailure(400, 'update-invalid-version');
    const release = await this.github(`releases/tags/${encodeURIComponent(tag)}`);
    if (!release || release.draft || release.tag_name !== tag) throw new ApiFailure(404, 'update-no-releases');
    return { version: tag, body: typeof release.body === 'string' ? release.body.slice(0, 65536) : '', publishedAt: typeof release.published_at === 'string' ? release.published_at : '' };
  }
  private async discover(force = false): Promise<ReleaseDiscovery> {
    if (this.pending) return this.pending;
    if (this.discovery && Date.now() < (force ? this.discovery.checkedAt + 60_000 : this.nextCheck)) return this.discovery;
    const generation = this.generation;
    this.pending = (async () => {
      const installed = await this.installation(), policy = await this.policy();
      const result: ReleaseDiscovery = { repository: installed.repository, currentVersion: installed.version, latestVersion: null, updateAvailable: null, releases: [], checkedAt: Date.now(), error: null };
      try {
        const releases: Record<string, any>[] = [];
        for (let page = 1; page <= 5; page++) {
          const items = await this.github(`releases?per_page=100&page=${page}`);
          if (!Array.isArray(items)) throw new Error('update-check-failed');
          releases.push(...items);
          if (items.length < 100) break;
          if (page === 5) throw new Error('update-feed-truncated');
        }
        const published = releases.filter(item => item && !item.draft && (policy.channel === 'beta' || !item.prerelease && versionParts(item.tag_name || '')?.[3] === Infinity) && typeof item.tag_name === 'string' && versionParts(item.tag_name) && (item.prerelease ? versionParts(item.tag_name)![3] !== Infinity : true) && typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)))
          .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
        const latest = published[0];
        result.latestVersion = latest?.tag_name ?? null;
        result.releases = published.slice(0, 5).map(item => ({ version: item.tag_name, url: `https://github.com/${installed.repository}/releases/tag/${encodeURIComponent(item.tag_name)}`, publishedAt: item.published_at }));
        if (latest && installed.version) result.updateAvailable = compareVersions(latest.tag_name, installed.version) > 0;
      } catch (error) { result.error = error instanceof Error && /^update-[a-z-]+$/.test(error.message) ? error.message : 'update-check-failed'; }
      if (generation === this.generation) { this.discovery = result; this.nextCheck = Date.now() + (result.error ? 3600000 : 6 * 3600000); }
      return result;
    })().finally(() => { if (generation === this.generation) this.pending = undefined; });
    return this.pending;
  }
  private async hostStatus(): Promise<UpdateStatus> {
    const installed = await this.installation();
    const base: UpdateStatus = { configured: Boolean(this.dir), connected: false, state: 'idle', mode: installed.mode, current: installed.version || installed.revision, latest: null, branch: null, behind: 0, ahead: 0, checkedAt: null, error: null };
    if (!this.dir) return base;
    try {
      const content = await readFile(path.join(this.dir, 'status.json'), 'utf8');
      if (content.length > 16384) throw new Error();
      const data = JSON.parse(content);
      if (!['idle', 'checking', 'updating', 'current', 'available', 'blocked', 'failed', 'restart-required', 'downloading', 'preflight', 'backup', 'applying', 'verifying', 'rolling-back', 'rolled-back', 'recovery-required'].includes(data.state) || ![null, 'git', 'docker', 'release'].includes(data.mode)) throw new Error();
      const text = (value: unknown) => typeof value === 'string' && value.length <= 256 ? value : null;
      return { ...base, ...releaseFields(data), connected: data.connected === true && Number.isFinite(data.heartbeat) && Math.abs(Date.now() - data.heartbeat) < 15000, state: data.state, mode: data.mode,
        current: text(data.current) || base.current, latest: text(data.latest), branch: text(data.branch), behind: Number.isSafeInteger(data.behind) && data.behind >= 0 ? data.behind : 0, ahead: Number.isSafeInteger(data.ahead) && data.ahead >= 0 ? data.ahead : 0,
        checkedAt: Number.isSafeInteger(data.checkedAt) ? data.checkedAt : null, error: typeof data.error === 'string' && /^update-[a-z-]+$/.test(data.error) ? data.error : null };
    } catch { return { ...base, error: 'updater-unavailable' }; }
  }
  async status(): Promise<UpdateStatus> {
    const status = await this.hostStatus();
    return status.connected ? status : { ...status, policy: await this.policy(), discovery: await this.discover() };
  }
  async system(): Promise<SystemInfo> {
    const installed = await this.installation();
    let name = os.type();
    if (process.platform === 'linux') { try { name = (await readFile('/etc/os-release', 'utf8')).match(/^PRETTY_NAME=["']?([^"'\n]+)["']?$/m)?.[1] || name; } catch {} }
    return { os: name, kernel: os.release(), architecture: os.arch(), nodeVersion: process.versions.node, version: installed.version || 'unknown', revision: installed.revision, deployment: installed.mode || 'unknown', cpuCount: os.availableParallelism(), memoryTotal: os.totalmem(), memoryUsed: os.totalmem() - os.freemem(), uptimeSeconds: Math.floor(process.uptime()) };
  }
  async request(action: 'check' | 'apply' | 'configure', policy?: UpdatePolicy) {
    const status = await this.hostStatus();
    if (action === 'configure' && !status.connected) {
      const selected = validatePolicy(policy), directory = this.env.MOA_DATA_DIR || path.join(this.cwd, 'data');
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, 'update-policy.json'), temp = `${target}-${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(selected), { flag: 'wx', mode: 0o600 }); await rename(temp, target); }
      finally { await rm(temp, { force: true }); }
      this.channel = selected; this.generation++; this.pending = undefined; this.discovery = undefined; this.nextCheck = 0;
      return this.status();
    }
    if (action === 'check' && !status.connected) return { ...status, policy: await this.policy(), discovery: await this.discover(true) };
    if (!this.dir || !status.connected) throw new ApiFailure(503, 'updater-unavailable');
    if (['checking', 'updating', 'downloading', 'preflight', 'backup', 'applying', 'verifying', 'rolling-back'].includes(status.state)) throw new ApiFailure(409, 'update-busy');
    if (action === 'apply' && status.state !== 'available') throw new ApiFailure(409, 'update-not-available');
    if (action === 'configure' && status.mode !== 'release') throw new ApiFailure(409, 'update-release-required');
    const file = path.join(this.dir, 'request.json');
    const temp = path.join(this.dir, `request-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ id: randomUUID(), action, createdAt: Date.now(), ...(action === 'configure' ? { policy: validatePolicy(policy) } : {}) }), { flag: 'wx', mode: 0o660 });
      await link(temp, file);
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiFailure(409, 'update-busy');
      throw new ApiFailure(503, 'updater-unavailable');
    } finally { await rm(temp, { force: true }).catch(() => {}); }
    return action === 'configure' ? status : { ...status, state: action === 'check' ? 'checking' as const : 'updating' as const };
  }
}

export function registerUpdates(app: FastifyInstance, jobs?:{prepare:()=>Promise<void>;resume:()=>void;canResume?:()=>boolean}) {
  const updates = new Updates();
  // Release the queue gate after a failed/cancelled host operation; successful restart
  // marks queued jobs interrupted. No automatic retry of partial files.
  let polling=false, preparing=false, requestedAt=0, observedBusy=false;
  const timer=jobs?setInterval(()=>{
    if(polling||!requestedAt||preparing)return;polling=true;
    void updates.status().then(async s=>{
      if(['updating','downloading','preflight','backup','applying','verifying','rolling-back'].includes(s.state)){observedBusy=true;return;}
      if(!observedBusy&&Date.now()-requestedAt<30000)return;
      try{await readFile(path.join(process.env.MOA_UPDATER_DIR||'','request.json'));return;}catch{}
      if(jobs.canResume&&!jobs.canResume())return;
      jobs.resume();requestedAt=0;observedBusy=false;
    }).catch(()=>{}).finally(()=>{polling=false;});
  },10000):undefined;
  timer?.unref();app.addHook('onClose',async()=>{clearInterval(timer);});
  app.get('/api/admin/system', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(await updates.system()));
  app.get<{ Params: { version: string } }>('/api/admin/updates/releases/:version', async (req, reply) => reply.header('Cache-Control', 'private, no-store').send(await updates.notes(req.params.version)));
  app.get('/api/admin/updates', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(await updates.status()));
  app.patch('/api/admin/updates/settings', async (req, reply) => reply.code(202).header('Cache-Control', 'private, no-store').send(await updates.request('configure', validatePolicy(req.body))));
  for (const action of ['check', 'apply'] as const) app.post(`/api/admin/updates/${action}`, async (req, reply) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw new ApiFailure(400, 'invalid-update-request');
    if(action!=='apply')return reply.code(202).header('Cache-Control','private, no-store').send(await updates.request(action));
    if(preparing||requestedAt)throw new ApiFailure(409,'update-busy');
    preparing=true;
    try{
      const status=await updates.status();
      if(!status.connected)throw new ApiFailure(503,'updater-unavailable');
      if(status.state!=='available')throw new ApiFailure(409,'update-not-available');
      await jobs?.prepare();
      const result=await updates.request(action);requestedAt=Date.now();
      return reply.code(202).header('Cache-Control','private, no-store').send(result);
    }catch(e){jobs?.resume();throw e;}finally{preparing=false;}

  });
}
