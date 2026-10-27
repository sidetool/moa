import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { TitleGroups } from '../src/catalog/title-groups.js';
import { Sources } from '../src/sources/service.js';
import { Tmdb, MATCH_VERSION, localizedTitle, searchTerms } from '../src/metadata/tmdb.js';
import { OnlineSubtitles } from '../src/subtitles/online.js';
import { RemotePlayback } from '../src/playback/remote.js';
import { parseEdl, edlPlaylist } from '../src/playback/edl.js';

const edl = (type: string, url = 'https://cdn.test/한,;segment.ts') => `edl://!delay_open,media_type=${type},codec=${type === 'video' ? 'h264' : 'aac'};%${Buffer.byteLength(url)}%${url},start=1.35,length=8.876;`;
test('EDL byte quoting, timings, stream partitions and explicit unsupported errors', () => {
  const streams = parseEdl(edl('video') + '!new_stream;' + edl('audio').slice(6));
  assert.equal(streams.length,2); assert.equal(streams[1].type,'audio');
  assert.equal(streams[0].segments[0].start,1.35);
  assert.match(edlPlaylist(streams[0], () => '/asset'), /TARGETDURATION:9[\s\S]*EXTINF:8.876,\n\/asset/);
  for (const value of ['edl://%999%short', 'edl://!mp4_dash,init=x;https://a.test/a,length=2', 'edl://file:///etc/passwd,length=2', 'edl://https://a.test/a', 'edl://https://a.test/a,length=-1']) assert.throws(() => parseEdl(value));
});

