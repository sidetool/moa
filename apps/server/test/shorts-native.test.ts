import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeShorts, selectNativeTrailer, trailerMediaUrl, type NativeTrailer } from '../src/shorts-native.js';
import { buildApp } from '../src/app.js';
const id='AAAAAAAAAAA';
const selected:NativeTrailer={url:'https://example.googlevideo.com/video.mp4',mime:'video/mp4',headers:{'User-Agent':'fixture'}};
const format={url:selected.url,protocol:'https',ext:'mp4',height:360,acodec:'mp4a.40.2',vcodec:'avc1.42001e'};
const data=(formats:unknown[])=>({id,duration:120,formats});
test('extractor selection requires muxed browser codecs, bounded resolution/duration and known public media family',()=>{
  const result=selectNativeTrailer(data([{...format,height:1080},{...format,acodec:'none'},format]),id);
  assert.equal(result.mime,'video/mp4');
  assert.equal(selectNativeTrailer(data([{...format,protocol:'m3u8_native'}]),id).mime,'application/vnd.apple.mpegurl');
  for(const value of [{...data([format]),is_live:true},{...data([format]),duration:700},data([{...format,has_drm:true}]),data([{...format,url:'https://localhost/x'}]),data([{...format,vcodec:'vp9'}])])assert.throws(()=>selectNativeTrailer(value,id));
  for(const url of ['https://googlevideo.com.evil.test/a','https://evilgooglevideo.com/a','http://example.googlevideo.com/a','https://u:p@example.googlevideo.com/a','https://example.googlevideo.com:444/a'])assert.throws(()=>trailerMediaUrl(url));
});
test('leases are profile-bound, capped per profile, expire, and return no upstream credentials',async()=>{
  let now=1;
  const native=new NativeShorts(async()=>selected,undefined,()=>now);
  try{
    const a=await native.prepare('a',[id],new AbortController().signal,'socks5://private.invalid');
    assert.equal(native.owner(a.sessionId),'a');assert.ok(!JSON.stringify(a).includes('googlevideo'));
    native.release(a.sessionId,'b');assert.equal(native.owner(a.sessionId),'a');
    await native.prepare('a',[id],new AbortController().signal);await native.prepare('a',[id],new AbortController().signal);
    assert.equal(native.owner(a.sessionId),undefined);
    const b=await native.prepare('b',[id],new AbortController().signal);
    now+=600_001;await native.prepare('c',[id],new AbortController().signal);
    assert.equal(native.owner(b.sessionId),undefined);
  }finally{native.close();}
});
test('aborted preparations do not create leases; shutdown aborts workers and prevents further requests',async()=>{
  let finish!:(value:NativeTrailer)=>void,childSignal!:AbortSignal;
  const native=new NativeShorts(async(_id,signal)=>{childSignal=signal;return new Promise(resolve=>finish=resolve);});
  const control=new AbortController(),pending=native.prepare('a',[id],control.signal);
  control.abort();finish(selected);await assert.rejects(pending);assert.equal(childSignal.aborted,true);
  const pending2=native.prepare('a',[id],new AbortController().signal);native.close();finish(selected);
  await assert.rejects(pending2);assert.equal(childSignal.aborted,true);
  await assert.rejects(native.prepare('a',[id],new AbortController().signal),{error:'shorts-native-unconfigured'});
});
function reply(){
  const raw=new EventEmitter();let sent:any,code=200;const headers:Record<string,unknown>={};
  const reply:any={raw,header:(k:string,v:unknown)=>{headers[k]=v;return reply;},type:(v:string)=>{headers['content-type']=v;return reply;},code:(v:number)=>{code=v;return reply;},send:(v:unknown)=>{sent=v;return reply;}};
  return {reply,headers,sent:()=>sent,status:()=>code};
}
test('relay rewrites HLS to opaque assets, rejects encrypted playlists and serves range bytes',async()=>{
  let encrypted=false;const calls:any[]=[];
  const transport:any=async(url:string,headers:any)=>{
    calls.push({url,headers});const playlist=url.includes('playlist');
    const response:any=Readable.from([Buffer.from(playlist?'#EXTM3U\n'+(encrypted?'#EXT-X-KEY:METHOD=AES-128,URI="key"\n':'')+'#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST':'sample')]);
    response.statusCode=playlist?200:206;response.headers={'content-type':playlist?'application/vnd.apple.mpegurl':'video/mp2t',...(!playlist?{'content-range':'bytes 0-5/6'}:{})};
    return {url,response};
  };
  const native=new NativeShorts(async()=>({...selected,url:'https://example.googlevideo.com/playlist.m3u8',mime:'application/vnd.apple.mpegurl'}),transport);
  try{
    const session=await native.prepare('a',[id],new AbortController().signal);
    const asset=session.url.split('/').at(-1)!;
    const r=reply();await native.stream({headers:{},moaProfile:'a'} as any,r.reply,session.sessionId,asset);
    assert.match(r.sent(),/\/api\/playback\//);assert.ok(!r.sent().includes('googlevideo'));
    const segment=r.sent().split('\n').find((v:string)=>v.startsWith('/api/')).split('/').at(-1)!;
    const r2=reply();await native.stream({headers:{range:'bytes=0-5'},moaProfile:'a'} as any,r2.reply,session.sessionId,segment);
    assert.equal(r2.status(),206);assert.equal(calls.at(-1).headers.Range,'bytes=0-5');
    for await(const _chunk of r2.sent()){};
    encrypted=true;await assert.rejects(native.stream({headers:{}} as any,reply().reply,session.sessionId,asset));
    await assert.rejects(native.stream({headers:{},moaProfile:'b'} as any,reply().reply,session.sessionId,asset),{error:'session-profile-mismatch'});
  }finally{native.close();}
});
test('native endpoints retain account/profile authorization, validate mode, and default to disabled',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-shorts-native-'));
  const {app,db}=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:true,shortsExtractor:undefined},false,{tmdb:{},youtube:{}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const account={'x-moa-account':'owner','x-moa-role':'admin'};
  await app.inject({url:'/api/me',headers:account});
  db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,0,?,?)','p','P','blue','2026','owner');
  const headers={...account,'x-moa-profile':'p'};
  assert.equal(db.settings('p').shortsPlayback,'embed');
  assert.equal((await app.inject({url:'/api/shorts/native'})).statusCode,401);
  assert.deepEqual((await app.inject({url:'/api/shorts/native',headers})).json(),{available:false});
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/native',headers,payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsPlayback:'bad'}})).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsPlayback:'native'}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/shorts/movie:1/native',headers,payload:{}})).statusCode,503);
  assert.equal((await app.inject({url:'/api/playback/unknown/shorts/unknown',headers:account})).statusCode,410);
});

