import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Catalog} from '../src/catalog.js';
import {Sources} from '../src/sources.js';
import {TitleGroups,titleIdentity,titleGroupSeason} from '../src/title-groups.js';

test('conservative identity retains season, edition, year and type',()=>{
  assert.equal(titleIdentity('작품 시즌 2!','anime'),titleIdentity('작품 2기','anime'));
  for(const [title,type,year] of [['작품','anime',undefined],['작품 3기','anime',undefined],['작품 2기 더빙','anime',undefined],['작품 2기','movie',undefined],['작품 2기','anime',2025]] as const) assert.notEqual(titleIdentity('작품 2기','anime'),titleIdentity(title,type,year));
});
test('cross-provider grouping, ambiguity, manual override, split/reset and profile isolation',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'moa-groups-')), db=new Store(temp), catalog=new Catalog(db);
  new Sources(db,catalog);const groups=new TitleGroups(catalog);
  for(const id of ['p1','p2']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',0,'2026');
  for(const id of ['a','b','c'])db.run('INSERT INTO source_entries(id,repository,entry,enabled) VALUES(?,?,?,1)',id,'fixture','{}');
  const add=(id:string,title:string,provider:string,meta:Record<string,unknown>={})=>db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,title,'anime',JSON.stringify({provider:{id:provider,name:provider,kind:'mangayomi-js'},...meta}),'2026');
  try{
    add('a1','작품 2기','a');add('b1','작품 시즌 2','b');add('c1','작품 시즌 3','c');
    assert.equal(groups.resolve(['a1','b1','c1'],'p1').length,2);
    assert.equal(groups.resolve(['a1','b1'],'p1')[0].sourceCount,2);
    assert.equal(groups.resolve(['a1'],'p1')[0].sourceCount,1,'selected provider boundary retained');
    groups.change('b1','p1','separate'); assert.equal(groups.resolve(['a1','b1'],'p1').length,2);
    assert.equal(groups.resolve(['a1','b1'],'p2').length,1);
    groups.change('b1','p1','reset');assert.equal(groups.group('a1','p1').members.length,2);
    groups.change('a1','p1','merge','c1');assert.equal(groups.group('a1','p1').members.length,3);
    groups.change('c1','p1','separate');assert.equal(groups.group('a1','p1').members.length,2);
    add('a2','작품 2기','a');assert.equal(groups.resolve(['a1','a2','b1'],'p2').length,1,'same provider duplicates with matching identity join');
    add('l1','라이브','a',{live:true});add('l2','라이브','b',{live:true});assert.equal(groups.resolve(['l1','l2'],'p1').length,2);
    db.run('UPDATE source_entries SET enabled=0 WHERE id=?','b');assert.equal(groups.group('a1','p1').members.length,1);
    assert.throws(()=>groups.change('a1','p1','merge','missing'),/media-not-found/);
    assert.equal(groups.group('a1','p1').members.length,1,'failed mutation is atomic');
  }finally{db.close();await rm(temp,{recursive:true,force:true});}
});

async function withTmdbGroups(run: (fixture: {
  db: Store; groups: TitleGroups;
  add: (id: string, title: string, provider: string, type?: string, meta?: Record<string,unknown>) => void;
  link: (id: string, tmdbId: number, kind?: string, season?: number | null, status?: string) => void;
}) => void | Promise<void>) {
  const temp = await mkdtemp(path.join(tmpdir(),'moa-tmdb-groups-')), db = new Store(temp), catalog = new Catalog(db);
  new Sources(db,catalog); const groups = new TitleGroups(catalog);
  for (const id of ['p1','p2']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',0,'2026');
  for (const id of ['a','b','c','d','e','f']) db.run('INSERT INTO source_entries(id,repository,entry,enabled) VALUES(?,?,?,1)',id,'fixture','{}');
  const add = (id: string, title: string, provider: string, type = 'anime', meta: Record<string,unknown> = {}) =>
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,title,type,JSON.stringify({...(provider === 'local' ? {} : {provider:{id:provider,name:provider,kind:'mangayomi-js'}}),...meta}),'2026');
  const link = (id: string, tmdbId: number, kind = 'tv', season: number | null = null, status = 'auto') =>
    db.run('INSERT INTO tmdb_links(media_id,kind,tmdb_id,season,status,score,checked_at) VALUES(?,?,?,?,?,100,?)',id,kind,tmdbId,season,status,Date.now());
  try { await run({db,groups,add,link}); } finally { db.close(); await rm(temp,{recursive:true,force:true}); }
}

