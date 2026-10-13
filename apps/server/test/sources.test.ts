import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { publicStream } from '@moa/extensions';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog.js';
import { Sources } from '../src/sources.js';
import { RemotePlayback, rewritePlaylist } from '../src/remote-playback.js';

test('source mapping, serial preference state, stable episode IDs, isolated progress and disabled source', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'moa-sources-')), db = new Store(temp), catalog = new Catalog(db);
  let active = 0, maxActive = 0, calls = 0;
  const source = new Sources(db,catalog,async (input) => {
    active++; maxActive = Math.max(active,maxActive); calls++;
    await new Promise(r => setTimeout(r,5)); active--;
    const result = input.action === 'list' ? { list: [{ name:'시리즈',link:'{"url":"/show"}',imageUrl:'https://poster.test/a.jpg' }],hasNextPage:false } : input.action === 'detail' ? { name:'시리즈',chapters:[{name:'3화',url:'episode/3'},{name:'1화',url:'episode/1'}] } : input.action === 'videos' ? [{url:'https://media.test/master.m3u8',headers:{Referer:'https://site.test/'},subtitles:[{file:'https://media.test/a.srt',label:'한국어'}]}] : [{ key: 'lang',listPreference:{title:'언어',entries:['한글','영어'],entryValues:['ko','en'],value:'ko'} }];
    return { result, changes:{ visits:Number(input.preferences?.visits || 0)+1 } };
  });
  const entry = JSON.stringify({ id:'x',name:'테스트',version:'1',baseUrl:'https://site.test/' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','source','https://repo.test/index.json',entry,entry,'fixture');
  for (const id of ['p1','p2']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',0,'2026');
  try {
    const { byedpi, ...network } = source.network();
    assert.deepEqual(network, {defaultProxy:'',revision:0});
    assert.equal(byedpi.enabled,false); assert.equal(byedpi.running,false);
    assert.equal(source.saveNetwork('socks5://proxy:1080',0).revision,1);
    assert.throws(() => source.saveNetwork('',0), /network-settings-conflict/);
    assert.throws(() => source.saveNetwork('file:///bad',1), /invalid-proxy-address/);
    source.saveNetwork('',1);
    const [a,b] = await Promise.all([source.browse('source','p1'),source.browse('source','p2')]);
    assert.equal(maxActive,1); assert.equal(calls,1); assert.equal(a.items[0].id,b.items[0].id);
    const mid = a.items[0].id;
    await source.detail(mid); const detail = catalog.detail(mid,'p1');
    assert.equal(detail.provider.id,'source'); assert.match(detail.poster!, /^\/api\/images\/source-/);
    assert.deepEqual(detail.seasons[0].episodes.map(e => e.number),[1,3]);
    const eid = detail.playTarget!.episodeId;
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p1',eid,200,1200,0,'2026');
    assert.equal(catalog.detail(mid,'p1').playTarget?.position,200); assert.equal(catalog.detail(mid,'p2').playTarget?.position,0);
    source.invalidate('source'); await source.detail(mid);
    assert.equal(catalog.detail(mid,'p1').playTarget?.episodeId,eid);
    assert.equal((await source.videos(eid))[0].subtitles?.[0].label,'한국어');
    await source.preferences('source',{lang:'en'});
    assert.equal((await source.preferences('source'))[0].value,'en');
    await assert.rejects(source.preferences('source',{lang:'invalid'}));
    const visits = JSON.parse(db.get('SELECT preferences FROM source_entries')!.preferences).visits;
    assert.ok(visits >= 5);
    source.configure('source',{enabled:false}); await assert.rejects(source.browse('source','p1'));
  } finally { await source.close(); db.close(); await rm(temp,{recursive:true,force:true}); }
});

test('HLS proxy rewrites nested URI, keeps headers and Range, hides URLs, handles SRT, profile scopes and expires',async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'moa-remote-')), db = new Store(temp), catalog = new Catalog(db);
  const source = new Sources(db,catalog,async () => ({ result:[{url:'https://media.test/master.m3u8',quality:'main',headers:{Referer:'https://site.test/a'},subtitles:[{file:'https://media.test/a.srt',label:'한국어'},{file:'1\n00:00:01,000 --> 00:00:03,000\n안녕하세요\n두 번째 줄\n2\n00:00:04,000 --> 00:00:06,000\n다음 자막\n',label:'Korean'},{file:'WEBVTT\n\n00:01.000 --> 00:03.000\nHello',label:'English'},{file:'[Script Info]\nScriptType: v4.00+\n[Events]\n',label:'ASS'},{file:'<html>error</html>',label:'invalid'},{file:'00:00:01,000 --> 00:00:02,000',label:'truncated'}]}],changes:{} }));
  const entry = JSON.stringify({id:'a',name:'S',version:'1',baseUrl:'https://site.test'});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled,live) VALUES(?,?,?,?,?,1,1)','s','repo',entry,entry,'fixture');
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','m','Show','series','{}','2026');
  db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','e','m',1,1,'Live',0,null);
  db.run('INSERT INTO source_media VALUES(?,?,?,0)','m','s','show'); db.run('INSERT INTO source_episodes VALUES(?,?)','e','ep');
  const requests: Array<{url:string;headers:Record<string,string>}> = [];
  const remote = new RemotePlayback(db,catalog,source,async (url,headers) => {
    requests.push({url,headers});
    let body = 'MEDIA', type = 'video/mp2t', status = 200;
    if (url.includes('master')) { body = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n'; type='application/vnd.apple.mpegurl'; }
    else if (url.includes('child')) { body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n'; type='application/vnd.apple.mpegurl'; }
    else if (url.includes('.srt')) { body = '1\n00:00:01,000 --> 00:00:02,000\n한글\n'; type='text/plain'; }
    else if (headers.Range) {body='ED';status=206;}
    const response = Readable.from([Buffer.from(body)]) as any; response.statusCode=status; response.headers={'content-type':type,...(status===206 ? {'content-range':'bytes 1-2/5'} : {})};
    return { response,url };
  });
  const app = Fastify(); app.get('/api/playback/:id/remote/:asset',async (req,reply) => { req.moaProfile = req.headers['x-moa-profile'] as string; const p=req.params as any; return remote.proxy(req,reply,p.id,p.asset); });
  try {
    const s = await remote.create('profile','e',200);
    assert.equal(s.live,true); assert.equal(s.startPosition,0); assert.equal(s.next,null);
    const master = await app.inject(s.url); assert.equal(master.statusCode,200); assert.ok(!master.body.includes('https://media.test'));
    const childUrl=master.body.split('\n').find(l=>l.startsWith('/api/'))!;
    const child=await app.inject(childUrl); assert.match(child.body, /KEY:.*URI="\/api\/playback\//);
    const segment=child.body.split('\n').find(l=>l.startsWith('/api/'))!;
    const partial=await app.inject({url:segment,headers:{range:'bytes=1-2'}}); assert.equal(partial.statusCode,206);assert.equal(partial.body,'ED');
    assert.equal(requests.at(-1)?.headers.Referer,'https://site.test/a');assert.equal(requests.at(-1)?.headers.Range,'bytes=1-2');
    const sub=await app.inject(s.subtitles[0].url);assert.match(sub.body,/^WEBVTT/);assert.match(sub.body,/00:00:01\.000/);
    assert.equal(s.subtitles.length,4);
    const requestsBefore=requests.length;
    const inline=await app.inject(s.subtitles[1].url);assert.equal(inline.statusCode,200);assert.match(inline.body,/^WEBVTT/);assert.match(inline.body,/00:00:01\.000/);assert.match(inline.body,/안녕하세요/);assert.equal(s.subtitles[1].lang,'ko');assert.match(inline.body,/안녕하세요\n두 번째 줄\n\n00:00:04\.000/);assert.doesNotMatch(inline.body,/\n2\n/);
    assert.match((await app.inject(s.subtitles[2].url)).body,/Hello/);
    assert.match((await app.inject(s.subtitles[3].url)).headers['content-type']!,/text\/x-ssa/);
    assert.equal(requests.length,requestsBefore,'inline subtitles require no upstream requests');
    assert.equal((await app.inject({url:s.subtitles[1].url,headers:{'x-moa-profile':'other'}})).statusCode,403);
    assert.equal((await app.inject({url:s.url,headers:{'x-moa-profile':'other'}})).statusCode,403);
    remote.remove(s.sessionId);assert.equal((await app.inject(s.url)).statusCode,404);
  } finally { await app.close();remote.close();await source.close();db.close();await rm(temp,{recursive:true,force:true}); }
});

test('stream transport rejects private network and non-HTTPS; unsupported variable playlists fail closed',async () => {
  for (const url of ['https://127.0.0.1/','https://[::1]/','http://example.com/','https://user:pass@example.com/']) await assert.rejects(publicStream(url,{},AbortSignal.timeout(1000)));
  assert.throws(()=>rewritePlaylist('#EXTM3U\n#EXT-X-DEFINE:NAME="x",VALUE="url"\n{$x}','https://test/',x=>x));
  const paths:string[]=[];rewritePlaylist('#EXTM3U\n#EXT-X-PART:URI="chunk.m4s"\n../seg.ts','https://test/path/master.m3u8',u=>{paths.push(u);return 'local';});assert.deepEqual(paths,['https://test/path/chunk.m4s','https://test/seg.ts']);
});

test('source-owned filter positions, validation, schema revision and cache separation',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'moa-filters-')),db=new Store(temp),catalog=new Catalog(db);
  let version=1, calls=0;
  const received:any[]=[];
  const source=new Sources(db,catalog,async input=>{
    if(input.action==='filters')return {changes:{},result:{browse:{availableModes:['popular','search'],filters:[{id:'2:0',position:2,groupPosition:0,label:'정렬',kind:'select',options:version===1?['업데이트','인기순']:['인기순','업데이트'],defaultValue:0},{id:'3:0',position:3,groupPosition:0,label:'정렬',kind:'sort',options:['이름','날짜'],defaultValue:{index:0,ascending:false}}]}}};
    calls++;received.push(input.params);return {changes:{},result:{list:[{name:'작품',link:'https://example.test/work'}],hasNextPage:false}};
  });
  const entry=JSON.stringify({id:'fixture',name:'fixture'});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','fixture',entry,entry,'fixture');db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  try{
    const schema=await source.capabilities('s');assert.deepEqual(schema.availableModes,['popular','search']);
    const selection={revision:schema.revision,filters:[{position:2,groupPosition:0,value:1}]};
    await source.browse('s','p','popular',1,'',selection);assert.equal(received[0].mode,'search');assert.deepEqual(received[0].filters,selection.filters);
    await source.browse('s','p','popular',1,'',selection);assert.equal(calls,1);
    await source.browse('s','p','popular',1,'',{...selection,filters:[{position:2,groupPosition:0,value:0}]});assert.equal(calls,2);
    await assert.rejects(source.browse('s','p','popular',1,'',{...selection,filters:[{position:2,groupPosition:0,value:22}]}),/invalid-source-filters/);
    await assert.rejects(source.browse('s','p','popular',1,'',{...selection,filters:[...selection.filters,...selection.filters]}),/invalid-source-filters/);
    await source.browse('s','p','popular',1,'',{...selection,filters:[{position:3,groupPosition:0,value:{index:1,ascending:true}}]});
    version=2;await assert.rejects(source.browse('s','p','popular',1,'',selection),/source-filters-changed/);
    assert.equal(calls,3,'invalid requests never invoke list');
  }finally{source.close();db.close();await rm(temp,{recursive:true,force:true});}
});

