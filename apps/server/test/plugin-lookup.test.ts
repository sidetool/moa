import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MetadataCandidate } from '@moa/shared';
import { PluginPeople, type PeopleProvider } from '../src/plugins/people.js';
import { buildApp } from '../src/app.js';
import { fixtureCatalog } from './fixtures/catalog.js';

function fixture(search: (title: string) => Promise<MetadataCandidate[]> = async () => []) {
  const { db, catalog, groups, sources } = fixtureCatalog({ sources: [], media: [], titles: [] });
  db.run("INSERT INTO profiles(id,name,color,kids,created_at) VALUES('p','Profile','blue',0,'2026')");
  const provider: PeopleProvider & { enabled: boolean; configurationRevision: number } = {
    providerId: 'tmdb', enabled: true, configurationRevision: 0, linkedTitle: () => null,
    peopleCredits: async () => ({ cast: [], crew: [], truncated: false }), personWorks: async () => ({ items: [], truncated: false }), search,
  };
  const people = new PluginPeople(db, provider, Date.now, { catalog, groups });
  const add = (id: string, title: string, metadata: object = {}, link?: { id: number; season?: number }) => {
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, title, 'anime', JSON.stringify(metadata), '2026');
    if (link) db.run("INSERT INTO tmdb_links VALUES(?,'tv',?,?,'manual',100,0)", id, link.id, link.season ?? null);
  };
  return { db, provider, people, add, close: async () => { await sources.close(); db.close(); } };
}

test('lookup resolves exact catalog aliases and seasons without TMDB, and excludes ambiguous or disabled sources', async () => {
  const f = fixture(); f.provider.enabled = false;
  try {
    f.add('s1', '별빛 여행'); f.add('s2', '별빛 여행 시즌 2');
    assert.deepEqual(await f.people.lookup('p', { title: '별빛 여행 Season2', type: 'anime' }), { provider: 'tmdb', status: 'unconfigured', mediaId: 's2' });
    assert.equal((await f.people.lookup('p', { title: '별빛 여행 II', type: 'anime' })).mediaId, undefined);
    f.add('alias', 'Original Title', { altTitles: ['다른 이름'] });
    assert.equal((await f.people.lookup('p', { title: '다른 이름', type: 'anime' })).mediaId, 'alias');
    f.add('duplicate', '별빛 여행 시즌 2');
    assert.ok(['s2', 'duplicate'].includes((await f.people.lookup('p', { title: '별빛 여행 2기', type: 'anime' })).mediaId!));
    f.add('other-edition', '별빛 여행 시즌 2', { year: 1999 });
    assert.equal((await f.people.lookup('p', { title: '별빛 여행 2기', type: 'anime' })).mediaId, undefined);
    f.add('disabled', '볼 수 없는 작품', { provider: { id: 'disabled-source', kind: 'mangayomi-js', name: 'Disabled' } });
    assert.equal((await f.people.lookup('p', { title: '볼 수 없는 작품', type: 'anime' })).mediaId, undefined);
    assert.equal((await f.people.lookup('p', { title: '별빛 여행 외전', type: 'anime' })).mediaId, undefined);
  } finally { await f.close(); }
});

