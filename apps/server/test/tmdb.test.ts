import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreResult, searchTerms } from '../src/metadata/tmdb.js';

test('search terms drop tags, seasons and trailing numbers', () => {
  const a = searchTerms('(자막) 극장판 달빛 수호대: 별빛성편 제1장');
  assert.equal(a.movieHint, true);
  assert.equal(a.targets[0].text, '극장판 달빛 수호대: 별빛성편 제1장');
  const b = searchTerms('정원사의 일기 3기');
  assert.deepEqual(b.targets[0], { text: '정원사의 일기', season: 3 });
  const c = searchTerms('신입 대원 3');
  assert.ok(c.targets.some(t => t.text === '신입 대원' && t.season === 3));
  const d = searchTerms('예제 해결사 Example Fix (2026)');
  assert.equal(d.year, 2026);
  assert.ok(d.targets.some(t => t.text === '예제 해결사'));
});

test('scores prefer exact titles of the expected kind', () => {
  const terms = searchTerms('보물 탐험가');
  const anime = scoreResult({ id: 1, media_type: 'tv', name: '보물 탐험가', genre_ids: [16] }, terms.targets, { type: 'anime', movieHint: false });
  const drama = scoreResult({ id: 2, media_type: 'tv', name: '보물 탐험가', genre_ids: [18] }, terms.targets, { type: 'anime', movieHint: false });
  assert.ok(anime.score >= 100);
  assert.ok(drama.score < 80);
  const other = scoreResult({ id: 3, media_type: 'tv', name: '완전히 다른 작품', genre_ids: [16] }, terms.targets, { type: 'anime', movieHint: false });
  assert.ok(other.score < 80);
  const year = scoreResult({ id: 4, media_type: 'movie', title: '보물 탐험가', release_date: '1990-01-01' }, terms.targets, { type: 'movie', movieHint: false, year: 2024 });
  assert.ok(year.score < 80);
});

test('season poster fallback is deduplicated, cached and shared by card/detail without changing the logo', async () => {
  const { Store } = await import('../src/db.js');
  const { Catalog } = await import('../src/catalog/service.js');
  const { Sources } = await import('../src/sources/service.js');
  const { Tmdb } = await import('../src/metadata/tmdb.js');
  const { mkdtemp,rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'moa-season-poster-')), db=new Store(dir),catalog=new Catalog(db);
  new Sources(db,catalog);
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','p','blue',0,'2026')");
  db.run("INSERT INTO source_entries(id,repository,entry,enabled) VALUES('source','fixture',?,1)",JSON.stringify({lang:'en'}));
  for(const id of ['a','b']) {
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,'Show Season 2','anime',JSON.stringify({provider:{id:'source',name:'Source',kind:'mangayomi-js'}}),'2026');
    db.run('INSERT INTO source_media(media_id,source_id,url) VALUES(?,?,?)',id,'source','https://fixture.invalid');
    db.run("INSERT INTO tmdb_links VALUES(?,'tv',100,2,'manual',100,?)",id,Date.now());
  }
  db.run("INSERT INTO tmdb_titles VALUES('tv',100,?,?,?)",JSON.stringify({title:'작품',poster:'series.jpg',logo:'logo.png',seasons:{1:{},2:{}}}),JSON.stringify({people:[],similar:[]}),Date.now());
  const calls: string[]=[];
  const tmdb=new Tmdb(db,()=>{},{token:'fixture',fetch:async input=>{
    const url=new URL(String(input));calls.push(url.pathname);
    await new Promise(resolve=>setTimeout(resolve,10));
    return Response.json({poster_path:'/season2.jpg',episodes:[]});
  }});
  try {
    await tmdb.ensure(['a','b'],1000);await tmdb.ensure(['a','b'],1000);
    assert.deepEqual(calls,['/3/tv/100/season/2']);
    const card=catalog.card(db.get("SELECT * FROM media WHERE id='a'")!,'p');
    assert.equal(card.poster,'https://image.tmdb.org/t/p/w500/season2.jpg');
    assert.equal(card.logo,'logo.png');assert.equal(card.provider.lang,'en');assert.equal(card.baseTitle,'작품');
    assert.deepEqual(card.seasonInfo,{kind:'season',season:2,label:'시즌 2'});
    const detail=catalog.detail('a','p');assert.equal(detail.provider.lang,'en');assert.equal(detail.poster,card.poster);
    db.run("UPDATE tmdb_links SET season=NULL WHERE media_id='b'");
    db.run("UPDATE media SET title='Show' WHERE id='b'");
    assert.equal(catalog.card(db.get("SELECT * FROM media WHERE id='b'")!,'p').seasonInfo?.label,'시즌 1');
  } finally {tmdb.close();db.close();await rm(dir,{recursive:true,force:true});}
});