test('TMDB joins Korean and English titles across types and years',()=>withTmdbGroups(({groups,add,link})=>{
  add('ko','같은 작품','a','anime',{year:2025}); add('en','The Same Show','b','series',{year:2026});
  link('ko',100); link('en',100,'tv',1,'manual');
  assert.deepEqual(groups.group('ko','p1').members.map(m=>m.id),['ko','en']);
  assert.equal(groups.resolve(['ko','en'],'p1')[0].sourceCount,2);
}));

test('movie TMDB identity ignores source classification and retains movie/TV distinction',()=>withTmdbGroups(({groups,add,link})=>{
  add('movie','극장판 작품','a','movie'); add('anime','The Movie','b'); add('series','작품 영화','c','series');
  add('tv','작품','d');
  link('movie',100,'movie'); link('anime',100,'movie'); link('series',100,'movie'); link('tv',100);
  assert.equal(groups.group('movie','p1').members.length,3);
  assert.equal(groups.resolve(['movie','anime','series','tv'],'p1').length,2);
}));

test('TV identity uses link season, then parsed title season, then season one',()=>withTmdbGroups(({groups,add,link})=>{
  add('one','작품','a'); add('two','작품 2기','b'); add('two-en','Show Season 2','c');
  add('explicit','Show Season 9','d'); add('three','작품 3기','e');
  for (const id of ['one','two','two-en','three']) link(id,100);
  link('explicit',100,'tv',2);
  assert.deepEqual(groups.group('two','p1').members.map(m=>m.id),['two','two-en','explicit']);
  assert.equal(groups.resolve(['one','two','two-en','explicit','three'],'p1').length,3);
}));

test('TV editions and subtitles use title identity only, including accepted manual metadata',()=>withTmdbGroups(({groups,add,link})=>{
  const editions = ['극장판 작품','작품 OVA','작품 OAD','작품 스페셜','작품 Special','작품 Specials','작품 특별편',
    '작품 총집편','작품 구름열차편','작품 - 구름열차 편','작품 제1장','Show Part 2','작품 파트 2','작품 2부',
    '작품 -부제-','작품 –부제–','작품 ~부제~','작품: 부제','작품 BD','작품 더빙','작품 (자막)'];
  editions.forEach((title,i)=>{
    const base = `base${i}`, edition = `edition${i}`, same = `same${i}`;
    add(base,`작품 ${i}`,'a'); add(edition,`case${i} ${title}`,'b'); add(same,`case${i} ${title}`,'c');
    link(base,100+i); link(edition,100+i,'tv',null,'manual');
    assert.equal(groups.group(base,'p1').members.length,1,title);
    assert.deepEqual(groups.group(edition,'p1').members.map(m=>m.id),[edition,same],title);
  });
  add('marked','작품 -부제-','a'); add('plain','작품 부제','b'); add('english','Show Subtitle','c');
  link('marked',500); link('plain',500); link('english',500);
  assert.deepEqual(groups.group('marked','p1').members.map(m=>m.id),['marked','plain'],'equivalent punctuation cannot bridge an edition into a broader TMDB group');
  assert.equal(groups.group('english','p1').members.length,1);
}));

test('conflicting TMDB identities split homonyms and leave unlinked entries in their own title group',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [id,provider] of [['first','a'],['second','b'],['none','c'],['off','d'],['pending','e']]) add(id,'동명 작품',provider);
  add('english','First Show','f');
  link('first',100); link('second',200); link('none',100,'tv',null,'none'); link('off',100,'tv',null,'off'); link('english',100);
  assert.deepEqual(groups.group('first','p1').members.map(m=>m.id),['first','english']);
  assert.deepEqual(groups.group('none','p1').members.map(m=>m.id),['none','off','pending']);
  assert.equal(groups.resolve(['first','second','none','off','pending','english'],'p1').length,3);
  add('special-a','동명 특별편','a'); add('special-b','동명 특별편','b');
  link('special-a',100); link('special-b',200);
  assert.equal(groups.resolve(['special-a','special-b'],'p1').length,2,'title-only editions still respect conflicting links');
  add('season-a','시즌 동명','a'); add('season-b','시즌 동명','b'); link('season-a',300,'tv',1); link('season-b',300,'tv',2);
  assert.equal(groups.resolve(['season-a','season-b'],'p1').length,2,'same title but different linked seasons');
}));

