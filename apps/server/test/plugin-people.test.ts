import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Tmdb} from '../src/tmdb.js';
import {tmdbPeople,tmdbPersonWorks} from '../src/tmdb-people.js';
import {PluginPeople} from '../src/plugin-people.js';
import {pluginPackage} from '../src/website-plugins.js';
import {buildApp} from '../src/app.js';
import type {LinkedPluginTitle,TitlePeople} from '@moa/shared';
const castRow={id:7,name:'인물',adult:false,profile_path:'/person.jpg',character:'역할 (voice)',roles:[{character:'역할 (voice)'},{character:'다른 역할'}]};
const payload={cast:[castRow],crew:[{id:7,name:'인물',job:'Writer',jobs:[{job:'Writer'},{job:'Director'}]}]};
const title:LinkedPluginTitle={mediaId:'m',provider:'tmdb',kind:'tv',id:'1',name:'예제',scope:'series'};
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'moa-people-'));const db=new Store(dir);db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','Profile','blue',0,'2026')");return {db,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};}

test('normalizes aggregate cast/crew separately, preserves voice tags, caps data and filters works',()=>{
  const input={cast:[castRow,{...castRow,roles:[{character:'third'}]}, {id:8,name:'Bad photo',profile_path:'//evil.test/image'},{id:9,name:'Adult',adult:true}],crew:payload.crew};
  const r=tmdbPeople(input,'tv');assert.equal(r.cast.length,2);assert.deepEqual(r.cast[0].roles,['역할 (voice)','다른 역할','third']);assert.deepEqual(r.crew[0].roles,['Writer','Director']);assert.equal(r.cast[0].photo,'https://image.tmdb.org/t/p/w185/person.jpg');assert.equal(r.cast[1].photo,undefined);
  assert.deepEqual(tmdbPeople(payload,'movie').cast[0].roles,['역할 (voice)']);
  assert.equal(tmdbPeople({cast:Array.from({length:100},(_,i)=>({...castRow,id:i+1})),crew:[]},'tv').truncated,true);
  const works=tmdbPersonWorks({cast:[{id:1,title:'Movie',media_type:'movie',adult:false,poster_path:'/p.jpg'},{id:1,title:'Dup',media_type:'movie',adult:false},{id:1,name:'TV',media_type:'tv',adult:false},{id:2,title:'Adult',media_type:'movie',adult:true},{id:3,title:'Unknown',media_type:'movie'},{id:4,title:'X',media_type:'person',adult:false}],crew:[]});
  assert.deepEqual(works.items.map(i=>[i.provider,i.kind,i.id]),[['tmdb','movie','1'],['tmdb','tv','1']]);
  assert.throws(()=>tmdbPeople(null,'tv'));assert.throws(()=>tmdbPersonWorks({cast:[]}));
});

test('bounded cache coalesces, backs off, changes provider/credentials, requires credited membership and valid profile',async()=>{
  const f=await fixture();let calls=0,works=0,now=100_000,fail=false;
  let linked:LinkedPluginTitle|null=title;
  const provider={providerId:'tmdb',configurationRevision:0,enabled:true,linkedTitle:()=>linked,peopleCredits:async()=>{calls++;if(fail)throw Error('secret');return tmdbPeople(payload,'tv');},personWorks:async()=>{works++;return {items:[],truncated:false};}};
  const p=new PluginPeople(f.db,provider,()=>now);
  try{
    const [a,b]=await Promise.all([p.credits('p','m'),p.credits('p','m')]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.title?.scope,'series');
    const result=await p.person('p','m',{provider:'tmdb',id:'7'});assert.equal(result.status,'ready');assert.deepEqual(result.person?.roles,['역할 (voice)','다른 역할','Writer','Director']);assert.equal(works,1);
    await assert.rejects(p.person('p','m',{provider:'other',id:'7'}),{error:'person-not-in-title'});
    await assert.rejects(p.person('p','m',{provider:'tmdb',id:'8'}));assert.equal(works,1);
    linked=null;assert.equal((await p.credits('p','m')).status,'unlinked');linked=title;
    provider.configurationRevision++;fail=true;assert.equal((await p.credits('p','m')).status,'unavailable');assert.equal((await p.credits('p','m')).status,'unavailable');assert.equal(calls,2);
    now+=60_001;fail=false;assert.equal((await p.credits('p','m')).status,'ready');assert.equal(calls,3);
    provider.providerId='other';linked={...title,provider:'other'};await p.credits('p','m');assert.equal(calls,4);
    provider.enabled=false;assert.equal((await p.credits('p','m')).status,'unconfigured');
    f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");assert.equal((await p.credits('p','m')).status,'restricted');assert.equal((await p.credits('missing','m')).title,null);
  }finally{await f.close();}
});

