import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';
import { TitleGroups } from '../src/catalog/title-groups.js';
import { Franchises, buildFranchise, type FranchiseMedia } from '../src/catalog/franchise.js';

function media(id:string,title:string,season?:number,part?:number):FranchiseMedia {
  return {title,card:{id,title,type:'anime',provider:{id:'ko',name:'한국',kind:'mangayomi-js',lang:'ko'}},seasons:[],
    ...(season ? {link:{id:9001,kind:'tv',season}} : {})};
}
const keys=(current:FranchiseMedia,all:FranchiseMedia[])=>buildFranchise(current,all).seasons.map(s=>s.key);
test('Sky Explorers regular seasons, complete season versus parts, current part and excluded editions',()=>{
 const all=[media('one','하늘 탐험대 1기',1),media('two','하늘 탐험대 2기',2),media('three','하늘 탐험대 3기',3),media('p1','하늘 탐험대 3기 파트1',3),media('p2','하늘 탐험대 3기 파트2',3),media('final','하늘 탐험대 The Final Season',4),media('f2','하늘 탐험대 파이널 시즌 파트 2',4),media('f3','하늘 탐험대 파이널 시즌 파트 3')];
 all[2].seasons=[{number:3,count:22}];all[3].seasons=[{number:3,count:12}];all[4].seasons=[{number:3,count:10}];
 const extras=['극장판 하늘 탐험대','하늘 탐험대 OAD','하늘 탐험대 특별편','하늘 탐험대: 붉은 나침반','하늘 탐험대 Chronicle','하늘 탐험대: 여행의 등불'].map((t,i)=>media('x'+i,t,1));
 const live=media('live','하늘 탐험대 파트 1',1);live.link={id:22,kind:'movie'};live.card.year=2015;
 assert.deepEqual(keys(all[0],[...all,...extras,live]),['s1','s2','s3','s4','s4p2','s4p3']);
 const result=buildFranchise(all[4],all);assert.deepEqual(result.seasons.map(s=>s.key),['s1','s2','s3','s3p2','s4','s4p2','s4p3']);assert.equal(result.seasons.find(s=>s.key==='s3p2')?.current,true);
 assert.deepEqual(keys(all[0],all.filter(m=>m.card.id!=='three')),['s1','s2','s3p1','s3p2','s4','s4p2','s4p3']);
 all[2].seasons[0].count=12;assert.ok(keys(all[0],all).includes('s3p1'),'unmarked cour is not a full season');
});
test('Starlight Academy accepted TMDB links, conflicts, foreign titles and unknown final ordering',()=>{
 const a=media('a','별빛 학교',1),b=media('b','STARLIGHT ACADEMY Season 2',2),c=media('c','별빛 학교 3기',3);
 c.link!.id=99;assert.deepEqual(keys(a,[a,b,c]),['s1','s2']);
 const f=media('f','별빛 학교 파이널 시즌');assert.deepEqual(keys(a,[a,b,f]),['s1','s2','final']);
});
test('Moonlight Guards named TV arcs need season evidence; movies are never added',()=>{
 const a=media('a','달빛 수호대',1),b=media('b','달빛 수호대: 구름열차 편',2),c=media('c','달빛 수호대: 정원 마을 편',3);
 for(const m of [a,b,c])m.metadata={title:'달빛 수호대'};
 const movie=media('movie','극장판 달빛 수호대: 구름열차 편',2),castle=media('castle','달빛 수호대: 별빛성편',3);castle.link!.kind='movie';
 assert.deepEqual(keys(a,[a,b,c,movie,castle]),['s1','s2','s3']);
});
test('unlinked baseTitle, singleton, series type boundary and source priority',()=>{
 const a=media('a','작품 1기'),b=media('b','작품 시즌 2'),x=media('x','작품: 외전');
 assert.deepEqual(keys(a,[a]),['s1']);assert.deepEqual(keys(a,[a,b,x]),['s1','s2']);
 const other=media('drama','작품 3기');other.card.type='series';assert.deepEqual(keys(a,[a,b,other]),['s1','s2']);
 a.card.type=b.card.type='series';assert.deepEqual(keys(a,[a,b,other]),['s1','s2','s3']);
 const en=media('en','작품 시즌 2');en.card.type='series';en.card.provider={id:'en',name:'English',kind:'mangayomi-js',lang:'en'};en.seasons=[{number:2,count:30}];
 a.card.provider=en.card.provider;assert.equal(buildFranchise(a,[a,b,en]).seasons[1].mediaId,'en');
 a.card.provider={id:'other',name:'other',kind:'mangayomi-js'};assert.equal(buildFranchise(a,[a,b,en]).seasons[1].mediaId,'b');
});
test('local multiple seasons expose playable seasons only, without specials',()=>{
 const a=media('local','드라마');a.card.type='series';a.card.provider={id:'local',name:'로컬',kind:'local'};
 a.seasons=[{number:0,count:2},{number:1,count:9},{number:2,count:6}];a.metadata={seasons:{'1':{episodes:9},'2':{episodes:6},'3':{episodes:6}}};
 const r=buildFranchise(a,[a]);assert.deepEqual(r.seasons.map(s=>[s.key,s.seasonNumber,s.episodeCount,s.current]),[['s1',1,9,true],['s2',2,6,true]]);
});
function setup(){
 const db=new Store('/tmp',new DatabaseSync(':memory:')),catalog=new Catalog(db);new Sources(db,catalog);const groups=new TitleGroups(catalog);
 for(const p of ['p','kids','other'])db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',p,p,'blue',p==='kids'?1:0,'2026');
 db.run("INSERT INTO source_entries(id,repository,entry,enabled,type,code) VALUES('ko','fixture','{\"lang\":\"ko\"}',1,'anime','fixture')");
 const add=(id:string,title:string)=>db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,title,'anime',JSON.stringify({provider:{id:'ko',name:'한국',kind:'mangayomi-js'}}),'2026');
 add('a','작품 1기');add('b','작품 2기');
 return {db,catalog,groups,add};
}
test('fast response, coalesced discovery, profile cache isolation, live filtering and disable invalidation',async()=>{
 const {db,catalog,groups}=setup();let calls=0;let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const f=new Franchises(catalog,groups,{browse:async()=>{calls++;await gate;return {items:[],page:1,hasNextPage:false};}});
 try{
 assert.equal(f.get('a','p').complete,false);assert.equal(f.get('b','p').complete,false);await Promise.resolve();assert.equal(calls,1);
 assert.equal(f.get('a','other').complete,false);await Promise.resolve();assert.equal(calls,2);
 release();await new Promise(r=>setTimeout(r,10));assert.equal(f.get('a','p').complete,true);assert.equal(calls,2);
 groups.change('b','p','separate');assert.equal(f.get('a','p').seasons.length,2);
 db.run("UPDATE source_entries SET enabled=0 WHERE id='ko'");assert.throws(()=>f.get('a','p'),/media-not-found/);
 }finally{db.close();}
});
test('kids policy rechecked on every read, including a cached franchise',async()=>{
 const {db,catalog,groups}=setup();const f=new Franchises(catalog,groups,{browse:async()=>({items:[],page:1,hasNextPage:false})});
 try{
 db.run("INSERT INTO tmdb_titles VALUES('tv',1,?, '{}',0)",JSON.stringify({title:'작품',certification:'ALL'}));
 db.run("INSERT INTO tmdb_links VALUES('a','tv',1,1,'manual',100,0)");
 assert.deepEqual(f.get('a','kids').seasons.map(s=>s.mediaId),['a']);
 db.run("UPDATE tmdb_titles SET card=?",JSON.stringify({title:'작품',certification:'19'}));assert.throws(()=>f.get('a','kids'),/kids-restricted/);
 await new Promise(r=>setTimeout(r,10));
 }finally{db.close();}
});
test('timeout and failed providers settle complete without repeated polling requests',async()=>{
 const {db,catalog,groups}=setup();let calls=0;
 const f=new Franchises(catalog,groups,{browse:async()=>{calls++;return new Promise(()=>{});}},undefined,5);
 try{assert.equal(f.get('a','p').complete,false);await new Promise(r=>setTimeout(r,15));assert.equal(f.get('a','p').complete,true);assert.equal(calls,1);}finally{db.close();}
});

