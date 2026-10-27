import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApkBridge, APK_RELAY, apkIconUrl, type ApkEntry } from '../src/sources/apk-bridge.js';
import { Sources } from '../src/sources/service.js';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { RemotePlayback } from '../src/playback/remote.js';
const repo='https://repo.test/index.json', packageId='a'.repeat(64), lease='b'.repeat(32);
const entry=(id:string,name:string):ApkEntry=>({id,name,lang:'ko',version:'14.1',baseUrl:'https://source.test',format:'aniyomi-apk',package:{pkg:'test.factory',code:1,version:'14.1',apkUrl:'https://repo.test/apk/a.apk'}});
class Fixture extends ApkBridge {
  entries=[entry('1','애니 A'),entry('2','영화 B')]; calls:any[]=[]; releases:string[]=[]; badRegistry=false; failRemove=false; inventory=false;
  override async registry(){if(this.badRegistry)throw Error('fetch failed');return this.entries;}
  override async install(){this.inventory=true;return {id:packageId,digest:'a'.repeat(64),metadata:{version:'14.1'},sources:this.entries.map(e=>({...e,id:String(Number(e.id)+100),supportsLatest:true}))};}
  override async rpc<T=any>(method:string,params:any={}):Promise<T>{
    this.calls.push({method,...params}); const p=params.params;
    let result:any;
    if(method==='remove'){if(this.failRemove)throw Error('apk_worker_unavailable');this.inventory=false;result={removed:true};}
    else if(method==='preferences-save')result={saved:true};
    else if(method==='filters')result=[{id:'0:',position:0,label:'제작사별',kind:'select',options:['전체','제작사 A'],defaultValue:0}];
    else if(method==='list')result={items:[{url:'__fixture_guide__/provider',title:'방송 안내'},{url:'/work',title:'작품',genre:'드라마, 모험'}],hasNextPage:false};
    else if(method==='detail')result={url:'/work',title:'작품'};
    else if(method==='episodes')result=p.sourceId==='102'?[{url:'/trailer',title:'예고편',number:2},{url:'/feature',title:'본편',number:1}]:[{url:'/episode',title:'Finale',number:13}];
    else if(method==='extract')result={videos:[{url:`${APK_RELAY}/${lease}/assets/${'c'.repeat(32)}`,quality:'1080p',subtitles:[{url:'https://cdn.test/a.vtt',label:'한국어'}]}],lease};
    else if(method==='preferences')result={fields:[{group:'101',key:'["101","lang"]',title:'언어',kind:'text',value:'ko',secret:false},{group:'102',key:'["102","lang"]',title:'언어',kind:'text',value:'en',secret:false}]};
    else throw Error('unexpected method '+method);
    return result as T;
  }
  override release(id?:string){if(id)this.releases.push(id);}
}
test('APK factory identity, original filters, episode numbers, preferences and playback leases integrate with MOA',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moa-apk-test-')),db=new Store(root),catalog=new Catalog(db),apk=new Fixture();
  const sources=new Sources(db,catalog,undefined,undefined,undefined,apk),remote=new RemotePlayback(db,catalog,sources);
  try{
    db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
    const list=await sources.refresh(repo,'aniyomi-apk');assert.equal(list.length,2);assert.equal(list[0].kind,'aniyomi-apk');
    const a=list.find(s=>s.name==='애니 A')!,b=list.find(s=>s.name==='영화 B')!;
    assert.match(a.iconUrl!,/^\/api\/images\/source-/);assert.notEqual(a.iconUrl,b.iconUrl);
    assert.equal(db.get('SELECT url FROM source_images')!.url,'https://repo.test/icon/test.factory.png');
    await sources.install(a.id);await sources.install(b.id);
    assert.equal(sources.row(a.id).code,'@aniyomi-apk');assert.equal(sources.row(b.id).type,'movie');
    assert.equal(JSON.parse(sources.row(a.id).installed_entry).id,'101');
    assert.equal(sources.repositories()[0].kind,'aniyomi-apk');
    await assert.rejects(sources.refresh(repo,'mangayomi-js'),/kind-conflict/);
    const schema=await sources.capabilities(a.id);assert.equal(schema.filters[0].label,'제작사별');
    const page=await sources.browse(a.id,'p','popular',1,'',{revision:schema.revision,filters:[{position:0,value:1}]});
    assert.deepEqual(apk.calls.find(c=>c.method==='list').params.filters,[{position:0,value:1}]);
    assert.equal(page.items.length,1);assert.equal(page.items[0].provider.kind,'aniyomi-apk');
    await sources.detail(page.items[0].id);const detail=catalog.detail(page.items[0].id,'p');const ep=detail.seasons[0].episodes[0];assert.equal(ep.number,13);
    const movie=await sources.browse(b.id,'p');await sources.detail(movie.items[0].id);assert.equal(catalog.detail(movie.items[0].id,'p').seasons[0].episodes[0].title,'본편');
    const fields=await sources.preferences(a.id);assert.equal(fields.length,2);assert.equal(fields[0].value,'ko');
    await assert.rejects(sources.preferences(a.id,{'["102","lang"]':'ko'}),/invalid-source-preference/);
    await sources.preferences(a.id,{'["101","lang"]':'en'});
    const session=await remote.create('p',ep.id);assert.equal(remote.get(session.sessionId).apkLease,lease);assert.ok(!session.url.includes(APK_RELAY));
    remote.remove(session.sessionId);assert.deepEqual(apk.releases,[lease]);
    await assert.rejects(remote.create('p',ep.id,0,'99'),/invalid-stream/);assert.equal(apk.releases.length,2);
    await sources.remove([a.id]);assert.equal(sources.list().find(s=>s.id===a.id)?.installed,false);assert.equal(sources.row(b.id).enabled,1);
  }finally{remote.close();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('failed APK repository retains its format; reserved relay URLs cannot use another session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moa-apk-repo-')),db=new Store(root),apk=new Fixture(),sources=new Sources(db,new Catalog(db),undefined,undefined,undefined,apk);
  try{
    apk.badRegistry=true;await assert.rejects(sources.refresh(repo,'aniyomi-apk'));
    assert.equal(sources.repositories()[0].kind,'aniyomi-apk');apk.badRegistry=false;assert.equal((await sources.refresh(repo)).length,2);
    await assert.rejects(apk.stream(`${APK_RELAY}/${lease}/assets/${'c'.repeat(32)}`,'x'.repeat(32),undefined,new AbortController().signal),/forbidden/);
    await assert.rejects(apk.call(packageId,entry('1','A'),'list',{},'https://proxy.test',new AbortController().signal),/proxy-unsupported/);
    assert.equal(apk.calls.length,0);
  }finally{await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('APK icons use repository package artwork and reject executable URLs',()=>{
 assert.equal(apkIconUrl('https://raw.githubusercontent.com/owner/repo/branch/index.min.json','eu.example.app'),'https://raw.githubusercontent.com/owner/repo/branch/icon/eu.example.app.png');
 assert.equal(apkIconUrl(repo,'eu.example.app','icon/custom.png'),'https://repo.test/icon/custom.png');
 assert.equal(apkIconUrl(repo,'eu.example.app','javascript:alert(1)'),undefined);
});


test('APK removal retains disabled installed siblings; last removal deletes worker package and permits reinstall',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moa-apk-remove-')),db=new Store(root),apk=new Fixture(),sources=new Sources(db,new Catalog(db),undefined,undefined,undefined,apk);
  try {
    const entries=await sources.refresh(repo,'aniyomi-apk'),a=entries[0].id,b=entries[1].id;
    await sources.install(a);await sources.install(b);sources.configure(b,{enabled:false});
    await sources.remove([a]);assert.equal(apk.calls.filter(c=>c.method==='remove').length,0);assert.equal(apk.inventory,true);
    await sources.remove([b]);assert.equal(apk.calls.filter(c=>c.method==='remove').length,1);assert.equal(apk.calls.at(-1).packageId,packageId);assert.equal(apk.inventory,false);
    assert.equal(db.get('SELECT count(*) AS n FROM source_apk')!.n,0);
    await sources.install(a);assert.equal(apk.inventory,true);assert.equal(sources.row(a).code,'@aniyomi-apk');
  } finally {await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('failed worker removal is persisted for retry, and reinstall cancels obsolete cleanup',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moa-apk-remove-retry-')),db=new Store(root),apk=new Fixture(),sources=new Sources(db,new Catalog(db),undefined,undefined,undefined,apk);
  try {
    const a=(await sources.refresh(repo,'aniyomi-apk'))[0].id;await sources.install(a);
    apk.failRemove=true;await sources.remove([a]);
    assert.equal(sources.row(a,false).code,null);assert.equal(db.get('SELECT count(*) AS n FROM source_apk_removals')!.n,1);
    apk.failRemove=false;await sources.remove([a]);assert.equal(apk.inventory,false);assert.equal(db.get('SELECT count(*) AS n FROM source_apk_removals')!.n,0);
    await sources.install(a);apk.failRemove=true;await sources.remove([a]);
    await sources.install(a);assert.equal(apk.inventory,true);assert.equal(db.get('SELECT count(*) AS n FROM source_apk_removals')!.n,0);
  } finally {await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('removal rechecks references after a concurrent sibling install completes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moa-apk-remove-race-')),db=new Store(root),apk=new Fixture(),sources=new Sources(db,new Catalog(db),undefined,undefined,undefined,apk);
  let release!:()=>void,started!:()=>void,removed!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),installStarted=new Promise<void>(r=>{started=r;}),localRemoved=new Promise<void>(r=>{removed=r;});
  try {
    const entries=await sources.refresh(repo,'aniyomi-apk'),a=entries[0].id,b=entries[1].id;await sources.install(a);
    const install=apk.install.bind(apk);apk.install=async()=>{started();await gate;return install();};
    const installing=sources.install(b);await installStarted;
    const removing=sources.remove([a],async()=>{removed();});await localRemoved;
    release();await Promise.all([installing,removing]);
    assert.equal(apk.calls.filter(c=>c.method==='remove').length,0);
    assert.equal(sources.row(b).code,'@aniyomi-apk');assert.equal(apk.inventory,true);
  } finally {release();await sources.close();db.close();await rm(root,{recursive:true,force:true});}
});
