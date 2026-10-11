import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Tmdb } from '../src/tmdb.js';
import { PluginDiscovery } from '../src/plugin-discovery.js';
import { buildApp } from '../src/app.js';

const items = [{provider:'tmdb',kind:'movie' as const,id:'1',title:'영화'}];
async function fixture() {
  const dir=await mkdtemp(path.join(tmpdir(),'moa-discovery-')), db=new Store(dir);
  for (const [id,kids] of [['adult',0],['child',1]] as const) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',kids,'2026');
  return {db,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}

test('TMDB query is fixed, first-page only and strips secrets, adult/malformed/duplicate rows',async()=>{
  const f=await fixture();let requests=0;
  const tmdb=new Tmdb(f.db,()=>{}, {token:'synthetic-secret',fetch:async(input,init)=>{
    const u=new URL(String(input));assert.equal(u.origin,'https://api.themoviedb.org');
    assert.equal(u.pathname,'/3/trending/movie/week');assert.equal(u.search,'?language=ko-KR');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-secret');requests++;
    return Response.json({results:[
      {id:1,title:'안전한 영화',original_title:'Example',adult:false,release_date:'2026-01-02',poster_path:'/safe.jpg',overview:'설명',privateToken:'synthetic-secret'},
      {id:1,title:'duplicate',adult:false},{id:2,title:'adult',adult:true},{id:3,title:'unknown age flag'},
      {id:4,title:'<script>text only</script>',adult:false,poster_path:'//evil.test/key'},
      {id:-2,title:'invalid',adult:false},{id:5,name:'TV mismatch',media_type:'tv',adult:false},null
    ]});
  }});
  try {
    const result=await tmdb.trending({kind:'movie',window:'week'});
    assert.equal(result.length,2);assert.equal(result[0].poster,'https://image.tmdb.org/t/p/w342/safe.jpg');
    assert.equal(result[0].year,2026);assert.equal(result[0].provider,'tmdb');assert.equal(result[0].id,'1');assert.equal(result[1].poster,undefined);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    await assert.rejects(tmdb.trending({kind:'../account',window:'week'} as any));assert.equal(requests,1);
  } finally {tmdb.close();await f.close();}
});

test('cache coalesces requests, reuses only bounded stale snapshots, backs off and clears on key changes',async()=>{
  const f=await fixture();let now=1_800_000_000_000,calls=0,fail=false;
  const provider={providerId:'tmdb',enabled:true,configurationRevision:0,trending:async()=>{calls++;await Promise.resolve();if(fail)throw Error('secret upstream');return items;}};
  const d=new PluginDiscovery(f.db,provider,()=>now),q={kind:'movie' as const,window:'day' as const};
  try{
    const [a,b]=await Promise.all([d.trending('adult',q),d.trending('adult',q)]);
    assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.stale,false);
    await d.trending('adult',q);assert.equal(calls,1);
    now+=31*60_000;fail=true;
    const stale=await d.trending('adult',q);assert.equal(stale.stale,true);assert.equal(stale.status,'ready');assert.equal(calls,2);
    await d.trending('adult',q);assert.equal(calls,2);
    now+=24*60*60_000;assert.equal((await d.trending('adult',q)).status,'unavailable');
    provider.configurationRevision++;provider.enabled=false;
    assert.equal((await d.trending('adult',q)).status,'unconfigured');
    provider.enabled=true;provider.configurationRevision++;fail=false;
    assert.equal((await d.trending('adult',q)).stale,false);assert.equal(calls,4);
    assert.deepEqual(await d.trending('child',q),{provider:'tmdb',status:'restricted',items:[],updatedAt:null,stale:false});
    assert.equal((await d.trending('missing',q)).status,'restricted');assert.equal(calls,4);
  }finally{await f.close();}
});

test('profile policy and credential changes during pending provider calls win over fetched results',async()=>{
  const f=await fixture();let finish!:()=>void;
  const provider={providerId:'tmdb',enabled:true,configurationRevision:0,trending:()=>new Promise<typeof items>(resolve=>{finish=()=>resolve(items);})};
  const d=new PluginDiscovery(f.db,provider),q={kind:'tv' as const,window:'week' as const};
  try{
    let p=d.trending('adult',q);f.db.run("UPDATE profiles SET kids=1 WHERE id='adult'");finish();
    assert.equal((await p).status,'restricted');
    f.db.run("UPDATE profiles SET kids=0 WHERE id='adult'");provider.configurationRevision++;
    p=d.trending('adult',q);provider.configurationRevision++;finish();assert.equal((await p).status,'unavailable');
  }finally{await f.close();}
});

