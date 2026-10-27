import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';
import { buildApp } from '../src/app.js';

test('repository operations require a user URL; proxy checks skip an empty registry and preserve live flags', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'public-repositories-'));
  const db = new Store(dir), calls: string[] = [];
  const entry = { id: 'fixture', name: 'Example Source', version: '1', baseUrl: 'https://example.com', lang: 'en', format: 'mangayomi-js' as const, itemType: 1 as const, sourceCodeUrl: 'https://example.com/source.js', isNsfw: false, hasCloudflare: false };
  const sources = new Sources(db, new Catalog(db), undefined, undefined, async url => { calls.push(url); return [entry]; });
  try {
    assert.deepEqual(await sources.testNetwork(''), { ok: false, skipped: true, elapsedMs: 0 });
    await assert.rejects(sources.refresh(undefined as unknown as string), /invalid-repository-url/);
    assert.deepEqual(calls, []);
    const [source] = await sources.refresh('https://example.com/index.json');
    db.run('UPDATE source_entries SET live=1 WHERE id=?', source.id);
    await sources.refresh(source.repository);
    assert.equal(sources.list()[0].live, true);
    assert.equal((await sources.testNetwork('')).ok, true);
    assert.deepEqual(calls, Array(3).fill(source.repository));
  } finally { await sources.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('category paths work for any source and explicit media type takes priority', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'public-categories-')), db = new Store(dir);
  const items = [
    { name: 'A', link: '/animation/1' }, { name: 'B', link: 'https://example.com/movies/2' },
    { name: 'C', link: '/dramas/3' }, { name: 'D', link: '/anime/4', type: 'movie' },
    { name: 'E', link: '/show/5?next=/movies/6' }, { name: 'F', link: '/series/6' },
    { name: 'G', link: '/tv/7' }, { name: 'H', link: '/movie/8' }, { name: 'I', link: '/anime/9' },
  ];
  const sources = new Sources(db, new Catalog(db), async () => ({ changes: {}, result: { list: items, hasNextPage: false } }));
  const entry = JSON.stringify({ id: 'fixture', name: 'Unrelated Source', baseUrl: 'https://example.com' });
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 's', 'fixture', entry, entry, 'fixture');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  try { assert.deepEqual((await sources.browse('s','p')).items.map(i=>i.type), ['anime','movie','series','movie','series','series','series','movie','anime']); }
  finally { await sources.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('refresh HTTP endpoint rejects omitted and empty URL without choosing a repository', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'public-refresh-'));
  const { app, sources } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web') }, false);
  try {
    const profile = (await app.inject({method:'POST',url:'/api/profiles',payload:{name:'Test'}})).json();
    for (const payload of [{}, { url: '' }]) assert.equal((await app.inject({method:'POST',url:'/api/sources/refresh',headers:{'x-moa-profile':profile.id},payload})).statusCode, 400);
    assert.deepEqual(sources.repositories(), []);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
