import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePlayback } from '../src/playback/remote.js';
import { ApiFailure } from '../src/util.js';
import { buildApp } from '../src/app.js';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import iconv from 'iconv-lite';
const state=(profile:string,now:number,lease?:string):any=>({profile,touched:now,apkLease:lease,renewAt:now+45_000,abort:new AbortController(),assets:new Map(),reverse:new Map(),response:{episodeId:'episode'}});

test('proxied subtitle bytes preserve CP949, UTF-16 and declared Shift_JIS before SRT conversion', async () => {
  for (const [encoding, text, charset] of [['cp949', '한글 기호 → ★', ''], ['utf16le', '한글 ｢日本語｣', ''], ['shift_jis', '｢日本語の字幕｣', '; charset=Shift_JIS']]) {
    const content = `1\n00:00:01,000 --> 00:00:03,000\n${text}\n`;
    const transport = async () => ({ url: 'https://cdn.example.test/sub.srt', response: Object.assign(Readable.from([iconv.encode(content, encoding)]), { statusCode: 200, headers: { 'content-type': `text/plain${charset}` } }) });
    const remote = new RemotePlayback(null as any, null as any, {} as any, transport as any);
    const session = state('p', Date.now()); session.assets.set('sub', { url: 'https://cdn.example.test/sub.srt', headers: {}, subtitle: 'vtt' }); remote.sessions.set('s', session);
    const app = Fastify(); app.get('/subtitle', (req, reply) => remote.proxy(req, reply, 's', 'sub'));
    try { const response = await app.inject('/subtitle'); assert.equal(response.statusCode, 200, response.body); assert.match(response.body, /^WEBVTT/); assert.ok(response.body.includes(text), encoding); }
    finally { await app.close(); remote.close(); }
  }
});

test('runtime heartbeats retain paused playback, abandoned sessions expire quickly, public sessions keep their old lifetime',async()=>{
 let now=1000;const released:string[]=[],renewed:string[]=[];
 const remote=new RemotePlayback(null as any,null as any,{apk:{renew:async(id:string)=>{renewed.push(id);},release:(id:string)=>{if(id)released.push(id);}}} as any,undefined,undefined,()=>now);
 try {
  remote.sessions.set('abandoned',state('p',now,'old'));remote.sessions.set('paused',state('p',now,'active'));remote.sessions.set('public',state('p',now));
  now+=170_000;remote.heartbeat('paused','p');await remote.maintain();
  now+=20_000;await remote.maintain();
  assert.equal(remote.sessions.has('abandoned'),false);assert.deepEqual(released,['old']);
  assert.ok(remote.sessions.has('paused'));assert.ok(remote.sessions.has('public'));assert.ok(renewed.includes('active'));
  assert.throws(()=>remote.heartbeat('paused','other'),/session-forbidden/);
  now+=31*60_000;await remote.maintain();assert.equal(remote.sessions.size,0);
 }finally{remote.close();}
});

test('a transient renew failure preserves the stream; renews do not overlap and a confirmed expired lease requests recovery',async()=>{
 let now=1000,calls=0,mode='timeout';let finish!:(v?:unknown)=>void;
 const remote=new RemotePlayback(null as any,null as any,{apk:{renew:async()=>{calls++;if(mode==='timeout')throw Error('timeout');if(mode==='expired')throw new ApiFailure(502,'apk_lease_expired');if(mode==='pending')await new Promise(r=>finish=r);},release:()=>{}}} as any,undefined,undefined,()=>now);
 try {
  const s=state('p',now,'lease');remote.sessions.set('s',s);now+=45_000;await remote.maintain();
  assert.equal(calls,1);assert.equal(s.abort.signal.aborted,false);remote.heartbeat('s','p');
  now+=15_000;mode='pending';const maintenance=remote.maintain();await remote.maintain();assert.equal(calls,2);
  finish();await maintenance;assert.equal(s.renewFailures,0);
  mode='expired';now+=45_000;await remote.maintain();assert.equal(s.leaseLost,true);
  assert.throws(()=>remote.heartbeat('s','p'),/playback-restart-required/);assert.equal(remote.sessions.has('s'),true);
  // A late control response must not bring back a closed session.
  s.leaseLost=false;s.renewAt=now;mode='pending';const late=remote.maintain();remote.remove('s');finish();await late;assert.equal(remote.sessions.size,0);
 }finally{remote.close();}
});

test('heartbeat requires the owning account and profile; DELETE acknowledges after releasing the APK slot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moa-heartbeat-'));
 const {app,remotePlayback,sources}=await buildApp({dataDir:dir,mediaRoot:dir,webDir:join(dir,'web'),requireAccount:true},false);
 const account={'x-moa-account':'owner','x-moa-role':'admin'},foreign={'x-moa-account':'other','x-moa-role':'member'};
 try {
  const create=async(headers:any)=>(await app.inject({method:'POST',url:'/api/profiles',headers,payload:{name:'Profile'}})).json().id;
  const a=await create(account),b=await create(account),c=await create(foreign),headers={...account,'x-moa-profile':a};
  remotePlayback.sessions.set('session',state(a,Date.now(),'lease'));
  const beat=(headers:any)=>app.inject({method:'POST',url:'/api/playback/session/heartbeat',headers});
  assert.equal((await beat(headers)).statusCode,204);
  assert.equal((await beat(account)).statusCode,401);
  assert.equal((await beat({...account,'x-moa-profile':b})).statusCode,403);
  assert.equal((await beat({...foreign,'x-moa-profile':c})).statusCode,403);
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  sources.apk.release=()=>{entered();return new Promise<void>(r=>release=r);};
  let completed=false;const removing=app.inject({method:'DELETE',url:'/api/playback/session',headers}).then(r=>{completed=true;return r;});
  await started;assert.equal(completed,false);assert.equal((await beat(headers)).statusCode,404);
  release();assert.equal((await removing).statusCode,204);
  sources.apk.release=()=>{};
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
