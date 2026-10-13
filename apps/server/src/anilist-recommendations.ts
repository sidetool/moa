import type { MetadataCandidate } from '@moa/shared';

export interface AnimeSeed { kind:'tv'|'movie'; id:number; title:string; originalTitle?:string; year:number }
interface Anime { id:number; type:string; format:string; isAdult:boolean; title:{native?:string;romaji?:string;english?:string}; startDate:{year?:number}; recommendations?:{nodes?:{rating:number;mediaRecommendation?:Anime}[]} }
const names=(a:Anime)=>Object.values(a.title??{}).filter((s):s is string=>typeof s==='string'&&s.length>0&&s.length<=300);
// Keep numerals/season qualifiers. No fuzzy franchise or season collapsing.
const normalized=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const overlap=(a:string[],b:string[])=>a.some(s=>normalized(s).length>1&&b.some(t=>normalized(s)===normalized(t)));
const valid=(a:Anime)=>a&&Number.isSafeInteger(a.id)&&a.id>0&&a.type==='ANIME'&&a.isAdult===false&&['TV','MOVIE'].includes(a.format)&&Number.isSafeInteger(a.startDate?.year)&&names(a).length>0;
export function matchAnimeSeed(seed:AnimeSeed, rows:Anime[]):Anime|undefined {
  const matches=rows.filter(a=>valid(a)&&a.format===(seed.kind==='movie'?'MOVIE':'TV')&&a.startDate.year===seed.year&&overlap([seed.originalTitle||seed.title],names(a)));
  return matches.length===1?matches[0]:undefined;
}
export function matchAnimeCandidate(anime:Anime,rows:MetadataCandidate[]):MetadataCandidate|undefined {
  if(!valid(anime))return;
  const unique=new Map(rows.filter(r=>r&&Number.isSafeInteger(r.id)&&r.id>0&&r.kind===(anime.format==='MOVIE'?'movie':'tv')&&r.year===anime.startDate.year&&r.genreIds?.includes(16)&&overlap(names(anime),[r.originalTitle||r.title])).map(r=>[`${r.kind}:${r.id}`,r]));
  return unique.size===1?[...unique.values()][0]:undefined;
}
const fields='id type format isAdult title { native romaji english } startDate { year }';
const query=`query($search:String!,$format:MediaFormat!,$from:FuzzyDateInt!,$to:FuzzyDateInt!){Page(page:1,perPage:10){pageInfo{hasNextPage}media(search:$search,type:ANIME,isAdult:false,format:$format,startDate_greater:$from,startDate_lesser:$to){${fields} recommendations(sort:RATING_DESC,perPage:8){nodes{rating mediaRecommendation{${fields}}}}}}}`;

/** Optional, bounded public metadata lookup. No profile, history, source URL or account is sent. */
export class AniListRecommendations {
  private cache=new Map<string,{until:number;items:MetadataCandidate[]}>();
  private pending=false;
  private nextRequest=0;
  private closed=false;
  private abort?:AbortController;
  constructor(private search:(q:string)=>Promise<MetadataCandidate[]>,private fetcher:typeof fetch=fetch,private now=Date.now){}
  get busy(){return this.pending;}
  close(){this.closed=true;this.abort?.abort();this.cache.clear();}
  lookup(seed:AnimeSeed):MetadataCandidate[]{
    const key=JSON.stringify([seed.kind,seed.id,seed.year,seed.originalTitle||seed.title]);
    const cached=this.cache.get(key);
    if(cached&&cached.until>this.now())return cached.items;
    if(this.closed||this.pending||this.now()<this.nextRequest)return [];
    this.pending=true;this.nextRequest=this.now()+3000;
    const abort=new AbortController();this.abort=abort;
    void this.load(seed,AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])).then(items=>{
      if(this.closed)return;
      this.cache.set(key,{items,until:this.now()+(items.length?6*3600_000:3600_000)});
      if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);
    }).catch(()=>{if(!this.closed){this.cache.set(key,{items:[],until:this.now()+3600_000});if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);}})
      .finally(()=>{this.pending=false;if(this.abort===abort)this.abort=undefined;});
    return [];
  }
  private async load(seed:AnimeSeed,signal:AbortSignal):Promise<MetadataCandidate[]>{
    const response=await this.fetcher('https://graphql.anilist.co',{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({query,variables:{search:(seed.originalTitle||seed.title).slice(0,300),format:seed.kind==='movie'?'MOVIE':'TV',from:seed.year*10000+100,to:(seed.year+1)*10000+101}})});
    if(response.status===429||response.headers.get('x-ratelimit-remaining')==='0'){
      const retry=Number(response.headers.get('retry-after'))||0,reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
      this.nextRequest=Math.max(this.nextRequest,this.now()+Math.min(3600_000,Math.max(60_000,retry*1000,Number.isFinite(reset)?reset-this.now():0)));
    }
    if(!response.ok){await response.body?.cancel();throw Error('anilist-unavailable');}
    const reader=response.body?.getReader();if(!reader)throw Error('anilist-empty');
    let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw Error('anilist-response-limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(body.errors?.length||body.data?.Page?.pageInfo?.hasNextPage!==false||!Array.isArray(body.data?.Page?.media))return [];
    const matched=matchAnimeSeed(seed,body.data.Page.media.slice(0,10));if(!matched)return [];
    const results:MetadataCandidate[]=[],seen=new Set<number>();
    for(const node of (matched.recommendations?.nodes??[]).slice(0,8)){
      if(this.closed||signal.aborted)break;
      const anime=node.mediaRecommendation;
      if(!anime||!valid(anime)||!(node.rating>0)||seen.has(anime.id))continue;seen.add(anime.id);
      const item=matchAnimeCandidate(anime,await this.search(anime.title.native||anime.title.romaji||anime.title.english!));
      if(item)results.push(item);
    }
    return results;
  }
}
