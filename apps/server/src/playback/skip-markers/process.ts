import { spawn } from "node:child_process";

export interface CommandOptions { signal?: AbortSignal; input?: Buffer; maxBytes?: number; timeoutMs?: number }
export type CommandRunner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<Buffer>;

/** No shell interpolation. Bound output, time, and terminate/reap the child on cancellation. */
export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  let failure: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: Error) => {
    if (failure) return;
    failure = error;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException("Aborted", "AbortError"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Error(`${command}: timed out`)), options.timeoutMs ?? 60_000);
  timer.unref();
  const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort); };
  child.on("error", error => { cleanup(); reject(error); });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) stop(new Error(`${command}: output limit exceeded`));
    else chunks.push(chunk);
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error); });
  child.on("close", code => {
    cleanup();
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error(`${command}: exited ${code}: ${stderr.trim()}`));
    else resolve(Buffer.concat(chunks));
  });
  child.stdin.end(options.input);
  if (options.signal?.aborted) abort();
});

/** Reuse one analyzer instance across season jobs to share its concurrency limit. */
export class Semaphore {
  private active = 0;
  private readonly queue: { resolve: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }[] = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new RangeError("concurrency must be 1..32");
  }
  async use<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (this.active < this.limit) { this.active++; resolve(); return; }
      const entry = { resolve, reject, signal, abort: () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason);
      } };
      this.queue.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
    });
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      this.active--;
      const next = this.queue.shift();
      if (next) { next.signal?.removeEventListener("abort", next.abort); this.active++; next.resolve(); }
    }
  }
}
