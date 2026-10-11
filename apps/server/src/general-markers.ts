import type { SkipMarkers } from '@moa/skip-markers';
import type { Store } from './db.js';

export interface GeneralMarkerIdentity { kind:'movie'|'tv'; id:number; season?:number; episode?:number }
/** TheIntroDB v3: select a duration group, never merge unspecified editions. */
export class GeneralMarkers {
  private cache=new Map<string,{until:number;value:SkipMarkers|null}>();
  private pending=new Map<string,Promise<SkipMarkers|null>>();
  private abort=new AbortController();
  constructor(private db:Store,private fetcher:typeof fetch=fetch){}
  close(){this.abort.abort();this.cache.clear();}
  identity(episodeId:string):GeneralMarkerIdentity|null{
    const r=this.db.get(`SELECT e.season,e.number,m.type,l.kind,l.tmdb_id,l.season AS linked_season,
      (SELECT COUNT(DISTINCT season) FROM episodes WHERE media_id=m.id) AS seasons
      FROM episodes e JOIN media m ON m.id=e.media_id JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual') WHERE e.id=?`,episodeId);
    if(!r||!Number.isSafeInteger(r.tmdb_id)||r.tmdb_id<1||!['movie','series'].includes(r.type))return null;
    if(r.type==='movie')return r.kind==='movie'?{kind:'movie',id:r.tmdb_id}:null;
    // A title containing several seasons must use its real episode seasons. A single
    // season title may be explicitly linked to one TMDB season. Specials/combined episodes excluded.
    const season=r.seasons===1?(r.linked_season??r.season):r.season;
    if(r.kind!=='tv'||!Number.isSafeInteger(season)||season<1||!Number.isSafeInteger(r.number)||r.number<1||r.seasons>1&&r.linked_season!=null)return null;
    return {kind:'tv',id:r.tmdb_id,season,episode:r.number};
  }
  async get(episode:string,session:string,duration:number):Promise<SkipMarkers|null>{
    const identity=this.identity(episode);if(!identity||!Number.isFinite(duration)||duration<60||duration>21600)return null;
    const key=JSON.stringify([session,identity,Math.round(duration*1000)]),saved=this.cache.get(key);
    if(saved&&saved.until>Date.now())return saved.value;
    if(this.pending.has(key))return this.pending.get(key)!;
    if(this.pending.size>=3||this.abort.signal.aborted)return null;
    const task=this.lookup(identity,duration).then(value=>{this.cache.set(key,{until:Date.now()+(value?3600_000:300_000),value});if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value!);return value;}).catch(()=>{this.cache.set(key,{until:Date.now()+30000,value:null});return null;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  private async json(params:URLSearchParams):Promise<any>{
    const r=await this.fetcher(`https://api.theintrodb.org/v3/media?${params}`,{redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)])});
    if(!r.ok){await r.body?.cancel();throw Error('provider-unavailable');}
    const reader=r.body?.getReader();if(!reader)throw Error();let size=0;const parts:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>128*1024)throw Error('provider-response-limit');parts.push(value);}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(parts).toString());
  }
  private matches(raw:any,id:GeneralMarkerIdentity){return raw?.tmdb_id===id.id&&raw.type===id.kind&&(id.kind==='movie'||raw.season===id.season&&raw.episode===id.episode);}
  private async lookup(id:GeneralMarkerIdentity,duration:number):Promise<SkipMarkers|null>{
    const q=new URLSearchParams({tmdb_id:String(id.id)});if(id.kind==='tv'){q.set('season',String(id.season));q.set('episode',String(id.episode));}
    const versions=await this.json(new URLSearchParams([...q,['list_versions','true']]));
    if(!this.matches(versions,id)||!Array.isArray(versions.versions))return null;
    const ms=Math.round(duration*1000);
    const candidates=versions.versions.filter((v:any)=>Number.isSafeInteger(v.duration_ms)&&v.duration_ms>0&&Math.abs(v.duration_ms-ms)<=2000);
    if(candidates.length!==1)return null;
    // Send the actual duration, not a catalog/selected group's substitute duration.
    q.set('duration_ms',String(ms));q.set('merge_unknown','false');
    const raw=await this.json(q);if(!this.matches(raw,id))return null;
    const interval=(value:any,credits:boolean)=>{
      if(!Array.isArray(value)||value.length!==1)return null;
      const {start_ms:start,end_ms:end}=value[0]??{};
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>ms||end-start>600_000)return null;
      if(credits?start<ms*.5:end>ms*.5)return null;
      return [start/1000,end/1000];
    };
    const intro=interval(raw.intro,false),credits=interval(raw.credits,true);
    return intro||credits?{source:'theintrodb',confidence:.8,...(intro?{introStart:intro[0],introEnd:intro[1]}:{}),...(credits?{creditsStart:credits[0],creditsEnd:credits[1]}:{})}:null;
  }
}
