import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { install, startUpdater } from './install-release.mjs';
import { BUNDLE_FILES } from './release-bundle.mjs';
import { SERVICES } from './release.mjs';

for (const [releaseVersion, channel] of [['v1.0.0', 'stable'], ['v1.1.0-beta.1', 'beta']]) for (const apk of [false, true]) test(`fresh ${channel} release installation pins components and selects APK=${apk}`, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'moa-installer-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const key = path.join(cwd, 'fixture-key'); await writeFile(key, 'fixture');
  await writeFile(path.join(cwd, '.env'), 'PUBLIC_HOST=custom.example\n');
  const commands = [];
  const manifest = { version: releaseVersion, schemaEpoch: 1, minimumUpdaterVersion: '1.0.0', minimumComposeVersion: '2.24.0', services: Object.fromEntries(SERVICES.map(n => [n,{image:`ghcr.io/sidetool/${n}`,digest:`sha256:${'a'.repeat(64)}`,platforms:['linux/amd64','linux/arm64']}])) };
  const files = Object.fromEntries(BUNDLE_FILES.map(n => [n, n === '.env.example' ? 'PUBLIC_HOST=default\n' : 'synthetic public fixture\n']));
  const config = { name: 'moa-fixture', services: { moa: { image:'old',environment:{LITERAL:'cost$$5'},volumes:[{type:'volume',source:'synthetic-data',target:'/data'}] }, 'moa-auth':{ image:'old',volumes:[{type:'volume',source:'synthetic-auth',target:'/data'}]}, 'moa-gateway':{image:'nginx:fixture',volumes:[{type:'bind',source:'/incorrect/base/path',target:'/etc/nginx/templates/default.conf.template'}]}, 'moa-updater':{image:'updater:container'} } };
  const run = async (command,args) => {
    commands.push([command,...args]);
    if(args[0]==='ps')return '';
    if(args.join(' ')==='compose version --short')return '2.30.0';
    if(args.includes('--format')){
      assert.equal(args.includes('--profile'),apk);
      if(apk)config.services['moa-apk']={image:'old',profiles:['apk']};
      return JSON.stringify(config);
    }
    return '';
  };
  const feed = { async releases(requested){assert.equal(requested,channel);return[{tag_name:releaseVersion}];},async manifest(){return{manifest};},async bundle(){return{format:1,files};} };
  assert.deepEqual(await install(['install','--cwd',cwd,'--project','moa-fixture','--version',releaseVersion,'--key',key,'--apk',String(apk)],{feed,run}), { started: true, error: null });
  const current=JSON.parse(await readFile(path.join(cwd,'.moa-release/current.json'),'utf8'));
  assert.equal(current.version,releaseVersion);
  const resolved=JSON.parse(await readFile(current.compose,'utf8'));
  assert.deepEqual(current.services,apk?['moa','moa-auth','moa-apk']:['moa','moa-auth']);
  if(apk){assert.equal(resolved.services['moa-apk'].profiles,undefined);assert.equal(resolved.services.moa.environment.MOA_APK_URL,'http://moa-apk:8797');}
  else assert.ok(commands.filter(c=>c.includes('pull')).every(c=>!c.some(v=>v.includes('moa-apk'))));
  assert.equal(resolved.services['moa-updater'], undefined);
  assert.equal(resolved.services.moa.environment.LITERAL,'cost$$5');
  assert.equal(resolved.services.moa.environment.MOA_DEPLOYMENT,'release');
  assert.match(resolved.services.moa.image,/@sha256:/);
  assert.equal(resolved.services['moa-gateway'].volumes[0].source,path.join(current.runtime,'deploy/gateway/default.conf.template'));
  assert.equal(await readFile(path.join(cwd,'.env'),'utf8'),'PUBLIC_HOST=custom.example\n');
  assert.match(await readFile(path.join(cwd,'moa-updater.service'),'utf8'),/UMask=0007/);
  assert.ok(commands.some(c=>c.includes('pull')&&c.includes('nginx:fixture')));
  assert.ok(commands.every(c=>!c.includes('build')&&!c.includes('down')));
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'.moa-release/policy.json'),'utf8')),{channel:'stable'});
  await assert.rejects(install(['install','--cwd',cwd,'--version',releaseVersion,'--key',key],{feed,run}),/update-already-installed/);
});

test('migration commands are not supported', async () => {
  for (const command of ['preview', 'adopt']) await assert.rejects(install([command]), /update-invalid-options/);
});

// Compose config has already escaped literal dollars for round-tripping.
test('real Compose JSON preserves nginx variables through installation serialization', async () => {
  const { execFileSync } = await import('node:child_process');
  const input=JSON.stringify({services:{gateway:{image:'nginx:alpine',environment:{IP:'$$remote_addr',FILTER:'^PUBLIC$$'}}}});
  const args=['compose','--project-name','moa-config-fixture','-f','-','config','--format','json'];
  const first=execFileSync('docker',args,{input,encoding:'utf8'});
  const second=execFileSync('docker',args,{input:first,encoding:'utf8'});
  assert.deepEqual(JSON.parse(second).services.gateway.environment,JSON.parse(first).services.gateway.environment);
  assert.equal(JSON.parse(first).services.gateway.environment.IP,'$$remote_addr');
});


test('updater startup verifies activity, preserves other services and reports unavailable managers', async () => {
  const unit = '/fixture/moa-updater.service';
  const commands = [];
  assert.deepEqual(await startUpdater(unit, async (command, args) => { commands.push([command, ...args]); return ''; }), { started: true, error: null });
  assert.deepEqual(commands, [
    ['systemctl', '--user', 'show', 'moa-updater.service', '--property=FragmentPath', '--value'],
    ['systemctl', '--user', 'enable', '--now', unit],
    ['systemctl', '--user', 'is-active', '--quiet', 'moa-updater.service']
  ]);
  const conflict = [];
  assert.deepEqual(await startUpdater(unit, async (...args) => { conflict.push(args); return '/another/moa-updater.service'; }), { started: false, error: 'update-service-conflict' });
  assert.equal(conflict.length, 1);
  assert.deepEqual(await startUpdater(unit, async () => { throw new Error('no manager'); }), { started: false, error: 'updater-unavailable' });
  assert.deepEqual(await startUpdater(unit, async (_command, args) => { if (args.includes('is-active')) throw new Error('inactive'); return ''; }), { started: false, error: 'updater-unavailable' });
});