test('shortened search titles do not overwrite full titles and source category refines type',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'moa-source-title-')),db=new Store(temp),catalog=new Catalog(db);
  let title='구름 정원을 여행하고 싶어';
  const source=new Sources(db,catalog,async()=>({changes:{},result:{list:[{name:title,link:'/animation/fixture-show'}],hasNextPage:false}}));
  const entry=JSON.stringify({id:'fixture',name:'Sample KR'});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','fixture',entry,entry,'fixture');db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  try {
    const page=await source.browse('s','p');assert.equal(page.items[0].type,'anime');
    title='구름 정원을 여행하고...';const search=await source.browse('s','p','search',1,'구름');assert.equal(search.items[0].title,'구름 정원을 여행하고 싶어');
  }finally{await source.close();db.close();await rm(temp,{recursive:true,force:true});}
});

test('extension update validation, atomic failure, previous code/preferences rollback and sanitized health',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'moa-update-')),db=new Store(temp),catalog=new Catalog(db);
 let fail=false,downloadFail=false;
 const source=new Sources(db,catalog,async input=>{
   if(fail)throw new Error('network failed https://secret.example/?token=secret');
   return {changes:{},result:input.action==='filters'?{browse:{filters:[],availableModes:['popular','search']}}:{list:[],hasNextPage:false}};
 },async()=>{if(downloadFail)throw new Error('download failed');return {source:'new-code',sha256:'new-hash'};});
 const old=JSON.stringify({id:'s',name:'s',version:'1'}),next=JSON.stringify({id:'s',name:'s',version:'2'});
 db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,sha256,preferences,enabled) VALUES(?,?,?,?,?,?,?,1)','s','fixture',next,old,'old-code','old-hash','{"pref":"old"}');
 try{
  fail=true;await assert.rejects(source.install('s'));assert.equal(source.row('s').code,'old-code');assert.equal(source.list()[0].rollbackVersion,undefined);
  fail=false;downloadFail=true;await assert.rejects(source.install('s'));assert.equal(source.row('s').code,'old-code');downloadFail=false;
  const installed=await source.install('s');assert.equal(installed.installedVersion,'2');assert.equal(installed.rollbackVersion,'1');
  db.run('UPDATE source_entries SET preferences=? WHERE id=?','{"pref":"changed"}','s');
  fail=true;const diagnostic=await source.diagnose('s','p');assert.equal(diagnostic.health?.ok,false);assert.equal(diagnostic.health?.code,'connection-failed');assert.ok(!JSON.stringify(diagnostic).includes('token=secret'));
  const restored=await source.rollback('s');assert.equal(restored.installedVersion,'1');assert.equal(restored.rollbackVersion,undefined);assert.equal(source.row('s').code,'old-code');assert.equal(JSON.parse(source.row('s').preferences).pref,'old');
  await assert.rejects(source.rollback('s'),/source-no-backup/);
 }finally{await source.close();db.close();await rm(temp,{recursive:true,force:true});}
});