test('one TMDB identity accepts title-equivalent none/off/pending entries without guessing other titles',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [id,provider] of [['linked','a'],['none','b'],['off','c'],['pending','d']]) add(id,'같은 제목',provider);
  add('english','Same Title','e'); add('unknown','다른 표기','f');
  link('linked',100); link('english',100); link('none',200,'tv',null,'none'); link('off',300,'tv',null,'off');
  assert.equal(groups.group('linked','p1').members.length,5);
  assert.equal(groups.group('unknown','p1').members.length,1);
}));

test('provider duplicates join a confirmed TMDB identity',()=>withTmdbGroups(({groups,add,link})=>{
  add('a1','작품','a'); add('a2','Show','a'); add('b','Different Spelling','b'); add('c','작품','c');
  for (const id of ['a1','a2','b']) link(id,100);
  assert.equal(groups.resolve(['a1','a2','b','c'],'p1').length,1);
  assert.deepEqual(groups.group('a1','p1').members.map(m=>m.id),['a1','c','a2','b']);
}));

test('manual overrides win over TMDB conflicts and duplicate providers with profile isolation and reset',()=>withTmdbGroups(({groups,add,link})=>{
  add('a','작품','a'); add('b','Show','b'); add('c','다른 작품','a'); link('a',100); link('b',100); link('c',200);
  groups.change('a','p1','merge','c');
  assert.equal(groups.group('a','p1').manual,true);
  assert.equal(groups.group('a','p1').members.length,3);
  assert.equal(groups.group('a','p2').members.length,2);
  groups.change('b','p1','separate'); assert.equal(groups.group('a','p1').members.length,2);
  groups.change('b','p1','reset'); assert.equal(groups.group('b','p1').manual,false); assert.equal(groups.group('b','p1').members.length,1);
  groups.change('c','p1','reset'); groups.change('a','p1','reset');
  assert.deepEqual(groups.group('a','p1').members.map(m=>m.id),['a','b']);
}));

test('linked live, truncated titles and disabled providers stay excluded from automatic matches',()=>withTmdbGroups(({db,groups,add,link})=>{
  add('base','정상 제목','a'); add('live','정상 제목','b','anime',{live:true});
  add('dots','정상 제목...','c'); add('ellipsis','정상 제목…','d'); add('disabled','Other Title','e');
  add('local-dots','정상 제목...','local');
  for (const id of ['base','live','dots','ellipsis','disabled','local-dots']) link(id,100);
  db.run("UPDATE source_entries SET enabled=0 WHERE id='e'");
  assert.equal(groups.resolve(['base','live','dots','ellipsis','disabled','local-dots'],'p1').length,5);
  assert.equal(groups.group('base','p1').members.length,1);
  assert.throws(()=>groups.group('disabled','p1'),/media-not-found/);
}));

test('local single seasons join their season while multi-season and unknown libraries stay title-only',()=>withTmdbGroups(({db,groups,add,link})=>{
  add('single','로컬 작품','local'); add('multi','로컬 작품','local'); add('unknown','로컬 작품','local');
  add('remote-one','Remote Show','a'); add('remote-two','Remote Show 2기','b');
  db.run("INSERT INTO episodes VALUES('s2','single',2,1,'1화',0,NULL)");
  db.run("INSERT INTO episodes VALUES('m1','multi',1,1,'1화',0,NULL)");
  db.run("INSERT INTO episodes VALUES('m2','multi',2,1,'1화',0,NULL)");
  for (const id of ['single','multi','unknown','remote-one','remote-two']) link(id,100);
  assert.deepEqual(groups.group('single','p1').members.map(m=>m.id),['single','remote-two']);
  assert.equal(groups.resolve(['single','multi','unknown','remote-one','remote-two'],'p1').length,4);
  add('roman','Local Show II','local'); add('roman-remote','Remote Season 2','c');
  db.run("INSERT INTO episodes VALUES('r1','roman',1,1,'1화',0,NULL)");
  link('roman',200); link('roman-remote',200);
  assert.deepEqual(groups.group('roman','p1').members.map(m=>m.id),['roman','roman-remote'],'parsed original title season precedes the appended local fallback');
  const queries: string[] = [], all = db.all.bind(db);
  db.all = ((sql: string,...params: Parameters<Store['all']>[1][]) => { queries.push(sql); return all(sql,...params); }) as Store['all'];
  groups.resolve([],'p1');
  assert.equal(queries.length,4,'mapping query count is independent of media and local season counts');
  assert.equal(queries.filter(sql=>sql.includes('tmdb_links')).length,1,'TMDB links loaded in one join');
}));

