import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { Store } from '../../src/db.js';
import { Catalog } from '../../src/catalog/service.js';
import { Sources } from '../../src/sources/service.js';
import { TitleGroups } from '../../src/catalog/title-groups.js';

/** Load only authored fixture records into an in-memory database. */
export function fixtureCatalog(fixture: any) {
  const db = new Store(tmpdir(), new DatabaseSync(':memory:'));
  const catalog = new Catalog(db);
  const sources = new Sources(db, catalog);
  const groups = new TitleGroups(catalog);
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('fixture','Fixture','blue',0,'2026')");
  for (const source of fixture.sources) db.run('INSERT INTO source_entries(id,repository,entry,enabled,type,live) VALUES(?,?,?,?,?,?)',
    source.id, 'https://example.org/index.json', JSON.stringify({ name: source.name, lang: source.lang }), source.enabled, source.type, source.live);
  for (const media of fixture.media) {
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', media.id, media.title, media.type, JSON.stringify({ provider: media.provider, live: media.live }), '2026');
    db.run('INSERT INTO source_media(media_id,source_id,url) VALUES(?,?,?)', media.id, media.provider.id, `https://catalog.example.com/${media.id}`);
    for (const [season, count] of Object.entries(media.episodeCounts)) for (let n = 1; n <= Number(count); n++) {
      db.run('INSERT INTO episodes VALUES(?,?,?,?,?,0,NULL)', `${media.id}-${season}-${n}`, media.id, Number(season), n, `${n}화`);
    }
    if (media.link) db.run('INSERT INTO tmdb_links VALUES(?,?,?,?,?,100,0)', media.id, media.link.kind, media.link.id, media.link.season, media.link.status);
  }
  for (const title of fixture.titles) db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,0)', title.kind, title.id,
    JSON.stringify({ title: title.title, originalTitle: title.originalTitle }), '{}');
  return { db, catalog, sources, groups };
}
