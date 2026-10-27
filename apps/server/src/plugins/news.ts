import type {Store} from '../db.js';
import {WatchlistReader} from '../profiles/watchlist.js';
import {seoulDay} from './schedule.js';
import type {WatchlistNews,WatchlistNewsEvent} from '@moa/shared';
export interface NewsProvider {enabled:boolean;configurationRevision:number;upcoming(kind:'movie'|'tv',id:number):Promise<Array<Omit<WatchlistNewsEvent,'mediaId'|'title'>>>}
/** Cache only public title events. Membership is always read again for the current profile. */
export class PluginNews {
 private reader:WatchlistReader;private active=0;private revision=-1;
 private cache=new Map<string,{until:number;value:Promise<Array<Omit<WatchlistNewsEvent,'mediaId'|'title'>>>}>();
 constructor(private db:Store,private provider:NewsProvider,private now=Date.now,private budgetMs=20000){this.reader=new WatchlistReader(db);}
 async list(profile:string):Promise<WatchlistNews>{
  const from=seoulDay(this.now()),through=seoulDay(this.now()+30*86400_000);
  const empty=(status:WatchlistNews['status']):WatchlistNews=>({provider:'tmdb',status,from,through,items:[],unlinked:0,checked:0,truncated:false});
  const allowed=()=>this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids===0;
  if(!allowed())return empty('restricted');
  if(!this.provider.enabled)return empty('unconfigured');
  const page=this.reader.list(profile,{limit:100});
  const linked=page.items.filter(x=>x.tmdb&&Number.isSafeInteger(x.tmdb.id)&&x.tmdb.id>0);
  const seen=new Set<string>();const selected=linked.filter(x=>{const key=`${x.tmdb!.kind}:${x.tmdb!.id}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,12);
  const result={...empty('ready'),unlinked:page.items.length-linked.length,checked:selected.length,truncated:!!page.nextCursor||seen.size>12};
  if(!selected.length)return result;
  if(this.active>=2)return empty('unavailable');this.active++;
  const revision=this.provider.configurationRevision;
  if(this.revision!==revision){this.cache.clear();this.revision=revision;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const work=Promise.allSettled(selected.map(async item=>{
    const key=`${item.tmdb!.kind}:${item.tmdb!.id}`;let cached=this.cache.get(key);
    if(!cached||cached.until<=this.now()){
     if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);
     cached={until:this.now()+30*60_000,value:Promise.resolve([])};const entry=cached;
     entry.value=Promise.resolve().then(()=>this.provider.upcoming(item.tmdb!.kind,item.tmdb!.id)).catch(e=>{entry.until=this.now()+60_000;throw e;});this.cache.set(key,entry);
    }
    return (await cached.value).filter(e=>e.date>=from&&e.date<=through).map(e=>({...e,mediaId:item.mediaId,title:item.title}));
   })).finally(()=>{this.active--;});
   const rows=await Promise.race([work,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),this.budgetMs);})]);
   if(!allowed())return empty('restricted');
   if(!this.provider.enabled||revision!==this.provider.configurationRevision)return empty('unavailable');
   if(!rows)return empty('unavailable');
   // Removal or relinking while a provider request was in flight must win.
   const current=this.reader.list(profile,{limit:100});
   const identities=new Map(current.items.map(i=>[i.mediaId,i.tmdb?`${i.tmdb.kind}:${i.tmdb.id}`:'']));
   result.items=rows.flatMap((r,i)=>r.status==='fulfilled'&&identities.get(selected[i].mediaId)===`${selected[i].tmdb!.kind}:${selected[i].tmdb!.id}`?r.value:[]).sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
   if(rows.every(r=>r.status==='rejected'))return empty('unavailable');
   result.truncated ||= rows.some(r=>r.status==='rejected')||page.revision!==current.revision;
   return result;
  }finally{if(timer)clearTimeout(timer);}
 }
}