test('manual grouping candidates also match accepted TMDB card titles',()=>withTmdbGroups(({db,groups,add,link})=>{
  for (const [id,provider] of [['linked','a'],['off','b'],['disabled','c']]) add(id,`원본 ${id}`,provider);
  link('linked',100,'tv',null,'manual'); link('off',100,'tv',null,'off'); link('disabled',100);
  db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)','tv',100,JSON.stringify({title:'The Canonical Title'}),'{}',Date.now());
  db.run("UPDATE source_entries SET enabled=0 WHERE id='c'");
  assert.deepEqual(groups.candidates('canonical','p1').map(m=>m.id),['linked']);
  assert.deepEqual(groups.candidates('원본 linked','p1').map(m=>m.id),['linked']);
  assert.deepEqual(groups.candidates('','p1'),[]);
}));


test('confirmed TMDB duplicates join even with repeated source title text',()=>withTmdbGroups(({groups,add,link})=>{
  const title = '구름을 따라갈 생각이야';
  add('a',`「${title}」라던 작은 탐험가이 어째선지 제게 푹 빠졌어요`,'a');
  add('b',`'${title}'라던 작은 탐험가이 어째선지 제게 푹 빠졌어요`,'b');
  add('duplicate',`「${title}」라던 작은 탐험가이 어째선지 제게 푹 빠졌어요 작은 탐험가이 어째선지 제게 푹 빠졌어요`,'a');
  for (const id of ['a','b','duplicate']) link(id,9101);
  assert.equal(groups.group('a','p1').members.length,3);
}));

test('duplicate fallback retains conflict partitions and never reconnects different identities',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [id,provider] of [['a','a'],['b','b'],['c','c'],['none','d']]) add(id,'동명 작품',provider);
  add('duplicate','Other Spelling','a');
  link('a',100); link('b',100); link('c',200); link('duplicate',100);
  assert.deepEqual(groups.group('a','p1').members.map(m=>m.id),['a','b','duplicate']);
  assert.equal(groups.resolve(['a','b','c','none','duplicate'],'p1').length,3);
}));

test('Latin suffixes after colon or hyphen permit TMDB grouping but Korean subtitles do not',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [i,title] of ['바람의 여행자: Immortal','바람의 여행자 Immortal','바람의 여행자 - Immortal','바람의 여행자 – Immortal'].entries()) {
    add(`latin${i}`,title,['a','b','c','d'][i],i===0 ? 'series' : 'anime'); link(`latin${i}`,9102);
  }
  assert.equal(groups.group('latin0','p1').members.length,4);
  for (const [i,title] of ['작품: 별빛성편','작품 - 구름열차 편','작품: Special','작품 - Part 2','작품: 2'].entries()) {
    add(`edition${i}`,title,'e'); link(`edition${i}`,9102);
    assert.equal(groups.group(`edition${i}`,'p1').members.length,1,title);
  }
}));

test('embedded Roman numerals establish season even before subtitles and parts',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [i,title,season] of [
    [0,'별나라 탐험 Ⅲ ~먼 행성에서 길을 찾는다',3],
    [1,'별나라 탐험 III ~먼 행성에서 길을 찾는다~',3],
    [2,'별나라 탐험 Ⅱ ~먼 행성에서 길을 찾는다~ 파트 1',2],
    [3,'별나라 탐험 III 먼 행성에서 길을 찾는다',3],
  ] as const) {
    assert.equal(titleGroupSeason(title),season,title);
    add(`roman${i}`,title,'a'); add(`first${i}`,title,'b');
    link(`roman${i}`,100+i); link(`first${i}`,100+i,'tv',1);
    assert.equal(groups.resolve([`roman${i}`,`first${i}`],'p1').length,2,title);
  }
}));