test('prepared media checks its account and PIN even when a video tag supplies no profile header',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-native-owner-')),binary=path.join(dir,'extractor');
  await writeFile(binary,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(data([format])))});\n`,{mode:0o700});
  const {app,db}=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:true,shortsExtractor:binary},false,{
    tmdb:{token:'fixture-token',fetch:async()=>Response.json({adult:false,videos:{results:[{site:'YouTube',type:'Trailer',key:id}]}})},youtube:{}
  });
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const account={'x-moa-account':'owner','x-moa-role':'admin'};
  await app.inject({url:'/api/me',headers:account});
  db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,0,?,?)','p','P','blue','2026','owner');
  const headers={...account,'x-moa-profile':'p'};
  await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsPlayback:'native',shortsEnabled:true}});
  const prepared=await app.inject({method:'POST',url:'/api/shorts/movie:1/native',headers,payload:{}});
  assert.equal(prepared.statusCode,200,prepared.body);
  const lease=prepared.json();assert.ok(!prepared.body.includes('googlevideo'));
  assert.equal((await app.inject({url:lease.url,headers:{'x-moa-account':'other','x-moa-role':'member','x-moa-permissions':'video.watch'}})).statusCode,403);
  assert.equal((await app.inject({url:lease.url,headers:{'x-moa-account':'owner','x-moa-role':'member'}})).statusCode,403);
  db.run("UPDATE profiles SET pin_hash='locked' WHERE id='p'");
  assert.equal((await app.inject({url:lease.url,headers:account})).json().error,'profile-locked');
  db.run("UPDATE profiles SET pin_hash=NULL WHERE id='p'");
  await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsEnabled:false}});
  assert.equal((await app.inject({url:lease.url,headers:account})).json().error,'shorts-native-disabled');
  assert.equal((await app.inject({url:lease.url,headers:account})).statusCode,410);
});
