/** Read only a copied DB. Never starts a server or calls a provider. */
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { Store } from '../src/db.js';
import { episodeQuery } from '../src/catalog/episode-query.js';
import { subtitleQuery } from '../src/subtitles/query.js';
import { playbackMediaType, subtitleIdentity } from '../src/metadata/tmdb.js';

const [input, sourceId, title = ''] = process.argv.slice(2);
if (!input || !sourceId) throw new Error('Usage: audit-anime-subtitles.ts <copied DB path> <source ID> [title filter]');
const file = realpathSync(input);
if (!file.startsWith('/tmp/')) throw new Error('Pass a DB copy under /tmp');
const sqlite = new DatabaseSync(file,{readOnly:true});
sqlite.exec('PRAGMA query_only=ON');
// Do not run Store's constructor/migrations against the snapshot.
const db: Store = Object.create(Store.prototype); db.db = sqlite;
try {
  const rows = db.all(`SELECT m.* FROM media m JOIN source_media sm ON sm.media_id=m.id
    WHERE sm.source_id=? AND m.title LIKE ?`, sourceId, `%${title}%`);
  for (const m of rows) {
    const episodes = db.all('SELECT * FROM episodes WHERE media_id=? ORDER BY season,number',m.id);
    const ep = episodes[0];
    const identity = subtitleIdentity(db,m.id);
    const original = ep ? {...ep,original_title:m.title} : undefined;
    const previous = original ? episodeQuery(db,original) : undefined;
    if(previous && identity) {previous.title=identity.title;previous.season=identity.season ?? previous.season;}
    console.log(JSON.stringify({title:m.title,storedType:m.type,playbackType:playbackMediaType(db,m.id,m.type),episodeCount:episodes.length,
      previous:previous ? {title:previous.title,season:previous.season,episode:previous.episode} : null,
      query:original ? subtitleQuery(db,original) : null}));
  }
} finally { sqlite.close(); }