test('in-flight remapping, deletion, credential and profile changes discard metadata',async()=>{
  const f=await fixture();let finish!:(r:TitlePeople)=>void,linked:LinkedPluginTitle|null=title;
  const provider={providerId:'tmdb',configurationRevision:0,enabled:true,linkedTitle:()=>linked,peopleCredits:()=>new Promise<TitlePeople>(resolve=>{finish=resolve;}),personWorks:async()=>({items:[],truncated:false})};
  try{
    for(const change of [()=>{linked={...title,id:'2'};},()=>{linked=null;},()=>{provider.configurationRevision++;},()=>{f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");}]){
      linked=title;f.db.run("UPDATE profiles SET kids=0 WHERE id='p'");
      const p=new PluginPeople(f.db,provider);const pending=p.credits('p','m');await Promise.resolve();change();finish(tmdbPeople(payload,'tv'));
      const result=await pending;assert.notEqual(result.status,'ready');assert.equal(result.title,null);assert.deepEqual(result.cast,[]);
    }
  }finally{await f.close();}
});

test('person results cannot outlive the original title mapping or profile policy',async()=>{
  const f=await fixture();let finish!:()=>void, linked:LinkedPluginTitle|null=title;
  const provider={providerId:'tmdb',configurationRevision:0,enabled:true,linkedTitle:()=>linked,
    peopleCredits:async()=>tmdbPeople(payload,'tv'),personWorks:()=>new Promise<{items:[];truncated:boolean}>(resolve=>{finish=()=>resolve({items:[],truncated:false});})};
  try {
    for (const restrict of [false,true]) {
      linked=title;f.db.run("UPDATE profiles SET kids=0 WHERE id='p'");
      const p=new PluginPeople(f.db,provider);await p.credits('p','m');
      let started=false;const original=provider.personWorks;
      provider.personWorks=()=>{started=true;return original();};
      const pending=p.person('p','m',{provider:'tmdb',id:'7'});
      for(let i=0;!started&&i<20;i++)await Promise.resolve();assert.ok(started);
      if(restrict)f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");else linked=null;
      finish();const r=await pending;assert.equal(r.status,restrict?'restricted':'unavailable');assert.equal(r.person,null);assert.equal(r.title,null);assert.deepEqual(r.items,[]);
      provider.personWorks=original;
    }
  }finally{await f.close();}
});

test('cache capacity and concurrency remain bounded across many titles',async()=>{
  const f=await fixture();let calls=0,block=false;const finishes:Array<()=>void>=[];
  const provider={providerId:'tmdb',configurationRevision:0,enabled:true,linkedTitle:(mediaId:string)=>({...title,mediaId,id:mediaId}),peopleCredits:async()=>{calls++;if(block)await new Promise<void>(r=>finishes.push(r));return tmdbPeople(payload,'tv');},personWorks:async()=>({items:[],truncated:false})};
  const p=new PluginPeople(f.db,provider);
  try {
    for(let i=0;i<129;i++)await p.credits('p',String(i));
    await p.credits('p','0');assert.equal(calls,130,'oldest snapshot evicted');
    block=true;const requests=Array.from({length:4},(_,i)=>p.credits('p',`pending${i}`));await Promise.resolve();
    assert.equal((await p.credits('p','fifth')).status,'unavailable');assert.equal(finishes.length,4);finishes.forEach(f=>f());await Promise.all(requests);
  }finally{finishes.forEach(f=>f());await f.close();}
});

test('runtime covers SDK wire schema, scoped profiles, permission, package revocation, and provider endpoints',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-people-api-'));let release:(()=>void)|undefined,block=false;
  const paths:string[]=[];
  const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:true},false,{tmdb:{token:'synthetic-token',fetch:async input=>{
    const u=new URL(String(input));paths.push(u.pathname);assert.equal(u.origin,'https://api.themoviedb.org');assert.equal(u.search,'?language=ko-KR');
    if(block)await new Promise<void>(resolve=>{release=resolve;});
    if(u.pathname==='/3/person/7/combined_credits')return Response.json({cast:[{id:10,title:'Other work',media_type:'movie',adult:false}],crew:[]});
    assert.match(u.pathname,/^\/3\/(tv\/1\/aggregate_credits|movie\/2\/credits)$/);return Response.json(payload);
  }}});
  const admin={'x-moa-account':'owner','x-moa-role':'admin'};
  const plugin={apiVersion:2,id:'people-test',name:'People',version:'1.0.0',description:'test',placements:['detail'],permissions:['metadata.read'],connect:[],script:'void 0;'};
  const install=async(p:object)=>{const r=await env.app.inject({method:'POST',url:'/api/admin/plugins',headers:admin,payload:p});assert.equal(r.statusCode,200,r.body);return r.json().revision;};
  try{
    const profile=(await env.app.inject({method:'POST',url:'/api/profiles',headers:admin,payload:{name:'Owner'}})).json();
    const h={...admin,'x-moa-profile':profile.id};let revision=await install(plugin);
    env.db.run("INSERT INTO media VALUES('m',NULL,'Synthetic','series','{}','2026')");env.db.run("INSERT INTO tmdb_links VALUES('m','tv',1,2,'manual',100,0)");
    const call=(action='credits',extra:object={},headers=h)=>env.app.inject({method:'POST',url:`/api/plugin-runtime/people-test/metadata/${action}`,headers,payload:{revision,mediaId:'m',...extra}});
    let r=await call();assert.equal(r.statusCode,200,r.body);assert.equal(r.json().title.scope,'series');assert.equal(r.json().cast[0].id,'7');assert.equal(r.headers['cache-control'],'private, no-store');assert.ok(!r.body.includes('synthetic-token'));
    r=await call('person',{person:{provider:'tmdb',id:'7'}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items[0].id,'10');
    assert.equal((await call('person',{person:{provider:'tmdb',id:'999'}})).statusCode,403);
    assert.equal((await call('person',{person:{provider:'tmdb',id:7}})).statusCode,400);
    assert.equal((await call('credits',{url:'https://evil.invalid'})).statusCode,400);
    assert.equal((await call('credits',{revision:'0'.repeat(32)})).statusCode,409);
    assert.equal((await call('credits',{},admin as any)).statusCode,401);
    assert.equal((await call('credits',{},{...h,'x-moa-account':'other','x-moa-role':'member'})).statusCode,401);
    const mp=(await env.app.inject({method:'POST',url:'/api/profiles',headers:{'x-moa-account':'member','x-moa-role':'admin'},payload:{name:'Member'}})).json();
    assert.equal((await call('credits',{},{'x-moa-account':'member','x-moa-role':'member','x-moa-profile':mp.id})).statusCode,200);
    revision=await install({...plugin,permissions:['discovery.read']});assert.equal((await call()).statusCode,403);revision=await install(plugin);
    env.db.run("UPDATE tmdb_links SET kind='movie',tmdb_id=2 WHERE media_id='m'");block=true;
    const pending=Promise.resolve(call());for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
    await env.app.inject({method:'PATCH',url:'/api/admin/plugins/people-test',headers:admin,payload:{enabled:false}});release!();assert.equal((await pending).statusCode,404);
    await env.app.inject({method:'PATCH',url:'/api/admin/plugins/people-test',headers:admin,payload:{enabled:true}});block=false;
    env.db.run('UPDATE profiles SET kids=1 WHERE id=?',profile.id);r=await call();assert.equal(r.json().status,'restricted');assert.deepEqual(r.json().cast,[]);
    assert.deepEqual(paths,['/3/tv/1/aggregate_credits','/3/person/7/combined_credits','/3/movie/2/credits']);
  }finally{release?.();await env.app.close();await rm(dir,{recursive:true,force:true});}
});

