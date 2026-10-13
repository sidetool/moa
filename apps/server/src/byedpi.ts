import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiFailure } from './util.js';

/** Optional local SOCKS helper. Disabled means no child process, not a direct fallback. */
export class ByeDpi {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private wanted = false;
  private failures = 0;
  private ready = false;
  readonly proxy: string;
  constructor(private binary = process.env.MOA_BYEDPI_BINARY || '', private bind = process.env.MOA_BYEDPI_BIND || '127.0.0.1', private port = Number(process.env.MOA_BYEDPI_PORT || 1080), proxy = process.env.MOA_BYEDPI_PROXY) {
    if (!['127.0.0.1', '0.0.0.0'].includes(bind) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid-byedpi-config');
    this.proxy = proxy || `socks5://127.0.0.1:${port}`;
    const url = new URL(this.proxy);
    if (url.protocol !== 'socks5:' || url.username || url.password || url.search || url.hash || url.pathname && url.pathname !== '/') throw new Error('invalid-byedpi-config');
  }
  get available() { try { if (!this.binary) return false; accessSync(this.binary, constants.X_OK); return true; } catch { return false; } }
  get running() { return this.ready; }
  private probe() {
    return new Promise<boolean>(resolve => {
      const socket = connect(this.port, '127.0.0.1');
      let bytes = Buffer.alloc(0), done = false;
      const finish = (ok: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
      socket.setTimeout(250, () => finish(false));
      socket.on('error', () => finish(false)); socket.on('close', () => finish(false));
      socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
      socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= 2) finish(bytes[0] === 5 && bytes[1] === 0); });
    });
  }
  private schedule() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => this.schedule()); }, Math.min(60_000, 1000 * 2 ** Math.min(++this.failures, 6)));
    this.retry.unref();
  }
  start(): Promise<void> {
    if (!this.available) return Promise.reject(new ApiFailure(503, 'byedpi-unavailable'));
    this.wanted = true;
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    clearTimeout(this.retry); this.retry = undefined;
    const task = async () => {
      const child = spawn(this.binary, ['--ip', this.bind, '--port', String(this.port), '--no-udp', '--max-conn', '128', '--tlsrec', '1+s', '--auto=torst,ssl_err', '--disorder', '1'], { stdio: 'ignore', windowsHide: true });
      this.child = child;
      const exited = () => { if (this.child !== child) return; this.ready = false; this.child = undefined; this.schedule(); };
      child.once('error', exited); child.once('exit', exited);
      try {
        // Let bind errors exit before accepting the readiness of an unrelated listener.
        await delay(100);
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!this.wanted || this.child !== child || child.exitCode !== null) break;
          if (await this.probe()) { if (this.child === child && this.wanted) { this.ready = true; this.failures = 0; return; } break; }
          await delay(100);
        }
        throw new ApiFailure(503, 'byedpi-start-failed');
      } catch (error) { child.kill('SIGKILL'); throw error; }
    };
    this.starting = task().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async stop() {
    this.wanted = false; clearTimeout(this.retry); this.retry = undefined; this.ready = false;
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await this.starting?.catch(() => {});
    this.child = undefined;
  }
}