test('bare TV number is a season only when absent from the linked TMDB title',()=>withTmdbGroups(({db,groups,add,link})=>{
  const base = '신기한 지도와 함께 떠나는 여행';
  add('one',base,'a'); add('two',`${base} 2`,'b'); add('two-en','Map Adventure Season 2','c');
  for (const id of ['one','two','two-en']) link(id,9103);
  db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)','tv',9103,JSON.stringify({title:base}),'{}',Date.now());
  assert.deepEqual(groups.group('two','p1').members.map(m=>m.id),['two','two-en']);
  assert.equal(groups.group('one','p1').members.length,1);
  assert.equal(titleGroupSeason('로봇 8','로봇 8'),undefined);
  assert.equal(titleGroupSeason('작품 2'),undefined,'missing TMDB title cannot establish a numeric season');
  assert.equal(titleGroupSeason('86','86'),undefined);
  assert.equal(titleGroupSeason('작품 ２','작품'),2);
}));

test('cours and parts stay title-only within the same TV season',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [i,suffix] of ['2쿨','2 쿨','파트 1','part 1','2부'].entries()) {
    add(`base${i}`,'본편','a'); add(`part${i}`,`본편 ${suffix}`,'b'); add(`same${i}`,`본편 ${suffix}`,'c');
    for (const id of [`base${i}`,`part${i}`,`same${i}`]) link(id,100+i,'tv',2);
    assert.equal(groups.group(`base${i}`,'p1').members.length,1,suffix);
    assert.deepEqual(groups.group(`part${i}`,'p1').members.map(m=>m.id),[`part${i}`,`same${i}`],suffix);
  }
}));

test('parts join across languages and same-provider duplicates, but never full seasons or other parts',()=>withTmdbGroups(({groups,add,link})=>{
  for (const [id,title,source] of [['full','작품 3기','a'],['p1','작품 3기 파트1','a'],['p2','작품 3기 파트2','b'],['en','Show Season 3 Part 2','c'],['dup','작품 3기 part 2','b']]) {
    add(id,title,source);link(id,100,'tv',3);
  }
  assert.deepEqual(groups.group('p2','p1').members.map(m=>m.id),['p2','dup','en']);
  assert.equal(groups.resolve(['full','p1','p2','en','dup'],'p1').length,3);
}));

test('conflicting source episode counts cannot merge through unknown-count entries',()=>withTmdbGroups(({db,groups,add,link})=>{
  for (const [id,count] of [['full',22],['cour',12],['unknown',0]] as const) {
    add(id,'작품 3기','a');link(id,100,'tv',3);
    for(let n=1;n<=count;n++)db.run('INSERT INTO episodes VALUES(?,?,3,?,?,0,NULL)',`${id}-${n}`,id,n,`${n}화`);
  }
  assert.equal(groups.resolve(['full','cour','unknown'],'p1').length,3);
}));

test('final halves and OAD numbers cannot collapse into the parent TV series',()=>withTmdbGroups(({groups,add,link})=>{
  const titles=['작품 4기','작품 4기 The FINAL part 3 완결편 (전편)','작품 4기 The FINAL part 3 완결편 (후편)','작품 OAD1','작품 OAD2','작품 특별편'];
  titles.forEach((title,i)=>{add(String(i),title,'a');link(String(i),100,'tv',4)});
  assert.equal(groups.resolve(titles.map((_,i)=>String(i)),'p1').length,6);
}));

