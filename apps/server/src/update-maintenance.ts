import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiFailure } from './util.js';

/** File-based lease: the web process never receives host commands or Docker access. */
export class UpdateMaintenance {
  private lease?: { id: string; expiresAt: number };
  private inFlight = 0;
  private ticking = false;
  private timer?: NodeJS.Timeout;
  constructor(private dir: string | undefined, private busy: () => boolean) {}
  get paused() { return Boolean(this.lease && this.lease.expiresAt > Date.now()); }
  async tick() {
    if (!this.dir || this.ticking) return;
    this.ticking = true;
    let temp: string | undefined;
    try {
      try {
        const content = await readFile(path.join(this.dir, 'maintenance.json'), 'utf8');
        if (content.length > 4096) throw new Error();
        const lease = JSON.parse(content);
        if (!/^[a-f0-9-]{36}$/.test(lease.id) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt > Date.now() + 60000) throw new Error();
        this.lease = lease;
      } catch { this.lease = undefined; }
      temp = path.join(this.dir, `activity-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ heartbeat: Date.now(), busy: this.inFlight > 0 || this.busy(), leaseId: this.paused ? this.lease!.id : null }), { flag: 'wx', mode: 0o660 });
      await rename(temp, path.join(this.dir, 'activity.json'));
    } catch { /* A missing heartbeat prevents host-side automatic installation. */ }
    finally { if (temp) await rm(temp, { force: true }).catch(() => {}); this.ticking = false; }
  }
  register(app: FastifyInstance) {
    if (!this.dir) return;
    app.addHook('onRequest', async (req, reply) => {
      const route = req.routeOptions.url ?? req.url.split('?')[0];
      if (!route.startsWith('/api/') || route === '/api/health' || route.startsWith('/api/admin/updates') || req.method === 'GET' && route === '/api/admin/components') return;
      if (this.paused) throw new ApiFailure(503, 'update-maintenance');
      this.inFlight++;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; this.inFlight--; } };
      reply.raw.once('finish', finish); reply.raw.once('close', finish);
    });
    app.addHook('onReady', async () => { await this.tick(); this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref(); });
    app.addHook('onClose', async () => { clearInterval(this.timer); });
  }
}
