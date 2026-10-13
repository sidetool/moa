// Explicit, isolated Docker smoke using an already cached Node image. No pulls,
// published ports, production volumes, source fixtures or credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Updater } from './update.mjs';
import { atomic } from './update-files.mjs';
import { BUNDLE_FILES } from './release-bundle.mjs';
import { DEFAULT_POLICY } from './release.mjs';
const exec = promisify(execFile);
if (process.argv[2] !== '--run') throw new Error('Run explicitly with --run; requires cached node:22-bookworm-slim and Docker Compose.');
const cwd = await mkdtemp(path.join(tmpdir(), 'moa-release-docker-'));
const root = path.join(cwd, '.moa-release'), dir = path.join(cwd, 'updater');
const project = `moa-release-test-${process.pid}`;
const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
const run = async (command, args, timeout = 120000) => {
  if (command === 'docker' && args[0] === 'pull') {
    await exec('docker', ['image', 'inspect', args.at(-1)], { timeout: 10000 }); return ''; // cached only
  }
  const shortened = [...args]; const wait = shortened.indexOf('--wait-timeout');
  if (wait !== -1) shortened[wait + 1] = '8';
  return (await exec(command, shortened, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
};
const image = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', 'node:22-bookworm-slim']))[0];
const [imageName, imageDigest] = image.split('@');
const previousCompose = path.join(root, 'initial-compose.json');
const compose = args => run('docker', ['compose', '--project-name', project, '--project-directory', cwd, '-f', previousCompose, ...args]);
let manager;
try {
  await mkdir(root); await mkdir(dir); await mkdir(path.join(cwd, 'data')); await mkdir(path.join(cwd, 'auth'));
  await writeFile(path.join(cwd, 'data', 'retained.txt'), 'synthetic persistent data');
  await writeFile(path.join(cwd, 'auth', 'retained.txt'), 'synthetic authentication data');
  await writeFile(path.join(cwd, 'fixture.mjs'), `
import {createServer} from 'node:http';
import {readFile,writeFile,rename} from 'node:fs/promises';
const dir=process.env.UPDATER;
if(dir) setInterval(async()=>{try {let lease;try{lease=JSON.parse(await readFile(dir+'/maintenance.json','utf8'));}catch{};await writeFile(dir+'/activity.tmp',JSON.stringify({heartbeat:Date.now(),busy:false,leaseId:lease?.expiresAt>Date.now()?lease.id:null}));await rename(dir+'/activity.tmp',dir+'/activity.json');}catch{}},200);
createServer((_req,res)=>{res.statusCode=process.env.MOA_VERSION==='v1.2.0'?503:200;res.end('fixture');}).listen(8795,'0.0.0.0');
`);
  const healthcheck = { test: ['CMD','node','-e', "fetch('http://127.0.0.1:8795/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval:'1s', timeout:'1s', retries:1, start_period:'1s' };
  const service = data => ({ image, command: ['node', '/fixture.mjs'], mem_limit: '128m', cpus: 0.5, pids_limit: 64, environment: { MOA_VERSION:'v1.0.0' }, volumes:[`${path.join(cwd,'fixture.mjs')}:/fixture.mjs:ro`,`${path.join(cwd,data)}:/data`], healthcheck });
  const config = { services: { moa: service('data'), 'moa-auth':service('auth') } };
  config.services.moa.environment.UPDATER='/updater'; config.services.moa.volumes.push(`${dir}:/updater`);
  await atomic(previousCompose,config);
  await compose(['up','-d','--pull','never','--wait','--wait-timeout','8']);
  const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  await writeFile(path.join(root,'trusted-key.pem'),key);
  await atomic(path.join(root,'installation.json'),{format:1,project,platform,repository:'fixture-owner/moa'});
  await atomic(path.join(root,'current.json'),{version:'v1.0.0',schemaEpoch:1,services:['moa','moa-auth'],compose:previousCompose,runtime:path.join(root,'initial-runtime')});
  await atomic(path.join(root,'policy.json'),DEFAULT_POLICY);
  const updater=new Updater({cwd,dir,mode:'release',run}); manager=updater.release; await manager.init();
  // Completed legacy upgrade: image is current, but the old tool left storage absent.
  await atomic(path.join(root,'journal.json'), {phase:'complete',previous:{...manager.current,version:'v0.1.1'},target:manager.current});
  for(let n=0;n<20 && !await manager.activity();n++) await new Promise(resolve=>setTimeout(resolve,200));
  await manager.finishStorageUpgrade();
  assert.equal(updater.state.state,'current',JSON.stringify(updater.state));
  await manager.compose(manager.current.compose,['exec','-T','moa','node','-e',"if(process.env.MOA_DOWNLOAD_ROOT!=='/downloads')process.exit(1);require('node:fs').writeFileSync('/downloads/retained.txt','synthetic saved video')"]);
  const files={}; for(const file of BUNDLE_FILES) files[file]=file==='trusted-key.pem'?key:await readFile(new URL('../'+file,import.meta.url),'utf8');
  let version='v1.1.0';
  manager.feed={async releases(){return[{tag_name:version}];},async manifest(){return{manifest:{version,minimumVersion:'v1.0.0',minimumUpdaterVersion:'1.0.0',minimumComposeVersion:'2.24.0',schemaEpoch:1,rollbackSafe:true,services:Object.fromEntries(['moa','moa-auth'].map(n=>[n,{image:imageName,digest:imageDigest,platforms:[platform]}]))}};},async bundle(){return{format:1,files};}};
  assert.equal((await updater.perform('check')).latest,'v1.1.0');
  let state=await updater.perform('apply'); assert.equal(state.state,'current',JSON.stringify(state));
  assert.equal(state.current,'v1.1.0');
  version='v1.2.0'; await updater.perform('check');
  state=await updater.perform('apply'); assert.equal(state.state,'rolled-back',JSON.stringify(state));
  assert.equal(state.current,'v1.1.0');
  assert.equal(await readFile(path.join(cwd,'data/retained.txt'),'utf8'),'synthetic persistent data');
  assert.equal(await readFile(path.join(cwd,'auth/retained.txt'),'utf8'),'synthetic authentication data');
  assert.equal(await manager.compose(manager.current.compose,['exec','-T','moa','node','-e',"process.stdout.write(require('node:fs').readFileSync('/downloads/retained.txt','utf8'))"]),'synthetic saved video');
  console.log('PASS: legacy storage handoff, isolated Docker upgrade, health failure, rollback, application/auth data preservation, maintenance acknowledgement and backup.');
} finally {
  await manager?.releaseLease();
  await compose(['down','--remove-orphans']).catch(()=>{});
  await run('docker',['volume','rm',`${project}_moa-downloads`]).catch(()=>{});
  await rm(cwd,{recursive:true,force:true});
}