test('resolve selects Korean, then all/local, and returns unique selected source languages',()=>withTmdbGroups(({db,groups,add,link})=>{
  for (const [id,lang] of [['a','en'],['b','all'],['c','ko'],['d','en']]) db.run('UPDATE source_entries SET entry=? WHERE id=?',JSON.stringify({lang}),id);
  for (const id of ['a','b','c','d']) {add(id,'작품',id);link(id,100)}
  const result=groups.resolve(['a','d','b','c'],'p1','작품');
  assert.equal(result[0].id,'c'); assert.equal(result[0].provider.lang,'ko');
  assert.deepEqual(result[0].langs,['all','en','ko']);assert.equal(result[0].sourceCount,4);assert.equal(result[0].relevance,1);
  assert.equal(groups.resolve(['a','b'],'p1')[0].id,'b');
  assert.deepEqual(groups.resolve(['a','d'],'p1')[0].langs,['en']);
  assert.equal(groups.resolve(['a'],'p1')[0].relevance,undefined);
  add('local','작품 season 1','local');link('local',100,'tv',1);
  assert.equal(groups.resolve(['a','local'],'p1')[0].id,'local');
  assert.equal(groups.resolve(['a','local'],'p1')[0].provider.lang,undefined);
}));


test('audio labels do not merge separate editions; plain movie labels stay absent',()=>withTmdbGroups(({groups,add,link})=>{
  add('plain','작품 2기','a'); add('dub','작품 2기 더빙판','b'); add('sub','작품 2기 (자막)','c');
  for (const id of ['plain','dub','sub']) link(id,100,'tv',2);
  const cards=groups.resolve(['plain','dub','sub'],'p1');
  assert.equal(cards.length,3);
  assert.deepEqual(cards.map(c=>c.audio),[undefined,'dub','sub']);
  add('movie','우주 구조대','d','movie'); add('tv','우주 구조대','e','series');
  link('movie',200,'movie');link('tv',200,'tv');
  assert.equal(groups.resolve(['movie','tv'],'p1').length,2);
  assert.equal(groups.resolve(['movie'],'p1')[0].seasonInfo,undefined);
}));


test('popular merges source ranks once per provider, independent of arrival/source order',()=>withTmdbGroups(({groups,add})=>{
  add('solo','Solo','a');add('shared-a','Shared','a');add('b-first','B First','b');add('b-second','B Second','b');add('shared-b','Shared','b');
  const lists=[{sourceId:'a',ids:['solo','shared-a','shared-a']},{sourceId:'b',ids:['b-first','b-second','shared-b']}];
  const result=groups.popular(lists,'p1');assert.equal(result[0].title,'Shared');assert.equal(result[0].sourceCount,2);
  assert.deepEqual(groups.popular([...lists].reverse(),'p1'),result);
  assert.deepEqual(groups.popular([...lists,lists[0]],'p1'),result);
  assert.equal(result.filter(c=>c.title==='Shared').length,1);
  // A single provider retains its own order; duplicate IDs never add points.
  assert.deepEqual(groups.popular([lists[0]],'p1').map(c=>c.title),['Solo','Shared']);
}));
test('popular keeps seasons separate, honors profile overrides and excludes wrong/disabled/live sources',()=>withTmdbGroups(({db,groups,add})=>{
  add('a1','Show season 1','a');add('b2','Show season 2','b');add('live','Channel','c','anime',{live:true});
  const lists=[{sourceId:'a',ids:['a1']},{sourceId:'b',ids:['b2']},{sourceId:'c',ids:['live']}];
  assert.equal(groups.popular(lists,'p1').length,2);
  groups.change('a1','p1','merge','b2');assert.equal(groups.popular(lists,'p1').length,1);
  assert.equal(groups.popular(lists,'p2').length,2);
  assert.equal(groups.popular([{sourceId:'b',ids:['a1']}],'p2').length,0);
  db.run("UPDATE source_entries SET enabled=0 WHERE id='a'");assert.deepEqual(groups.popular(lists,'p2').map(c=>c.id),['b2']);
  db.run("UPDATE profiles SET kids=1 WHERE id='p2'");assert.equal(groups.popular(lists,'p2').length,0);
}));
test('popular limits each source to twenty candidates and returns at most ten',()=>withTmdbGroups(({groups,add})=>{
  for(let i=0;i<22;i++)add(`a${i}`,`Title ${i}`,'a','movie');add('b','Title 21','b','movie');
  const cards=groups.popular([{sourceId:'a',ids:Array.from({length:22},(_,i)=>`a${i}`)},{sourceId:'b',ids:['b']}],'p1');
  assert.equal(cards.length,10);assert.equal(cards.find(c=>c.title==='Title 21')?.sourceCount,1);
}));
