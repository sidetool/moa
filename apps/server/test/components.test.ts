import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Updates} from '../src/updates.js';
import {buildApp} from '../src/app.js';
test('component requests are admin-only, capability-gated and serialize only a bounded action', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-component-api-'));const before=process.env.MOA_UPDATER_DIR;process.env.MOA_UPDATER_DIR=dir;
 const {app}=await buildApp({dataDir:path.join(dir,'data'),mediaRoot:path.join(dir,'media'),webDir:path.join(dir,'web'),requireAccount:true},false);
 const state={connected:true,state:'current',mode:'release',current:'v1.2.0',heartbeat:Date.now(),componentSupport:true,components:[{id:'apk',enabled:false,installed:false,managed:true,supported:true,reason:null,downloadBytes:null,secret:'must not leak'}]};
 const headers={'x-moa-account':'fixture-admin','x-moa-role':'admin'},url='/api/admin/components/apk';
 try{
  await writeFile(path.join(dir,'status.json'),JSON.stringify(state));
  assert.equal((await app.inject('/api/admin/components')).statusCode,401);
  assert.equal((await app.inject({method:'POST',url,headers:{...headers,'x-moa-role':'member'},payload:{enabled:true}})).statusCode,403);
  const s=(await app.inject({url:'/api/admin/components',headers})).json();assert.equal(s.available,true);assert.equal(s.items[0].secret,undefined);
  for(const payload of [{enabled:1},{enabled:true,image:'arbitrary'},{enabled:true,command:'anything'}])assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/components/unknown',headers,payload:{enabled:true}})).statusCode,400);
  await writeFile(path.join(dir,'status.json'),JSON.stringify({...state,componentSupport:false}));
  assert.equal((await app.inject({method:'POST',url,headers,payload:{enabled:true}})).statusCode,503);
  await writeFile(path.join(dir,'status.json'),JSON.stringify(state));
  const response=await app.inject({method:'POST',url,headers,payload:{enabled:true}});assert.equal(response.statusCode,202,response.body);
  assert.equal(response.json().operation.state,'working');assert.equal(response.json().busy,true);
  const queued=JSON.parse(await readFile(path.join(dir,'request.json'),'utf8'));assert.equal(queued.action,'component');assert.deepEqual(queued.component,{id:'apk',enabled:true});
  assert.equal((await app.inject({method:'POST',url,headers,payload:{enabled:false}})).statusCode,409);
 }finally{await app.close();if(before===undefined)delete process.env.MOA_UPDATER_DIR;else process.env.MOA_UPDATER_DIR=before;await rm(dir,{recursive:true,force:true});}
});
test('component status preserves terminal results, ignores malformed data, and disables stale hosts',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'moa-component-status-'));const client=new Updates(dir);
 try{
  const state={connected:true,state:'current',mode:'release',current:'v1.2.0',heartbeat:Date.now(),componentSupport:true,components:[{id:'evil',enabled:true},{id:'browser',enabled:true,installed:true,managed:true,supported:true,downloadBytes:'secret'}],componentOperation:{id:'browser',enabled:true,state:'complete',error:null,token:'secret'}};
  await writeFile(path.join(dir,'status.json'),JSON.stringify(state));const s=await client.components();assert.equal(s.available,true);assert.equal(s.items.length,1);assert.equal(s.items[0].downloadBytes,null);assert.deepEqual(s.operation,{id:'browser',enabled:true,state:'complete',error:null});
  await writeFile(path.join(dir,'status.json'),JSON.stringify({...state,heartbeat:1}));assert.equal((await client.components()).available,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('component preparation refuses busy work without queuing a host action',async()=>{
 const {default:Fastify}=await import('fastify');const {registerUpdates}=await import('../src/updates.js');const {ApiFailure}=await import('../src/util.js');
 const dir=await mkdtemp(path.join(tmpdir(),'moa-component-busy-')),before=process.env.MOA_UPDATER_DIR;process.env.MOA_UPDATER_DIR=dir;
 const app=Fastify();let called=false;
 app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof ApiFailure?e.statusCode:500).send({error:e.message}));
 registerUpdates(app,{prepare:async()=>{throw Error('must not use aborting update path');},prepareComponent:async()=>{called=true;throw new ApiFailure(409,'update-app-busy');},resume:()=>{}});
 try{
  await writeFile(path.join(dir,'status.json'),JSON.stringify({connected:true,state:'current',mode:'release',heartbeat:Date.now(),componentSupport:true,components:[{id:'apk',enabled:false,installed:false,managed:true,supported:true}]}));
  const r=await app.inject({method:'POST',url:'/api/admin/components/apk',payload:{enabled:true}});assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error,'update-app-busy');assert.equal(called,true);
  await assert.rejects(readFile(path.join(dir,'request.json')),{code:'ENOENT'});
 }finally{await app.close();if(before===undefined)delete process.env.MOA_UPDATER_DIR;else process.env.MOA_UPDATER_DIR=before;await rm(dir,{recursive:true,force:true});}
});
