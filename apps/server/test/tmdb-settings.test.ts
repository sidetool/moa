import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { Tmdb } from '../src/metadata/tmdb.js';

test('TMDB settings are admin-only, private, persistent, immediately applied and overridden by environment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-tmdb-settings-'));
  const { app, db } = await buildApp({ dataDir:dir, mediaRoot:dir, webDir:path.join(dir,'web'), requireAccount:true }, false, {tmdb:{}});
  const headers = {'x-moa-account':'admin', 'x-moa-role':'admin'};
  const url = '/api/admin/tmdb/config';
  try {
    assert.equal((await app.inject({url})).statusCode,401);
    assert.equal((await app.inject({url, headers:{...headers,'x-moa-role':'member'}})).statusCode,403);
    assert.equal((await app.inject({method:'PATCH',url,headers:{...headers,'x-moa-role':'member'},payload:{clear:true}})).statusCode,403);
    assert.deepEqual((await app.inject({url,headers})).json(),{configured:false,source:'none',credentialType:null,hasSavedCredential:false});
    for (const payload of [{},{clear:false},{token:'short'},{apiKey:'bad'},{token:'test-token-value-long',clear:true}]) {
      assert.equal((await app.inject({method:'PATCH',url,headers,payload})).statusCode,400);
    }
    const saved = await app.inject({method:'PATCH',url,headers,payload:{token:'test-token-value-long'}});
    assert.equal(saved.statusCode,200); assert.equal(saved.headers['cache-control'],'private, no-store');
    assert.deepEqual(saved.json(),{configured:true,source:'database',credentialType:'token',hasSavedCredential:true});
    assert.ok(!saved.body.includes('test-token-value-long'));
    const persisted = new Tmdb(db,()=>{},{fetch:async (_url, options) => {
      assert.equal(new Headers(options?.headers).get('authorization'),'Bearer test-token-value-long');
      return Response.json({results:[]});
    }});
    assert.equal(persisted.enabled,true); await persisted.search('fixture'); persisted.close();
    const overridden = new Tmdb(db,()=>{},{key:'a'.repeat(32)});
    assert.deepEqual(overridden.status(),{configured:true,source:'environment',credentialType:'apiKey',hasSavedCredential:true});
    assert.equal(overridden.configure({clear:true}).configured,true); overridden.close();
    const key = await app.inject({method:'PATCH',url,headers,payload:{apiKey:'b'.repeat(32)}});
    assert.equal(key.json().credentialType,'apiKey');
    const cleared = await app.inject({method:'PATCH',url,headers,payload:{clear:true}});
    assert.equal(cleared.json().configured,false);
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});
