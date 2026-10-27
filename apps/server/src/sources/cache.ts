import { CacheStats, type CacheOperation } from '../system/cache-stats.js';
import { Store } from '../db.js';

export interface ReadPolicy { freshMs: number; staleMs: number; background?: boolean; fallback?: boolean; cache?: boolean; operation?: CacheOperation }
export const SOURCE_CACHE_LIMITS = { maxEntries: 10_000, maxBytes: 128 * 1024 * 1024 } as const;
interface Entry<T> { value:T; fetched:number; retry:number; touched:number }
/** Shared source facts only. Profile responses, progress and playback URLs never enter this cache. */
export class SourceReadCache {
  private flights = new Map<string,Promise<unknown>>();
  private revisions = new Map<string,number>();
  constructor(private db:Store, private signal:AbortSignal, private clock=Date.now, private limits: {maxEntries:number;maxBytes:number}=SOURCE_CACHE_LIMITS, private stats?: CacheStats) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS source_read_cache(source_id TEXT NOT NULL REFERENCES source_entries(id),cache_key TEXT NOT NULL,payload TEXT NOT NULL,fetched INTEGER NOT NULL,retry INTEGER NOT NULL DEFAULT 0,touched INTEGER NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,cache_key));
      CREATE INDEX IF NOT EXISTS source_read_cache_age ON source_read_cache(touched);`);
    // Upgrade persisted caches once; size checks then read a small covering index, not JSON bodies.
    if(!db.all('PRAGMA table_info(source_read_cache)').some(column=>column.name==='bytes')) db.transaction(()=>{
      db.db.exec('ALTER TABLE source_read_cache ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0');
      db.run('UPDATE source_read_cache SET bytes=length(CAST(payload AS BLOB))');
    });
    db.db.exec('CREATE INDEX IF NOT EXISTS source_read_cache_bytes ON source_read_cache(bytes)');
  }
  private identity(source:string,key:string){return source+':'+key;}
  private entry<T>(source:string,key:string):Entry<T>|undefined {
    const row=this.db.get('SELECT payload,fetched,retry,touched FROM source_read_cache WHERE source_id=? AND cache_key=?',source,key);
    if(!row)return;
    try {return {value:JSON.parse(row.payload),fetched:row.fetched,retry:row.retry,touched:row.touched};}
    catch {this.db.run('DELETE FROM source_read_cache WHERE source_id=? AND cache_key=?',source,key);}
  }
  prime(source:string,key:string,value:unknown,fetched:number) {
    const payload=JSON.stringify(value);if(Buffer.byteLength(payload)>512*1024)return;
    const inserted=this.db.run('INSERT OR IGNORE INTO source_read_cache(source_id,cache_key,payload,fetched,retry,touched,bytes) VALUES(?,?,?,?,0,?,?)',source,key,payload,fetched,this.clock(),Buffer.byteLength(payload));
    if(inserted.changes)this.prune();
  }
  invalidate(source:string) {
    this.revisions.set(source,(this.revisions.get(source)||0)+1);
    this.db.run('DELETE FROM source_read_cache WHERE source_id=?',source);
  }
  clear(){for(const row of this.db.all('SELECT id FROM source_entries'))this.invalidate(row.id);}
  private put(source:string,key:string,value:unknown) {
    const payload=JSON.stringify(value);if(Buffer.byteLength(payload)>512*1024)return;
    this.db.run('INSERT OR REPLACE INTO source_read_cache(source_id,cache_key,payload,fetched,retry,touched,bytes) VALUES(?,?,?,?,0,?,?)',source,key,payload,this.clock(),this.clock(),Buffer.byteLength(payload));
    this.prune();
  }
  private prune() {
    const totals=this.db.get('SELECT count(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM source_read_cache INDEXED BY source_read_cache_bytes')!;
    let count=totals.count as number,bytes=totals.bytes as number;
    while(count>this.limits.maxEntries || bytes>this.limits.maxBytes){
      const oldest=this.db.all('SELECT rowid,bytes FROM source_read_cache ORDER BY touched,rowid LIMIT 128');
      if(!oldest.length)break;
      for(const row of oldest){
        this.db.run('DELETE FROM source_read_cache WHERE rowid=?',row.rowid);count--;bytes-=row.bytes;
        if(count<=this.limits.maxEntries && bytes<=this.limits.maxBytes)return;
      }
    }
  }

  async read<T>(source:string,key:string,policy:ReadPolicy,loader:(current:()=>void)=>Promise<T>):Promise<T> {
    this.signal.throwIfAborted();
    const revision=this.revisions.get(source)||0,identity=this.identity(source,key)+':'+revision;
    const current=()=>{this.signal.throwIfAborted();if((this.revisions.get(source)||0)!==revision)throw new Error('source_cache_invalidated');};
    const cached=policy.cache===false?undefined:this.entry<T>(source,key),age=cached?this.clock()-cached.fetched:Infinity;
    const usable=!!cached && age>=0 && age<=policy.staleMs;
    const operation=policy.operation ?? (key.startsWith('detail:')?'detail':key==='schema'?'filters':'list');
    if(usable && age<=policy.freshMs){
      this.stats?.cache(source,operation,'hit');
      // Minute precision is sufficient for eviction; warm views do not need a SQLite write each time.
      if(this.clock()-cached!.touched>=60_000)this.db.run('UPDATE source_read_cache SET touched=? WHERE source_id=? AND cache_key=?',this.clock(),source,key);
      return cached!.value;
    }
    const refresh=():Promise<T>=>{
      const flight=this.flights.get(identity);if(flight){this.stats?.cache(source,operation,'coalesced');return flight as Promise<T>;}
      const pending=Promise.resolve().then(()=>loader(current)).then(value=>{current();if(policy.cache!==false)this.put(source,key,value);return value;}).catch(error=>{
        if((this.revisions.get(source)||0)===revision)this.db.run('UPDATE source_read_cache SET retry=? WHERE source_id=? AND cache_key=?',this.clock()+30_000,source,key);
        throw error;
      }).finally(()=>{if(this.flights.get(identity)===pending)this.flights.delete(identity);});
      this.flights.set(identity,pending);return pending;
    };
    if(usable && policy.background!==false){
      this.stats?.cache(source,operation,'stale');
      if(cached!.retry<=this.clock())void refresh().catch(()=>{});
      return cached!.value;
    }
    this.stats?.cache(source,operation,'miss');
    try{return await refresh();}
    catch(error){current();if(usable && policy.fallback!==false)return cached!.value;throw error;}
  }
  async drain(source?:string){await Promise.allSettled([...this.flights].filter(([key])=>!source||key.startsWith(source+':')).map(([,flight])=>flight));}
}
