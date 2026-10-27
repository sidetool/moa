import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Shorts} from '../src/shorts/service.js';
import {Recommendations} from '../src/profiles/recommendations.js';
import {Tmdb} from '../src/metadata/tmdb.js';
import {buildApp} from '../src/app.js';
const DAY=86400_000;
async function fixture(t:TestContext){
  const dir=await mkdtemp(path.join(tmpdir(),'moa-shorts-')),db=new Store(dir,new DatabaseSync(':memory:'));
  let now=Date.parse('2026-10-11T12:00:00Z'),calls=0;
  for(const id of ['viewer','other','kid'])db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',Number(id==='kid'),'2026');
  new Recommendations(db,{enabled:true,ensureDetail:async()=>{}}); // Owns feedback schema.
  const configure=(profile:string,value:Record<string,unknown>)=>db.run('INSERT OR REPLACE INTO settings VALUES(?,?)',profile,JSON.stringify(value));
  const tmdb={shortPopular:async(category:'movie'|'series'|'anime')=>Array.from({length:20},(_,n)=>({key:`movie:${n+1}`,kind:'movie' as const,tmdbId:n+1,title:`Title ${n+1}`,category,href:'/search',reason:'popular' as const})),enabled:true,configurationRevision:0,shortTrailers:async()=>{calls++;return {adult:false,trailers:['AAAAAAAAAAA']};}};
  const recommendations={get:()=>({status:'ready' as const,items:[1,2,3].map(id=>({genreIds:[18],id,kind:'movie' as const,key:`movie:${id}`,title:`Title ${id}`,reason:'personal',href:'/ignored'}))})};
  const youtube={check:async(trailers:unknown[])=>({trailers:trailers as string[],checked:false})};
  const shorts=new Shorts(db,tmdb,recommendations,youtube,()=>now);
  t.after(async()=>{shorts.close();db.close();await rm(dir,{recursive:true,force:true});});
  return {db,tmdb,recommendations,shorts,configure,calls:()=>calls,advance:(days:number)=>{now+=days*DAY;}};
}
test('OFF is default; children and unconfigured metadata do not start discovery',async t=>{
  const f=await fixture(t);
  assert.equal((await f.shorts.feed('viewer')).status,'disabled');
  f.configure('kid',{shortsEnabled:true});assert.equal((await f.shorts.feed('kid')).status,'restricted');
  await assert.rejects(f.shorts.trailers('kid','movie:1'),{error:'shorts-restricted'});
  f.configure('viewer',{shortsEnabled:true});f.tmdb.enabled=false;
  assert.equal((await f.shorts.feed('viewer')).status,'unconfigured');assert.equal(f.calls(),0);
});
test('feed interleaves, deduplicates and paginates without skipping because a prior page was seen',async t=>{
  const f=await fixture(t);f.configure('viewer',{shortsEnabled:true});
  const a=await f.shorts.feed('viewer');assert.equal(a.items.length,8);assert.ok(a.nextCursor);assert.equal(a.items[0].reason,'personal');
  for(const item of a.items)f.shorts.seen('viewer',item.key);
  const b=await f.shorts.feed('viewer',a.nextCursor!);
  assert.equal(b.items.length,8);assert.ok(b.items.every(item=>!a.items.some(prev=>prev.key===item.key)));
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM progress')!.n,0);
});
test('viewed trailers expire after 7 days and isolate profiles',async t=>{
  const f=await fixture(t);for(const id of ['viewer','other'])f.configure(id,{shortsEnabled:true,shortsMode:'personal'});
  f.shorts.seen('viewer','movie:1');
  assert.ok(!(await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  assert.ok((await f.shorts.feed('other')).items.some(i=>i.key==='movie:1'));
  assert.ok((await f.shorts.feed('viewer','0',true)).items.some(i=>i.key==='movie:1'));
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM shorts_seen WHERE profile_id='viewer'")!.n,1);
  f.advance(6);assert.ok(!(await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  f.advance(1);assert.ok((await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  f.shorts.seen('viewer','movie:1');f.shorts.reset('viewer');assert.ok((await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
});
test('manual skips suppress repeats for the selected window without changing viewing history or recommendation feedback',async t=>{
  const f=await fixture(t);
  assert.equal(f.db.settings('viewer').shortsScreenFit,true);
  for(const id of ['viewer','other'])f.configure(id,{shortsEnabled:true,shortsMode:'personal',shortsRepeatDays:7});
  f.shorts.skip('viewer','movie:1');
  assert.ok(!(await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  assert.ok((await f.shorts.feed('other')).items.some(i=>i.key==='movie:1'));
  assert.ok((await f.shorts.feed('viewer','0',true)).items.some(i=>i.key==='movie:1'));
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM progress')!.n,0);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM recommendation_feedback')!.n,0);
  f.advance(7);assert.ok((await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  f.configure('viewer',{shortsEnabled:true,shortsMode:'personal',shortsRepeatDays:0});
  f.shorts.skip('viewer','movie:1');assert.ok((await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  f.configure('viewer',{shortsEnabled:false});assert.throws(()=>f.shorts.skip('viewer','movie:2'),{error:'shorts-disabled'});
  assert.throws(()=>f.shorts.skip('kid','movie:2'),{error:'shorts-restricted'});
});
test('watched titles and feedback are excluded; linked targets resolve within MOA',async t=>{
  const f=await fixture(t);f.configure('viewer',{shortsEnabled:true,shortsMode:'personal'});
  for(const n of [1,2]){
    f.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',`m${n}`,`Title ${n}`,'movie','{}','2026');
    f.db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'movie',?,'manual',1)",`m${n}`,n);
  }
  f.db.run("INSERT INTO episodes VALUES('e','m1',1,1,'Episode',1200,NULL)");
  f.db.run("INSERT INTO progress VALUES('viewer','e',100,1200,0,'2026')");
  f.db.run("INSERT INTO recommendation_feedback VALUES('viewer','movie:3',1)");
  assert.deepEqual((await f.shorts.feed('viewer')).items.map(i=>[i.key,i.href]),[['movie:2','/title/m2']]);
  f.configure('viewer',{shortsEnabled:true,shortsMode:'personal',shortsHideWatched:false});
  assert.equal((await f.shorts.feed('viewer')).items.length,2);
});
test('trailers coalesce and cache; changing metadata config or disabling invalidates access',async t=>{
  const f=await fixture(t);f.configure('viewer',{shortsEnabled:true});
  await Promise.all([f.shorts.trailers('viewer','movie:1'),f.shorts.trailers('viewer','movie:1')]);assert.equal(f.calls(),1);
  f.tmdb.configurationRevision++;await f.shorts.trailers('viewer','movie:1');assert.equal(f.calls(),2);
  let release!:(value:{adult:boolean;trailers:string[]})=>void;
  f.tmdb.shortTrailers=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.shorts.trailers('viewer','movie:2');f.configure('viewer',{shortsEnabled:false});release({adult:false,trailers:['AAAAAAAAAAA']});
  await assert.rejects(pending,{error:'shorts-disabled'});
});
test('routes require profile ownership and settings validate new controls',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-shorts-routes-'));
  const {app,db}=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:true},false,{tmdb:{},youtube:{}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const account={'x-moa-account':'owner','x-moa-role':'admin'};
  await app.inject({url:'/api/me',headers:account});
  for(const [id,owner] of [['p','owner'],['q','other']])db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,0,?,?)',id,id,'blue','2026',owner);
  const headers={...account,'x-moa-profile':'p'};
  assert.equal((await app.inject({url:'/api/shorts'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/shorts',headers:{...headers,'x-moa-profile':'q'}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/shorts',headers})).json().status,'disabled');
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/skip',headers:{...headers,'x-moa-profile':'q'},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/skip',headers,payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/failed',headers:{...headers,'x-moa-profile':'q'},payload:{reason:'temporary'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/failed',headers,payload:{reason:'temporary'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/failed',headers,payload:{reason:'forever'}})).statusCode,400);
  assert.equal((await app.inject({url:'/api/settings',headers})).json().shortsQuality,'auto');
  for(const payload of [{shortsQuality:'1080p'},{shortsQuality:720},{shortsScreenFit:{}},{shortsCategories:[]},{shortsCategories:['sports']},{shortsCategories:['anime','anime']},{shortsRepeatDays:-1},{shortsRepeatDays:365},{shortsMode:'bad'}])assert.equal((await app.inject({method:'PATCH',url:'/api/settings',headers,payload})).statusCode,400);
  const enabled=await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsQuality:'480p',shortsEnabled:true,shortsScreenFit:false,shortsCategories:['movie','anime'],shortsRepeatDays:7,shortsMode:'mixed'}});
  assert.equal(enabled.statusCode,200,enabled.body);
  assert.equal(enabled.json().shortsScreenFit,false);
  assert.equal((await app.inject({url:'/api/settings',headers})).json().shortsQuality,'480p');
  assert.deepEqual(enabled.json().shortsCategories,['movie','anime']);
  assert.equal((await app.inject({url:'/api/shorts',headers})).json().status,'unconfigured');
});

test('category selection rejects unknown genres and unselected personal candidates',async t=>{
  const f=await fixture(t);f.configure('viewer',{shortsEnabled:true,shortsMode:'personal',shortsCategories:['anime']});
  f.recommendations.get=()=>({status:'ready',items:[{id:1,kind:'movie',key:'movie:1',title:'Animated Film',genreIds:[16],reason:'personal',href:'/ignored'},
    {id:2,kind:'movie',key:'movie:2',title:'Drama',genreIds:[18],reason:'personal',href:'/ignored'},
    {id:3,kind:'movie',key:'movie:3',title:'Unknown',genreIds:[],reason:'personal',href:'/ignored'}]});
  assert.deepEqual((await f.shorts.feed('viewer')).items.map(item=>item.key),['movie:1']);
  f.configure('viewer',{shortsEnabled:true,shortsMode:'personal',shortsCategories:['movie']});
  assert.deepEqual((await f.shorts.feed('viewer')).items.map(item=>item.key),['movie:2']);
  f.configure('viewer',{shortsEnabled:true,shortsMode:'personal',shortsCategories:['movie','anime']});
  assert.deepEqual((await f.shorts.feed('viewer')).items.map(item=>item.key),['movie:1','movie:2']);
});
test('TMDB category queries are bounded, classify actual genres and reject mismatched results',async t=>{
  const f=await fixture(t),urls:URL[]=[];
  const tmdb=new Tmdb(f.db,()=>{},{token:'fixture-only',fetch:async(input)=>{
    const url=new URL(String(input));urls.push(url);
    return Response.json({results:[{id:1,adult:false,title:'Animation',name:'Animation',genre_ids:[16]},
      {id:2,adult:false,title:'Drama',name:'Drama',genre_ids:[18]},
      {id:3,adult:false,title:'Unknown',name:'Unknown',genre_ids:[]},
      {id:4,adult:false,title:'Talk',name:'Talk',genre_ids:[10767]},
      {id:5,adult:true,title:'Adult',name:'Adult',genre_ids:[18]}]});
  }});t.after(()=>tmdb.close());
  const anime=await tmdb.shortPopular('anime');assert.equal(anime.length,2);assert.ok(anime.every(item=>item.category==='anime'&&item.tmdbId===1));
  assert.ok(urls.every(url=>url.searchParams.get('with_genres')==='16'&&url.searchParams.get('page')==='1'));
  const series=await tmdb.shortPopular('series');assert.deepEqual(series.map(item=>item.tmdbId),[2]);
  assert.equal(urls.at(-1)!.searchParams.get('without_genres'),'16,10763,10764,10767');
});


test('failed works stay excluded across feeds and replay without becoming watched or disliked',async t=>{
  const f=await fixture(t);for(const id of ['viewer','other'])f.configure(id,{shortsEnabled:true,shortsMode:'personal'});
  f.shorts.failed('viewer','movie:1','unavailable');
  for(const replay of [false,true])assert.ok(!(await f.shorts.feed('viewer','0',replay)).items.some(i=>i.key==='movie:1'));
  assert.ok((await f.shorts.feed('other')).items.some(i=>i.key==='movie:1'));
  for(const table of ['shorts_seen','progress','recommendation_feedback'])assert.equal(f.db.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n,0);
  f.advance(6);f.shorts.failed('viewer','movie:1','temporary'); // Must not shorten the original exclusion.
  f.advance(.5);assert.ok(!(await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
  f.advance(.5);assert.ok((await f.shorts.feed('viewer')).items.some(i=>i.key==='movie:1'));
});
test('transient failures expire in an hour; unavailable works have a minimum day and reset is profile scoped',async t=>{
  const f=await fixture(t);for(const id of ['viewer','other'])f.configure(id,{shortsEnabled:true,shortsMode:'personal',shortsRepeatDays:0});
  f.shorts.failed('viewer','movie:1','unavailable');f.shorts.failed('viewer','movie:2','temporary');
  assert.deepEqual((await f.shorts.feed('viewer')).items.map(i=>i.key),['movie:3']);
  f.advance(1/24);assert.deepEqual((await f.shorts.feed('viewer')).items.map(i=>i.key),['movie:2','movie:3']);
  f.advance(23/24);assert.equal((await f.shorts.feed('viewer')).items.length,3);
  for(const id of ['viewer','other'])f.shorts.failed(id,'movie:1','unavailable');
  f.shorts.reset('viewer');assert.equal((await f.shorts.feed('viewer')).items.length,3);
  assert.equal((await f.shorts.feed('other')).items.length,2);
  assert.throws(()=>f.shorts.failed('kid','movie:1','temporary'),{error:'shorts-restricted'});
  assert.throws(()=>f.shorts.failed('viewer','invalid','temporary'),{error:'invalid-shorts-failure'});
});
