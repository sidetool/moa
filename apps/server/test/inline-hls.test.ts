import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineHls, INLINE_HLS_LIMIT } from '../src/playback/inline-hls.js';
const data = (body: string) => 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from(body).toString('base64');
const key = 'data:application/octet-stream;base64,' + Buffer.alloc(16, 7).toString('base64');
const body = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="${key}",IV=0x00000000000000000000000000000001\n#EXTINF:5,\nhttps://media.example.com/one.ts\n#EXT-X-ENDLIST\n`;
test('accepts existing URL field encoding and preserves key bytes and IV', () => {
  for (const prefix of ['data:', 'data://']) {
    const result = parseInlineHls(data(body).replace('data:',prefix));
    assert.equal(result.body,body); assert.deepEqual(result.keys.get(key),Buffer.alloc(16,7));
  }
});
test('rejects nested data, relative/file resources, unsupported encryption and unbounded input', () => {
  for (const invalid of [body.replace('https://media.example.com/one.ts','file:///etc/passwd'),body.replace('https://media.example.com/one.ts','one.ts'),body.replace('https://media.example.com/one.ts',key),body.replace('AES-128','SAMPLE-AES'),body.replace(key,key.slice(0,-4)),body.replace('#EXT-X-ENDLIST',''),body+'#EXT-X-DEFINE:NAME="x",VALUE="y"\n',body+'#EXT-X-MAP:URI="file:///tmp/a"\n',body.replace(key,'https://example.com/key')]) assert.throws(()=>parseInlineHls(data(invalid)));
  assert.throws(()=>parseInlineHls(data('a'.repeat(INLINE_HLS_LIMIT+1))));
});
test('keeps distinct rotated keys, rejects excessive key counts', () => {
  const lines=Array.from({length:33},(_,i)=>`#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,${Buffer.alloc(16,i).toString('base64')}"`);
  assert.equal(parseInlineHls(data(body.replace('#EXTINF:',lines.slice(0,2).join('\n')+'\n#EXTINF:'))).keys.size,3);
  assert.throws(()=>parseInlineHls(data(body+lines.join('\n'))));
});

test('session proxy hides inline key, keeps auth isolation, forwards range/proxy and expires assets', async () => {
  const { RemotePlayback } = await import('../src/playback/remote.js');
  const { default: Fastify } = await import('fastify');
  const { Readable } = await import('node:stream');
  const calls: unknown[] = [];
  const remote = new RemotePlayback(null as any,null as any,{} as any,async (url,headers,_signal,proxy)=>{
    calls.push({url,headers,proxy});const response=Readable.from([Buffer.from('segment')]) as any;
    response.statusCode=206;response.headers={'content-type':'video/mp2t','content-range':'bytes 0-6/7'};return {url,response};
  });
  const state:any={profile:'owner',touched:Date.now(),proxy:'socks5://proxy.example:1080',assets:new Map(),reverse:new Map(),abort:new AbortController(),response:{}};
  remote.sessions.set('test',state);
  const url=(remote as any).inlineHls('test',state,{url:data(body),headers:{Referer:'https://source.example/'}});
  const app=Fastify();app.get('/api/playback/:id/remote/:asset',async(req,reply)=>{req.moaProfile=String(req.headers['x-profile']||'owner');const p=req.params as any;return remote.proxy(req,reply,p.id,p.asset);});
  try{
    const playlist=await app.inject(url);assert.equal(playlist.statusCode,200);assert(!playlist.body.includes('data:'));assert(!playlist.body.includes('https:'));
    const keyUrl=/URI="([^"]+)"/.exec(playlist.body)![1];const result=await app.inject(keyUrl);assert.deepEqual(result.rawPayload,Buffer.alloc(16,7));assert.equal(result.headers['cache-control'],'private, no-store');
    assert.equal((await app.inject({url:keyUrl,headers:{'x-profile':'other'}})).statusCode,403);
    const segment=playlist.body.split('\n').find(l=>l.startsWith('/api/'))!;
    assert.equal((await app.inject({url:segment,headers:{range:'bytes=0-6'}})).statusCode,206);
    assert.deepEqual(calls,[{url:'https://media.example.com/one.ts',headers:{Referer:'https://source.example/',Range:'bytes=0-6'},proxy:'socks5://proxy.example:1080'}]);
    remote.remove('test');assert.equal((await app.inject(keyUrl)).statusCode,404);
  }finally{await app.close();remote.close();}
});

