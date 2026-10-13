import type {Store} from './db.js';
import type {BoxOfficeResponse} from '@moa/shared';
import {ApiFailure} from './util.js';
import {seoulDay} from './plugin-schedule.js';
export interface BoxOfficeOptions {key?:string;fetch?:typeof fetch;now?:()=>number}
/** KOBIS key stays on the host. No caller-controlled URLs or credential-bearing error messages. */
export class PluginBoxOffice {
 private abort=new AbortController();private now:()=>number;private key:string;private active=0;
 private cache=new Map<string,{until:number;value:Promise<BoxOfficeResponse>}>();
 constructor(private db:Store,private options:BoxOfficeOptions={}){this.now=options.now||Date.now;this.key=(options.key??process.env.MOA_KOBIS_API_KEY??'').trim();}
 close(){this.abort.abort();this.cache.clear();}
 async list(profile:string,period:'day'|'week'):Promise<BoxOfficeResponse>{
  if(!['day','week'].includes(period))throw new ApiFailure(400,'invalid-boxoffice-query');
  const today=seoulDay(this.now()),dayMs=86400_000;
  const yesterday=new Date(Date.parse(today)-dayMs);
  // Last completed Monday-Sunday period, not a partial current week.
  const sunday=new Date(Date.parse(today)-(new Date(today).getUTCDay()||7)*dayMs);
  const target=(period==='day'?yesterday:sunday).toISOString().slice(0,10);
  const from=period==='day'?target:new Date(sunday.getTime()-6*dayMs).toISOString().slice(0,10);
  const empty=(status:BoxOfficeResponse['status']):BoxOfficeResponse=>({provider:'kobis',period,from,through:target,status,items:[]});
  const allowed=()=>this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids===0;
  if(!allowed())return empty('restricted');if(!this.key)return empty('unconfigured');
  const cacheKey=`${period}:${target}`;let cached=this.cache.get(cacheKey);
  if(!cached||cached.until<=this.now()){
   if(this.active>=2)return empty('unavailable');if(this.cache.size>=4)this.cache.delete(this.cache.keys().next().value!);
   this.active++;cached={until:this.now()+30*60_000,value:Promise.resolve(empty('unavailable'))};const entry=cached;
   entry.value=this.fetch(period,target,from).catch(()=>{entry.until=this.now()+60_000;return empty('unavailable');}).finally(()=>this.active--);this.cache.set(cacheKey,entry);
  }
  const result=await cached.value;return allowed()?result:empty('restricted');
 }
 private async fetch(period:'day'|'week',date:string,from:string):Promise<BoxOfficeResponse>{
  const url=new URL(`https://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice/${period==='day'?'searchDailyBoxOfficeList':'searchWeeklyBoxOfficeList'}.json`);
  url.searchParams.set('key',this.key);url.searchParams.set('targetDt',date.replaceAll('-',''));url.searchParams.set('itemPerPage','10');if(period==='week')url.searchParams.set('weekGb','0');
  const response=await(this.options.fetch||fetch)(url,{redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(8000)])});
  if(!response.ok){await response.body?.cancel();throw Error('unavailable');}
  const reader=response.body?.getReader();if(!reader)throw Error('unavailable');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>512*1024)throw Error('unavailable');chunks.push(r.value);}}finally{await reader.cancel();}
  const data=JSON.parse(Buffer.concat(chunks).toString());if(data.faultInfo)throw Error('unavailable');
  const box=data.boxOfficeResult,list=box?.[period==='day'?'dailyBoxOfficeList':'weeklyBoxOfficeList'];
  if(!Array.isArray(list)||box.showRange!==`${from.replaceAll('-','')}~${date.replaceAll('-','')}`)throw Error('unavailable');
  const items:BoxOfficeResponse['items']=[],seen=new Set<string>(),ranks=new Set<number>();
  const integer=(v:unknown)=>typeof v==='string'&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
  for(const row of list.slice(0,10)){
   const rank=integer(row?.rank),audience=integer(row?.audiCnt),totalAudience=integer(row?.audiAcc);
   if(!rank||rank>10||ranks.has(rank)||typeof row.movieCd!=='string'||!/^\d{1,12}$/.test(row.movieCd)||seen.has(row.movieCd)||typeof row.movieNm!=='string'||!row.movieNm.trim()||audience===null||totalAudience===null)throw Error('unavailable');
   const change=typeof row.rankInten==='string'&&/^-?\d+$/.test(row.rankInten)&&Number.isSafeInteger(Number(row.rankInten))?Number(row.rankInten):null;
   seen.add(row.movieCd);ranks.add(rank);items.push({id:row.movieCd,title:row.movieNm.slice(0,200),rank,audience,totalAudience,change,isNew:row.rankOldAndNew==='NEW'});
  }
  items.sort((a,b)=>a.rank-b.rank);return {provider:'kobis',period,from,through:date,status:'ready',items};
 }
}
