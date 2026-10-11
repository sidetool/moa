import type { Store } from './db.js';
import { KidsPolicy } from './kids.js';
import { ApiFailure, hash } from './util.js';
import type { HistoryPage, HistoryQuery } from '@moa/shared';

/** Read-only, profile-scoped view; positions are not accumulated watch time. */
export class HistoryReader {
  private kids: KidsPolicy;
  constructor(private db: Store) {
    this.kids = new KidsPolicy(db);
    db.db.exec(`CREATE TABLE IF NOT EXISTS history_revisions(profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS progress_recent ON progress(profile_id,updated_at DESC,episode_id);
      CREATE TRIGGER IF NOT EXISTS history_insert AFTER INSERT ON progress BEGIN
        INSERT INTO history_revisions VALUES(NEW.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS history_update AFTER UPDATE ON progress BEGIN
        INSERT INTO history_revisions VALUES(NEW.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS history_delete AFTER DELETE ON progress WHEN EXISTS(SELECT 1 FROM profiles WHERE id=OLD.profile_id) BEGIN
        INSERT INTO history_revisions VALUES(OLD.profile_id,1) ON CONFLICT(profile_id) DO UPDATE SET revision=revision+1; END;`);
  }
  recent(profile: string, since: string, limit = 100) {
    const rows=this.db.all(`SELECT m.id,m.title,l.kind,l.tmdb_id,MAX(p.updated_at) AS watched,MAX(p.completed) AS completed
      FROM progress p JOIN episodes e ON e.id=p.episode_id JOIN media m ON m.id=e.media_id
      JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      WHERE p.profile_id=? AND p.updated_at>=? AND (p.completed=1 OR (p.position>=300 AND p.duration>0 AND p.position/p.duration>=0.2))
      AND json_extract(m.metadata,'$.live') IS NOT 1 GROUP BY m.id,l.kind,l.tmdb_id ORDER BY watched DESC LIMIT ?`,profile,since,limit);
    return this.kids.filter(rows,profile);
  }
  list(profile: string, query: HistoryQuery = {}): HistoryPage {
    if(!query || typeof query!=='object' || Array.isArray(query) || Object.keys(query).some(k=>!['cursor','limit','since'].includes(k))) throw new ApiFailure(400,'invalid-history-query');
    const limit=query.limit??50, requestedSince=query.since??'1970-01-01T00:00:00.000Z';
    if(!Number.isInteger(limit)||limit<1||limit>100||typeof requestedSince!=='string'||requestedSince.length>40||!Number.isFinite(Date.parse(requestedSince))) throw new ApiFailure(400,'invalid-history-query');
    const since=new Date(requestedSince).toISOString();
    // Includes policy/link changes as well as progress changes; no cross-profile data in the token.
    const revision=hash(JSON.stringify([profile,this.db.get('SELECT revision FROM history_revisions WHERE profile_id=?',profile)?.revision??0,this.kids.active(profile),this.db.get('SELECT MAX(checked_at) AS t FROM tmdb_links')?.t,this.db.get('SELECT MAX(fetched_at) AS t FROM tmdb_titles')?.t]));
    let after=['9999','\uffff'];
    if(query.cursor!==undefined){
      try { if(typeof query.cursor!=='string'||query.cursor.length>2048)throw Error(); const c=JSON.parse(Buffer.from(query.cursor,'base64url').toString());
        if(c.revision!==revision||c.since!==since)throw new ApiFailure(409,'history-changed');
        if(typeof c.time!=='string'||typeof c.id!=='string'||c.id.length>512)throw Error();after=[c.time,c.id];
      }catch(e){if(e instanceof ApiFailure)throw e;throw new ApiFailure(400,'invalid-history-cursor');}
    }
    const rows=this.db.all(`SELECT m.id,m.title,e.id AS episode_id,e.title AS episode_title,e.season,e.number,p.position,p.duration,p.completed,p.updated_at,l.kind,l.tmdb_id
      FROM progress p JOIN episodes e ON e.id=p.episode_id JOIN media m ON m.id=e.media_id
      LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      WHERE p.profile_id=? AND p.updated_at>=? AND (p.updated_at<? OR (p.updated_at=? AND e.id<?))
      ORDER BY p.updated_at DESC,e.id DESC LIMIT ?`,profile,since,after[0],after[0],after[1],limit+1);
    const scanned=rows.slice(0,limit),last=scanned.at(-1);
    return {revision,items:this.kids.filter(scanned,profile).map(r=>({mediaId:r.id,episodeId:r.episode_id,title:r.title,episodeTitle:r.episode_title,season:r.season,episode:r.number,position:r.position,duration:r.duration,completed:Boolean(r.completed),updatedAt:r.updated_at,...(r.tmdb_id?{tmdb:{kind:r.kind,id:r.tmdb_id}}:{})})),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({revision,since,time:last.updated_at,id:last.episode_id})).toString('base64url'):null};
  }
}
