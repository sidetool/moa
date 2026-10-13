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
    assert.equal(native.busy,false);
    const a=await native.prepare('a',[id],new AbortController().signal,'socks5://private.invalid');
    assert.equal(native.busy,true);
    assert.equal(native.owner(a.sessionId),'a');assert.ok(!JSON.stringify(a).includes('googlevideo'));
    native.release(a.sessionId,'b');assert.equal(native.owner(a.sessionId),'a');
    await native.prepare('a',[id],new AbortController().signal);await native.prepare('a',[id],new AbortController().signal);
    assert.equal(native.owner(a.sessionId),'a');
    await native.prepare('a',[id],new AbortController().signal);
    assert.equal(native.owner(a.sessionId),undefined);
    const b=await native.prepare('b',[id],new AbortController().signal);
    now+=600_001;assert.equal(native.busy,false);await native.prepare('c',[id],new AbortController().signal);
    assert.equal(native.owner(b.sessionId),undefined);
  }finally{native.close();}
});
test('aborted preparations do not create leases; shutdown aborts workers and prevents further requests',async()=>{
  let finish!:(value:NativeTrailer)=>void,childSignal!:AbortSignal;
  const native=new NativeShorts(async(_id,signal)=>{childSignal=signal;return new Promise(resolve=>finish=resolve);});
  const control=new AbortController(),pending=native.prepare('a',[id],control.signal);
  assert.equal(native.busy,true);
  control.abort();finish(selected);await assert.rejects(pending);assert.equal(childSignal.aborted,true);assert.equal(native.busy,false);
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
  assert.equal((await app.inject({method:'POST',url:`/api/shorts/native/${lease.sessionId}/warm`,headers:{'x-moa-account':'other','x-moa-role':'member','x-moa-permissions':'video.watch','x-moa-profile':'p'},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:`/api/shorts/native/${lease.sessionId}/subtitles/unknown/translate`,headers:{'x-moa-account':'owner','x-moa-role':'member','x-moa-permissions':'video.watch','x-moa-profile':'p'},payload:{}})).statusCode,403);
  assert.equal((await app.inject({url:`/api/playback/${lease.sessionId}/shorts-captions/unknown`,headers:{'x-moa-account':'other','x-moa-role':'member','x-moa-permissions':'video.watch'}})).statusCode,403);

  assert.equal((await app.inject({url:lease.url,headers:{'x-moa-account':'other','x-moa-role':'member','x-moa-permissions':'video.watch'}})).statusCode,403);
  assert.equal((await app.inject({url:lease.url,headers:{'x-moa-account':'owner','x-moa-role':'member'}})).statusCode,403);
  db.run("UPDATE profiles SET pin_hash='locked' WHERE id='p'");
  assert.equal((await app.inject({url:lease.url,headers:account})).json().error,'profile-locked');
  db.run("UPDATE profiles SET pin_hash=NULL WHERE id='p'");
  await app.inject({method:'PATCH',url:'/api/settings',headers,payload:{shortsEnabled:false}});
  assert.equal((await app.inject({url:lease.url,headers:account})).json().error,'shorts-native-disabled');
  assert.equal((await app.inject({url:lease.url,headers:account})).statusCode,410);
});

test('prepared references are briefly reused only within the same profile, proxy and candidate list',async()=>{
  let now=1,calls=0;
  const native=new NativeShorts(async()=>{calls++;return selected;},undefined,()=>now);
  try{
    const a=await native.prepare('a',[id],new AbortController().signal);
    native.release(a.sessionId);
    await native.prepare('a',[id],new AbortController().signal);assert.equal(calls,1);
    await native.prepare('b',[id],new AbortController().signal);assert.equal(calls,2);
    await native.prepare('a',[id],new AbortController().signal,'http://proxy.invalid');assert.equal(calls,3);
    now+=120_001;await native.prepare('a',[id],new AbortController().signal);assert.equal(calls,4);
  }finally{native.close();}
});

test('connection and extraction failures are not mislabeled unsupported media',async()=>{
  const {extractorFailure}=await import('../src/shorts-native.js');
  assert.equal(extractorFailure('Video unavailable').statusCode,422);
  assert.equal(extractorFailure('Sign in to confirm you are not a bot').error,'shorts-native-auth-required');
  assert.equal(extractorFailure('connection timed out at secret-url').statusCode,504);
  assert.ok(!extractorFailure('secret-url').message.includes('secret-url'));
  const native=new NativeShorts(async()=>{throw extractorFailure('connection timed out');});
  try{await assert.rejects(native.prepare('a',[id],new AbortController().signal),{statusCode:504});}finally{native.close();}
});

