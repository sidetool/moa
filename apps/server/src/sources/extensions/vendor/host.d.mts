export class ExtensionRuntimeError extends Error {
  readonly code: string;
}
export function runExtension(input: {
  source: string;
  method: string;
  input?: unknown;
  broker?: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  memoryBytes?: number;
  profile?: 'mangayomi-v1' | 'source-webview-v1';
}): Promise<unknown>;
