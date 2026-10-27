import { AniListClient } from '../metadata/anilist-client.js';
import {load} from 'cheerio';
import type {Store} from '../db.js';
import type {Tmdb} from '../metadata/tmdb.js';
import type {ReviewResponse,ReviewItem,ReviewProvider,ReviewCandidate} from '@moa/shared';
export interface ReviewOptions { fetch?:typeof fetch; anilist?:AniListClient }
export function reviewText(value:unknown,max=600){return typeof value==='string'?load(value.slice(0,40_000)).text().replace(/\s+/g,' ').trim().slice(0,max):'';}

/** On-demand, public reviews. No accounts, tracking sync, full-text archive or background crawling. */
export class PluginReviews {
  private cache=new Map<string,{until:number;promise:Promise<any>}>();
  private active=0;
  private anilist:AniListClient;
  private abort=new AbortController();
  constructor(private db:Store,private tmdb:Tmdb,options:ReviewOptions={},private now=Date.now){this.anilist=options.anilist??new AniListClient(options.fetch,now);}
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
    return this.anilist.graphql(query,variables,this.abort.signal,512*1024);
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
