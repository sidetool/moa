export type CacheOperation = 'search' | 'list' | 'detail' | 'videos' | 'filters';
export type CacheOutcome = 'hit' | 'stale' | 'miss' | 'coalesced';
/** Runtime invocations, not individual HTTP requests inside extensions. */
export class CacheStats {
  readonly startedAt = Date.now();
  private sources = new Map<string, Record<CacheOperation, { externalCalls: number; hit: number; stale: number; miss: number; coalesced: number }>>();
  private row(source: string, operation: CacheOperation) {
    let rows = this.sources.get(source);
    if (!rows) {
      rows = Object.fromEntries(['search','list','detail','videos','filters'].map(op => [op, { externalCalls: 0, hit: 0, stale: 0, miss: 0, coalesced: 0 }])) as NonNullable<typeof rows>;
      this.sources.set(source, rows);
    }
    return rows[operation];
  }
  external(source: string, operation: CacheOperation) { this.row(source, operation).externalCalls++; }
  cache(source: string, operation: CacheOperation, outcome: CacheOutcome) { this.row(source, operation)[outcome]++; }
  snapshot() { return { startedAt: this.startedAt, externalCallUnit: 'source-runtime-invocation', sources: structuredClone(Object.fromEntries(this.sources)) }; }
}
