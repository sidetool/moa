import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const config=(...files)=>JSON.parse(execFileSync('docker',['compose','--project-name','moa-defaults-check',...files.flatMap(f=>['-f',f]),'config','--format','json'],{encoding:'utf8',env:{...process.env,MOA_VERSION:'v0.1.2-beta.4',MOA_SHORTS_EXTRACTOR:'/usr/local/bin/yt-dlp'}}));
test('default Compose omits heavy runtimes, includes dormant tools, and keeps them off host ports',()=>{
  const c=config('compose.yaml');
  assert.equal(c.services['moa-apk'],undefined);assert.equal(c.services['moa-source-browser'],undefined);
  assert.equal(c.services.moa.environment.MOA_APK_URL,'');
  assert.equal(c.services.moa.environment.MOA_SHORTS_EXTRACTOR,'/usr/local/bin/yt-dlp');
  assert.equal(c.services.moa.environment.MOA_BYEDPI_PROXY,'socks5://moa:1080');
  assert.equal(c.services.moa.ports,undefined);
  assert.ok(c.services.moa.volumes.some(v=>v.target==='/downloads'));
});
test('optional APK, browser and legacy token overlays retain their connections',()=>{
  const c=config('compose.yaml','compose.apk.yaml','compose.source-browser.yaml');
  assert.ok(c.services['moa-apk']);assert.ok(c.services['moa-source-browser']);
  assert.equal(c.services.moa.environment.MOA_APK_URL,'http://moa-apk:8797');
  assert.equal(c.services.moa.depends_on['moa-apk'].condition,'service_healthy');
  assert.equal(c.services['moa-source-browser'].image,'ghcr.io/sidetool/moa-source-browser:v0.1.2-beta.4');
  const legacy=config('compose.yaml','compose.aniyomi.yaml');
  assert.equal(legacy.services.moa.environment.MOA_APK_SECRET_FILE,'/run/secrets/apk-token');
  assert.equal(legacy.services['moa-apk'].environment.MOA_APK_GENERATE_SECRET,'0');
  const disabled=config('compose.yaml','compose.no-apk.yaml');assert.equal(disabled.services['moa-apk'],undefined);
});
