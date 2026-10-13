import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ByeDpi } from '../src/byedpi.js';
import { Sources } from '../src/sources.js';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog.js';

test('helper starts on demand, coalesces startup, stops, and handles an invalid executable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moa-byedpi-'));
  const reservation = createServer(); await new Promise<void>(r => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as any).port; await new Promise<void>(r => reservation.close(() => r()));
  const binary = join(dir, 'helper');
  await writeFile(binary, `#!${process.execPath}\nrequire('node:net').createServer(s=>s.on('data',()=>s.end(Buffer.from([5,0])))).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');\n`, { mode: 0o700 });
  const helper = new ByeDpi(binary, '127.0.0.1', port);
  t.after(async () => { await helper.stop(); await rm(dir, {recursive:true,force:true}); });
  assert.equal(helper.running, false); assert.equal(helper.available, true);
  await Promise.all([helper.start(), helper.start()]); assert.equal(helper.running, true);
  await helper.stop(); assert.equal(helper.running, false);
  await helper.start(); await helper.stop();
  const invalid = join(dir, 'invalid'); await writeFile(invalid, '#!/missing-interpreter\n', {mode:0o700});
  const broken = new ByeDpi(invalid, '127.0.0.1', port);
  await assert.rejects(broken.start(), /byedpi-start-failed/); await broken.stop();
  const cancelled = helper.start(); await helper.stop(); await assert.rejects(cancelled); assert.equal(helper.running,false);
});

test('enabling retains manual and source overrides; restart and failures never silently connect directly', async t => {
  const dir=await mkdtemp(join(tmpdir(),'moa-network-mode-')), db=new Store(dir);
  class Helper extends ByeDpi {
    up=false; fail=false;
    override get available(){return true;}
    override get running(){return this.up;}
    override async start(){if(this.fail)throw new Error('byedpi-start-failed');this.up=true;}
    override async stop(){this.up=false;}
  }
  const helper=new Helper('', '127.0.0.1',1080,'socks5://moa:1080');
  const sources=new Sources(db,new Catalog(db),undefined,undefined,undefined,undefined,undefined,helper);
  t.after(async()=>{await sources.close();db.close();await rm(dir,{recursive:true,force:true});});
  const entry=JSON.stringify({format:'mangayomi-js',id:'test',name:'Test',baseUrl:'https://example.com'});
  db.run('INSERT INTO source_entries(id,repository,entry) VALUES(?,?,?)','own','https://example.com/index.json',entry);
  db.run('INSERT INTO source_network VALUES(?,?,0)','own','socks5://own.example.com:1080');
  const manual='socks5://manual.example.com:1080';
  assert.equal(sources.network().byedpi.enabled,false);
  await sources.configureNetwork(manual,0,true);
  assert.equal(sources.proxy(),helper.proxy); assert.equal(sources.network().defaultProxy,manual);
  assert.equal(sources.proxy('own'),'socks5://own.example.com:1080');
  await helper.stop(); assert.equal(sources.proxy(),helper.proxy);
  await sources.startNetwork(); assert.equal(helper.running,true);
  await assert.rejects(sources.configureNetwork('',0,false),/network-settings-conflict/);
  assert.equal(helper.running,true);
  await sources.configureNetwork(manual,1,false); assert.equal(helper.running,false);assert.equal(sources.proxy(),manual);
  helper.fail=true;await assert.rejects(sources.configureNetwork(manual,2,true),/byedpi-start-failed/);
  assert.equal(sources.network().revision,2);assert.equal(sources.network().byedpi.enabled,false);assert.equal(sources.proxy(),manual);
});
