import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AniListClient} from '../src/anilist-client.js';
import {AniListRecommendations} from '../src/anilist-recommendations.js';
import {PluginReviews} from '../src/plugin-reviews.js';
import {Store} from '../src/db.js';
import {Tmdb} from '../src/tmdb.js';
const seed={kind:'tv' as const,id:1,title:'Synthetic',year:2024};
const wait=async(s:AniListRecommendations)=>{for(let i=0;i<100&&s.busy;i++)await new Promise(r=>setTimeout(r,1));assert.equal(s.busy,false);};

test('reviews and recommendations share request budget and provider cooldown',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-anilist-shared-'));
  const db=new Store(dir),tmdb=new Tmdb(db,()=>{},{});
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','P','blue',0,'2026')");
  db.run("INSERT INTO media VALUES('m',NULL,'Synthetic','anime','{}','2026')");
  let now=100_000,calls=0,limited=false;
  const client=new AniListClient(async()=>{calls++;return limited?new Response('',{status:429,headers:{'retry-after':'120'}}):Response.json({data:{Page:{pageInfo:{hasNextPage:false},media:[]}}});},()=>now);
  const reviews=new PluginReviews(db,tmdb,{anilist:client},()=>now);
  const recommendations=new AniListRecommendations(async()=>[],undefined,()=>now,client);
  try{
    for(let i=0;i<10;i++){
      now+=3001;db.run('UPDATE media SET title=? WHERE id=?',`Synthetic ${i}`,'m');
      assert.equal((await reviews.list('p','m','anilist')).status,'select');
      recommendations.lookup({...seed,id:i+1});await wait(recommendations);
    }
    assert.equal(calls,20);assert.equal(client.available,false);
    now+=3001;recommendations.lookup({...seed,id:101});await wait(recommendations);
    db.run("UPDATE media SET title='Over budget' WHERE id='m'");
    assert.equal((await reviews.list('p','m','anilist')).status,'unavailable');assert.equal(calls,20);
    now+=60_001;limited=true;
    db.run("UPDATE media SET title='Provider limit' WHERE id='m'");
    assert.equal((await reviews.list('p','m','anilist')).status,'unavailable');assert.equal(calls,21);
    now+=30_000;recommendations.lookup({...seed,id:102});await wait(recommendations);assert.equal(calls,21);
    now+=90_001;limited=false;recommendations.lookup({...seed,id:102});await wait(recommendations);assert.equal(calls,22);
  }finally{recommendations.close();reviews.close();client.close();tmdb.close();db.close();await rm(dir,{recursive:true,force:true});}
});
test('closing shared client aborts active requests; cancellation releases concurrency',async()=>{
  let calls=0;
  const client=new AniListClient(async(_input,init)=>{calls++;return new Promise((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});
  });});
  const abort=new AbortController();
  const pending=Array.from({length:4},(_,i)=>client.graphql('query {}',{},i===0?abort.signal:undefined));
  const settled=Promise.allSettled(pending);
  await assert.rejects(client.graphql('query {}',{}),/anilist-busy/);assert.equal(calls,4);
  abort.abort();await assert.rejects(pending[0]);assert.equal(client.available,true);
  client.close();const results=await settled;assert.ok(results.every(r=>r.status==='rejected'));
  await assert.rejects(client.graphql('query {}',{}),/anilist-busy/);assert.equal(calls,4);
});
test('rate-limit headers on successful replies also pause all consumers; bounded body is cancelled',async()=>{
  let now=100_000;
  const client=new AniListClient(async()=>Response.json({data:{ok:true}},{headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'190'}}),()=>now);
  assert.deepEqual(await client.graphql('query {}',{}),{ok:true});assert.equal(client.available,false);
  now=190_001;assert.equal(client.available,true);client.close();
  let cancelled=false;
  const large=new AniListClient(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1025));},cancel(){cancelled=true;}})));
  await assert.rejects(large.graphql('query {}',{},undefined,1024),/anilist-response-limit/);assert.equal(cancelled,true);large.close();
});