test('multiple repositories isolate source IDs, retain installed sources on removal and preserve failed refresh data',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'moa-repos-')),db=new Store(temp),catalog=new Catalog(db);
 let fail=false;
 const source=new Sources(db,catalog,undefined,undefined,async()=>{if(fail)throw new Error('unavailable');return [{id:'same',name:'같은 이름',version:'1',baseUrl:'https://example.com',sourceCodeUrl:'https://example.com/source.js'}] as any;});
 try{
  await source.refresh('https://one.example/index.json');await source.refresh('https://two.example/index.json');
  assert.equal(source.repositories().length,2);assert.equal(source.list().length,2);assert.notEqual(source.list()[0].id,source.list()[1].id);
  const installed=source.list().find(s=>s.repository.includes('one.example'))!;db.run('UPDATE source_entries SET code=?,installed_entry=entry,enabled=1 WHERE id=?','fixture',installed.id);
  await source.removeRepository('https://one.example/index.json');assert.equal(source.repositories().length,1);assert.equal(source.list().length,2);
  await source.removeRepository('https://two.example/index.json');assert.equal(source.repositories().length,0);assert.equal(source.list().length,1);
  await source.refresh('https://two.example/index.json');fail=true;await assert.rejects(source.refresh('https://two.example/index.json'));assert.equal(source.list().length,2);assert.ok(source.repositories()[0].error);
  const second=new Sources(db,catalog);assert.equal(second.repositories().length,1,'removed repository must not return on restart');await second.close();
  await assert.rejects(source.refresh('file:///secret'),/invalid-repository-url/);
 }finally{await source.close();db.close();await rm(temp,{recursive:true,force:true});}
});