test('split HLS resolves through its master and retains compatible video plus matching audio',async()=>{
  const {selectTrailerMaster}=await import('../src/shorts-native.js');
  const master='https://example.googlevideo.com/master.m3u8';
  const result=selectNativeTrailer(data([{...format,protocol:'m3u8_native',acodec:'none',manifest_url:master}]),id);
  assert.equal(result.url,master);assert.equal(result.master,true);
  const body=['#EXTM3U','#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Default",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="opus",NAME="Other",URI="unused.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aac"','video.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="aac"','large.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="vp09.00.21.08,opus",RESOLUTION=1280x720,AUDIO="opus"','vp9.m3u8'].join('\n');
  const selected=selectTrailerMaster(body);assert.match(selected,/audio.m3u8/);assert.match(selected,/video.m3u8/);
  assert.doesNotMatch(selected,/large.m3u8|unused.m3u8|vp9.m3u8/);
  assert.throws(()=>selectTrailerMaster(body.replaceAll('avc1.','av01.')));
  assert.throws(()=>selectTrailerMaster(body.replaceAll('AUDIO="aac"','AUDIO="missing"')));
});

test('segment paths containing playlist/index.m3u8 are still binary segments',async()=>{
  const transport:any=async(url:string)=>{
    const playlist=url.endsWith('/root.m3u8');
    const response:any=Readable.from([Buffer.from(playlist?'#EXTM3U\n#EXTINF:5,\nhttps://example.googlevideo.com/playlist/index.m3u8/sq/0/seg.ts\n#EXT-X-ENDLIST':'binary segment')]);
    response.statusCode=200;response.headers={'content-type':playlist?'application/vnd.apple.mpegurl':'application/octet-stream'};
    return {url,response};
  };
  const native=new NativeShorts(async()=>({...selected,url:'https://example.googlevideo.com/root.m3u8',mime:'application/vnd.apple.mpegurl'}),transport);
  try{
    const s=await native.prepare('p',[id],new AbortController().signal),r=reply();
    await native.stream({headers:{}} as any,r.reply,s.sessionId,s.url.split('/').at(-1)!);
    const asset=r.sent().split('\n').find((line:string)=>line.startsWith('/api/')).split('/').at(-1);
    const media=reply();await native.stream({headers:{}} as any,media.reply,s.sessionId,asset);
    const chunks=[];for await(const chunk of media.sent())chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(),'binary segment');
  }finally{native.close();}
});

