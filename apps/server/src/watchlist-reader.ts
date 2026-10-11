import type { Store } from './db.js';
import { KidsPolicy } from './kids.js';
import { ApiFailure, hash } from './util.js';
import type { WatchlistPage, WatchlistQuery } from '@moa/shared';

/** Read-only, profile-scoped saved titles. No source metadata or playback URLs cross this boundary. */
export class WatchlistReader {
  private kids: KidsPolicy;
  constructor(private db: Store) {
    this.kids = new KidsPolicy(db);
    db.db.exec(`CREATE TABLE IF NOT EXISTS watchlist_revisions(profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS watchlist_recent ON watchlist(profile_id,added_at DESC,media_id);
      CREATE TRIGGER IF NOT EXISTS watchlist_insert AFTER INSERT ON watchlist BEGIN
        INSERT INTO watchlist_revisions VALUES(NEW.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS watchlist_update AFTER UPDATE ON watchlist BEGIN
        INSERT INTO watchlist_revisions VALUES(OLD.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1;
        INSERT INTO watchlist_revisions VALUES(NEW.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS watchlist_delete AFTER DELETE ON watchlist WHEN EXISTS(SELECT 1 FROM profiles WHERE id=OLD.profile_id) BEGIN
        INSERT INTO watchlist_revisions VALUES(OLD.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;`);
  }
  /** Bounded recommendation seeds; ambiguous identities and live broadcasts cannot become evidence. */
  recent(profile: string) {
    const rows=this.db.all(`SELECT m.id,m.title,l.kind,l.tmdb_id,w.added_at FROM watchlist w
      JOIN media m ON m.id=w.media_id JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      WHERE w.profile_id=? AND json_extract(m.metadata,'$.live') IS NOT 1
      ORDER BY w.added_at DESC,m.id DESC LIMIT 100`,profile);
    return this.kids.filter(rows,profile);
  }
  list(profile: string, query: WatchlistQuery = {}): WatchlistPage {
    if(!query || typeof query!=='object' || Array.isArray(query) || Object.keys(query).some(k=>!['cursor','limit','since'].includes(k))) throw new ApiFailure(400,'invalid-watchlist-query');
    const limit=query.limit??50, requestedSince=query.since??'1970-01-01T00:00:00.000Z';
    if(!Number.isInteger(limit)||limit<1||limit>100||typeof requestedSince!=='string'||requestedSince.length>40||!Number.isFinite(Date.parse(requestedSince))) throw new ApiFailure(400,'invalid-watchlist-query');
    const since=new Date(requestedSince).toISOString();
    // Includes policy/link changes as well as list changes; no cross-profile data in the token.
    const revision=hash(JSON.stringify([profile,this.db.get('SELECT revision FROM watchlist_revisions WHERE profile_id=?',profile)?.revision??0,this.kids.active(profile),this.db.get('SELECT MAX(checked_at) AS t FROM tmdb_links')?.t,this.db.get('SELECT MAX(fetched_at) AS t FROM tmdb_titles')?.t]));
    let after=['9999','\uffff'];
    if(query.cursor!==undefined){
      try { if(typeof query.cursor!=='string'||query.cursor.length>2048)throw Error(); const c=JSON.parse(Buffer.from(query.cursor,'base64url').toString());
        if(c.revision!==revision||c.since!==since)throw new ApiFailure(409,'watchlist-changed');
        if(typeof c.time!=='string'||c.time.length>40||typeof c.id!=='string'||c.id.length>512)throw Error();after=[c.time,c.id];
      }catch(e){if(e instanceof ApiFailure)throw e;throw new ApiFailure(400,'invalid-watchlist-cursor');}
    }
    const rows=this.db.all(`SELECT m.id,m.title,m.type,w.added_at,l.kind,l.tmdb_id
      FROM watchlist w JOIN media m ON m.id=w.media_id
      LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      WHERE w.profile_id=? AND w.added_at>=? AND (w.added_at<? OR (w.added_at=? AND m.id<?))
      ORDER BY w.added_at DESC,m.id DESC LIMIT ?`,profile,since,after[0],after[0],after[1],limit+1);
    const scanned=rows.slice(0,limit),last=scanned.at(-1);
    return {revision,items:this.kids.filter(scanned,profile).map(r=>({mediaId:r.id,title:r.title,type:r.type,addedAt:r.added_at,...(r.tmdb_id?{tmdb:{kind:r.kind,id:r.tmdb_id}}:{})})),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({revision,since,time:last.added_at,id:last.id})).toString('base64url'):null};
  }
}
