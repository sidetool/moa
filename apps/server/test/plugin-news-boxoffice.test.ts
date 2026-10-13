import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {Store} from '../src/db.js';import {PluginNews,type NewsProvider} from '../src/plugin-news.js';import {PluginBoxOffice} from '../src/plugin-boxoffice.js';import {Tmdb} from '../src/tmdb.js';import {buildApp} from '../src/app.js';import {pluginPackage} from '../src/website-plugins.js';
const now=()=>Date.parse('2026-10-13T16:00:00Z'); // Oct 14 in Korea
const event={date:'2026-10-15',kind:'episode' as const,detail:'season 1 episode 2'};
async function fixture(t:TestContext){const dir=await mkdtemp(path.join(tmpdir(),'moa-news-'));const db=new Store(dir);for(const id of ['p','q','kid'])db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',Number(id==='kid'),'2026');
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const add=(id:string,profile='p',tmdbId:number|null=1)=>{db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,id,'series','{}','2026');db.run('INSERT INTO watchlist VALUES(?,?,?)',profile,id,'2026-10-13T00:00:00Z');if(tmdbId)db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'tv',?,'manual',1)",id,tmdbId);};return {db,add};}
const boxRow={rank:'1',movieCd:'12345678',movieNm:'Example',audiCnt:'234',audiAcc:'1234',rankInten:'2',rankOldAndNew:'OLD'};
const box=(period='day',showRange='20261013~20261013')=>({boxOfficeResult:{showRange,[period==='day'?'dailyBoxOfficeList':'weeklyBoxOfficeList']:[boxRow]}});
test('news isolates profiles, de-duplicates identities, limits dates and reuses only public event cache',async t=>{
 const {db,add}=await fixture(t);add('a');add('b');add('unlinked','p',null);add('other','q',2);let calls=0;
 const news=new PluginNews(db,{enabled:true,configurationRevision:0,upcoming:async()=>{calls++;return [event,{...event,date:'2026-09-10'},{...event,date:'2027-01-01'}];}},now);
 const a=await news.list('p');assert.equal(a.items.length,1);assert.equal(a.unlinked,1);assert.equal(a.checked,1);assert.equal(a.items[0].mediaId,'b');assert.equal(a.items[0].date,event.date);assert.equal(calls,1);
 await news.list('p');assert.equal(calls,1);const q=await news.list('q');assert.equal(q.items[0].mediaId,'other');assert.equal(calls,2);assert.equal((await news.list('kid')).status,'restricted');assert.equal((await news.list('missing')).status,'restricted');assert.equal(calls,2);
 db.run("DELETE FROM watchlist WHERE profile_id='p'");assert.deepEqual((await news.list('p')).items,[]);
});
test('news rechecks removed/relinked memberships, kid restrictions and credential changes after awaiting',async t=>{
 const {db,add}=await fixture(t);add('a');let release:()=>void=()=>{};
 const provider:NewsProvider={enabled:true,configurationRevision:0,upcoming:async()=>{await new Promise<void>(r=>release=r);return [event];}};
 const start=async()=>{const n=new PluginNews(db,provider,now);const p=n.list('p');await new Promise(r=>setTimeout(r,0));return {p};};
 let x=await start();db.run("UPDATE tmdb_links SET tmdb_id=9 WHERE media_id='a'");release();assert.deepEqual((await x.p).items,[]);
 x=await start();db.run("UPDATE profiles SET kids=1 WHERE id='p'");release();assert.equal((await x.p).status,'restricted');db.run("UPDATE profiles SET kids=0 WHERE id='p'");
 x=await start();provider.configurationRevision++;release();assert.equal((await x.p).status,'unavailable');
 provider.enabled=false;assert.equal((await new PluginNews(db,provider,now).list('p')).status,'unconfigured');
});
test('news bounds candidates and coalesces concurrent requests by identity',async t=>{
 const {db,add}=await fixture(t);for(let i=1;i<=14;i++)add(`title-${i}`, 'p',i);let calls=0;
 const n=new PluginNews(db,{enabled:true,configurationRevision:0,upcoming:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return [event];}},now);
 const results=await Promise.all([n.list('p'),n.list('p')]);assert.equal(calls,12);assert.equal(results[0].items.length,12);assert.equal(results[0].truncated,true);
});
test('TMDB news requires KR theatrical dates and exact series ID; no title guessing',async t=>{
 const {db}=await fixture(t);const paths:string[]=[];
 const tmdb=new Tmdb(db,()=>{},{key:'fixture',fetch:async input=>{const u=new URL(String(input));paths.push(u.pathname);if(u.pathname.includes('release_dates'))return Response.json({results:[{iso_3166_1:'KR',release_dates:[{type:3,release_date:'2026-10-15T00:00:00Z'},{type:2,release_date:'2026-10-15T00:00:00Z'},{type:4,release_date:'2026-10-16T00:00:00Z'},{type:3,release_date:'invalid'}]},{iso_3166_1:'US',release_dates:[{type:3,release_date:'2026-10-17T00:00:00Z'}]}]});return Response.json({id:1,next_episode_to_air:{air_date:'2026-10-18',season_number:2,episode_number:1}});}});t.after(()=>tmdb.close());
 assert.deepEqual((await tmdb.upcoming('movie',2)).map(x=>x.date),['2026-10-15']);assert.match((await tmdb.upcoming('tv',1))[0].detail,/시즌 2 · 1화/);await assert.rejects(tmdb.upcoming('tv',2));assert.ok(paths.every(p=>!p.includes('search')));
});
test('KOBIS uses yesterday KST and the last complete Mon-Sun week, caches and never returns credentials',async t=>{
 const {db}=await fixture(t);const calls:URL[]=[];const s=new PluginBoxOffice(db,{key:'fixture-secret',now,fetch:async input=>{const u=new URL(String(input));calls.push(u);assert.equal(u.protocol,'https:');assert.equal(u.searchParams.get('key'),'fixture-secret');assert.equal(u.searchParams.get('itemPerPage'),'10');return Response.json(u.pathname.includes('Weekly')?box('week','20261005~20261011'):box());}});t.after(()=>s.close());
 const daily=await s.list('p','day');assert.equal(daily.through,'2026-10-13');assert.equal(daily.items[0].audience,234);assert.equal(JSON.stringify(daily).includes('fixture-secret'),false);await s.list('q','day');assert.equal(calls.length,1);
 const weekly=await s.list('p','week');assert.equal(weekly.from,'2026-10-05');assert.equal(weekly.through,'2026-10-11');assert.equal(calls[1].searchParams.get('weekGb'),'0');assert.equal(calls[1].searchParams.get('targetDt'),'20261011');assert.equal((await s.list('kid','day')).status,'restricted');assert.equal(calls.length,2);
 for(const stamp of ['2026-10-11T03:00:00Z','2026-10-12T03:00:00Z']){const expected=stamp.includes('-11T')?'20261004':'20261011';const weekend=new PluginBoxOffice(db,{key:'fixture',now:()=>Date.parse(stamp),fetch:async input=>{assert.equal(new URL(String(input)).searchParams.get('targetDt'),expected);return Response.json({faultInfo:{}});}});await weekend.list('p','week');weekend.close();}
});
test('KOBIS missing key makes no request, errors redact details and back off; mismatched ranges and oversized bodies rejected',async t=>{
 const {db}=await fixture(t);let calls=0;const noKey=new PluginBoxOffice(db,{key:'',now,fetch:async()=>{calls++;throw Error();}});assert.equal((await noKey.list('p','day')).status,'unconfigured');assert.equal(calls,0);noKey.close();
 let clock=now();const bad=new PluginBoxOffice(db,{key:'secret',now:()=>clock,fetch:async()=>{calls++;throw Error('https://example?key=secret');}});t.after(()=>bad.close());assert.equal((await bad.list('p','day')).status,'unavailable');assert.equal(JSON.stringify(await bad.list('p','day')).includes('secret'),false);assert.equal(calls,1);clock+=61000;await bad.list('p','day');assert.equal(calls,2);
 for(const value of [box('day','20000101~20000101'),{faultInfo:{message:'secret'}}, {...box(),boxOfficeResult:{showRange:'20261013~20261013',dailyBoxOfficeList:[{...boxRow,audiCnt:'-1'}]}}]){const x=new PluginBoxOffice(db,{key:'secret',now,fetch:async()=>Response.json(value)});assert.equal((await x.list('p','day')).status,'unavailable');x.close();}
 const large=new PluginBoxOffice(db,{key:'secret',now,fetch:async()=>new Response('x'.repeat(512*1024+1))});assert.equal((await large.list('p','day')).status,'unavailable');large.close();
});
test('runtime routes enforce separate permissions and recheck disable during requests',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-news-runtime-'));let release:()=>void=()=>{};let started=false;
 const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:false},false,{boxoffice:{key:'fixture',now,fetch:async()=>{started=true;await new Promise<void>(r=>release=r);return Response.json(box());}}});
 try{const profile=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'P'}})).json();
 const install=async(id:string,permissions:any)=>{const pkg=pluginPackage({apiVersion:2,id,name:id,version:'0.1.0',description:'',placements:['home'],permissions,connect:[],script:'// fixture'});return(await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg})).json();};
 const call=(id:string,revision:string,endpoint:string,query:any)=>env.app.inject({method:'POST',url:`/api/plugin-runtime/${id}/${endpoint}`,headers:{'x-moa-profile':profile.id},payload:{revision,query}});
 const noPerm=await install('no-perm',['watchlist.read']);assert.equal((await call('no-perm',noPerm.revision,'watchlist/news',{})).statusCode,403);assert.equal((await call('no-perm',noPerm.revision,'discovery/boxoffice',{period:'day'})).statusCode,403);
 const news=await install('news',['watchlist.read','schedule.read']);assert.equal((await call('news',news.revision,'watchlist/news',{profile:'q'})).statusCode,400);assert.equal((await call('news',news.revision,'watchlist/news',{})).json().status,'unconfigured');
 const bx=await install('box',['boxoffice.read']);assert.equal((await call('box',bx.revision,'discovery/boxoffice',{period:'day',key:'injected'})).statusCode,400);
 const pending=call('box',bx.revision,'discovery/boxoffice',{period:'day'}).then(r=>r);for(let i=0;i<100&&!started;i++)await new Promise(r=>setTimeout(r,5));assert.ok(started);env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='box'");release();assert.equal((await pending).statusCode,404);
 }finally{release();await env.app.close();await rm(dir,{recursive:true,force:true});}
});
test('slow news responds within its budget without starting unlimited background work',async t=>{
 const {db,add}=await fixture(t);add('a');let release:()=>void=()=>{},calls=0;
 const news=new PluginNews(db,{enabled:true,configurationRevision:0,upcoming:async()=>{calls++;await new Promise<void>(r=>release=r);return [event];}},now,10);
 assert.equal((await news.list('p')).status,'unavailable');assert.equal((await news.list('p')).status,'unavailable');assert.equal((await news.list('p')).status,'unavailable');assert.equal(calls,1);
 release();await new Promise(r=>setTimeout(r,0));assert.equal((await news.list('p')).items.length,1);assert.equal(calls,1);
});