test('two next leases warm audio/video and playback serves those bytes without upstream repeats',async()=>{
  const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42001e,mp4a.40.2",AUDIO="a"\nvideo.m3u8\n';
  const urls:string[]=[],a=Buffer.from('audio'),v=Buffer.from('video');
  const native=new NativeShorts(async()=>({...selected,url:'https://example.googlevideo.com/master.m3u8',mime:'application/vnd.apple.mpegurl',master:true}),async(url)=>{
    urls.push(String(url));const file=new URL(String(url)).pathname.slice(1);
    const body=file==='master.m3u8'?master:file.endsWith('.m3u8')?`#EXTM3U\n#EXTINF:5,\n${file.startsWith('audio')?'a':'v'}.ts\n#EXT-X-ENDLIST\n`:file==='a.ts'?a:v;
    return {url:String(url),response:Object.assign(Readable.from([Buffer.from(body)]),{statusCode:200,headers:{'content-type':file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'}})} as any;
  });
  try{
    const current=await native.prepare('p',[id],new AbortController().signal);
    const next=await native.prepare('p',['BBBBBBBBBBB'],new AbortController().signal);
    const second=await native.prepare('p',['CCCCCCCCCCC'],new AbortController().signal);
    assert.equal(native.owner(current.sessionId),'p');
    await assert.rejects(native.warm(next.sessionId,'q',new AbortController().signal),{statusCode:403});
    assert.deepEqual(await native.warm(next.sessionId,'p',new AbortController().signal),{ready:true});
    assert.equal(urls.length,5);
    const read=async(url:string)=>{const out=reply();await native.stream({headers:{},moaProfile:'p'} as any,out.reply,url.split('/')[3],url.split('/').at(-1)!);return out.sent();};
    const root=await read(next.url);
    const video=root.split('\n').find((line:string)=>line.startsWith('/api'));
    const list=await read(video),segment=list.split('\n').find((line:string)=>line.startsWith('/api'));
    const stream=await read(segment),chunks=[];for await(const c of stream)chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks),v);assert.equal(urls.length,5);
    await native.warm(next.sessionId,'p',new AbortController().signal);assert.equal(urls.length,5);
    assert.deepEqual(await native.warm(second.sessionId,'p',new AbortController().signal),{ready:true});
  }finally{native.close();}
});

test('MP4 prewarm caches a bounded prefix and preserves byte range semantics',async()=>{
  let calls=0;
  const native=new NativeShorts(async()=>selected,async(_url,headers)=>{
    calls++;assert.equal(headers.Range,'bytes=0-524287');
    return {url:selected.url,response:Object.assign(Readable.from([Buffer.from('12345')]),{statusCode:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-4/10'}})} as any;
  });
  try{
    const lease=await native.prepare('p',[id],new AbortController().signal);
    await native.warm(lease.sessionId,'p',new AbortController().signal);
    const out=reply();await native.stream({headers:{range:'bytes=2-4'}} as any,out.reply,lease.sessionId,lease.url.split('/').at(-1)!);
    const chunks=[];for await(const c of out.sent())chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(),'345');assert.equal(out.status(),206);assert.equal(out.headers['content-range'],'bytes 2-4/10');assert.equal(calls,1);
  }finally{native.close();}
});

test('caption URLs are opaque, validated, cached and lease-owned; releasing cancels registered translation',async()=>{
  const source=selectNativeTrailer({...data([format]),title:'Fixture',subtitles:{ko:[{ext:'vtt',url:'https://www.youtube.com/api/timedtext?v=fixture'}],en:[{ext:'vtt',url:'https://example.com/private'}]},automatic_captions:{ja:[{ext:'vtt',url:'https://www.youtube.com/api/timedtext?v=fixture&lang=ja'}],fr:[{ext:'vtt',url:'https://www.youtube.com/api/timedtext?v=fixture&tlang=fr'}]}},id);
  assert.deepEqual(source.subtitles?.map(c=>c.lang),['ko','ja']);let calls=0,cancelled=false;
  const native=new NativeShorts(async()=>source,async(url)=>{
    calls++;return {url,response:Object.assign(Readable.from([Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n')]),{statusCode:200,headers:{'content-type':'text/vtt'}})} as any;
  });
  try{
    const lease=await native.prepare('p',[id],new AbortController().signal),track=lease.subtitles[0];
    assert.equal(JSON.stringify(lease).includes('timedtext'),false);
    await assert.rejects(native.caption(lease.sessionId,track.id,'q',new AbortController().signal),{statusCode:403});
    assert.match((await native.caption(lease.sessionId,track.id,'p',new AbortController().signal)).content,/Hello/);
    await native.caption(lease.sessionId,track.id,'p',new AbortController().signal);assert.equal(calls,1);
    native.onRelease(lease.sessionId,'p','job',()=>{cancelled=true;});native.release(lease.sessionId);assert.equal(cancelled,true);
    await assert.rejects(native.caption(lease.sessionId,track.id,'p',new AbortController().signal),{statusCode:410});
  }finally{native.close();}
});


test('warm buffers six seconds of matching quality with bounded concurrent audio/video tracks',async t=>{
  const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n'+[360,480,720].map(h=>`#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x${h},CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"\n${h}.m3u8\n`).join('');
  const calls:string[]=[];let active=0,peak=0;
  const native=new NativeShorts(async()=>({...selected,url:'https://rr1---sn-test.googlevideo.com/master.m3u8',mime:'application/vnd.apple.mpegurl',master:true}),async url=>{
    const file=new URL(url).pathname.slice(1);calls.push(file);active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,25));active--;
    const body=file==='master.m3u8'?master:file.endsWith('.m3u8')?'#EXTM3U\n'+Array.from({length:6},(_,i)=>`#EXTINF:2,\n${file}-${i}.ts\n`).join('')+'#EXT-X-ENDLIST\n':'fragment';
    return {url:String(url),response:Object.assign(Readable.from([Buffer.from(body)]),{statusCode:200,headers:{'content-type':file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'}})} as any;
  });
  try{
    const lease=await native.prepare('p',[id],new AbortController().signal);
    assert.deepEqual(await native.warm(lease.sessionId,'p',new AbortController().signal,'480p'),{ready:true});
    assert.equal(peak,2);assert.ok(!calls.some(u=>u.startsWith('360')||u.startsWith('720')));
    for(const track of ['audio','480'])assert.deepEqual(calls.filter(u=>u.startsWith(track)&&u.endsWith('.ts')),Array.from({length:3},(_,i)=>`${track}.m3u8-${i}.ts`));
  }finally{native.close();}
});

test('new profiles get native mode when bundled without replacing navigation or old preferences', async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moa-native-default-'));
  const {app,db}=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:true,shortsExtractor:process.execPath},false,{tmdb:{},youtube:{}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const headers={'x-moa-account':'owner','x-moa-role':'admin'};
  await app.inject({url:'/api/me',headers});
  db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,0,?,?)','old','Old','blue','2026','owner');
  db.saveDefaultNavigation([{id:'home',label:'홈',type:'home',sourceIds:[]}] as any);
  const response=await app.inject({method:'POST',url:'/api/profiles',headers,payload:{name:'New'}});
  assert.equal(response.statusCode,201,response.body);
  assert.equal(db.settings(response.json().id).shortsPlayback,'native');
  assert.equal(db.settings(response.json().id).shortsEnabled,false);
  assert.equal(db.settings('old').shortsPlayback,'embed');
  assert.deepEqual(db.settings(response.json().id).navigation,db.availableNavigation(db.defaultNavigation()!));
});
