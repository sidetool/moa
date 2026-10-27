import type { RequestOptions } from "./types.js";

export function deadline(options: RequestOptions = {}) {
  const ms = options.timeoutMs ?? 12_000;
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError("timeoutMs must be positive");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), ms);
  const externalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); options.signal?.removeEventListener("abort", externalAbort); },
  };
}

export function failureCode(error: unknown, signal: AbortSignal): "timeout" | "aborted" | "error" {
  const reason = signal.aborted ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError") return "timeout";
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
  return "error";
}

/** Bounds even an injected cache that does not support cancellation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function parallel<T>(items: T[], concurrency: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal.aborted && cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  }));
}
