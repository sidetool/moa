import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { GeneralMarkers } from '../src/general-markers.js';

async function fixture(t: TestContext, fetcher: typeof fetch) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-general-markers-'));
  const db = new Store(dir, new DatabaseSync(':memory:'));
  const service = new GeneralMarkers(db, fetcher);
  t.after(async () => { service.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  db.run("INSERT INTO media VALUES('movie',NULL,'Movie','movie','{}','2026')");
  db.run("INSERT INTO episodes VALUES('ep','movie',1,1,'Movie',9999,NULL)");
  db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES('movie','movie',1,'manual',1)");
  return { db, service };
}
const response = (value: unknown) => new Response(JSON.stringify(value));
const version = (durations = [1200000]) => ({ type: 'movie', tmdb_id: 1, versions: durations.map(duration_ms => ({ duration_ms })) });
const markers = (patch: object = {}) => ({ type: 'movie', tmdb_id: 1, intro: [{ start_ms: 10000, end_ms: 70000 }], credits: [{ start_ms: 1100000, end_ms: 1170000 }], ...patch });

test('duration lookup sends actual player milliseconds and never merges unknown editions', async t => {
  const calls: URL[] = [];
  const { service } = await fixture(t, (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return response(url.searchParams.has('list_versions') ? version([1201000]) : markers());
  }) as typeof fetch);
  const result = await service.get('ep', 'session', 1200.125);
  assert.deepEqual(result, { source: 'theintrodb', confidence: .8, introStart: 10, introEnd: 70, creditsStart: 1100, creditsEnd: 1170 });
  assert.equal(calls.length, 2); assert.equal(calls[0].searchParams.get('list_versions'), 'true');
  assert.equal(calls[1].searchParams.get('duration_ms'), '1200125');
  assert.equal(calls[1].searchParams.get('merge_unknown'), 'false');
  assert.equal(calls[1].searchParams.has('season'), false, 'movie is not queried as a TV episode');
});

test('ambiguous/mismatched versions and wrong provider identities produce no markers', async t => {
  let versions: unknown = version([1199000, 1201000]), raw: unknown = markers(), lookups = 0;
  const { service } = await fixture(t, (async input => {
    const listing = new URL(String(input)).searchParams.has('list_versions');
    if (!listing) lookups++;
    return response(listing ? versions : raw);
  }) as typeof fetch);
  assert.equal(await service.get('ep', 'ambiguous', 1200), null); assert.equal(lookups, 0);
  versions = version([1300000]); assert.equal(await service.get('ep', 'mismatch', 1200), null); assert.equal(lookups, 0);
  versions = { ...version(), tmdb_id: 2 }; assert.equal(await service.get('ep', 'wrong-listing', 1200), null);
  versions = version(); raw = markers({ tmdb_id: 2 }); assert.equal(await service.get('ep', 'wrong-result', 1200), null);
});

test('invalid intervals are rejected independently while valid credits preserve post-credits tail', async t => {
  let raw: unknown = markers();
  const { service } = await fixture(t, (async input => response(new URL(String(input)).searchParams.has('list_versions') ? version() : raw)) as typeof fetch);
  const invalid = [
    [{ start_ms: -1, end_ms: 10000 }], [{ start_ms: 20000, end_ms: 10000 }],
    [{ start_ms: 0, end_ms: 1200001 }], [{ start_ms: 0, end_ms: 650000 }],
    [{ start_ms: 700000, end_ms: 710000 }], [{ start_ms: 0, end_ms: 1000 }, { start_ms: 2000, end_ms: 3000 }],
  ];
  for (const [i, intro] of invalid.entries()) {
    raw = markers({ intro }); const value = await service.get('ep', `invalid-${i}`, 1200);
    assert.deepEqual(value, { source: 'theintrodb', confidence: .8, creditsStart: 1100, creditsEnd: 1170 });
  }
  raw = markers({ credits: [{ start_ms: 1000, end_ms: 5000 }] });
  assert.deepEqual(await service.get('ep', 'early-credits', 1200), { source: 'theintrodb', confidence: .8, introStart: 10, introEnd: 70 });
});

test('cache and pending identity distinguish sessions, duration and corrected TMDB links', async t => {
  let calls = 0;
  const { db, service } = await fixture(t, (async input => {
    calls++; const q = new URL(String(input)).searchParams, id = Number(q.get('tmdb_id'));
    await new Promise<void>(resolve => setImmediate(resolve));
    return response(q.has('list_versions') ? { ...version(), tmdb_id: id } : markers({ tmdb_id: id }));
  }) as typeof fetch);
  const [a, b] = await Promise.all([service.get('ep', 's1', 1200), service.get('ep', 's1', 1200)]);
  assert.deepEqual(a, b); assert.equal(calls, 2);
  await service.get('ep', 's1', 1200); assert.equal(calls, 2);
  await service.get('ep', 's2', 1200); assert.equal(calls, 4);
  await service.get('ep', 's1', 1201); assert.equal(calls, 6);
  db.run("UPDATE tmdb_links SET tmdb_id=2 WHERE media_id='movie'");
  await service.get('ep', 's1', 1200); assert.equal(calls, 8);
});

test('TV identity rejects specials and ambiguous season mappings; invalid input and outage are safe', async t => {
  let calls = 0;
  const { db, service } = await fixture(t, (async () => { calls++; throw Error('synthetic outage'); }) as typeof fetch);
  db.run("INSERT INTO media VALUES('tv',NULL,'Series','series','{}','2026')");
  db.run("INSERT INTO episodes VALUES('tv-ep','tv',1,2,'Episode',1200,NULL)");
  db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,season,status,checked_at) VALUES('tv','tv',2,3,'manual',1)");
  assert.deepEqual(service.identity('tv-ep'), { kind: 'tv', id: 2, season: 3, episode: 2 });
  db.run("INSERT INTO episodes VALUES('special','tv',0,0,'Special',1200,NULL)");
  assert.equal(service.identity('special'), null); assert.equal(service.identity('tv-ep'), null, 'multi-season title plus linked season is ambiguous');
  db.run("UPDATE tmdb_links SET season=NULL WHERE media_id='tv'");
  assert.deepEqual(service.identity('tv-ep'), { kind: 'tv', id: 2, season: 1, episode: 2 });
  for (const duration of [NaN, Infinity, 0, 59, 21601]) assert.equal(await service.get('ep', 's', duration), null);
  assert.equal(await service.get('missing', 's', 1200), null); assert.equal(calls, 0);
  assert.equal(await service.get('ep', 'outage', 1200), null); assert.equal(calls, 1);
  service.close(); assert.equal(await service.get('ep', 'closed', 1200), null); assert.equal(calls, 1);
});
