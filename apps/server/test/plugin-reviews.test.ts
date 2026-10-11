import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Tmdb} from '../src/tmdb.js';
import {PluginReviews,reviewText,reviewUrl} from '../src/plugin-reviews.js';
import {buildApp} from '../src/app.js';
import {pluginPackage} from '../src/website-plugins.js';
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'moa-reviews-'));const db=new Store(dir);db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','P','blue',0,'2026')");db.run("INSERT INTO media VALUES('m',NULL,'예제 영화','movie','{}','2026')");const tmdb=new Tmdb(db,()=>{},{});return {dir,db,tmdb,close:async()=>{tmdb.close();db.close();await rm(dir,{recursive:true,force:true});}};}
test('keyless and restricted responses need no network and keep honest search fallback',async()=>{
 const f=await fixture();try{let calls=0;const r=new PluginReviews(f.db,f.tmdb,{fetch:async()=>{calls++;throw Error();}});
 const answer=await r.list('p','m','naver');assert.equal(answer.status,'unconfigured');assert.match(answer.query,/예제 영화.*리뷰/);assert.deepEqual(answer.items,[]);
 f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");const denied=await r.list('p','m','naver');assert.equal(denied.status,'restricted');assert.equal(denied.query,'');assert.equal(calls,0);
 assert.equal(reviewUrl('javascript:alert(1)'),null);assert.equal(reviewUrl('https://user:secret@example.com'),null);assert.equal(reviewText('<b>리뷰</b> &amp; 글'),'리뷰 & 글');
 }finally{await f.close();}
});
test('official search stays bounded, strips highlights, coalesces, isolates authorization and discards stale replies',async()=>{
 const f=await fixture();let calls=0,release:(()=>void)|undefined;try{
 const reviews=new PluginReviews(f.db,f.tmdb,{naverId:'fake-id',naverSecret:'fake-secret',fetch:async(input,init)=>{
 calls++;const u=new URL(String(input));assert.equal(u.origin,'https://openapi.naver.com');assert.equal(u.pathname,'/v1/search/blog.json');assert.equal(u.searchParams.get('display'),'8');assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('X-Naver-Client-Secret'),'fake-secret');
 await new Promise<void>(resolve=>release=resolve);return Response.json({items:[{title:'<b>리뷰</b>',link:'https://example.com/review',description:'<img src=x>내용',bloggername:'작성자'}, {title:'위험',link:'javascript:alert(1)'},{title:'중복',link:'https://example.com/review'}]});}});
 const a=reviews.list('p','m','naver'),b=reviews.list('p','m','naver');release!();const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);assert.deepEqual(x,y);assert.equal(x.items.length,1);assert.equal(x.items[0].title,'리뷰');assert.equal(x.items[0].excerpt,'내용');
 f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");assert.equal((await reviews.list('p','m','naver')).status,'restricted');f.db.run("UPDATE profiles SET kids=0 WHERE id='p'");
 f.db.run("UPDATE media SET title='다른 제목' WHERE id='m'");const c=reviews.list('p','m','naver');f.db.run("UPDATE media SET title='다시 변경' WHERE id='m'");release!();assert.equal((await c).status,'unavailable');
 }finally{release?.();await f.close();}
});
test('Kakao and TMDB use fixed identities and safe responses; failures back off',async()=>{
 const f=await fixture();try{let calls=0;const reviews=new PluginReviews(f.db,f.tmdb,{kakaoKey:'fake-key',fetch:async(input,init)=>{calls++;const u=new URL(String(input));assert.equal(u.origin,'https://dapi.kakao.com');assert.equal(new Headers(init?.headers).get('Authorization'),'KakaoAK fake-key');return new Response('no',{status:429});}});
 assert.equal((await reviews.list('p','m','kakao')).status,'unavailable');assert.equal((await reviews.list('p','m','kakao')).status,'unavailable');assert.equal(calls,1);
 const tmdb=new Tmdb(f.db,()=>{},{token:'synthetic',fetch:async input=>{assert.equal(new URL(String(input)).pathname,'/3/tv/1/reviews');return Response.json({results:[{url:'https://www.themoviedb.org/review/abcdef',content:'Review',author:'Writer'},{url:'https://evil.example/review/x',content:'Bad'}]});}});
 try{f.db.run("INSERT INTO tmdb_links VALUES('m','tv',1,NULL,'manual',100,?)",Date.now());const r=await new PluginReviews(f.db,tmdb).list('p','m','tmdb');assert.equal(r.status,'ready');assert.equal(r.items.length,1);}finally{tmdb.close();}
 }finally{await f.close();}
});
test('runtime requires explicit permission/revision and rechecks plugin disable after fetch',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-review-api-'));let release:(()=>void)|undefined;
 const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:false},false,{reviews:{naverId:'fake',naverSecret:'fake',fetch:async()=>{await new Promise<void>(r=>release=r);return Response.json({items:[]});}}});
 try{
 env.db.run("INSERT INTO media VALUES('m',NULL,'예제','movie','{}','2026')");
 const profile=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'P'}})).json();
 const pkg=pluginPackage({apiVersion:2,id:'review-test',name:'Reviews',version:'0.1.0',description:'',placements:['app'],permissions:['reviews.read'],hooks:['title.reviews'],connect:[],script:'// test'});
 assert.throws(()=>pluginPackage({...pkg,permissions:[]}));
 const installed=(await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg})).json();
 const request=(body:object)=>env.app.inject({method:'POST',url:'/api/plugin-runtime/review-test/reviews',headers:{'x-moa-profile':profile.id},payload:body});
 const body={revision:installed.revision,mediaId:'m',provider:'naver'};
 assert.equal((await request({...body,provider:'anything'})).statusCode,400);assert.equal((await request({...body,revision:'bad'})).statusCode,409);
 const pending=request(body).then(r=>r);await new Promise<void>(resolve=>{const limit=Date.now()+2000;const tick=()=>release?resolve():Date.now()>limit?resolve():setTimeout(tick,5);tick();});
 env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='review-test'");release!();assert.equal((await pending).statusCode,404);
 }finally{release?.();await env.app.close();await rm(dir,{recursive:true,force:true});}
});