test('romanized bilingual title is retained, arbitrary Latin subtitles cannot use the TV parent link',()=>{
 const a=media('a','Moonlight Guards: Tsuki no Mamori',1);a.metadata={title:'달빛 수호대',originalTitle:'月の守り'};
 const b=media('b','Moonlight Guards: No Regrets',2);b.metadata=a.metadata;
 assert.deepEqual(keys(a,[a,b]),['s1']);assert.deepEqual(keys(b,[a,b]),[]);
});
test('unknown counts stay absent and preferred source ties favor observed count then grouped sources',()=>{
 const a=media('a','작품 1기'),b=media('b','작품 2기'),c=media('c','작품 2기');
 b.seasons=[{number:2,count:12}];c.seasons=[{number:2,count:24}];
 assert.equal(buildFranchise(a,[a,b,c]).seasons[1].mediaId,'c');
 b.seasons[0].count=24;b.group='many';
 const d=media('d','작품 2기');d.group='many';d.card.provider={id:'en',name:'English',kind:'mangayomi-js',lang:'en'};
 const result=buildFranchise(a,[a,b,c,d]);assert.equal(result.seasons[1].mediaId,'b');assert.equal(result.seasons[0].episodeCount,undefined);
});

test('discovery adds new DB seasons, cached reads use fresh rows, and shutdown prevents late metadata work',async()=>{
 const {db,catalog,groups,add}=setup();let ensureCalls=0;
 const f=new Franchises(catalog,groups,{browse:async()=>{add('c','작품 3기');return {items:[],page:1,hasNextPage:false};}}, {ensure:async()=>{ensureCalls++;}});
 try{
 assert.equal(f.get('a','p').seasons.length,2);await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(f.get('a','p').seasons.map(s=>s.key),['s1','s2','s3']);assert.equal(ensureCalls,1);
 let finish!:(page:any)=>void;
 const closing=new Franchises(catalog,groups,{browse:()=>new Promise(resolve=>finish=resolve)}, {ensure:async()=>{ensureCalls++;}});
 closing.get('a','p');await Promise.resolve();await closing.close();
 finish({items:[],page:1,hasNextPage:false});await new Promise(r=>setTimeout(r,5));assert.equal(ensureCalls,1);
 }finally{await f.close();db.close();}
});

test('whole edition beats a preferred-source partial cour; noncontiguous parts do not prove a full season',()=>{
 const a=media('a','작품 3기',3),whole=media('whole','작품 3기',3),p1=media('p1','작품 3기 파트 1',3),p2=media('p2','작품 3기 파트 2',3);
 a.seasons=[{number:3,count:12}];whole.seasons=[{number:3,count:22}];whole.card.provider={id:'other',name:'other',kind:'mangayomi-js',lang:'ko'};
 p1.seasons=[{number:3,count:12}];p2.seasons=[{number:3,count:10}];
 const r=buildFranchise(a,[a,whole,p1,p2]);assert.equal(r.seasons.length,1);assert.equal(r.seasons[0].mediaId,'whole');assert.equal(r.seasons[0].current,true);
 const p3=media('p3','작품 3기 파트 3',3);p3.seasons=[{number:3,count:2}];
 assert.deepEqual(keys(a,[a,p2,p3]),['s3','s3p2','s3p3']);
});
