import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('plugin details reuse TMDB data, coalesce requests and never expose credentials or unrestricted endpoints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-metadata-'));
  const calls: string[] = [];
  let finish: (() => void) | undefined, block = false;
  const server = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false, { tmdb: {
    token: 'synthetic-credential',
    fetch: async input => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.equal(url.origin, 'https://api.themoviedb.org');
      assert.match(url.pathname, /^\/3\/movie\/[23]$/);
      if (block) await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ id: Number(url.pathname.split('/').at(-1)), title: '새 작품', original_title: 'Original', overview: '소개', adult: false, release_date: '2026-01-02', runtime: 100, vote_average: 7.5, vote_count: 100, genres: [{ id: 18, name: 'Drama' }], poster_path: '/poster.jpg', credits: { cast: [] } });
    },
  } });
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
  const plugin = { apiVersion: 2, id: 'metadata-test', name: 'Metadata', version: '1.0.0', description: 'test', placements: ['detail'], permissions: ['metadata.read'], connect: [], script: 'void 0;' };
  const install = async (permissions = plugin.permissions) => {
    const result = await server.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...plugin, permissions } });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().revision;
  };
  try {
    const profile = (await server.app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Owner' } })).json();
    const headers = { ...admin, 'x-moa-profile': profile.id };
    let revision = await install();
    server.db.run("INSERT INTO media VALUES('m',NULL,'작품','movie','{}','2026')");
    server.db.run("INSERT INTO tmdb_links VALUES('m','movie',1,NULL,'manual',100,0)");
    server.db.run("INSERT INTO tmdb_titles VALUES('movie',1,?,'{}',?)", JSON.stringify({ title: '캐시 작품', overview: '소개', genres: ['드라마', 123], rating: 8, poster: 'https://image.tmdb.org/t/p/w500/image.jpg', backdrop: 'https://evil.invalid/image.jpg', apiKey: 'synthetic-credential' }), Date.now());
    const call = (extra: object = {}, auth = headers) => server.app.inject({ method: 'POST', url: '/api/plugin-runtime/metadata-test/metadata/details', headers: auth, payload: { revision, mediaId: 'm', ...extra } });
    let response = await call();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().details, { title: '캐시 작품', overview: '소개', genres: ['드라마'], rating: 8, poster: 'https://image.tmdb.org/t/p/w500/image.jpg' });
    assert.equal(response.json().title.mediaId, 'm');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.ok(!response.body.includes('synthetic-credential'));
    assert.equal(calls.length, 0);
    assert.equal((await call({ url: 'https://evil.invalid' })).statusCode, 400);
    assert.equal((await call({ revision: '0'.repeat(32) })).statusCode, 409);
    assert.equal((await call({}, admin as any)).statusCode, 401);
    assert.equal((await call({}, { ...headers, 'x-moa-account': 'other', 'x-moa-role': 'member' })).statusCode, 401);
    revision = await install([]);
    assert.equal((await call()).statusCode, 403);
    revision = await install();
    server.db.run("UPDATE tmdb_links SET tmdb_id=2 WHERE media_id='m'");
    const responses = await Promise.all([call(), call()]);
    assert.equal(calls.length, 1);
    assert.deepEqual(responses[0].json(), responses[1].json());
    assert.equal(responses[0].json().details.runtime, 100);
    assert.equal(responses[0].json().details.rating, 7.5);
    server.db.run('UPDATE profiles SET kids=1 WHERE id=?', profile.id);
    response = await call();
    assert.equal(response.json().status, 'restricted');
    assert.equal(response.json().details, null);
    assert.equal(calls.length, 1);
    server.db.run('UPDATE profiles SET kids=0 WHERE id=?', profile.id);
    server.db.run("UPDATE tmdb_links SET status='off' WHERE media_id='m'");
    assert.equal((await call()).json().status, 'unlinked');
    server.db.run("UPDATE tmdb_links SET status='manual',tmdb_id=3 WHERE media_id='m'");
    block = true;
    const pending = Promise.resolve(call());
    for (let i = 0; !finish && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(finish);
    await server.app.inject({ method: 'PATCH', url: '/api/admin/plugins/metadata-test', headers: admin, payload: { enabled: false } });
    finish!();
    assert.equal((await pending).statusCode, 404);
  } finally { finish?.(); await server.app.close(); await rm(directory, { recursive: true, force: true }); }
});
