// Opt-in, isolated lifecycle smoke. Cached Node image and synthetic helpers only.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {Updater} from './update.mjs';
import {atomic,readJson} from './update-files.mjs';
import {BUNDLE_FILES} from './release-bundle.mjs';
if(process.argv[2]!=='--run')throw Error('Explicit --run required, with cached node:22-bookworm-slim.');
const exec=promisify(execFile),cwd=await mkdtemp(path.join(tmpdir(),'moa-component-docker-')),root=path.join(cwd,'.moa-release'),dir=path.join(cwd,'mailbox'),project='moa-component-test-'+process.pid;
const run=async(cmd,args,timeout=120000)=>{
 if(cmd==='docker'&&args[0]==='pull'){await exec('docker',['image','inspect',args.at(-1)]);return '';}
 const argv=[...args],i=argv.indexOf('--wait-timeout');if(i!==-1)argv[i+1]='10';
 try { return (await exec(cmd,argv,{cwd,timeout,maxBuffer:4*1024*1024})).stdout.trim(); } catch(error) { console.error(error.stderr || error.message); throw error; }
};
const image=JSON.parse(await run('docker',['image','inspect','--format','{{json .RepoDigests}}','node:22-bookworm-slim']))[0];
const [imageName,digest]=image.split('@');let manager,config;
const initial=path.join(root,'initial.json');
const compose=(file,args)=>run('docker',['compose','--project-name',project,'-f',file,...args]);
try{
 await mkdir(root);await mkdir(dir);await mkdir(path.join(cwd,'data'));
 await writeFile(path.join(cwd,'data/retained.txt'),'preserved');
 const code=`process.on('SIGTERM',()=>process.exit(0));const fs=require('node:fs'); const http=require('node:http'); const env=process.env;
 if(env.ROLE==='helper'){fs.mkdirSync(env.SECRET_DIR,{recursive:true});fs.writeFileSync(env.SECRET_DIR+'/token','synthetic-token');}
 if(env.UPDATER)setInterval(()=>{try{let lease;try{lease=JSON.parse(fs.readFileSync(env.UPDATER+'/maintenance.json'));}catch{};fs.writeFileSync(env.UPDATER+'/activity.tmp',JSON.stringify({heartbeat:Date.now(),busy:false,leaseId:lease?.expiresAt>Date.now()?lease.id:null}));fs.renameSync(env.UPDATER+'/activity.tmp',env.UPDATER+'/activity.json');}catch{}},200);
 http.createServer((req,res)=>{let ok=env.FAIL!=='1';for(const k of ['MOA_APK_SECRET_FILE','MOA_SOURCE_BROWSER_SECRET_FILE'])if(env[k]){try{ok=ok&&fs.readFileSync(env[k],'utf8')==='synthetic-token';}catch{ok=false;}}res.statusCode=ok?200:503;res.end('fixture');}).listen(8795,'0.0.0.0');`;
 const healthcheck={test:['CMD','node','-e',"fetch('http://127.0.0.1:8795/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'1s',timeout:'1s',retries:1,start_period:'1s'};
 const service=environment=>({image,command:['node','-e',code],environment,healthcheck,mem_limit:'128m',pids_limit:64});
 config={services:{moa:{...service({UPDATER:'/updater'}),volumes:[{type:'bind',source:dir,target:'/updater'},{type:'bind',source:path.join(cwd,'data'),target:'/data'}]}},volumes:{},networks:{default:{}}};
 await atomic(initial,config);await compose(initial,['up','-d','--pull','never','--wait','--wait-timeout','10']);
 await atomic(path.join(root,'current.json'),{version:'v1.0.0',schemaEpoch:1,services:['moa'],compose:initial,runtime:path.join(root,'runtime')});
 await atomic(path.join(root,'installation.json'),{format:1,project,platform:'linux/amd64',repository:'fixture/moa'});
 const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});await writeFile(path.join(root,'trusted-key.pem'),key);
 const updater=new Updater({cwd,dir,mode:'release',run});manager=updater.release;await manager.init();
 const change=manager.changeComponent.bind(manager);manager.changeComponent=async value=>{try{return await change(value);}catch(error){console.error(error);throw error;}};
 const app={image,environment:{},volumes:[]},services={moa:app},volumes={};
 for(const [id,name,mount] of [['apk','moa-apk','/run/moa-apk'],['browser','moa-source-browser','/run/moa-source-browser']]){
  const secret=id+'-secret';volumes[secret]={};app.volumes.push({type:'volume',source:secret,target:mount,read_only:true});
  services[name]={...service({ROLE:'helper',SECRET_DIR:mount,...(id==='browser'?{FAIL:'1'}:{})}),volumes:[{type:'volume',source:secret,target:mount}]};
 }
 const files={};for(const f of BUNDLE_FILES)files[f]=f==='compose.yaml'?JSON.stringify({services,volumes}):f==='compose.source-browser.yaml'?'services: {}':f==='trusted-key.pem'?key:await readFile(new URL('../'+f,import.meta.url),'utf8');
 manager.feed={releases:async()=>[{tag_name:'v1.0.0'}],manifest:async()=>({digest:'fixture-seal',manifest:{version:'v1.0.0',minimumUpdaterVersion:'1.0.0',minimumComposeVersion:'2.20.0',services:Object.fromEntries(['moa-apk','moa-source-browser'].map(name=>[name,{image:imageName,digest,platforms:['linux/amd64']}]))}}),bundle:async()=>({format:1,files})};
 for(const enabled of [true,false,true]){
  await updater.performComponent({id:'apk',enabled});assert.equal(updater.state.componentOperation.state,'complete',JSON.stringify(updater.state));
  const current=await readJson(manager.current.compose);assert.equal(Boolean(current.services.moa.environment.MOA_APK_URL),enabled);
 }
 await updater.performComponent({id:'browser',enabled:true});assert.equal(updater.state.componentOperation.state,'rolled-back',JSON.stringify(updater.state));
 assert.equal(updater.state.components.find(c=>c.id==='apk').enabled,true);assert.equal(updater.state.components.find(c=>c.id==='browser').enabled,false);
 assert.equal(await readFile(path.join(cwd,'data/retained.txt'),'utf8'),'preserved');
 console.log('PASS: Docker install → disable → re-enable; helper token mount; failed helper rollback; app data retained.');
}finally{
 await manager?.releaseLease();
 // Delete only this test project's containers/networks/volumes, including rollback orphans.
 await compose(manager?.current.compose||initial,['down','--remove-orphans','--volumes']).catch(()=>{});
 const orphanVolumes=(await run('docker',['volume','ls','-q','--filter','label=com.docker.compose.project='+project]).catch(()=>'')).split('\n').filter(Boolean);
 if(orphanVolumes.length)await run('docker',['volume','rm',...orphanVolumes]).catch(()=>{});
 await rm(cwd,{recursive:true,force:true});
}
