import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {Store} from '../src/db.js';import {Tmdb} from '../src/tmdb.js';import {PluginSchedule,seoulDay} from '../src/plugin-schedule.js';import {buildApp} from '../src/app.js';import {pluginPackage} from '../src/website-plugins.js';
const now=()=>Date.parse('2026-10-13T16:00:00Z'),day='2026-10-14';
const episode={id:1,airdate:day,airtime:'21:00',airstamp:'2026-10-14T12:00:00Z',season:1,number:2,show:{name:'Example',type:'Scripted',network:{name:'Channel',country:{code:'KR'}}}};
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'moa-calendar-')),db=new Store(dir);db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','P','blue',0,'2026')");return {db,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};}
test('KST date window, domestic Scripted filtering, unknown times, dedup and coalescing',async()=>{
 const f=await fixture();let calls=0;const provider={enabled:false,configurationRevision:0,movieSchedule:async()=>({items:[],truncated:false})};const s=new PluginSchedule(f.db,provider,{now,fetch:async(input)=>{calls++;assert.equal(String(input),`https://api.tvmaze.com/schedule?country=KR&date=${day}`);return Response.json([episode,episode,{...episode,id:2,airtime:''},{...episode,id:3,show:{...episode.show,type:'Reality'}},{...episode,id:4,show:{...episode.show,network:{country:{code:'US'}}}},{...episode,id:5,airdate:'2026-10-15',airstamp:'2026-10-15T12:00:00Z'},{...episode,id:6,airdate:'2026-10-13',airtime:'00:00',airstamp:'2026-10-13T15:00:00Z'}]);}});
 try{assert.equal(seoulDay(now()),day);const [a,b]=await Promise.all([s.list('p',{kind:'tv',date:day}),s.list('p',{kind:'tv',date:day})]);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.items.length,3);assert.equal(a.items[0].time,'00:00');assert.equal(a.items[1].time,'21:00');assert.equal(a.items[2].time,null);
 for(const date of ['2026-10-13','2026-10-21','bad'])await assert.rejects(s.list('p',{kind:'tv',date}));assert.equal((await s.list('p',{kind:'movie',date:day})).status,'unconfigured');
 f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");assert.equal((await s.list('p',{kind:'tv',date:day})).status,'restricted');assert.equal(calls,1);
 }finally{s.close();await f.close();}
});
test('TMDB only uses exact KR theatrical release dates, not global premiere or streaming',async()=>{
 const f=await fixture();const tmdb=new Tmdb(f.db,()=>{},{token:'test',fetch:async input=>{const u=new URL(String(input));if(u.pathname==='/3/discover/movie'){assert.equal(u.searchParams.get('region'),'KR');assert.equal(u.searchParams.get('with_release_type'),'2|3');return Response.json({results:[{id:1,adult:false,title:'Exact'},{id:2,adult:false,title:'Wrong'},{id:3,adult:true,title:'Adult'}],total_pages:1});}return Response.json({results:[{iso_3166_1:'KR',release_dates:[{type:u.pathname.includes('/1/')?3:4,release_date:day+'T00:00:00.000Z'}]},{iso_3166_1:'US',release_dates:[{type:3,release_date:day+'T00:00:00.000Z'}]}]});}});
 try{const r=await tmdb.movieSchedule(day);assert.equal(r.items.length,1);assert.equal(r.items[0].title,'Exact');assert.equal(r.items[0].time,null);}finally{tmdb.close();await f.close();}
});
test('permission and revocation checks protect the real runtime route',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-calendar-api-'));let release:(()=>void)|undefined;
 const env=await buildApp({dataDir:dir,mediaRoot:dir,requireAccount:false},false,{schedule:{now,fetch:async()=>{await new Promise<void>(r=>release=r);return Response.json([episode]);}}});
 try{const profile=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'P'}})).json();const pkg=pluginPackage({apiVersion:2,id:'calendar-test',name:'Calendar',version:'0.1.0',description:'',placements:['home'],permissions:['schedule.read'],connect:[],script:'// fixture'});
 const installed=(await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg})).json();const body={revision:installed.revision,query:{kind:'tv',date:day}};
 const request=(payload:any)=>env.app.inject({method:'POST',url:'/api/plugin-runtime/calendar-test/discovery/schedule',headers:{'x-moa-profile':profile.id},payload});
 assert.equal((await request({...body,revision:'bad'})).statusCode,400);assert.equal((await request({...body,query:{...body.query,date:'1900-01-01'}})).statusCode,400);
 const pending=request(body).then(r=>r);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='calendar-test'");release();assert.equal((await pending).statusCode,404);
 }finally{release?.();await env.app.close();await rm(dir,{recursive:true,force:true});}
});
