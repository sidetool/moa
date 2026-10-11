import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Tmdb} from '../src/tmdb.js';
import {PluginReviews} from '../src/plugin-reviews.js';
import {buildApp} from '../src/app.js';
import {pluginPackage} from '../src/website-plugins.js';
const candidate={id:1,isAdult:false,title:{native:'例',english:'Example',romaji:'Rei'},startDate:{year:2023},format:'TV'};
const reviews={Media:{id:1,isAdult:false,reviews:{nodes:[{mediaId:1,summary:'<b>Review</b>',body:'<p>Text</p>',siteUrl:'https://anilist.co/review/12',user:{name:'Writer'}},{mediaId:2,summary:'Wrong title',siteUrl:'https://anilist.co/review/13'},{mediaId:1,siteUrl:'javascript:alert(1)'}]}}};
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'moa-reviews-'));const db=new Store(dir);db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','P','blue',0,'2026')");db.run("INSERT INTO media VALUES('m',NULL,'예제 애니','anime','{}','2026')");const tmdb=new Tmdb(db,()=>{},{});return {db,tmdb,close:async()=>{tmdb.close();db.close();await rm(dir,{recursive:true,force:true});}};}
test('AniList needs no credentials, requires candidate selection, caps/sanitizes replies and caches only public data',async()=>{
 const f=await fixture();let calls=0;const r=new PluginReviews(f.db,f.tmdb,{fetch:async(input,init)=>{
 assert.equal(String(input),'https://graphql.anilist.co');assert.equal(new Headers(init?.headers).has('Authorization'),false);assert.equal(init?.redirect,'error');calls++;
 const b=JSON.parse(String(init?.body));return Response.json({data:b.variables.search?{Page:{media:[candidate,{...candidate,id:2,isAdult:true}]}}:reviews});}});
 try{
 const first=await r.list('p','m','anilist');assert.equal(first.status,'select');assert.equal(first.candidates.length,1);assert.deepEqual(first.items,[]);
 assert.equal((await r.list('p','m','anilist','99')).status,'select');assert.equal(calls,1,'unrelated ID never fetched');
 const [a,b]=await Promise.all([r.list('p','m','anilist','1'),r.list('p','m','anilist','1')]);assert.deepEqual(a,b);assert.equal(calls,2);assert.equal(a.items.length,1);assert.equal(a.items[0].title,'Review');assert.equal(a.items[0].excerpt,'Text');
 f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");const denied=await r.list('p','m','anilist','1');assert.equal(denied.status,'restricted');assert.deepEqual(denied.candidates,[]);assert.equal(denied.query,'');assert.equal(calls,2);
 }finally{r.close();await f.close();}
});
test('stale title/profile and remapped TMDB identity cannot return pending AniList results',async()=>{
 const f=await fixture();let release:(()=>void)|undefined;const r=new PluginReviews(f.db,f.tmdb,{fetch:async()=>{await new Promise<void>(x=>release=x);return Response.json({data:{Page:{media:[candidate]}}});}});
 try{const pending=r.list('p','m','anilist');await Promise.resolve();f.db.run("UPDATE media SET title='Changed' WHERE id='m'");release!();assert.equal((await pending).status,'unavailable');
 const next=r.list('p','m','anilist');await Promise.resolve();f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");release!();assert.equal((await next).status,'restricted');
 }finally{release?.();r.close();await f.close();}
});
test('provider errors back off, oversized/GraphQL error responses fail closed',async()=>{
 const f=await fixture();try{for(const response of [()=>new Response('',{status:429}),()=>Response.json({errors:[{message:'error'}]}),()=>new Response('x'.repeat(512*1024+1))]){
 let calls=0;const r=new PluginReviews(f.db,f.tmdb,{fetch:async()=>{calls++;return response();}});
 assert.equal((await r.list('p','m','anilist')).status,'unavailable');assert.equal((await r.list('p','m','anilist')).status,'unavailable');assert.equal(calls,1);r.close();
 }}finally{await f.close();}
});
test('AniList rate limit applies across different titles and respects retry-after',async()=>{
 const f=await fixture();let calls=0,now=100_000;
 const r=new PluginReviews(f.db,f.tmdb,{fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}},()=>now);
 try{
  assert.equal((await r.list('p','m','anilist')).status,'unavailable');
  f.db.run("UPDATE media SET title='Second' WHERE id='m'");assert.equal((await r.list('p','m','anilist')).status,'unavailable');assert.equal(calls,1);
  now+=121_000;assert.equal((await r.list('p','m','anilist')).status,'unavailable');assert.equal(calls,2);
 }finally{r.close();await f.close();}
});
test('TMDB reuses configured credentials, queries Korean first and falls back to English only when empty',async()=>{
 const f=await fixture();const languages:string[]=[];const tmdb=new Tmdb(f.db,()=>{},{token:'synthetic',fetch:async(input,init)=>{const u=new URL(String(input));assert.equal(u.pathname,'/3/tv/1/reviews');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic');languages.push(u.searchParams.get('language')!);return Response.json({results:languages.length===1?[]:[{url:'https://www.themoviedb.org/review/abcdef',content:'Review',author:'Writer'},{url:'https://evil.example/review/x',content:'Bad'}]});}});
 try{assert.equal((await new PluginReviews(f.db,f.tmdb).list('p','m','tmdb')).status,'unconfigured');f.db.run("INSERT INTO tmdb_links VALUES('m','tv',1,NULL,'manual',100,?)",Date.now());const r=await new PluginReviews(f.db,tmdb).list('p','m','tmdb');assert.equal(r.status,'ready');assert.equal(r.items.length,1);assert.deepEqual(languages,['ko-KR','en-US']);}finally{tmdb.close();await f.close();}
});
test('runtime rejects undeclared permission/revision/selection and checks disable after lookup',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-review-api-'));let release:(()=>void)|undefined;
 const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:false},false,{reviews:{fetch:async()=>{await new Promise<void>(r=>release=r);return Response.json({data:{Page:{media:[candidate]}}});}}});
 try{
 env.db.run("INSERT INTO media VALUES('m',NULL,'예제','anime','{}','2026')");const profile=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'P'}})).json();
 const pkg=pluginPackage({apiVersion:2,id:'review-test',name:'Reviews',version:'0.1.0',description:'',placements:['app'],permissions:['reviews.read'],hooks:['title.reviews'],connect:[],script:'// test'});assert.throws(()=>pluginPackage({...pkg,permissions:[]}));
 const installed=(await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg})).json();
 const request=(body:object)=>env.app.inject({method:'POST',url:'/api/plugin-runtime/review-test/reviews',headers:{'x-moa-profile':profile.id},payload:body});const body={revision:installed.revision,mediaId:'m',provider:'anilist'};
 for(const invalid of [{provider:'naver'},{selection:1},{selection:'https://anilist.co/1'},{provider:'tmdb',selection:'1'}])assert.equal((await request({...body,...invalid})).statusCode,400);
 assert.equal((await request({...body,revision:'bad'})).statusCode,409);
 const pending=request(body).then(r=>r);await new Promise<void>(resolve=>{const limit=Date.now()+2000;const tick=()=>release||Date.now()>limit?resolve():setTimeout(tick,5);tick();});assert.ok(release);
 env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='review-test'");release();assert.equal((await pending).statusCode,404);
 }finally{release?.();await env.app.close();await rm(dir,{recursive:true,force:true});}
});
