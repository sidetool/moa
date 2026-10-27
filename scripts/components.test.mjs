import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Updater } from './update.mjs';
import { componentCompose, componentItems } from './release-updater.mjs';
import { atomic, readJson, optionalJson } from './update-files.mjs';
import { BUNDLE_FILES } from './release-bundle.mjs';
const image = 'fixture@sha256:'+'a'.repeat(64);
const template = {
 services: {
  moa: {environment:{MOA_APK_SECRET_FILE:'/run/moa-apk/token',MOA_SOURCE_BROWSER_SECRET_FILE:'/run/moa-source-browser/token'},volumes:[{type:'volume',source:'apk-secret',target:'/run/moa-apk',read_only:true},{type:'volume',source:'browser-secret',target:'/run/moa-source-browser',read_only:true}]},
  'moa-apk':{image,volumes:[{type:'volume',source:'apk-secret',target:'/run/moa-apk'},{type:'volume',source:'apk-data',target:'/data'}]},
  'moa-source-browser':{image,volumes:[{type:'volume',source:'browser-secret',target:'/run/moa-source-browser'}]}
 },volumes:{'apk-secret':{},'apk-data':{},'browser-secret':{}}
};
async function fixture(t, releaseVersion = 'v1.0.0') {
 const cwd=await mkdtemp(path.join(tmpdir(),'moa-components-')),root=path.join(cwd,'.moa-release'),dir=path.join(cwd,'mailbox');
 await mkdir(root); await mkdir(dir);
 const previous={version:releaseVersion,schemaEpoch:1,services:['moa'],compose:path.join(root,'original.json'),runtime:path.join(root,'runtime')};
 const original={services:{moa:{image,environment:{LITERAL:'a$$b'},networks:{default:{aliases:['custom-app']}},volumes:[{type:'volume',source:'data',target:'/data'}]}},networks:{default:{}},volumes:{data:{}}};
 await atomic(previous.compose,original); await atomic(path.join(root,'current.json'),previous);
 await atomic(path.join(root,'installation.json'),{format:1,project:'component-test',platform:'linux/amd64',repository:'fixture/moa'});
 await writeFile(path.join(root,'trusted-key.pem'),generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}));
 const calls=[], feedCalls=[], faults={pull:false,health:false,rollback:false}; let active=previous.compose, live=new Set(['moa']);
 const run=async(cmd,args)=>{
  calls.push([cmd,...args]);
  if(args[0]==='pull'){if(faults.pull)throw Error('pull');return '';}
  if(args[0]==='inspect')return (await readJson(active)).services[args.at(-1)].image;
  if(args.join(' ')==='compose version --short')return '2.30.0';
  if(args.includes('--format')&&args.includes('config'))return JSON.stringify(template);
  const at=args.indexOf('-f'),file=args[at+1], op=args[at+2];
  if(op==='ps')return JSON.stringify([...live].map(Service=>({Service,ID:Service,State:'running',Health:faults.health&&file!==previous.compose?'unhealthy':'healthy'})));
  if(op==='up'){
   if(faults.rollback&&file===previous.compose)throw Error('rollback');
   active=file; for(const n of args.slice(args.indexOf('--wait-timeout')+2))live.add(n);
  }
  if(op==='stop')for(const n of args.slice(args.indexOf('--timeout')+2))live.delete(n);
  return '';
 };
 const host=new Updater({cwd,dir,mode:'release',run});await host.release.init();
 const manager=host.release;
 const manifest={version:previous.version,minimumUpdaterVersion:'1.0.0',minimumComposeVersion:'2.20.0',services:{'moa-apk':{image:'fixture',digest:'sha256:'+'a'.repeat(64),platforms:['linux/amd64']},'moa-source-browser':{image:'fixture',digest:'sha256:'+'a'.repeat(64),platforms:['linux/amd64']}}};
 manager.feed={releases:async channel=>{feedCalls.push(channel);return channel===(releaseVersion.includes('-beta.')?'beta':'stable')?[{tag_name:previous.version}]:[];},manifest:async()=>({manifest,digest:'sealed'}),bundle:async()=>({format:1,files:Object.fromEntries(BUNDLE_FILES.map(n=>[n,'fixture']))})};
 manager.activity=async()=>({busy:false,heartbeat:Date.now(),leaseId:(await optionalJson(path.join(dir,'maintenance.json'),{})).id});
 t.after(async()=>{await manager.releaseLease();await rm(cwd,{recursive:true,force:true});});
 return {host,manager,previous,original,calls,feedCalls,faults,root,dir,live};
}
test('component installation looks up the installed version rather than the selected update channel',async t=>{
 for(const [releaseVersion,channel] of [['v1.0.0','stable'],['v1.1.0-beta.1','beta']]){
  const f=await fixture(t,releaseVersion);
  await f.manager.configure({channel:channel==='stable'?'beta':'stable'});
  await f.host.performComponent({id:'apk',enabled:true});
  assert.equal(f.host.state.componentOperation.state,'complete');
  assert.deepEqual(f.feedCalls,[channel]);assert.equal(f.manager.current.version,releaseVersion);
 }
});
test('install, disable and re-enable preserve data, literal values and the other component',async t=>{
 const f=await fixture(t);
 await f.host.performComponent({id:'apk',enabled:true});
 assert.equal(f.host.state.componentOperation.state,'complete');
 await f.host.performComponent({id:'browser',enabled:true});
 let config=await readJson(f.manager.current.compose);
 assert.equal(config.services.moa.environment.LITERAL,'a$$b');
 assert.deepEqual(config.services['moa-apk'].networks,{default:null});
 const mounts=config.services['moa-apk'].volumes;
 await f.host.performComponent({id:'apk',enabled:false});
 assert.equal(f.host.state.componentOperation.state,'complete');assert.equal(f.live.has('moa-apk'),false);
 config=await readJson(f.manager.current.compose);
 assert.deepEqual(config.services['moa-apk'].volumes,mounts);assert.ok(f.manager.current.services.includes('moa-source-browser'));
 assert.equal(config.services.moa.environment.MOA_APK_URL,'');
 await f.host.performComponent({id:'apk',enabled:true});
 assert.equal(f.host.state.componentOperation.state,'complete');
 assert.deepEqual((await readJson(f.manager.current.compose)).services['moa-apk'].volumes,mounts);
 assert.deepEqual(await readJson(f.previous.compose),f.original);
 assert.ok(f.calls.every(c=>!c.includes('down')&&!c.includes('--volumes')));
 assert.equal(f.host.restartRequested,undefined);
});
test('pull failure does not stop the app; health failure stops the new worker and restores config',async t=>{
 const f=await fixture(t);f.faults.pull=true;
 await f.host.performComponent({id:'apk',enabled:true});assert.equal(f.host.state.componentOperation.state,'failed');
 assert.ok(f.calls.every(c=>!c.includes('stop')));f.faults.pull=false;f.faults.health=true;
 await f.host.performComponent({id:'apk',enabled:true});assert.equal(f.host.state.componentOperation.state,'rolled-back');
 assert.deepEqual(f.manager.current,f.previous);assert.deepEqual([...f.live],['moa']);assert.equal(f.manager.failedVersion,null);
});
test('rollback failure blocks further operations',async t=>{
 const f=await fixture(t);f.faults.health=true;f.faults.rollback=true;
 await f.host.performComponent({id:'browser',enabled:true});assert.equal(f.host.state.state,'recovery-required');
 const before=f.calls.length;await f.host.performComponent({id:'apk',enabled:true});assert.equal(f.calls.length,before);
});
test('external endpoints and unsupported platforms are never replaced',async t=>{
 const f=await fixture(t);const c=structuredClone(f.original);c.services.moa.environment.MOA_APK_URL='http://external.invalid:8797';
 await atomic(f.previous.compose,c);await f.host.performComponent({id:'apk',enabled:true});
 assert.equal(f.host.state.error,'update-component-external');assert.equal(f.calls.length,0);
 f.manager.install.platform='linux/arm64';await f.host.performComponent({id:'browser',enabled:true});assert.equal(f.host.state.error,'update-platform-unsupported');assert.equal(f.calls.length,0);
});
test('recovery after installing a worker stops the added worker and does not suppress releases',async t=>{
 const f=await fixture(t);await f.host.performComponent({id:'apk',enabled:true});
 const journal=await readJson(path.join(f.root,'journal.json'));await atomic(path.join(f.root,'journal.json'),{...journal,phase:'verifying'});
 f.manager.ready=false;await f.manager.init();
 assert.equal(f.host.state.componentOperation.state,'rolled-back');assert.equal(f.manager.failedVersion,null);assert.deepEqual([...f.live],['moa']);
});
test('mismatched shared mounts fail closed and unchanged requests never restart',async t=>{
 const f=await fixture(t);await f.host.performComponent({id:'apk',enabled:false});assert.equal(f.calls.length,0);
 const c=structuredClone(f.original);c.services['moa-apk']=structuredClone(template.services['moa-apk']);
 assert.throws(()=>componentCompose(f.previous,c,template,'apk',true,image),/update-layout-unsupported/);
 assert.equal(componentItems(f.previous,c,'linux/amd64')[0].enabled,false);
});
test('a stopped helper can be disabled without requiring its health check to pass',async t=>{
 const f=await fixture(t);await f.host.performComponent({id:'apk',enabled:true});f.live.delete('moa-apk');
 await f.host.performComponent({id:'apk',enabled:false});assert.equal(f.host.state.componentOperation.state,'complete');
 assert.equal(f.host.state.components.find(c=>c.id==='apk').enabled,false);
});
test('a changed current-release manifest cannot install a runtime',async t=>{
 const f=await fixture(t);f.manager.current.manifestDigest='previously-signed';
 await f.host.performComponent({id:'browser',enabled:true});assert.equal(f.host.state.error,'update-release-mutated');
 assert.ok(f.calls.every(c=>!c.includes('pull')&&!c.includes('stop')));
});
