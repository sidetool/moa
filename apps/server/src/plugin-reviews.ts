import {load} from 'cheerio';
import type {Store} from './db.js';
import type {Tmdb} from './tmdb.js';
import type {ReviewResponse, ReviewItem, ReviewProvider} from '@moa/shared';

export interface ReviewOptions { naverId?:string; naverSecret?:string; kakaoKey?:string; fetch?:typeof fetch }
export function reviewText(value:unknown, max=600) {
  if(typeof value!=='string')return '';
  return load(value.slice(0,40_000)).text().replace(/\s+/g,' ').trim().slice(0,max);
}
export function reviewUrl(value:unknown):string|null {
  try { const u=new URL(String(value));return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&u.hostname.includes('.')&&u.href.length<=2048?u.href:null; } catch{return null;}
}
/** Fixed official endpoints only. Never retrieves the linked article or scrapes its full text. */
export class PluginReviews {
  private cache=new Map<string,{until:number;promise:Promise<ReviewItem[]>}>();
  private active=0;
  constructor(private db:Store,private tmdb:Tmdb,private options:ReviewOptions={},private now=Date.now){}
  private title(id:string){return this.db.get('SELECT title,type FROM media WHERE id=?',id);}
  private allowed(profile:string){return this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids===0;}
  private async search(provider:'naver'|'kakao',query:string):Promise<ReviewItem[]> {
    const naver=provider==='naver';
    const u=new URL(naver?'https://openapi.naver.com/v1/search/blog.json':'https://dapi.kakao.com/v2/search/blog');
    u.searchParams.set('query',query);u.searchParams.set(naver?'display':'size','8');u.searchParams.set('sort',naver?'sim':'accuracy');
    const headers:Record<string,string>=naver?{'X-Naver-Client-Id':this.options.naverId!,'X-Naver-Client-Secret':this.options.naverSecret!}:{Authorization:`KakaoAK ${this.options.kakaoKey}`};
    const r=await (this.options.fetch||fetch)(u,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw Error('review-provider-unavailable');
    const reader=r.body?.getReader();if(!reader)throw Error('empty-response');
    const chunks:Uint8Array[]=[];let total=0;
    try {while(true){const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>512*1024)throw Error('response-too-large');chunks.push(x.value);}}finally{await reader.cancel();}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8')),rows=naver?data.items:data.documents;
    if(!Array.isArray(rows))throw Error('invalid-response');
    const found=new Set<string>(),items:ReviewItem[]=[];
    for(const row of rows.slice(0,30)){
      const url=reviewUrl(naver?row.link:row.url),title=reviewText(row.title,200);
      if(!url||!title||found.has(url))continue;found.add(url);
      items.push({url,title,excerpt:reviewText(naver?row.description:row.contents),author:reviewText(naver?row.bloggername:row.blogname,100),date:reviewText(naver?row.postdate:row.datetime,40),kind:'article',language:'unknown'});
      if(items.length===8)break;
    }return items;
  }
  async list(profile:string,mediaId:string,provider:ReviewProvider):Promise<ReviewResponse>{
    const empty=(status:ReviewResponse['status']):ReviewResponse=>({mediaId,provider,status,query:'',items:[]});
    if(!this.allowed(profile))return empty('restricted');
    const title=this.title(mediaId);if(!title)return empty('unavailable');
    const name=reviewText(title.title,140).replace(/["\r\n]/g,' ');
    const query=`${name} ${title.type==='movie'?'영화':title.type==='anime'?'애니':'드라마'} 리뷰`;
    const reply=(status:ReviewResponse['status'],items:ReviewItem[]=[]):ReviewResponse=>({mediaId,provider,status,query,items});
    const linked=this.tmdb.linkedTitle(mediaId),stamp=JSON.stringify([title,linked,this.tmdb.configurationRevision]);
    const valid=()=>this.allowed(profile)&&stamp===JSON.stringify([this.title(mediaId),this.tmdb.linkedTitle(mediaId),this.tmdb.configurationRevision]);
    if(provider==='naver'&&!(this.options.naverId&&this.options.naverSecret)||provider==='kakao'&&!this.options.kakaoKey||provider==='tmdb'&&!this.tmdb.enabled)return reply('unconfigured');
    if(provider==='tmdb'&&!linked)return reply('unlinked');
    const key=JSON.stringify([provider,provider==='tmdb'?linked:query,this.tmdb.configurationRevision]);
    let cached=this.cache.get(key);
    if(!cached||cached.until<this.now()){
      if(this.active>=4)return reply('unavailable');
      if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value!);
      this.active++;
      const entry={until:this.now()+10*60_000,promise:Promise.resolve([] as ReviewItem[])};
      entry.promise=(provider==='tmdb'?this.tmdb.reviewItems(linked!):this.search(provider,query)).catch(e=>{entry.until=this.now()+30_000;throw e;}).finally(()=>this.active--);
      this.cache.set(key,entry);cached=entry;
    }
    try{const items=await cached.promise;return valid()?reply('ready',items):empty(this.allowed(profile)?'unavailable':'restricted');}
    catch{return valid()?reply('unavailable'):empty(this.allowed(profile)?'unavailable':'restricted');}
  }
}
