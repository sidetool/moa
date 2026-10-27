import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_FILES, stageBundle } from './release-bundle.mjs';
import { SERVICES, verifiedManifest, sha256 } from './release.mjs';
const exec=promisify(execFile);
const source=fileURLToPath(new URL('../',import.meta.url));

test('publisher creates only allowlisted public artifacts; signed bundle boots the updater probe',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'moa-release-artifacts-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  for(const file of BUNDLE_FILES.filter(n=>n!=='trusted-key.pem')){
    await mkdir(path.dirname(path.join(cwd,file)),{recursive:true});
    await writeFile(path.join(cwd,file),await readFile(path.join(source,file)));
  }
  await writeFile(path.join(cwd,'not-for-release.txt'),'synthetic excluded data');
  await mkdir(path.join(cwd,'release-digests'));
  for(const name of SERVICES)await writeFile(path.join(cwd,'release-digests',name+'.txt'),`sha256:${'a'.repeat(64)}`);
  await writeFile(path.join(cwd,'deploy/release-policy.json'),JSON.stringify({version:'v1.0.0-beta.1',minimumVersion:'v0.1.0',schemaEpoch:1,rollbackSafe:true}));
  const pair=generateKeyPairSync('ed25519');
  const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
  await writeFile(path.join(cwd,'deploy/release-trust.json'),JSON.stringify({algorithm:'Ed25519',publicKey}));
  const env={...process.env,RELEASE_TAG:'v1.0.0-beta.1',GITHUB_REPOSITORY:'fixture-owner/moa',GITHUB_SHA:'b'.repeat(40),RELEASE_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}),RELEASE_PUBLIC_KEY:publicKey,RELEASE_OUTPUT:path.join(cwd,'output')};
  await exec(process.execPath,[path.join(source,'scripts/publish-release.mjs')],{cwd,env});
  assert.equal(verify(null, await readFile(path.join(cwd,'output/moa-install.tar.gz')), publicKey, await readFile(path.join(cwd,'output/moa-install.tar.gz.sig'))), true);
  const bytes=await readFile(path.join(cwd,'output/release.json'));
  const signature=await readFile(path.join(cwd,'output/release.json.sig'));
  const manifest=verifiedManifest(bytes,signature,publicKey,'fixture-owner/moa');
  const bundleBytes=await readFile(path.join(cwd,'output/moa-release.json'));
  assert.equal(sha256(bundleBytes),manifest.bundle.sha256);
  const bundle=JSON.parse(bundleBytes);
  assert.deepEqual(Object.keys(bundle.files).sort(),[...BUNDLE_FILES].sort());
  assert.equal(bundle.files['not-for-release.txt'],undefined);
  assert.ok(!bundle.files['compose.source-browser.yaml'].includes('source-browser-local'));
  assert.deepEqual(manifest.services['moa-source-browser'].platforms,['linux/amd64']);
  const stage=path.join(cwd,'stage');await stageBundle(bundle,stage);
  const probe=JSON.parse((await exec(process.execPath,[path.join(stage,'scripts/update.mjs'),'probe'])).stdout);
  assert.equal(probe.protocol,1);assert.equal(probe.version,'1.0.0');
  await stageBundle(bundle,stage);
  await assert.rejects(stageBundle({...bundle,files:{...bundle.files,'../outside':'blocked'}},stage),/update-bundle-invalid/);
  await assert.rejects(stageBundle({...bundle,files:{...bundle.files,'scripts/update.mjs':'different'}},stage),/update-release-mutated/);
});
