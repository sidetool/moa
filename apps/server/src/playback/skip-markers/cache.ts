import { createHash } from "node:crypto";
import type { CacheEntry, CacheStore } from "./types.js";

export function cacheKey(namespace: string, value: unknown): string {
  return `skip-markers:${namespace}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
export async function readCache<T>(cache: CacheStore | undefined, key: string): Promise<T | undefined> {
  const entry = await cache?.get(key);
  return entry && (entry.expiresAt === undefined || entry.expiresAt > Date.now()) ? entry.value as T : undefined;
}
/** Useful for tests/small installations. SQLite adapters implement the same two methods. */
export class MemoryCache implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | undefined> {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : structuredClone(entry);
  }
  async set(key: string, entry: CacheEntry): Promise<void> { this.entries.set(key, structuredClone(entry)); }
}
