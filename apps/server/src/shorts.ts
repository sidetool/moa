import { createHash } from 'node:crypto';
import type { MetadataKind, ShortsFeed, ShortsItem, ShortsCategory } from '@moa/shared';
import type { Store } from './db.js';
import type { Tmdb } from './tmdb.js';
import type { Recommendations } from './recommendations.js';
import type { YouTubeTrailers, TrailerCheck } from './youtube-trailers.js';
import { ApiFailure } from './util.js';

const DAY = 86400_000;
const validKey = /^(tv|movie):([1-9][0-9]{0,14})$/;
const empty = (status: ShortsFeed['status']): ShortsFeed => ({status,items:[],nextCursor:null});
type VideoList = {trailers:string[];adult:boolean};
/** Public metadata caches may be shared. Seen history and feed decisions are always profile-scoped. */
export class Shorts {
  private videoCache = new Map<string,{expires:number;value:VideoList}>();
  private pending = new Map<string,Promise<VideoList>>();
  private revision = -1;
  private popularCache=new Map<ShortsCategory,{items:ShortsItem[];expires:number}>();
  private popularRetry=new Map<ShortsCategory,number>();
  private popularPending=new Map<ShortsCategory,Promise<ShortsItem[]>>();
  private closed = false;
  constructor(private db:Store,private tmdb:Pick<Tmdb,'enabled'|'configurationRevision'|'shortTrailers'|'shortPopular'>,
    private recommendations:Pick<Recommendations,'get'>,
    private youtube:Pick<YouTubeTrailers,'check'>,private now=Date.now){
    db.db.exec(`CREATE TABLE IF NOT EXISTS shorts_seen(
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      external_key TEXT NOT NULL,seen_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,external_key));
      CREATE INDEX IF NOT EXISTS shorts_seen_time ON shorts_seen(seen_at);`);
  }
  private state(profile:string):ShortsFeed['status'] {
    const row=this.db.get('SELECT kids FROM profiles WHERE id=?',profile);
    if(!row)throw new ApiFailure(401,'profile-required');
    if(row.kids)return 'restricted'; // Trending previews have no trustworthy age certification.
    if(this.db.settings(profile).shortsEnabled!==true)return 'disabled';
    if(!this.tmdb.enabled)return 'unconfigured';
    return 'ready';
  }
  private assert(profile:string){const state=this.state(profile);if(state!=='ready')throw new ApiFailure(state==='unconfigured'?503:403,`shorts-${state}`);}
  private cleanup(){this.db.run('DELETE FROM shorts_seen WHERE seen_at<=?',this.now()-30*DAY);}
  private checkRevision(){
    if(this.revision!==this.tmdb.configurationRevision){
      this.videoCache.clear();this.pending.clear();this.popularCache.clear();this.popularPending.clear();this.popularRetry.clear();this.revision=this.tmdb.configurationRevision;
    }
  }
  private popular(category:ShortsCategory):Promise<ShortsItem[]> {
    this.checkRevision();const revision=this.revision,cached=this.popularCache.get(category);
    if(cached&&cached.expires>this.now())return Promise.resolve(cached.items);
    if((this.popularRetry.get(category)??0)>this.now())return Promise.reject(new ApiFailure(503,'shorts-unavailable'));
    let work=this.popularPending.get(category);
    if(!work){
      work=this.tmdb.shortPopular(category).then(items=>{
        if(!this.closed&&revision===this.tmdb.configurationRevision)this.popularCache.set(category,{items,expires:this.now()+30*60_000});
        return items;
      }).catch(error=>{if(!this.closed&&revision===this.tmdb.configurationRevision)this.popularRetry.set(category,this.now()+60_000);throw error;}).finally(()=>{if(this.popularPending.get(category)===work)this.popularPending.delete(category);});
      this.popularPending.set(category,work);
    }
    return work;
  }
  private category(item:{kind:MetadataKind;id:number;genreIds?:number[]}):ShortsCategory|undefined {
    const cached=this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?',item.kind,item.id);
    const genres=item.genreIds??(cached?JSON.parse(cached.card).genreIds:undefined);
    if(!Array.isArray(genres)||!genres.length)return undefined;
    if(genres.includes(16))return 'anime';
    if(item.kind==='movie')return 'movie';
    if(genres.some(g=>[10763,10764,10767].includes(g)))return undefined;
    return 'series';
  }
  async feed(profile:string,cursor='0',replay=false):Promise<ShortsFeed>{
    const state=this.state(profile);if(state!=='ready')return empty(state);
    if(!/^\d{1,3}$/.test(cursor)||Number(cursor)>100)throw new ApiFailure(400,'invalid-shorts-cursor');
    this.cleanup();
    const settings=this.db.settings(profile),mode=settings.shortsMode??'mixed';
    const categories=settings.shortsCategories??['movie','series','anime'];
    const personal:ShortsItem[]=mode==='popular'?[]:this.recommendations.get(profile).items.flatMap(item=>{
      const category=this.category(item);if(!category||!categories.includes(category))return [];
      return [{key:item.key,kind:item.kind,tmdbId:item.id,title:item.title,poster:item.poster,year:item.year,overview:item.overview,category,
        href:`/search?q=${encodeURIComponent(item.title)}`,reason:'personal' as const}];
    });
    const popular:ShortsItem[]=[];
    let unavailable=false;
    const generation=this.tmdb.configurationRevision;
    if(mode!=='personal'||!personal.length){
      const responses=await Promise.allSettled(categories.map(category=>this.popular(category)));
      unavailable=responses.every(r=>r.status==='rejected');
      for(const response of responses)if(response.status==='fulfilled')popular.push(...response.value);
      const score=(key:string)=>createHash('sha256').update(`${profile}:${Math.floor(this.now()/DAY)}:${key}`).digest('hex');
      popular.sort((a,b)=>score(a.key).localeCompare(score(b.key)));
    }
    if(this.closed||generation!==this.tmdb.configurationRevision)return empty('unavailable');
    // A profile may be switched to kids or disabled while the shared discovery fetch is in flight.
    const finalState=this.state(profile);if(finalState!=='ready')return empty(finalState);
    const mixed:ShortsItem[]=[];
    for(let p=0,t=0;p<personal.length||t<popular.length;){
      if(p<personal.length)mixed.push(personal[p++]);
      if(p<personal.length)mixed.push(personal[p++]);
      if(t<popular.length)mixed.push(popular[t++]);
    }
    const unique=new Set<string>();
    const pool=mixed.filter(item=>{
      if(!validKey.test(item.key)||!item.title||unique.has(item.key))return false;
      unique.add(item.key);return true;
    });
    const repeatDays=settings.shortsRepeatDays??7;
    const excluded=new Set<string>(!replay&&repeatDays>0?this.db.all('SELECT external_key FROM shorts_seen WHERE profile_id=? AND seen_at>?',profile,this.now()-repeatDays*DAY).map(row=>row.external_key):[]);
    // Honor existing "not interested" feedback, including the popular side of a mixed feed.
    for(const row of this.db.all('SELECT external_key FROM recommendation_feedback WHERE profile_id=?',profile))excluded.add(row.external_key);
    if(settings.shortsHideWatched!==false){
      for(const row of this.db.all(`SELECT DISTINCT l.kind,l.tmdb_id FROM progress p JOIN episodes e ON e.id=p.episode_id
        JOIN tmdb_links l ON l.media_id=e.media_id AND l.status IN ('auto','manual')
        WHERE p.profile_id=? AND (p.position>0 OR p.completed=1)`,profile))excluded.add(`${row.kind}:${row.tmdb_id}`);
    }
    const items:ShortsItem[]=[];
    let index=Number(cursor);
    for(;index<pool.length&&items.length<8;index++){
      const item=pool[index];if(excluded.has(item.key))continue;
      const cached=this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?',item.kind,item.tmdbId);
      if(cached&&JSON.parse(cached.card).adult)continue;
      const match=this.db.get(`SELECT m.id FROM media m JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
        WHERE l.kind=? AND l.tmdb_id=? ORDER BY m.added_at DESC LIMIT 1`,item.kind,item.tmdbId);
      items.push({...item,...(match?{mediaId:match.id,href:`/title/${encodeURIComponent(match.id)}`}:{})});
    }
    return {status:unavailable&&!pool.length?'unavailable':'ready',items,nextCursor:index<pool.length?String(index):null};
  }
  async trailers(profile:string,key:string):Promise<TrailerCheck>{
    this.assert(profile);
    const parts=validKey.exec(key);if(!parts)throw new ApiFailure(400,'invalid-shorts-key');
    if(this.closed)throw new ApiFailure(503,'shorts-unavailable');
    const revision=this.tmdb.configurationRevision;
    this.checkRevision();
    const cached=this.videoCache.get(key);
    let value=cached&&cached.expires>this.now()?cached.value:undefined;
    if(!value){
      let work=this.pending.get(key);
      if(!work){
        if(this.pending.size>=4)throw new ApiFailure(503,'shorts-busy');
        work=this.tmdb.shortTrailers(parts[1] as MetadataKind,Number(parts[2])).then(result=>{
          if(!this.closed&&revision===this.tmdb.configurationRevision){
            this.videoCache.set(key,{value:result,expires:this.now()+6*3600_000});
            while(this.videoCache.size>256)this.videoCache.delete(this.videoCache.keys().next().value!);
          }
          return result;
        }).finally(()=>{if(this.pending.get(key)===work)this.pending.delete(key);});
        this.pending.set(key,work);
      }
      try{value=await work;}catch{throw new ApiFailure(503,'shorts-unavailable');}
    }
    this.assert(profile);
    if(this.closed||revision!==this.tmdb.configurationRevision)throw new ApiFailure(503,'shorts-unavailable');
    const result=value.adult?{trailers:[],checked:true}:await this.youtube.check(value.trailers);
    this.assert(profile);return result;
  }
  // Both actions suppress repeats temporarily; neither is a recommendation dislike or episode view.
  seen(profile:string,key:string){this.exclude(profile,key);}
  skip(profile:string,key:string){this.exclude(profile,key);}
  private exclude(profile:string,key:string){
    this.assert(profile);if(!validKey.test(key))throw new ApiFailure(400,'invalid-shorts-key');
    this.cleanup();
    this.db.run('INSERT INTO shorts_seen VALUES(?,?,?) ON CONFLICT(profile_id,external_key) DO UPDATE SET seen_at=excluded.seen_at',profile,key,this.now());
    // Bound the feature's persistent footprint even for very active viewers.
    this.db.run('DELETE FROM shorts_seen WHERE profile_id=? AND external_key NOT IN (SELECT external_key FROM shorts_seen WHERE profile_id=? ORDER BY seen_at DESC LIMIT 2000)',profile,profile);
  }
  reset(profile:string){this.db.run('DELETE FROM shorts_seen WHERE profile_id=?',profile);}
  close(){this.closed=true;this.videoCache.clear();this.pending.clear();this.popularCache.clear();this.popularPending.clear();this.popularRetry.clear();}
}