test('foreign matching, rule upgrades, Korean overlays/search/subtitle queries and EDL sessions', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'moa-foreign-test-')), db = new Store(temp), catalog = new Catalog(db);
  const sources = new Sources(db,catalog,async () => ({ result: [{url:edl('video'),headers:{Referer:'https://player.example.com/'},audios:[{file:edl('audio'),label:'Japanese'}],subtitles:[{file:'https://cdn.test/en.ass',label:'English'}]}], changes:{} }));
  const entry = JSON.stringify({name:'Example Source A',lang:'en'});
  db.run('INSERT INTO source_entries(id,repository,entry,code,enabled) VALUES(?,?,?,?,1)','source','https://repo.test/anime_index.json',entry,'fixture');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','P','blue',0,'2026');
  const names = ['Sky Explorers','Clockwork Island','Moonlight Guards','STARLIGHT ACADEMY','Forest Journey','Sky Explorers Season 2','Sky Explorers Season 3 Part 2','Sky Explorers Final Season'];
  const korean = ['하늘 탐험대','시계섬의 이야기','달빛 수호대','별빛 학교','숲의 여행','하늘 탐험대','하늘 탐험대','하늘 탐험대'];
  const calls: string[] = [];
  const tmdb = new Tmdb(db, () => {}, { token:'fixture', fetch: async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/search/multi')) {
      const q = url.searchParams.get('query')!, i = names.indexOf(q);
      return Response.json({results: [{id:999,media_type:'movie',original_title:q,title:'예제 액션 영화',genre_ids:[28],popularity:100}, ...(url.searchParams.get('language') === 'en-US' ? [{id:i+1,media_type:'tv',name:q,original_name:'日本語',genre_ids:[16]}] : [])]});
    }
    const i = Number(url.pathname.split('/').at(-1))-1;
    return Response.json({ name:korean[i], original_name:'日本語', genres:[{id:16,name:'애니메이션'}], overview:'한국어 줄거리', seasons:[{season_number:2},{season_number:3}] });
  }});
  const remote = new RemotePlayback(db,catalog,sources);
  let online: OnlineSubtitles | undefined;
  try {
    for (let i=0;i<names.length;i++) {
      const id = String(i);
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,names[i],'series',JSON.stringify({provider:{id:'source',kind:'source',name:'Example Source A'}}),'2026');
      db.run('INSERT INTO source_media VALUES(?,?,?,?)',id,'source',id,Date.now());
      db.run("INSERT INTO tmdb_links(media_id,status,score,checked_at) VALUES(?,'none',NULL,?)",id,Date.now());
      await tmdb.ensure([id],10000);
      assert.equal(db.get('SELECT kind FROM tmdb_links WHERE media_id=?',id)?.kind,'tv');
      assert.equal(db.get('SELECT version FROM tmdb_match_versions WHERE media_id=?',id)?.version,MATCH_VERSION);
      assert.equal(catalog.card(db.get('SELECT * FROM media WHERE id=?',id)!,'p').originalTitle,names[i]);
    }
    assert.equal(db.get("SELECT season FROM tmdb_links WHERE media_id='7'")?.season,3);
    assert.equal(catalog.card(db.get("SELECT * FROM media WHERE id='5'")!,'p').title,'하늘 탐험대 시즌 2');
    assert.ok(catalog.search('p','숲').groups.some(g => g.items.some(c => c.id === '4')));
    assert.ok(catalog.search('p','Forest').groups.some(g => g.items.some(c => c.id === '4')));
    const groups = new TitleGroups(catalog);
    assert.ok(groups.candidates('숲','p').some(c => c.id === '4'));
    assert.ok(groups.candidates('Forest','p').some(c => c.id === '4'));
    const count = calls.length; await tmdb.backfill(); assert.equal(calls.length,count);
    for (const [id,status,score] of [['0','manual',100],['1','off',null],['2','auto',100]] as const) {
      db.run('UPDATE tmdb_links SET status=?,score=? WHERE media_id=?',status,score,id);
      db.run('DELETE FROM tmdb_match_versions WHERE media_id=?',id);
      const before = calls.length; await tmdb.ensure([id],10000); assert.equal(calls.length,before);
    }
    db.run("UPDATE tmdb_links SET status='auto',score=88 WHERE media_id='0'");
    await tmdb.ensure(['0'],10000); assert.equal(db.get("SELECT score FROM tmdb_links WHERE media_id='0'")?.score,110);
    db.run("INSERT INTO episodes VALUES('ep','4',1,1,'E1 — Homecoming',0,NULL)");
    db.run("INSERT INTO source_episodes VALUES('ep','fixture-work|1')");
    db.run('INSERT INTO tmdb_seasons VALUES(?,?,?,?)',5,1,JSON.stringify([{number:1,name:'귀향'}]),Date.now());
    assert.equal(catalog.detail('4','p').seasons[0].episodes[0].title,'귀향');
    assert.equal(catalog.detail('4','p').overview,'한국어 줄거리');
    online = new OnlineSubtitles(db,()=>{}, {resolveKoreanTitle:async () => '',searchSubtitles:async q => {assert.equal(q.title,'숲의 여행');assert.ok(q.aliases?.includes('日本語'));return [];}});
    await online.search('ep','p');
    const session = await remote.create('p','ep');
    const state = remote.get(session.sessionId);
    const playlists = [...state.assets.values()].filter(a => a.playlist).map(a => a.playlist!);
    assert.equal(playlists.length,3); assert.ok(playlists.some(p => p.includes('TYPE=AUDIO')));
    assert.equal(session.subtitles[0].format,'ass');
    assert.equal(session.mediaType,'anime');
    assert.ok([...state.assets.values()].some(a => a.headers.Referer === 'https://player.example.com/'));
    assert.equal(searchTerms('Sky Explorers Final Season').targets[0].text,'Sky Explorers');
    assert.equal(localizedTitle('하늘 탐험대','Sky Explorers Season 3 Part 2'),'하늘 탐험대 시즌 3 파트 2');
  } finally { online?.close();remote.close();tmdb.close();await sources.close();db.close();await rm(temp,{recursive:true,force:true}); }
});

test('new anime repository entries default to anime and existing types remain user controlled', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'moa-register-')), db = new Store(temp);
  const sources = new Sources(db,new Catalog(db),undefined,undefined,async () => [{id:'x',name:'Foreign',lang:'en',version:'1',baseUrl:'https://site.test/'} as any]);
  try {
    const [row] = await sources.refresh('https://repo.test/anime_index.json');
    assert.equal(row.type,'anime');
    db.run("UPDATE source_entries SET type='series' WHERE id=?",row.id);
    assert.equal((await sources.refresh('https://repo.test/anime_index.json'))[0].type,'series');
  } finally { await sources.close(); db.close();await rm(temp,{recursive:true,force:true}); }
});