test('lookup uses exact TMDB identities for artwork and existing media without changing accepted links', async () => {
  let calls = 0;
  const f = fixture(async title => {
    calls++; assert.equal(title, '별빛 여행');
    return [{ kind: 'tv', id: 7, title, originalTitle: 'Starlight', genreIds: [16], poster: 'https://image.tmdb.org/t/p/w342/star.jpg' }];
  });
  try {
    f.add('s1', 'Starlight', {}, { id: 7, season: 1 });
    f.add('s2', 'Starlight Season 2', {}, { id: 7, season: 2 });
    const before = f.db.all('SELECT * FROM tmdb_links');
    const results = await Promise.all([f.people.lookup('p', { title: '별빛 여행 2기', type: 'anime' }), f.people.lookup('p', { title: '별빛 여행 Season2', type: 'anime' })]);
    assert.equal(calls, 1);
    assert.deepEqual(results[0], { provider: 'tmdb', status: 'ready', mediaId: 's2', poster: 'https://image.tmdb.org/t/p/w342/star.jpg' });
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(f.db.all('SELECT * FROM tmdb_links'), before);
    f.db.run("UPDATE tmdb_links SET status='off' WHERE media_id='s2'");
    assert.equal((await f.people.lookup('p', { title: '별빛 여행 2기', type: 'anime' })).mediaId, undefined);
    f.db.run("UPDATE profiles SET kids=1 WHERE id='p'");
    assert.deepEqual(await f.people.lookup('p', { title: '별빛 여행', type: 'anime' }), { provider: 'tmdb', status: 'restricted' });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('lookup preserves exact local navigation during provider failures and rejects unsafe or ambiguous artwork', async () => {
  const f = fixture(async () => { throw new Error('synthetic-credential'); });
  try {
    f.add('local', '별빛 여행');
    assert.deepEqual(await f.people.lookup('p', { title: '별빛 여행', type: 'anime' }), { provider: 'tmdb', status: 'unavailable', mediaId: 'local' });
    f.provider.configurationRevision++;
    f.provider.search = async () => [{ kind: 'tv', id: 7, title: '이미지 작품', genreIds: [16], poster: 'https://evil.test/image.jpg' }];
    assert.deepEqual(await f.people.lookup('p', { title: '이미지 작품', type: 'anime' }), { provider: 'tmdb', status: 'ready' });
    f.provider.configurationRevision++;
    f.provider.search = async () => [7, 8].map(id => ({ kind: 'tv', id, title: '동명 작품', genreIds: [16], poster: 'https://image.tmdb.org/t/p/w342/star.jpg' }));
    assert.deepEqual(await f.people.lookup('p', { title: '동명 작품', type: 'anime' }), { provider: 'tmdb', status: 'ready' });
    f.provider.configurationRevision++;
    f.provider.search = async () => [{ kind: 'tv', id: 7, title: '실사 작품', genreIds: [18], poster: 'https://image.tmdb.org/t/p/w342/star.jpg' }];
    assert.deepEqual(await f.people.lookup('p', { title: '실사 작품', type: 'anime' }), { provider: 'tmdb', status: 'ready' });
  } finally { await f.close(); }
});

test('lookup reuses cached TMDB artwork and keeps series aliases in their accepted season', async () => {
  const f = fixture(async () => { assert.fail('cached artwork must not trigger another lookup'); });
  try {
    f.add('s2', '별빛 여행 시즌 2', {}, { id: 7, season: 2 });
    f.db.run("INSERT INTO tmdb_titles VALUES('tv',7,?,'{}',?)", JSON.stringify({ title: '별빛 여행', originalTitle: 'Starlight', animation: true, poster: 'https://image.tmdb.org/t/p/w500/star.jpg' }), Date.now());
    assert.deepEqual(await f.people.lookup('p', { title: '별빛 여행 Season2', type: 'anime' }), { provider: 'tmdb', status: 'ready', mediaId: 's2', poster: 'https://image.tmdb.org/t/p/w342/star.jpg' });
    f.provider.enabled = false;
    assert.equal((await f.people.lookup('p', { title: '별빛 여행', type: 'anime' })).mediaId, undefined);
    f.db.run("UPDATE tmdb_links SET season=NULL WHERE media_id='s2'");
    assert.equal((await f.people.lookup('p', { title: '별빛 여행', type: 'anime' })).mediaId, undefined);
  } finally { await f.close(); }
});

test('lookup rechecks profile, provider configuration and catalog after asynchronous searches', async () => {
  let finish!: (value: MetadataCandidate[]) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    for (const change of [() => { f.provider.configurationRevision++; }, () => { f.db.run("UPDATE profiles SET kids=1 WHERE id='p'"); }]) {
      f.provider.configurationRevision++; f.db.run("UPDATE profiles SET kids=0 WHERE id='p'");
      const pending = f.people.lookup('p', { title: '별빛 여행', type: 'anime' });
      await Promise.resolve(); change();
      finish([{ kind: 'tv', id: 7, title: '별빛 여행', genreIds: [16], poster: 'https://image.tmdb.org/t/p/w342/star.jpg' }]);
      const result = await pending;
      assert.notEqual(result.status, 'ready'); assert.equal(result.poster, undefined); assert.equal(result.mediaId, undefined);
    }
    f.db.run("UPDATE profiles SET kids=0 WHERE id='p'"); f.provider.configurationRevision++; f.add('deleted', '별빛 여행');
    const pending = f.people.lookup('p', { title: '별빛 여행', type: 'anime' });
    await Promise.resolve(); f.db.run("DELETE FROM media WHERE id='deleted'"); finish([]);
    assert.equal((await pending).mediaId, undefined);
  } finally { await f.close(); }
});

test('lookup route validates its contract and enforces profile ownership, permission and revision before and after requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-lookup-'));
  let finish: (() => void) | undefined, block = false;
  const server = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false, { tmdb: { token: 'synthetic-credential', fetch: async input => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.themoviedb.org'); assert.equal(url.pathname, '/3/search/multi');
    assert.equal(url.searchParams.get('language'), 'ko-KR'); assert.equal(url.searchParams.get('include_adult'), 'false');
    if (block) await new Promise<void>(resolve => { finish = resolve; });
    return Response.json({ results: [{ id: 7, media_type: 'tv', name: url.searchParams.get('query'), genre_ids: [16], poster_path: '/star.jpg' }] });
  } } });
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
  const plugin = { apiVersion: 2, id: 'lookup-test', name: 'Lookup', version: '1.0.0', description: 'test', placements: ['home'], permissions: ['metadata.read'], connect: [], script: 'void 0;' };
  const install = async (permissions = plugin.permissions) => (await server.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...plugin, permissions } })).json().revision;
  try {
    const profile = (await server.app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Owner' } })).json();
    const headers = { ...admin, 'x-moa-profile': profile.id };
    let revision = await install();
    const call = (extra: object = {}, auth = headers) => server.app.inject({ method: 'POST', url: '/api/plugin-runtime/lookup-test/metadata/lookup', headers: auth, payload: { revision, query: { title: '별빛 여행', type: 'anime' }, ...extra } });
    const response = await call();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { provider: 'tmdb', status: 'ready', poster: 'https://image.tmdb.org/t/p/w342/star.jpg' });
    assert.equal(response.headers['cache-control'], 'private, no-store'); assert.ok(!response.body.includes('synthetic-credential'));
    for (const query of [{ title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { title: 123 }, { title: ['x'] }, { title: 'x', type: 'tv' }, { title: 'x', url: 'https://evil.test' }]) assert.equal((await call({ query })).statusCode, 400);
    assert.equal((await call({ revision: '0'.repeat(32) })).statusCode, 409);
    assert.equal((await call({}, admin as any)).statusCode, 401);
    assert.equal((await call({}, { ...headers, 'x-moa-account': 'other', 'x-moa-role': 'member' })).statusCode, 401);
    revision = await install([]); assert.equal((await call()).statusCode, 403); revision = await install();
    block = true;
    const pending = Promise.resolve(call({ query: { title: '다른 작품', type: 'anime' } }));
    for (let i = 0; !finish && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(finish);
    await server.app.inject({ method: 'PATCH', url: '/api/admin/plugins/lookup-test', headers: admin, payload: { enabled: false } });
    finish!(); assert.equal((await pending).statusCode, 404);
    await server.app.inject({ method: 'PATCH', url: '/api/admin/plugins/lookup-test', headers: admin, payload: { enabled: true } });
    finish = undefined;
    const moved = Promise.resolve(call({ query: { title: '이동된 프로필', type: 'anime' } }));
    for (let i = 0; !finish && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(finish);
    server.db.run('UPDATE profiles SET account_id=? WHERE id=?', 'other', profile.id);
    finish!(); assert.equal((await moved).statusCode, 401);
  } finally { finish?.(); await server.app.close(); await rm(directory, { recursive: true, force: true }); }
});
