import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.js';
import { Sources } from '../src/sources/service.js';
import { Catalog } from '../src/catalog/service.js';
import { DetailPolicy, ACTIVE_DETAIL_POLICY, COMPLETED_DETAIL_POLICY } from '../src/catalog/detail-policy.js';
import { ImageCache } from '../src/metadata/image-cache.js';
import { buildApp } from '../src/app.js';
const DAY=86400_000;
const temporary=()=>mkdtemp(join(tmpdir(),'moa-cache-tuning-'));

test('completion evidence is conservative, durable, and changes reset even TMDB and movies',async()=>{
 const root=await temporary(),db=new Store(root);let now=Date.UTC(2026,9,4);const policy=new DetailPolicy(db,()=>now);
 db.run("INSERT INTO media VALUES('m',NULL,'Title','series','{}','2026')");
 const observe=(ids:string[],completed=true)=>policy.observe('m',ids.map((id,i)=>({id,number:i+1})),completed);
 const active=()=>assert.deepEqual(policy.policy('m'),ACTIVE_DETAIL_POLICY),done=()=>assert.deepEqual(policy.policy('m'),COMPLETED_DETAIL_POLICY);
 try {
  active();observe(['a']);active();now+=21*DAY-1;active();now++;done();
  // Same count and same last episode, but another ID changed.
  observe(['a','b']);active();now+=21*DAY;done();observe(['x','b']);active();
  assert.equal(db.get("SELECT changed_at FROM source_detail_observations WHERE media_id='m'")!.changed_at,now);
  assert.deepEqual(new DetailPolicy(db,()=>now).policy('m'),ACTIVE_DETAIL_POLICY);
  now+=21*DAY;observe(['x','b'],false);active();observe(['x','b']);done();
  db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES('m','tv',1,'auto',?)",now);
  const metadata=(status:string,date:string)=>db.run("INSERT OR REPLACE INTO tmdb_titles VALUES('tv',1,?,'{}',?)",JSON.stringify({status,lastAirDate:date}),now);
  const date=(days:number)=>new Date(now-days*DAY).toISOString().slice(0,10);
  metadata('Returning Series',date(60));active();metadata('Ended',date(29));active();metadata('Ended',date(30));done();
  metadata('Canceled',date(31));done();metadata('Ended','2026-02-30');active();metadata('Ended','');active();
  metadata('Ended',date(60));observe(['x','b','c']);active();now+=21*DAY;done();
  db.run("UPDATE tmdb_links SET status='off' WHERE media_id='m'");observe(['x','b','c'],false);active();
  db.run("UPDATE media SET type='movie' WHERE id='m'");done();observe(['x','b','c','d']);active();
  now+=21*DAY;done();db.run("UPDATE media SET metadata='{\"live\":true}' WHERE id='m'");active();
  db.run("DELETE FROM media WHERE id='m'");assert.equal(db.get('SELECT * FROM source_detail_observations'),undefined);
 } finally {db.close();await rm(root,{recursive:true,force:true});}
});

