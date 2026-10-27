import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Sources } from '../src/sources/service.js';
import { Catalog } from '../src/catalog/service.js';
import { subtitleQuery } from '../src/subtitles/query.js';
import { playbackMediaType } from '../src/metadata/tmdb.js';
import { buildApp } from '../src/app.js';

test('anime playback classification preserves catalog type, rejects non-Japanese animation and live/movie types', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'moa-anime-v2-')), db = new Store(dir);
  const sources = new Sources(db,new Catalog(db));
  try {
    db.run("INSERT INTO media VALUES('m',NULL,'Title','series','{}','2026')");
    db.run("INSERT INTO tmdb_links VALUES('m','tv',1,NULL,'auto',100,0)");
    const card = (value: object) => db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)','tv',1,JSON.stringify(value),'{}',0);
    card({animation:true,originCountries:['JP']});
    assert.equal(playbackMediaType(db,'m','series'),'anime');
    assert.equal(playbackMediaType(db,'m','movie'),'movie');
    card({animation:true,originCountries:['US']}); assert.equal(playbackMediaType(db,'m','series'),'series');
    db.run("INSERT INTO source_entries(id,repository,entry) VALUES('s','https://example.org/anime_index.json','{\"name\":\"Example Source A\",\"lang\":\"en\"}')");
    db.run("INSERT INTO source_media VALUES('m','s','id',0)");
    card({animation:true}); assert.equal(playbackMediaType(db,'m','series'),'anime', 'old metadata has no country; anime source supplies evidence');
    card({animation:false}); assert.equal(playbackMediaType(db,'m','series'),'series');
    assert.equal(db.get("SELECT type FROM media WHERE id='m'")?.type,'series');
  } finally { await sources.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

// Neutral known titles are required by the bundled offset table and the title-specific part rule.
// The catalog, episode lists and all metadata responses below are authored, never recorded.
test('subtitle numbering: known offsets, merged season, long series, parts and partial ranges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'moa-query-v2-')), db = new Store(dir);
  const sources = new Sources(db,new Catalog(db));
  try {
    db.run("INSERT INTO source_entries(id,repository,entry) VALUES('s','https://example.org/anime_index.json','{\"name\":\"Example Source A\",\"lang\":\"en\"}')");
    db.run("INSERT INTO media VALUES('m',NULL,'Title','series','{}','2026')");
    db.run("INSERT INTO source_media VALUES('m','s','id',0)");
    db.run("INSERT INTO tmdb_links VALUES('m','tv',1,1,'auto',100,0)");
    const setup = (title: string, ko: string, first: number, last: number, season = 1) => {
      db.run("UPDATE media SET title=? WHERE id='m'",title);
      db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)','tv',1,JSON.stringify({title:ko,originalTitle:'原題',animation:true}),'{}',0);
      db.run('DELETE FROM episodes');
      for(let n=first;n<=last;n++) db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)',String(n),'m',season,n,'Ep',0,null);
      return db.get("SELECT e.*,m.title AS original_title FROM episodes e JOIN media m ON m.id=e.media_id ORDER BY number LIMIT 1")!;
    };
    let q = subtitleQuery(db,setup('JUJUTSU KAISEN Season 2','주술회전',25,47,2));
    assert.deepEqual([q.title,q.season,q.episode,q.episodeOffset,q.mapping],['주술회전',2,1,24,'absolute-to-season']);
    q = subtitleQuery(db,setup('JUJUTSU KAISEN Season 2','주술회전',1,23,2)); assert.equal(q.episode,1);
    q = subtitleQuery(db,setup('JUJUTSU KAISEN Season 2','주술회전',25,30,2)); assert.equal(q.episode,25);
    q = subtitleQuery(db,setup('Forest Journey','숲의 여행',1,500)); assert.equal(q.season,1); assert.equal(q.episodeOffset,0);
    q = subtitleQuery(db,setup('Attack on Titan Season 3 Part 2','진격의 거인',1,10,3));
    assert.deepEqual([q.season,q.episode,q.episodeOffset,q.mapping],[3,13,37,'part-to-season']);
    const ep = setup('Attack on Titan Season 3 Part 2','진격의 거인',1,4,3);
    q = subtitleQuery(db,ep); assert.deepEqual(q.warnings,['part-numbering-unverified']);
    q = subtitleQuery(db,ep,{title:'수동 작품',season:2,episode:7,episodeOffset:12});
    assert.deepEqual([q.title,q.season,q.episode,q.episodeOffset,q.mapping],['수동 작품',2,7,12,'manual']); assert.deepEqual(q.aliases,[]);
    q = subtitleQuery(db,setup('Attack on Titan Final Season','진격의 거인',1,16)); assert.equal(q.season,4); assert.equal(q.episodeOffset,59);
  } finally { await sources.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('manual search API validates overrides and reports the actual query without leaking subtitle bodies', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'moa-api-v2-'));
  const calls: any[] = [];
  const env = await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web')},false,{subtitleClient:{resolveKoreanTitle:async ()=>'제목',searchSubtitles:async q=>{calls.push(q);return [];}}});
  try {
    const profile = (await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'P'}})).json();
    env.db.run("INSERT INTO media VALUES('m',NULL,'Title','series','{}','2026')");
    env.db.run("INSERT INTO episodes VALUES('e','m',1,1,'Ep',0,NULL)");
    const url='/api/episodes/e/subtitles/online',headers={'x-moa-profile':profile.id};
    assert.equal((await env.app.inject(url+'?episode=1')).statusCode,401);
    for(const query of ['episode=-1','season=0','episodeOffset=1.5','title=%20','title=%5B%5D','title='+ 'x'.repeat(501)]) assert.equal((await env.app.inject({url:url+'?'+query,headers})).statusCode,400);
    const result = await env.app.inject({url:url+'?title='+encodeURIComponent('별빛 학교')+'&season=2&episode=1&episodeOffset=24',headers});
    assert.equal(result.statusCode,200);
    assert.equal(result.json().query.mapping,'manual'); assert.equal(result.json().resolvedTitle,'별빛 학교 2기');
    assert.deepEqual([calls[0].title,calls[0].season,calls[0].episode,calls[0].episodeOffset],['별빛 학교',2,1,24]);
    env.db.run("UPDATE media SET title='Sky Explorers Season 3 Part 2' WHERE id='m'");
    env.db.run("INSERT INTO source_entries(id,repository,entry) VALUES('s','https://example.org/anime_index.json','{}')");
    env.db.run("INSERT INTO source_media VALUES('m','s','id',0)");
    const uncertain = (await env.app.inject({url,headers})).json();
    assert.equal(uncertain.autoApply,false);
    assert.ok(uncertain.query.warnings.includes('part-numbering-unverified'));
  } finally { await env.app.close(); await rm(dir,{recursive:true,force:true}); }
});