test('runtime enforces account/profile, permission, revision and revocation; keys never enter responses',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-discovery-api-'));
  let release:(()=>void)|undefined,calls=0;
  const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:true},false,{tmdb:{token:'synthetic-only-token',fetch:async()=>{
    calls++;if(calls===2)await new Promise<void>(resolve=>{release=resolve;});
    return Response.json({results:[{id:1,adult:false,title:'Example movie'}]});
  }}});
  const admin={'x-moa-account':'owner','x-moa-role':'admin'};
  const plugin={apiVersion:2,id:'trending-test',name:'Test',version:'1.0.0',description:'test',placements:['home'],permissions:['discovery.read'],connect:[],script:'void 0;'};
  const install=async(p:object)=>{const r=await env.app.inject({method:'POST',url:'/api/admin/plugins',headers:admin,payload:p});assert.equal(r.statusCode,200,r.body);return r.json().revision;};
  try{
    const profile=(await env.app.inject({method:'POST',url:'/api/profiles',headers:admin,payload:{name:'Owner'}})).json();
    const h={...admin,'x-moa-profile':profile.id};let revision=await install(plugin);
    const url='/api/plugin-runtime/trending-test/discovery/trending';
    const call=(query:object={kind:'movie',window:'week'},headers=h,rev=revision)=>env.app.inject({method:'POST',url,headers,payload:{revision:rev,query}});
    let r=await call();assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items.length,1);assert.equal(r.json().provider,'tmdb');assert.equal(r.json().items[0].id,'1');assert.equal(r.json().items[0].provider,'tmdb');assert.equal(r.headers['cache-control'],'private, no-store');
    assert.ok(!r.body.includes('synthetic-only-token'));
    const memberProfile=(await env.app.inject({method:'POST',url:'/api/profiles',headers:{'x-moa-account':'member','x-moa-role':'admin'},payload:{name:'Member'}})).json();
    const memberHeaders={'x-moa-account':'member','x-moa-role':'member','x-moa-profile':memberProfile.id};
    assert.equal((await call({kind:'movie',window:'week'},memberHeaders)).statusCode,200);

    assert.equal((await call({kind:'movie',window:'week'},{...h,'x-moa-account':'other','x-moa-role':'member'})).statusCode,401);
    assert.equal((await call({kind:'movie',window:'week'}, {...admin} as any)).statusCode,401);
    assert.equal((await call({kind:'movie',window:'week',url:'https://example.test'})).statusCode,400);
    assert.equal((await call({kind:'movie',window:'month'})).statusCode,400);
    assert.equal((await call({},h)).statusCode,400);
    assert.equal((await call({kind:'movie',window:'week'},h,'0'.repeat(32))).statusCode,409);
    revision=await install({...plugin,permissions:[]});assert.equal((await call()).statusCode,403);
    revision=await install(plugin);
    const pending=call({kind:'movie',window:'day'});
    // Start inject's thenable, then pause until the provider has begun.
    const completion=Promise.resolve(pending);
    for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
    await env.app.inject({method:'PATCH',url:'/api/admin/plugins/trending-test',headers:admin,payload:{enabled:false}});
    release!();assert.equal((await completion).statusCode,404);
    assert.equal((await call()).statusCode,404);
    await env.app.inject({method:'PATCH',url:'/api/admin/plugins/trending-test',headers:admin,payload:{enabled:true}});
    env.db.run('UPDATE profiles SET kids=1 WHERE id=?',profile.id);
    r=await call();assert.equal(r.json().status,'restricted');assert.deepEqual(r.json().items,[]);assert.equal(calls,2);
  }finally{release?.();await env.app.close();await rm(dir,{recursive:true,force:true});}
});


test('alternate provider supports opaque IDs and cannot reuse another provider cache or in-flight result',async()=>{
  const f=await fixture();let calls=0;
  const provider={providerId:'tmdb',enabled:true,configurationRevision:0,trending:async()=>{calls++;return [{provider:provider.providerId,kind:'tv' as const,id:'0007/a:b',title:'Example'}];}};
  const d=new PluginDiscovery(f.db,provider),q={kind:'tv' as const,window:'week' as const};
  try {
    const first=await d.trending('adult',q);
    provider.providerId='example-catalog';
    const second=await d.trending('adult',q);
    assert.equal(calls,2);assert.equal(first.provider,'tmdb');assert.equal(second.provider,'example-catalog');
    assert.equal(second.items[0].id,'0007/a:b');assert.equal(second.items[0].provider,'example-catalog');
    let finish!:()=>void;
    provider.trending=()=>new Promise(resolve=>{finish=()=>resolve([{provider:'example-catalog',kind:'tv',id:'1',title:'Old'}]);});
    const pending=d.trending('adult',{...q,window:'day'});
    provider.providerId='replacement';finish();
    assert.equal((await pending).status,'unavailable');
  }finally{await f.close();}
});