test('language variants keep original metadata and isolate state without changing legacy source identity',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'moa-repo-langs-')),db=new Store(root),repo='https://repo.test/anime_index.json';
 const en={id:'same',name:'Sample Multilingual',lang:'en',version:'1',format:'mangayomi-js',itemType:1,baseUrl:'https://source.test',sourceCodeUrl:'https://repo.test/source.js',iconUrl:'https://repo.test/icon.png',isNsfw:false,hasCloudflare:false};
 let entries:any[]=[en,{...en,lang:'ja'}];
 const legacy=createHash('sha256').update(JSON.stringify([repo,en.id])).digest('hex').slice(0,40);
 const sources=new Sources(db,new Catalog(db),undefined,undefined,async()=>entries);
 db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,preferences,enabled) VALUES(?,?,?,?,?,?,1)',legacy,repo,JSON.stringify(en),JSON.stringify(en),'installed-code','{"token":"preserved"}');
 try{
  const first=await sources.refresh(repo),english=first.find(s=>s.lang==='en')!,japanese=first.find(s=>s.lang==='ja')!;
  assert.equal(first.length,2);assert.equal(english.id,legacy);assert.notEqual(japanese.id,legacy);
  assert.equal(sources.row(legacy).code,'installed-code');assert.equal(JSON.parse(sources.row(legacy).preferences).token,'preserved');
  assert.equal(JSON.parse(sources.row(japanese.id,false).entry).id,'same');assert.equal(sources.row(japanese.id,false).enabled,0);
  assert.match(english.iconUrl!,/^\/api\/images\/source-[a-f0-9]+$/);assert.notEqual(english.iconUrl,japanese.iconUrl);
  const count=()=>db.get('SELECT count(*) AS n FROM source_images')!.n;assert.equal(count(),2);sources.list();sources.list();assert.equal(count(),2);
  assert.equal(db.get('SELECT count(*) AS n FROM source_image_owners')!.n,2);
  entries=entries.slice().reverse().map(e=>({...e,version:'2'}));const refreshed=await sources.refresh(repo);
  assert.equal(refreshed.find(s=>s.lang==='ja')!.id,japanese.id);assert.equal(refreshed.find(s=>s.lang==='en')!.id,legacy);
  entries=[entries[0]];await sources.refresh(repo);assert.equal(sources.list().find(s=>s.lang==='ja')!.id,japanese.id);
 }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('slow search does not block coalesced detail or videos and concurrent preference deltas survive', async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'moa-source-lanes-')),db=new Store(temp),catalog=new Catalog(db);
  let searchStarted!:()=>void; const started=new Promise<void>(r=>{searchStarted=r;});
  let searching=false,detailCalls=0,active=0,maxActive=0;
  const source=new Sources(db,catalog,async input=>{
    maxActive=Math.max(maxActive,++active);
    try {
      if(input.action==='list' && input.params?.query){
        searching=true;searchStarted();await new Promise(r=>setTimeout(r,650));searching=false;
        return {result:{list:[],hasNextPage:false},changes:{searchCache:'search',shared:'last'}};
      }
      if(input.action==='detail'){
        detailCalls++;await new Promise(r=>setTimeout(r,20));
        return {result:{name:'작품',chapters:[{name:'1화',url:'https://site.test/episode/1'}]},changes:{detailCache:'detail',shared:'first'}};
      }
      if(input.action==='videos')return {result:[{url:'https://site.test/video.mp4'}],changes:{videoCache:'video'}};
      if(input.action==='filters')return {result:{browse:{filters:[],availableModes:['search']}},changes:{filterCache:'filters'}};
      return {result:{list:[{name:'작품',link:'/work'}],hasNextPage:false},changes:{seed:'retained'}};
    } finally {active--;}
  });
  const entry=JSON.stringify({id:'x',name:'테스트',format:'mangayomi-js',version:'1',baseUrl:'https://site.test'});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','source','fixture',entry,entry,'fixture');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  try {
    const id=(await source.browse('source','p')).items[0].id;
    const search=source.browse('source','p','search',1,'slow');await started;
    const schema=source.capabilities('source');
    const start=performance.now();await Promise.all([source.detail(id),source.detail(id)]);
    const elapsed=Math.round(performance.now()-start);
    assert.equal(searching,true,'detail finishes while search remains in flight');assert.equal(detailCalls,1);
    const episode=db.get('SELECT id FROM episodes WHERE media_id=?',id)!.id;
    await source.videos(episode);assert.equal(searching,true,'player lane also bypasses search');
    await Promise.all([search,schema]);
    assert.deepEqual(JSON.parse(db.get('SELECT preferences FROM source_entries WHERE id=?','source')!.preferences),{seed:'retained',detailCache:'detail',shared:'last',videoCache:'video',searchCache:'search',filterCache:'filters'});
    assert.equal(maxActive,2);
    await source.detail(id);assert.equal(detailCalls,1,'detail cache remains warm');
    t.diagnostic(`650 ms mock search: detail completed in ${elapsed} ms, rather than waiting for search`);
  } finally {await source.close();db.close();await rm(temp,{recursive:true,force:true});}
});