test('handles a near-limit valid playlist and rejects malformed UTF-8/base64', () => {
  const large=body+'#'+ 'x'.repeat(INLINE_HLS_LIMIT-Buffer.byteLength(body)-2)+'\n';
  assert.equal(Buffer.byteLength(large),INLINE_HLS_LIMIT);
  assert.equal(parseInlineHls(data(large)).body,large);
  assert.throws(()=>parseInlineHls(data(body)+'='));
  assert.throws(()=>parseInlineHls('data:application/vnd.apple.mpegurl;base64,'+Buffer.from([255,255]).toString('base64')));
});

test('real JS runtime and Sources.videos reach playback; inline credentials stay on the declared origin', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { parseRepository } = await import('../src/sources/extensions/index.js');
  const { default: Fastify } = await import('fastify');
  const { Store } = await import('../src/db.js');
  const { Catalog } = await import('../src/catalog/service.js');
  const { Sources } = await import('../src/sources/service.js');
  const { RemotePlayback } = await import('../src/playback/remote.js');
  const dir = await mkdtemp(join(tmpdir(),'moa-inline-integration-'));
  const db = new Store(dir), catalog = new Catalog(db), sources = new Sources(db,catalog);
  const entry = JSON.stringify(parseRepository([{id:'inline-fixture',name:'Fixture',lang:'en',version:'1',itemType:1,sourceCodeLanguage:1,baseUrl:'https://source.example',sourceCodeUrl:'https://source.example/code.js'}])[0]);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','fixture',entry,entry,'fixture');
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','m','Fixture','series','{}','2026');
  db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','e','m',1,1,'Episode',10,null);
  db.run('INSERT INTO source_media VALUES(?,?,?,0)','m','s','show');
  db.run('INSERT INTO source_episodes VALUES(?,?)','e','episode');
  sources.saveNetwork('socks5://proxy.example:1080',0);
  const calls: Array<{url:string;headers:Record<string,string>;proxy?:string}> = [];
  const remote = new RemotePlayback(db,catalog,sources,async(url,headers,_signal,proxy)=>{
    calls.push({url,headers,proxy});
    const response=Readable.from([Buffer.from('segment')]) as any;
    response.statusCode=206;response.headers={'content-type':'video/mp2t','content-range':'bytes 0-6/7'};
    return {url,response};
  });
  const app=Fastify();
  app.get('/api/playback/:id/remote/:asset',async(req,reply)=>{
    req.moaProfile='owner'; const p=req.params as {id:string;asset:string};
    return remote.proxy(req,reply,p.id,p.asset);
  });
  const twoOrigins=body.replace('#EXT-X-ENDLIST','#EXTINF:5,\nhttps://cdn.example.net/two.ts\n#EXT-X-ENDLIST');
  const headers={aUtHoRiZaTiOn:'Bearer fixture',cOoKiE:'fixture=yes',Referer:'https://source.example/','User-Agent':'fixture'};
  try {
    for (const [prefix,originalUrl] of [
      ['data:','https://media.example.com/list.m3u8'],
      ['data://','https://media.example.com/list.m3u8'],
      ['data:',undefined],['data:','invalid'],['data:','https://user:pass@media.example.com/list.m3u8'],
    ] as const) {
      const inline={url:data(twoOrigins).replace('data:',prefix),originalUrl,headers};
      const ordinary=[{url:'https://media.example.com/plain.mp4'},{url:'edl://fixture'}];
      const videos=[{url:'data:text/html;base64,PGh0bWw+'},{url:data('not a playlist')},inline,...ordinary];
      // No mocked Sources.videos or private playback helper: execute the guest, filter and create.
      db.run('UPDATE source_entries SET code=? WHERE id=?',`class DefaultExtension extends MProvider { async getVideoList(){return ${JSON.stringify(videos)};} }`,'s');
      assert.deepEqual((await sources.videos('e')).map(v=>v.url),[inline.url,...ordinary.map(v=>v.url)]);
      const session=await remote.create('owner','e');
      const playlist=await app.inject(session.url);
      assert.equal(playlist.statusCode,200);
      assert.doesNotMatch(playlist.body,/https:|data:/);
      const keyUrl=/URI="([^"]+)"/.exec(playlist.body)![1];
      assert.deepEqual((await app.inject(keyUrl)).rawPayload,Buffer.alloc(16,7));
      calls.length=0;
      for(const url of playlist.body.split('\n').filter(l=>l.startsWith('/api/'))) {
        assert.equal((await app.inject({url,headers:{range:'bytes=0-6'}})).statusCode,206);
      }
      assert.equal(calls.length,2);
      for(const call of calls){
        assert.equal(call.proxy,'socks5://proxy.example:1080');
        assert.equal(call.headers.Referer,headers.Referer);
        assert.equal(call.headers['User-Agent'],'fixture');
        assert.equal(call.headers.Range,'bytes=0-6');
        const keep=originalUrl==='https://media.example.com/list.m3u8' && new URL(call.url).hostname==='media.example.com';
        assert.equal(call.headers.aUtHoRiZaTiOn,keep?headers.aUtHoRiZaTiOn:undefined);
        assert.equal(call.headers.cOoKiE,keep?headers.cOoKiE:undefined);
      }
      remote.remove(session.sessionId);
      assert.equal((await app.inject(session.url)).statusCode,404);
    }
    // Distinguish an empty result from rejected formats at the actual playback entry point.
    for (const [videos,code] of [
      [[], 'no-streams'],
      [[{url:'data:text/html;base64,c2VjcmV0',headers:{Cookie:'private=fixture'}}], 'unsupported-stream-format'],
      [[{url:data('not a playlist')}], 'unsupported-stream-format'],
    ] as const) {
      db.run('UPDATE source_entries SET code=? WHERE id=?',`class DefaultExtension extends MProvider { async getVideoList(){return ${JSON.stringify(videos)};} }`,'s');
      await assert.rejects(remote.create('owner','e'),(error:any)=>{
        assert.equal(error.statusCode,502);
        assert.equal(error.error,code);
        assert.equal(error.message,code,'diagnostics must not include extension data');
        return true;
      });
      assert.equal(remote.sessions.size,0);
    }
  } finally {await app.close();remote.close();await sources.close();db.close();await rm(dir,{recursive:true,force:true});}
});

test('rejected APK formats release their lease; accepted mixed results keep the lease', async () => {
  const { Sources } = await import('../src/sources/service.js');
  const released:string[]=[];
  const videos:any=Object.assign([{url:'data:text/html;base64,Zml4dHVyZQ=='}],{apkLease:'fixture-lease'});
  const source:any={
    remoteEpisode:()=>({source_id:'s',url:'episode'}),
    serial:(_id:string,task:()=>Promise<unknown>)=>task(),
    navigationCall:async()=>({result:videos,url:'episode',current:()=>{}}),
    apk:{release:(lease:string)=>{released.push(lease);}},
  };
  await assert.rejects(Sources.prototype.videos.call(source,'e'),/unsupported-stream-format/);
  assert.deepEqual(released,['fixture-lease']);
  released.length=0;
  videos.push({url:'https://media.example.com/video.mp4'});
  const result=await Sources.prototype.videos.call(source,'e');
  assert.equal(result.length,1);assert.equal(result.apkLease,'fixture-lease');
  assert.deepEqual(released,[]);
});
