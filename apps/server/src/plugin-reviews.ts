import {load} from 'cheerio';
import type {Store} from './db.js';
import type {Tmdb} from './tmdb.js';
import type {ReviewResponse,ReviewItem,ReviewProvider,ReviewCandidate} from '@moa/shared';
export interface ReviewOptions { fetch?:typeof fetch }
export function reviewText(value:unknown,max=600){return typeof value==='string'?load(value.slice(0,40_000)).text().replace(/\s+/g,' ').trim().slice(0,max):'';}

/** On-demand, public reviews. No accounts, tracking sync, full-text archive or background crawling. */
export class PluginReviews {
  private cache=new Map<string,{until:number;promise:Promise<any>}>();
  private active=0;
  private retryAt=0;
  private requests:number[]=[];
  private abort=new AbortController();
  constructor(private db:Store,private tmdb:Tmdb,private options:ReviewOptions={},private now=Date.now){}
  close(){this.abort.abort();this.cache.clear();}
  private title(id:string){
    const row=this.db.get('SELECT title,type FROM media WHERE id=?',id);
    if(!row)return null;
    const link=this.tmdb.linkedTitle(id);
    const card=link?this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?',link.kind,Number(link.id))?.card:null;
    let originalTitle='';try{originalTitle=reviewText(JSON.parse(card||'{}').originalTitle,140);}catch{}
    return {title:String(row.title),type:String(row.type),originalTitle};
  }
  private allowed(profile:string){return this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids===0;}
  private async cached<T>(key:string,fetcher:()=>Promise<T>):Promise<T>{
    let entry=this.cache.get(key);
    if(entry&&entry.until>this.now())return entry.promise;
    if(this.active>=4)throw Error('provider-busy');
    if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value!);
    this.active++;
    entry={until:this.now()+10*60_000,promise:Promise.resolve()};const target=entry;
    target.promise=Promise.resolve().then(fetcher).catch(error=>{target.until=this.now()+30_000;throw error;}).finally(()=>this.active--);
    this.cache.set(key,target);return target.promise;
  }
  private async graphql(query:string,variables:object):Promise<any>{
    this.requests=this.requests.filter(t=>t>this.now()-60_000);
    if(this.retryAt>this.now()||this.requests.length>=20)throw Error('provider-busy');
    this.requests.push(this.now());
    const r=await (this.options.fetch||fetch)('https://graphql.anilist.co',{
      method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},redirect:'error',
      body:JSON.stringify({query,variables}),signal:AbortSignal.any([AbortSignal.timeout(8000),this.abort.signal])
    });
    if(r.status===429){const seconds=Number(r.headers.get('retry-after'));this.retryAt=this.now()+Math.min(300,Math.max(60,Number.isFinite(seconds)?seconds:60))*1000;}
    if(!r.ok){await r.body?.cancel();throw Error('review-provider-unavailable');}
    const reader=r.body?.getReader();if(!reader)throw Error('empty-response');
    const chunks:Uint8Array[]=[];let total=0;
    try{while(true){const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>512*1024)throw Error('response-too-large');chunks.push(x.value);}}finally{await reader.cancel();}
    const json=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(json.errors?.length||!json.data)throw Error('invalid-graphql-response');return json.data;
  }
  private candidates(search:string):Promise<ReviewCandidate[]>{
    return this.cached(`anilist-search:${search}`,async()=>{
      const data=await this.graphql('query($search:String!){Page(page:1,perPage:5){media(search:$search,type:ANIME,isAdult:false){id isAdult title{romaji english native}startDate{year}format}}}',{search});
      if(!Array.isArray(data.Page?.media))throw Error('invalid-search');
      return data.Page.media.slice(0,5).flatMap((m:any)=>{
        const title=reviewText(m?.title?.native||m?.title?.english||m?.title?.romaji,200);
        return Number.isSafeInteger(m?.id)&&m.id>0&&m.isAdult===false&&title?[{id:String(m.id),title,alternative:reviewText(m.title.english||m.title.romaji,200),year:Number.isInteger(m.startDate?.year)?m.startDate.year:null,format:reviewText(m.format,30)}]:[];
      });
    });
  }
  private animeReviews(id:string):Promise<ReviewItem[]>{
    return this.cached(`anilist-reviews:${id}`,async()=>{
      const data=await this.graphql('query($id:Int!){Media(id:$id,type:ANIME){id isAdult reviews(page:1,perPage:8){nodes{id mediaId summary body(asHtml:false) siteUrl createdAt user{name}}}}}',{id:Number(id)});
      if(data.Media?.id!==Number(id)||data.Media.isAdult!==false||!Array.isArray(data.Media.reviews?.nodes))throw Error('invalid-review-title');
      const seen=new Set<string>();
      return data.Media.reviews.nodes.slice(0,8).flatMap((r:any)=>{
        if(r?.mediaId!==Number(id)||typeof r.siteUrl!=='string'||!/^https:\/\/anilist\.co\/review\/[1-9][0-9]*\/?$/.test(r.siteUrl)||seen.has(r.siteUrl))return [];
        seen.add(r.siteUrl);return [{url:r.siteUrl,title:reviewText(r.summary,200)||'사용자 리뷰',excerpt:reviewText(r.body),author:reviewText(r.user?.name,100),date:'',kind:'review' as const,language:'unknown' as const}];
      });
    });
  }
  async list(profile:string,mediaId:string,provider:ReviewProvider,selection?:string):Promise<ReviewResponse>{
    const empty=(status:ReviewResponse['status']):ReviewResponse=>({mediaId,provider,status,query:'',items:[],candidates:[]});
    if(!this.allowed(profile))return empty('restricted');
    const title=this.title(mediaId);if(!title)return empty('unavailable');
    const query=`${reviewText(title.title,140)} 리뷰`;
    const reply=(status:ReviewResponse['status'],items:ReviewItem[]=[],candidates:ReviewCandidate[]=[]):ReviewResponse=>({mediaId,provider,status,query,items,candidates});
    const linked=this.tmdb.linkedTitle(mediaId),stamp=JSON.stringify([title,linked,this.tmdb.configurationRevision]);
    const changed=():ReviewResponse['status']|null=>!this.allowed(profile)?'restricted':stamp!==JSON.stringify([this.title(mediaId),this.tmdb.linkedTitle(mediaId),this.tmdb.configurationRevision])?'unavailable':null;
    if(provider==='tmdb'&&!this.tmdb.enabled)return reply('unconfigured');
    if(provider==='tmdb'&&!linked)return reply('unlinked');
    try{
      let items:ReviewItem[];
      if(provider==='anilist'){
        const candidates=await this.candidates(title.originalTitle||reviewText(title.title,140));
        const status=changed();if(status)return empty(status);
        if(!selection||!candidates.some(x=>x.id===selection))return reply('select',[],candidates);
        items=await this.animeReviews(selection);
      }else items=await this.cached(JSON.stringify(['tmdb',linked,this.tmdb.configurationRevision]),()=>this.tmdb.reviewItems(linked!));
      const status=changed();return status?empty(status):reply('ready',items);
    }catch{return empty(changed()||'unavailable');}
  }
}
