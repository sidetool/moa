import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteAccessConfigure, RemoteAccessStatus } from '@moa/shared';
import { ApiFailure } from '../util.js';
type Saved = RemoteAccessConfigure & { enabled: boolean };
type Runtime = Pick<RemoteAccessStatus, 'state'|'url'|'loginUrl'|'lastError'>;
export type ConnectorRpc = (method: string, config?: Saved) => Promise<Runtime>;
export class RemoteAccess {
  private saved: Saved = { mode: 'off', enabled: false };
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private runtime: Runtime = { state: 'off', url: null, loginUrl: null, lastError: null };
  constructor(private dir: string, private rpc: ConnectorRpc | null, private safe: () => Promise<boolean>, private external = false) {}
  async init() {
    try { this.saved = JSON.parse(await readFile(path.join(this.dir, 'remote-access.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('remote-access-config-unreadable'); }
    if (this.rpc && !this.external) {
      await this.reconcile();
      this.timer = setInterval(() => { void this.serial(() => this.reconcile()); }, 15_000); this.timer.unref();
    }
  }
  close() { if (this.timer) clearInterval(this.timer); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  private async persist() {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'remote-access.json');
    await writeFile(file + '.tmp', JSON.stringify(this.saved), { mode: 0o600 }); await rename(file + '.tmp', file);
  }
  private async reconcile() {
    try {
      const enabled = this.saved.enabled && this.saved.mode !== 'off';
      if (enabled && !await this.safe()) {
        await this.rpc!('stop');
        this.runtime = { state: 'error', url: null, loginUrl: null, lastError: 'login-gate-and-admin-required' }; return;
      }
      this.runtime = await this.rpc!(enabled ? 'apply' : 'stop', enabled ? this.saved : undefined);
    } catch { this.runtime = { state: 'error', url: null, loginUrl: null, lastError: 'connector-unavailable' }; }
  }
  status(): RemoteAccessStatus {
    const { mode, enabled, publicHostname = '', funnel = false } = this.saved;
    const runtime = this.external ? { state: 'off' as const, url: null, loginUrl: null, lastError: null } : this.runtime;
    return { ...runtime, mode, urls: runtime.url ? [runtime.url] : [], funnel, externallyManaged: this.external,
      available: !!this.rpc && !this.external, desiredEnabled: enabled, gatewayServiceUrl: 'http://moa-gateway:8080',
      warning: mode === 'cloudflare-quick' || mode === 'cloudflare-token' || (mode === 'tailscale' && funnel)
        ? 'This URL is public. Anyone can reach the MOA login page. Use strong passwords and share it carefully.' : null,
      config: { mode, publicHostname, funnel, cloudflareToken: this.saved.cloudflareToken ? '********' : null, tailscaleAuthKey: this.saved.tailscaleAuthKey ? '********' : null } };
  }
  mutate(action: 'configure'|'start'|'stop', input?: RemoteAccessConfigure) { return this.serial(async () => {
    if (this.external) throw new ApiFailure(409, 'remote-access-externally-managed');
    if (!this.rpc) throw new ApiFailure(503, 'connector-unavailable');
    const next = { ...this.saved, ...(action === 'configure' ? input : {}), enabled: action === 'start' ? true : action === 'stop' ? false : this.saved.enabled };
    if (next.publicHostname && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(next.publicHostname)) throw new ApiFailure(400, 'invalid-public-hostname');
    if (next.cloudflareToken === '********' || next.tailscaleAuthKey === '********') throw new ApiFailure(400, 'invalid-secret');
    if (next.mode === 'off') next.enabled = false;
    if (next.enabled) {
      if (!await this.safe()) throw new ApiFailure(409, 'login-gate-and-admin-required');
      if (next.mode === 'cloudflare-token' && (!next.cloudflareToken || !next.publicHostname)) throw new ApiFailure(400, 'cloudflare-token-and-hostname-required');
    }
    this.saved = next; await this.persist(); await this.reconcile(); return this.status();
  }); }
}
export function connectorRpc(url: string, secretFile: string): ConnectorRpc {
  return async (method, config) => {
    const token = (await readFile(secretFile, 'utf8')).trim();
    const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, config }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('connector-rpc-failed'); return await response.json() as Runtime;
  };
}