test('native detail people retain display fields and gain an optional provider identity',async()=>{
  const f=await fixture();f.db.run("INSERT INTO media VALUES('m',NULL,'Movie','movie','{}','2026')");
  const tmdb=new Tmdb(f.db,()=>{},{token:'fixture',fetch:async()=>Response.json({id:1,title:'Movie',adult:false,genres:[],credits:{cast:[castRow,{name:'Unidentified',character:'Guest'}],crew:[]}})});
  try {
    await tmdb.change('m',{action:'link',kind:'movie',tmdbId:1});
    const detail=JSON.parse(f.db.get("SELECT detail FROM tmdb_titles WHERE kind='movie' AND tmdb_id=1")!.detail);
    assert.deepEqual(detail.people[0].identity,{provider:'tmdb',id:'7'});
    assert.equal(detail.people[0].name,'인물');assert.equal(detail.people[0].role,'역할');
    assert.equal(detail.people[1].identity,undefined);
  }finally{tmdb.close();await f.close();}
});


test('native people hook requires its own declared metadata permission',()=>{
  const p={apiVersion:2,id:'people-test',name:'People',version:'1.0.0',description:'test',placements:['app'],permissions:['metadata.read'],hooks:['title.people'],connect:[],script:'void 0;'};
  assert.doesNotThrow(()=>pluginPackage(p));
  assert.throws(()=>pluginPackage({...p,permissions:['catalog.modify']}));
  assert.throws(()=>pluginPackage({...p,apiVersion:1}));
  assert.doesNotThrow(()=>pluginPackage({...p,permissions:['metadata.read','catalog.modify'],hooks:['title.people','catalog.transform']}));
});
