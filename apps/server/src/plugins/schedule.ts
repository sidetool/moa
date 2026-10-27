import type {Store} from '../db.js';
import {ApiFailure} from '../util.js';
import type {ScheduleQuery,ScheduleResponse,ScheduleItem} from '@moa/shared';
export const seoulDay=(now:number)=>new Date(now+9*3600_000).toISOString().slice(0,10);
export interface ScheduleProvider { enabled:boolean; configurationRevision:number; movieSchedule(date:string):Promise<{items:ScheduleItem[];truncated:boolean}> }
export interface ScheduleOptions { fetch?:typeof fetch; now?:()=>number }
/** Fixed-date provider lookup, bounded in-memory cache; no background polling. */
export class PluginSchedule {
 private cache=new Map<string,{until:number;promise:Promise<{items:ScheduleItem[];truncated:boolean}>}>();
 private active=0;private abort=new AbortController();private now:()=>number;private revision=-1;
 constructor(private db:Store,private movies:ScheduleProvider,private options:ScheduleOptions={}){this.now=options.now||Date.now;}
 close(){this.abort.abort();this.cache.clear();}
 private async television(date:string){
  const u=new URL('https://api.tvmaze.com/schedule');u.searchParams.set('country','KR');u.searchParams.set('date',date);
  const r=await (this.options.fetch||fetch)(u,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(8000),this.abort.signal])});
  if(!r.ok){await r.body?.cancel();throw Error('schedule-unavailable');}
  const reader=r.body?.getReader();if(!reader)throw Error('empty-response');let size=0;const parts:Uint8Array[]=[];
  try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>2*1024*1024)throw Error('response-too-large');parts.push(x.value);}}finally{await reader.cancel();}
  const rows=JSON.parse(Buffer.concat(parts).toString());if(!Array.isArray(rows))throw Error('invalid-schedule');
  const items:ScheduleItem[]=[],seen=new Set<number>();
  for(const row of rows){
   const s=row?.show,channel=s?.network||s?.webChannel;
   if(!Number.isSafeInteger(row?.id)||row.id<1||seen.has(row.id)||s?.type!=='Scripted'||channel?.country?.code!=='KR'||typeof s.name!=='string')continue;
   const timestamp=typeof row.airstamp==='string'?Date.parse(row.airstamp):NaN;
   if((Number.isFinite(timestamp)?seoulDay(timestamp):row.airdate)!==date)continue;
   seen.add(row.id);
   const time=typeof row.airtime==='string'&&/^\d{2}:\d{2}$/.test(row.airtime)&&Number.isFinite(timestamp)&&seoulDay(timestamp)===date?new Date(timestamp+9*3600_000).toISOString().slice(11,16):null;
   items.push({id:String(row.id),title:s.name.slice(0,200),date,time,detail:[typeof channel.name==='string'?channel.name.slice(0,80):'',Number.isInteger(row.season)&&Number.isInteger(row.number)?`시즌 ${row.season} · ${row.number}화`:'회차 미정'].filter(Boolean).join(' · ')});
  }
  items.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99')||a.title.localeCompare(b.title));return {items:items.slice(0,40),truncated:items.length>40};
 }
 async list(profile:string,query:ScheduleQuery):Promise<ScheduleResponse>{
  const today=seoulDay(this.now()),end=seoulDay(this.now()+6*86400_000);
  if(!query||!['movie','tv'].includes(query.kind)||typeof query.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(query.date)||query.date<today||query.date>end||!Number.isFinite(Date.parse(query.date))||new Date(query.date).toISOString().slice(0,10)!==query.date)throw new ApiFailure(400,'invalid-schedule-query');
  const provider=query.kind==='movie'?'tmdb':'tvmaze',empty=(status:ScheduleResponse['status']):ScheduleResponse=>({provider,date:query.date,status,items:[],truncated:false});
  const allowed=()=>this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids===0;
  if(!allowed())return empty('restricted');if(query.kind==='movie'&&!this.movies.enabled)return empty('unconfigured');
  if(this.revision!==this.movies.configurationRevision){this.cache.clear();this.revision=this.movies.configurationRevision;}
  const revision=this.revision,key=`${query.kind}:${query.date}`;let entry=this.cache.get(key);
  if(!entry||entry.until<=this.now()){
   if(this.active>=2)return empty('unavailable');if(this.cache.size>=14)this.cache.delete(this.cache.keys().next().value!);
   this.active++;entry={until:this.now()+30*60_000,promise:Promise.resolve({items:[],truncated:false})};const target=entry;
   target.promise=Promise.resolve().then(()=>query.kind==='movie'?this.movies.movieSchedule(query.date):this.television(query.date)).catch(e=>{target.until=this.now()+60_000;throw e;}).finally(()=>this.active--);this.cache.set(key,target);
  }
  try{const value=await entry.promise;if(!allowed())return empty('restricted');if(query.kind==='movie'&&(!this.movies.enabled||revision!==this.movies.configurationRevision))return empty('unavailable');return {...empty('ready'),...value};}
  catch{return empty(allowed()?'unavailable':'restricted');}
 }
}