test('search has six-hour fresh/24-hour SWR; popular stays five minutes; counters include real loader attempts',async()=>{
 const root=await temporary(),db=new Store(root),catalog=new Catalog(db);let calls=0,release:()=>void=()=>{};let gate:Promise<void>|undefined;
 const sources=new Sources(db,catalog,async input=>{calls++;if(gate)await gate;return {result:input.action==='list'?{list:[{name:'Title',link:'/title'}],hasNextPage:false}:{name:'Title',status:1,chapters:[{name:'1화',url:'/1'}]},changes:{}};});
 const entry=JSON.stringify({id:'s',name:'Source',baseUrl:'https://test.invalid',version:'1',format:'mangayomi-js'});
 db.run("INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES('s','repo',?,?,'x',1)",entry,entry);
 db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','p','blue',0,'2026')");
 const age=(hours:number)=>db.run('UPDATE source_read_cache SET fetched=?',Date.now()-hours*3600000);
 try {
  gate=new Promise<void>(r=>release=r);
  const reads=Array.from({length:20},()=>sources.browse('s','p','search',1,'query'));
  await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);release();await Promise.all(reads);gate=undefined;
  age(5);const page=await sources.browse('s','p','search',1,'query');assert.equal(calls,1);
  gate=new Promise<void>(r=>release=r);age(7);
  await Promise.all(Array.from({length:10},()=>sources.browse('s','p','search',1,'query')));assert.equal(calls,2);release();gate=undefined;
  // Drain refresh via a cold read of the same flight after expiring it fully.
  age(25);await sources.browse('s','p','search',1,'query');
  await sources.browse('s','p','popular');const before=calls;age(2);
  await sources.browse('s','p','popular');await new Promise(r=>setTimeout(r,10));assert.equal(calls,before+1);
  const mid=page.items[0].id;await sources.detail(mid);await sources.detail(mid);
  const observation=db.get('SELECT * FROM source_detail_observations WHERE media_id=?',mid)!;assert.equal(observation.completed,1);
  const stats=sources.stats.snapshot();assert.equal(stats.sources.s.search.hit,1);assert.ok(stats.sources.s.search.stale>=10);
  assert.ok(stats.sources.s.search.coalesced>=19);assert.equal(stats.sources.s.detail.externalCalls,1);assert.equal(stats.sources.s.detail.hit,1);
  assert.equal(JSON.stringify(stats).includes('query'),false);assert.equal(JSON.stringify(stats).includes(mid),false);
  // Settings changes remove old observations along with freshness.
  sources.invalidate('s');assert.equal(db.get('SELECT * FROM source_detail_observations'),undefined);
 } finally {release();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('image cache merges same variant and original downloads; freshness and durable LRU budget',async()=>{
 const root=await temporary();let now=Date.now();const dir=join(root,'images');await mkdir(dir);
 const cache=new ImageCache(dir,100,()=>now);let calls=0;
 try {
  const produce=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Buffer.alloc(40,1);};
  await Promise.all(Array.from({length:20},()=>cache.get('a.webp',1000,produce)));assert.equal(calls,1);
  now+=500;await cache.get('a.webp',1000,produce);assert.equal(calls,1);
  now+=1001;await cache.get('a.webp',1000,produce);assert.equal(calls,2);
  let downloads=0;
  await Promise.all(['b','c'].map(k=>cache.get(k+'.webp',1000,()=>cache.original('same-url-and-headers',async()=>{downloads++;await new Promise(r=>setTimeout(r,10));return Buffer.alloc(20);})))) ;assert.equal(downloads,1);
  await cache.prune();
  // Deterministic older entries, then touch old mtime file to make it most recently accessed.
  for(const name of await readdir(dir))await rm(join(dir,name));
  for(const [key,t] of [['old',1000],['hot',2000],['new',3000]] as const){await writeFile(join(dir,key+'.webp'),Buffer.alloc(40));await utimes(join(dir,key+'.webp'),new Date(t),new Date(t));}
  await cache.get('hot.webp',Infinity,async()=>{throw Error('cache missed');});
  await cache.prune();assert.deepEqual((await readdir(dir)).sort(),['hot.webp','new.webp']);
  assert.equal((await stat(join(dir,'hot.webp'))).mtimeMs,2000);
  await assert.rejects(cache.get('../escape.webp',1,produce),/invalid-image-key/);
 } finally {await cache.close();await rm(root,{recursive:true,force:true});}
});

test('cache stats requires admin (including encoded path), no profile needed and no personal fields',async()=>{
 const root=await temporary();process.env.MOA_SCAN_INTERVAL_MS='0';
 const {app,sources}=await buildApp({dataDir:root,mediaRoot:root,webDir:join(root,'no-web'),requireAccount:true},false,{tmdb:{}});
 try {
  sources.stats.external('safe-source','videos');
  for(const url of ['/api/admin/cache-stats','/%61pi/admin/cache-stats']) {
   assert.equal((await app.inject({url})).statusCode,401);
   assert.equal((await app.inject({url,headers:{'x-moa-account':'member','x-moa-role':'member'}})).statusCode,403);
  }
  const response=await app.inject({url:'/api/admin/cache-stats',headers:{'x-moa-account':'admin','x-moa-role':'admin'}});
  assert.equal(response.statusCode,200);assert.equal(response.json().sources['safe-source'].videos.externalCalls,1);
  assert.deepEqual(Object.keys(response.json()).sort(),['externalCallUnit','sources','startedAt']);
  assert.equal(response.headers['cache-control'],'private, no-store');
 } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('legacy details acquire new observations safely; completed detail reads stay fresh for three days and SWR afterward',async()=>{
 const root=await temporary();let db=new Store(root),calls=0;
 const create=()=>new Sources(db,new Catalog(db),async()=>{calls++;return {result:{name:'Legacy',status:1,chapters:[{name:'1화',url:'/e'}]},changes:{}};});
 let sources=create();
 const entry=JSON.stringify({id:'s',name:'Source',baseUrl:'https://test.invalid',version:'1',format:'mangayomi-js'});
 db.run("INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES('s','repo',?,?,'x',1)",entry,entry);
 db.run("INSERT INTO media VALUES('m',NULL,'Legacy','series','{}','2026')");
 db.run("INSERT INTO source_media VALUES('m','s','/m',?)",Date.now()-30*DAY);
 try {
  assert.equal(db.get('SELECT * FROM source_detail_observations'),undefined);
  await sources.detail('m');assert.equal(calls,1);
  // Historical detail_at did not invent a long stable period.
  assert.deepEqual(new DetailPolicy(db).policy('m'),ACTIVE_DETAIL_POLICY);
  db.run('UPDATE source_detail_observations SET changed_at=?',Date.now()-22*DAY);
  db.run('UPDATE source_read_cache SET fetched=?',Date.now()-2*DAY);
  await sources.detail('m');assert.equal(calls,1);
  await sources.close();db.close();db=new Store(root);sources=create();
  await sources.detail('m');assert.equal(calls,1);
  db.run('UPDATE source_read_cache SET fetched=?',Date.now()-4*DAY);
  await sources.detail('m');await sources.close();assert.equal(calls,2);
  assert.deepEqual(new DetailPolicy(db).policy('m'),COMPLETED_DETAIL_POLICY);
 } finally {await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('image startup LRU survives restart, excludes unrelated files and recovers after failed generation',async()=>{
 const root=await temporary();let cache=new ImageCache(root,100);
 try {
  await cache.get('hot.jpg',Infinity,async()=>Buffer.alloc(40));await cache.close();
  await writeFile(join(root,'old.webp'),Buffer.alloc(40));await utimes(join(root,'old.webp'),new Date(1000),new Date(1000));
  await writeFile(join(root,'new.png'),Buffer.alloc(40));await writeFile(join(root,'unrelated.json'),'keep');
  cache=new ImageCache(root,100);await cache.prune();
  assert.deepEqual((await readdir(root)).sort(),['hot.jpg','new.png','unrelated.json']);
  await assert.rejects(cache.get('../escape.jpg',1,async()=>Buffer.alloc(1)),/invalid-image-key/);
  await assert.rejects(cache.get('script.svg',1,async()=>Buffer.alloc(1)),/invalid-image-key/);
  await assert.rejects(cache.get('failed.webp',1000,async()=>{throw Error('network failed');}),/network failed/);
  assert.equal((await readdir(root)).some(n=>n.includes('.tmp')),false);
  assert.equal((await cache.get('failed.webp',1000,async()=>Buffer.from('ok'))).toString(),'ok');
 } finally {await cache.close();await rm(root,{recursive:true,force:true});}
});

test('TMDB completion status and air date survive the actual metadata fetch/save path',async()=>{
 const {Tmdb}=await import('../src/metadata/tmdb.js');
 const root=await temporary(),db=new Store(root),sources=new Sources(db,new Catalog(db));
 db.run("INSERT INTO media VALUES('m',NULL,'Title','series','{}','2026')");
 const tmdb=new Tmdb(db,()=>{},{token:'test-only',fetch:async()=>Response.json({id:1,name:'Title',status:'Ended',last_air_date:'2020-01-01',episodes:[]})});
 try {
  await tmdb.change('m',{action:'link',kind:'tv',tmdbId:1});
  const card=JSON.parse(db.get("SELECT card FROM tmdb_titles WHERE tmdb_id=1")!.card);
  assert.equal(card.status,'Ended');assert.equal(card.lastAirDate,'2020-01-01');
  assert.deepEqual(new DetailPolicy(db).policy('m'),COMPLETED_DETAIL_POLICY);
 } finally {tmdb.close();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
