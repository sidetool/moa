import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/db.js';
import {SourceReadCache,SOURCE_CACHE_LIMITS} from '../src/source-cache.js';
import {Sources} from '../src/sources.js';
import {Catalog} from '../src/catalog.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(){const root=await mkdtemp(join(tmpdir(),'moa-cache-'));const db=new Store(root),catalog=new Catalog(db);return{root,db,catalog};}
const seed=(db:Store)=>{const e=JSON.stringify({id:'s',name:'Source',format:'mangayomi-js',baseUrl:'https://source.test',version:'1'});db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','https://repo.test',e,e,'source');};
test('40 simultaneous reads share one upstream call; cached hits bypass a full source queue and hydrate each profile',async()=>{
 const {root,db,catalog}=await fixture();let calls=0;const sources=new Sources(db,catalog,async input=>{
  calls++;await sleep(25);return{result:input.action==='list'?{list:[{name:'작품',link:'/title',adult:true}],hasNextPage:false}:{name:'작품',chapters:[{name:'1화',url:'/episode'}]},changes:{}};
 });seed(db);
 for(const p of ['a','b','kid'])db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,?,?,?)',p,p,'blue',Number(p==='kid'),'2026',p);
 try{
  const results=await Promise.all(Array.from({length:40},(_,i)=>sources.browse('s',i%2?'a':'b')));assert.equal(calls,1);
  const mid=results[0].items[0].id;await Promise.all(Array.from({length:40},()=>sources.detail(mid)));assert.equal(calls,2);
  const eid=catalog.detail(mid,'a').playTarget!.episodeId;db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','a',eid,120,1200,0,'2026');db.run('INSERT INTO watchlist VALUES(?,?,?)','a',mid,'2026');
  let release!:()=>void;const blocker=sources.serial('s',()=>new Promise<void>(r=>{release=r;}));await sleep(0);
  const queue=Array.from({length:7},()=>sources.serial('s',async()=>{}));
  const [a,b,k]=await Promise.all([sources.browse('s','a'),sources.browse('s','b'),sources.browse('s','kid')]);
  assert.equal(a.items[0].inWatchlist,true);assert.ok(a.items[0].progress);assert.equal(b.items[0].inWatchlist,false);assert.equal(b.items[0].progress,undefined);assert.equal(k.items.length,0);assert.equal(calls,2);
  release();await Promise.all([blocker,...queue]);await sources.close();
  const reopened=new Sources(db,catalog,async()=>{throw Error('must not request after restart');});
  assert.equal((await reopened.browse('s','b')).items.length,1);await reopened.detail(mid);await reopened.close();
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('stale successful data is immediate, one refresh fails, and cooldown prevents an upstream stampede',async()=>{
 const {root,db,catalog}=await fixture();const sources=new Sources(db,catalog);seed(db);let now=1000,calls=0;const cache=new SourceReadCache(db,new AbortController().signal,()=>now),policy={freshMs:100,staleMs:5000};
 try{
  assert.deepEqual(await cache.read('s','page',policy,async()=>{calls++;return{ids:['old']};}),{ids:['old']});now=1200;
  let fail!:(e:Error)=>void;const loader=async()=>{calls++;return new Promise<{ids:string[]}>((_,reject)=>{fail=reject;});};
  const pages=await Promise.all(Array.from({length:30},()=>cache.read('s','page',policy,loader)));assert.equal(calls,2);assert.ok(pages.every(p=>p.ids[0]==='old'));
  fail(Error('upstream failed'));await cache.drain();for(let i=0;i<30;i++)await cache.read('s','page',policy,loader);assert.equal(calls,2);
  now=7000;await assert.rejects(cache.read('s','page',policy,async()=>{throw Error('expired');}),/expired/);
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('settings invalidation separates in-flight generations and prevents stale publication',async()=>{
 const {root,db,catalog}=await fixture();const sources=new Sources(db,catalog);seed(db);const cache=new SourceReadCache(db,new AbortController().signal);let release!:()=>void;
 try{
  const old=assert.rejects(cache.read('s','page',{freshMs:1000,staleMs:1000},async current=>{await new Promise<void>(r=>release=r);current();return'old';}),/invalidated/);await sleep(0);
  cache.invalidate('s');assert.equal(await cache.read('s','page',{freshMs:1000,staleMs:1000},async()=> 'new'),'new');release();await old;
  assert.equal(await cache.read('s','page',{freshMs:1000,staleMs:1000},async()=> 'wrong'),'new');
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('a quick transient detail error retries once; permission and invalid payload errors do not retry',async()=>{
 const {root,db,catalog}=await fixture();let calls=0,fail='source_connection_failed';const sources=new Sources(db,catalog,async input=>{
  if(input.action==='list')return{result:{list:[{name:'작품',link:'/title'}],hasNextPage:false},changes:{}};
  calls++;if(fail==='invalid-payload')return{result:{name:'작품'},changes:{}};if(calls%2===1)throw Error(fail);return{result:{name:'작품',chapters:[]},changes:{}};
 });seed(db);db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
 try{const mid=(await sources.browse('s','p')).items[0].id;await Promise.all([sources.detail(mid),sources.detail(mid)]);assert.equal(calls,2);sources.invalidate('s');fail='source_access_denied';await assert.rejects(sources.detail(mid),/access_denied/);assert.equal(calls,3);sources.invalidate('s');fail='invalid-payload';await assert.rejects(sources.detail(mid),/source-invalid-response/);assert.equal(calls,4);}
 finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('cache bounds include migrated details and large pages; oversized responses are not retained',async()=>{
 const {root,db,catalog}=await fixture();const sources=new Sources(db,catalog);seed(db);const cache=new SourceReadCache(db,new AbortController().signal,Date.now,{maxEntries:1000,maxBytes:16*1024*1024});
 try{
  for(let i=0;i<1100;i++)cache.prime('s','detail:'+i,true,Date.now());
  assert.equal(db.get('SELECT count(*) AS n FROM source_read_cache')!.n,1000);
  for(let i=0;i<40;i++)await cache.read('s','page:'+i,{freshMs:1000,staleMs:1000},async()=> 'x'.repeat(500_000));
  assert.ok(db.get('SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM source_read_cache')!.bytes<=16*1024*1024);
  await cache.read('s','oversized',{freshMs:1000,staleMs:1000},async()=> 'x'.repeat(600_000));
  assert.equal(db.get("SELECT 1 FROM source_read_cache WHERE cache_key='oversized'"),undefined);
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});


test('expanded cache retains more than the old limit and upgrades persisted byte accounting',async()=>{
 const {root,db,catalog}=await fixture();const sources=new Sources(db,catalog);seed(db);
 try {
  assert.deepEqual(SOURCE_CACHE_LIMITS,{maxEntries:10_000,maxBytes:128*1024*1024});
  db.db.exec('DROP TABLE source_read_cache; CREATE TABLE source_read_cache(source_id TEXT,cache_key TEXT,payload TEXT,fetched INTEGER,retry INTEGER,touched INTEGER,PRIMARY KEY(source_id,cache_key))');
  const payload=JSON.stringify({title:'한글 작품'});
  db.run('INSERT INTO source_read_cache VALUES(?,?,?,?,0,?)','s','legacy',payload,1000,1000);
  const cache=new SourceReadCache(db,new AbortController().signal,()=>1000);
  assert.equal(db.get('SELECT bytes FROM source_read_cache')!.bytes,Buffer.byteLength(payload));
  assert.deepEqual(await cache.read('s','legacy',{freshMs:100,staleMs:100},async()=>{throw Error('legacy cache missed');}),{title:'한글 작품'});
  for(let i=0;i<1200;i++)cache.prime('s','page:'+i,true,1000);
  assert.equal(db.get('SELECT count(*) AS n FROM source_read_cache')!.n,1201);
  const plan=db.all('EXPLAIN QUERY PLAN SELECT SUM(bytes) FROM source_read_cache INDEXED BY source_read_cache_bytes');
  assert.ok(plan.some(row=>String(row.detail).includes('COVERING INDEX')));
  const bounded=new SourceReadCache(db,new AbortController().signal,()=>2000,{maxEntries:4,maxBytes:100});
  bounded.prime('s','new','안녕'.repeat(6),2000);
  assert.ok(db.get('SELECT count(*) AS n FROM source_read_cache')!.n<=4);
  assert.ok(db.get('SELECT SUM(bytes) AS n FROM source_read_cache')!.n<=100);
  assert.equal(db.get('SELECT SUM(bytes) AS n FROM source_read_cache')!.n,db.get('SELECT SUM(length(CAST(payload AS BLOB))) AS n FROM source_read_cache')!.n);
  cache.invalidate('s');assert.equal(db.get('SELECT count(*) AS n FROM source_read_cache')!.n,0);
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('source preloading follows supported pages, reuses the persistent cache and avoids hydrating profile cards', async t => {
 const {root,db,catalog}=await fixture();let lists=0;
 const sources=new Sources(db,catalog,async input=>{
  if(input.action==='filters')return{result:{browse:{filters:[],availableModes:['latest','search']}},changes:{}};
  assert.equal(input.params?.mode,'latest');lists++;
  const page=Number(input.params?.page);
  return{result:{list:[{name:'Cached title '+page,link:'/title/'+page}],hasNextPage:page<3},changes:{}};
 });seed(db);
 const cards=t.mock.method(catalog,'card');
 const settled=async()=>{for(let i=0;i<100&&sources.preloadStatus('s').state==='running';i++)await sleep(20);return sources.preloadStatus('s');};
 try{
  assert.equal(sources.preload('s').state,'running');assert.equal(sources.preload('s').state,'running');
  let status=await settled();assert.equal(status.state,'completed');assert.equal(status.pages,3);assert.equal(status.items,3);assert.equal(status.cachedItems,3);assert.equal(lists,3);assert.equal(cards.mock.callCount(),0);
  sources.preload('s');status=await settled();assert.equal(status.state,'completed');assert.equal(lists,3);
  assert.equal(catalog.search('p','Cached title 3').groups.flatMap(group=>group.items).length,1);
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('source preloading stops repeated pages and cancellation prevents further shared reads', async()=>{
 const {root,db,catalog}=await fixture();let lists=0,release:(()=>void)|undefined,blocked=false;
 const sources=new Sources(db,catalog,async input=>{
  if(input.action==='filters')return{result:{browse:{filters:[],availableModes:['popular']}},changes:{}};
  lists++;if(blocked)await new Promise<void>(resolve=>{release=resolve;});
  return{result:{list:[{name:'Repeated title',link:'/title'}],hasNextPage:true},changes:{}};
 });seed(db);
 try{
  sources.preload('s');for(let i=0;i<100&&sources.preloadStatus('s').state==='running';i++)await sleep(20);
  assert.equal(sources.preloadStatus('s').state,'limited');assert.equal(lists,2);
  sources.invalidate('s');blocked=true;sources.preload('s');
  for(let i=0;i<100&&!release;i++)await sleep(10);
  assert.ok(release);assert.equal(sources.cancelPreload('s').state,'cancelled');release();
  await sleep(300);assert.equal(lists,3);assert.equal(sources.preloadStatus('s').state,'cancelled');
  sources.configure('s',{enabled:false});assert.throws(()=>sources.preload('s'),/source-unavailable/);
 }finally{release?.();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('source preloading rejects unsupported modes and limits concurrent sources', async()=>{
 const {root,db,catalog}=await fixture();let release!:(()=>void),blocked=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const sources=new Sources(db,catalog,async input=>{
  if(input.action==='filters'){if(blocked)await gate;return{result:{browse:{filters:[],availableModes:['search']}},changes:{}};}
  throw Error('list must not run');
 });seed(db);
 for(const id of ['second','third'])db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) SELECT ?,repository,entry,installed_entry,code,enabled FROM source_entries WHERE id=?',id,'s');
 try{
  sources.preload('s');for(let i=0;i<100&&sources.preloadStatus('s').state==='running';i++)await sleep(10);
  assert.equal(sources.preloadStatus('s').state,'failed');assert.equal(sources.preloadStatus('s').error,'source-preload-unavailable');
  blocked=true;sources.preload('s');sources.preload('second');assert.throws(()=>sources.preload('third'),/source-preload-busy/);
  sources.cancelPreload('s');sources.cancelPreload('second');release();
 }finally{release();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
