import type { MetadataCandidate, RecommendationItem, RecommendationsResponse } from '@moa/shared';
import { Store } from './db.js';
import { KidsPolicy } from './kids.js';
import { ApiFailure } from './util.js';
import { WatchlistReader } from './watchlist-reader.js';
import { HistoryReader } from './history-reader.js';
import { AniListRecommendations } from './anilist-recommendations.js';
import type { Tmdb } from './tmdb.js';

const keyOf = (kind: string, id: number) => `${kind}:${id}`;
const valid = (item: MetadataCandidate) => item && ['tv', 'movie'].includes(item.kind) && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.title === 'string' && item.title.trim().length > 0;
export class Recommendations {
  private warming = new Set<string>();
  private attempted = new Map<string, number>();
  private kids: KidsPolicy;
  private history: HistoryReader;
  private watchlist: WatchlistReader;
  private anime?:Pick<AniListRecommendations,'lookup'|'busy'|'close'>;
  close(){this.anime?.close();}
  constructor(private db: Store, private tmdb: Pick<Tmdb, 'enabled' | 'ensureDetail'> & Partial<Pick<Tmdb,'search'>>, private clock = Date.now, anime?:Pick<AniListRecommendations,'lookup'|'busy'|'close'>) {
    this.anime=anime??(tmdb.search?new AniListRecommendations(q=>tmdb.search!(q)):undefined);
    this.kids = new KidsPolicy(db); this.history=new HistoryReader(db); this.watchlist=new WatchlistReader(db);
    db.db.exec(`CREATE TABLE IF NOT EXISTS recommendation_feedback(profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,external_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(profile_id,external_key));`);
  }
  dismiss(profile: string, key: string, remove = false) {
    if (!/^(tv|movie):[1-9]\d{0,14}$/.test(key)) throw new ApiFailure(400, 'invalid-recommendation');
    if (remove) this.db.run('DELETE FROM recommendation_feedback WHERE profile_id=? AND external_key=?', profile, key);
    else this.db.run('INSERT OR IGNORE INTO recommendation_feedback VALUES(?,?,?)', profile, key, this.clock());
  }
  reset(profile: string) { this.db.run('DELETE FROM recommendation_feedback WHERE profile_id=?', profile); }
  get(profile: string): RecommendationsResponse {
    if (this.db.settings(profile).recommendationsEnabled === false) return { items: [], status: 'disabled' };
    if (!this.tmdb.enabled) return { items: [], status: 'unconfigured' };
    const unique = (rows: Record<string, any>[]) => {
      const seen = new Set<string>();
      return rows.filter(row => {
        const key=keyOf(row.kind,row.tmdb_id);
        if(seen.has(key)) return false;
        seen.add(key); return true;
      });
    };
    const history = unique(this.history.recent(profile,new Date(this.clock()-90*86400_000).toISOString()));
    const saved = unique(this.watchlist.recent(profile));
    const evidence = new Map<string, { id: string; title: string; kind: string; tmdb_id: number; weight: number; reason: string }>();
    for(const [index,row] of history.entries()) {
      evidence.set(keyOf(row.kind,row.tmdb_id), {id:row.id,title:row.title,kind:row.kind,tmdb_id:row.tmdb_id, weight:(row.completed?1.25:1)/(1+index*0.15), reason:`${row.title} 시청 기록을 바탕으로 추천`});
    }
    for(const [index,row] of saved.entries()) {
      const key=keyOf(row.kind,row.tmdb_id), previous=evidence.get(key), weight=0.8/(1+index*0.15);
      // Saving expresses interest, not necessarily approval. Aliases never add votes; overlap gives only a small boost.
      evidence.set(key, {id:row.id,title:row.title,kind:row.kind,tmdb_id:row.tmdb_id,
        weight:previous?Math.max(previous.weight,weight)+Math.min(previous.weight,weight)*0.2:weight,
        reason:previous?`${row.title} 시청 기록과 내 목록을 바탕으로 추천`:`내 목록의 ${row.title} 기반 추천`});
    }
    const selected = [...evidence.values()].sort((a,b)=>b.weight-a.weight||keyOf(a.kind,a.tmdb_id).localeCompare(keyOf(b.kind,b.tmdb_id))).slice(0,20);
    if (!selected.length) return { items: [], status: 'insufficient-history' };
    // A small background warmup never blocks the Home response. No independent recommendation cache:
    // changes to history, watchlist, links, dismissals and kids policy apply on the next request.
    for (const s of selected) {
      const cached = this.db.get('SELECT fetched_at FROM tmdb_titles WHERE kind=? AND tmdb_id=?',s.kind,s.tmdb_id);
      if (cached && cached.fetched_at > this.clock()-7*86400_000) continue;
      if (this.warming.size >= 2 || this.warming.has(s.id) || (this.attempted.get(s.id) ?? 0) > this.clock()-3600_000) continue;
      this.attempted.set(s.id,this.clock()); this.warming.add(s.id);
      if (this.attempted.size>1000) this.attempted.delete(this.attempted.keys().next().value!);
      void this.tmdb.ensureDetail(s.id,6000).catch(()=>{}).finally(()=>this.warming.delete(s.id));
    }
    const excluded = new Set(this.db.all(`SELECT DISTINCT l.kind,l.tmdb_id FROM progress p JOIN episodes e ON e.id=p.episode_id JOIN tmdb_links l ON l.media_id=e.media_id AND l.status IN ('auto','manual') WHERE p.profile_id=? AND (p.position>0 OR p.completed=1)`, profile).map(r=>keyOf(r.kind,r.tmdb_id)));
    for(const r of this.db.all(`SELECT l.kind,l.tmdb_id FROM watchlist w JOIN tmdb_links l ON l.media_id=w.media_id AND l.status IN ('auto','manual') WHERE w.profile_id=?`,profile)) excluded.add(keyOf(r.kind,r.tmdb_id));
    for (const r of this.db.all('SELECT external_key FROM recommendation_feedback WHERE profile_id=?',profile)) excluded.add(r.external_key);
    const ranked = new Map<string, { item: MetadataCandidate; score: number; reason: string }>();
    for (const s of selected) {
      const cached = this.db.get('SELECT detail FROM tmdb_titles WHERE kind=? AND tmdb_id=?',s.kind,s.tmdb_id);
      if (!cached) continue;
      const candidates = JSON.parse(cached.detail).similar as MetadataCandidate[] | undefined;
      const weight = s.weight;
      const counted = new Set<string>();
      for (const [rank,item] of (candidates || []).slice(0,18).entries()) {
        if (!valid(item)) continue;
        const key = keyOf(item.kind,item.id);
        if (excluded.has(key) || counted.has(key)) continue; counted.add(key);
        if (!ranked.has(key) && ranked.size>=100) continue;
        const previous = ranked.get(key), score=weight/(1+rank*0.08);
        ranked.set(key,{item,score:(previous?.score||0)+score,reason:previous?.reason||s.reason});
      }
    }
    const allowed = this.kids.candidates([...ranked.values()].map(x=>x.item),profile);
    const allowedKeys = new Set(allowed.map(x=>keyOf(x.kind,x.id)));
    const sorted = [...ranked.entries()].filter(([key])=>allowedKeys.has(key)).sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0]));
    const genres=new Map<string,number>(), deferred: typeof sorted=[];
    const diversified: typeof sorted=[];
    for (const entry of sorted) {
      const [key,r]=entry;
      const c=this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?',r.item.kind,r.item.id);
      const genre=c && JSON.parse(c.card).genres?.[0];
      if(genre&&(genres.get(genre)||0)>=4){deferred.push(entry);continue;}
      if(genre)genres.set(genre,(genres.get(genre)||0)+1);diversified.push(entry);
    }
    // Supplemental provider has its own ordering; never add AniList community votes to TMDB scores.
    // Keep TMDB identity everywhere (including Shorts) and only fill up to 12 animation suggestions.
    const chosen=[...diversified,...deferred].slice(0,40);
    const animationCount=chosen.filter(([,r])=>r.item.genreIds?.includes(16)).length;
    if(this.anime&&this.db.settings(profile).anilistRecommendationsEnabled===true&&!this.kids.active(profile)&&animationCount<12&&chosen.length<40){
      const present=new Set([...excluded,...chosen.map(([key])=>key)]);
      let added=0,seeds=0;
      for(const seed of selected){
        const row=this.db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?',seed.kind,seed.tmdb_id);
        const card=row?JSON.parse(row.card):undefined;
        const link=this.db.get('SELECT season FROM tmdb_links WHERE media_id=?',seed.id);
        if(!card?.genreIds?.includes(16)||!Number.isSafeInteger(card.year)||!card.originalTitle||link?.season>1)continue;
        if(++seeds>3)break;
        for(const item of this.anime.lookup({kind:seed.kind as 'movie'|'tv',id:seed.tmdb_id,title:card.title,originalTitle:card.originalTitle,year:card.year})){
          const key=keyOf(item.kind,item.id);if(!valid(item)||present.has(key))continue;
          present.add(key);chosen.push([key,{item,score:0,reason:`${seed.title} 기반 애니 추천 · AniList`}]);
          if(++added>=12-animationCount||chosen.length>=40)break;
        }
        if(added>=12-animationCount||chosen.length>=40)break;
      }
    }
    const items:RecommendationItem[]=chosen.map(([key,r])=>{
      const matches=this.db.all("SELECT m.id FROM media m JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual') WHERE l.kind=? AND l.tmdb_id=? ORDER BY m.added_at DESC",r.item.kind,r.item.id);
      const match=this.kids.filter(matches,profile)[0];
      return {...r.item,key,reason:r.reason,href:match?`/title/${encodeURIComponent(match.id)}`:`/search?q=${encodeURIComponent(r.item.title)}`};
    });
    return {items,status:'ready',...(this.warming.size||this.anime?.busy?{refreshAfterMs:3000}:{})};
  }
}
