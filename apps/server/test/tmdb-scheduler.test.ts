import test from 'node:test';
import assert from 'node:assert/strict';
import { TmdbScheduler, type TmdbWork } from '../src/metadata/tmdb-scheduler.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { Tmdb } from '../src/metadata/tmdb.js';

const context = (priority: TmdbWork['priority'] = 'foreground'): TmdbWork => ({ priority, revision: 0 });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('TMDB shares identical in-flight work and separates unrelated work', async t => {
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  const gate = deferred<Response>(); let calls = 0;
  const first = scheduler.request('same', context('background'), async () => { calls++; return gate.promise; });
  const second = scheduler.request('same', context(), async () => { assert.fail('duplicate transport'); });
  const separate = scheduler.request('other', context(), async () => { calls++; return Response.json({ other: true }); });
  gate.resolve(Response.json({ shared: true }));
  assert.deepEqual(await first, { shared: true });
  assert.deepEqual(await second, { shared: true });
  assert.deepEqual(await separate, { other: true });
  assert.equal(calls, 2);
});

for (const format of ['seconds', 'http-date'] as const) test(`TMDB ${format} Retry-After holds unrelated queued work behind a shared cooldown`, async t => {
  const now = Date.UTC(2026, 0, 1);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  let attempts = 0; const events: Array<[string, number]> = [];
  const limited = scheduler.request('limited', context(), async () => {
    events.push(['limited', Date.now()]);
    return ++attempts === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': format === 'seconds' ? '2' : new Date(now + 2000).toUTCString() } }) : Response.json({ ok: true });
  });
  await flush();
  const queued = scheduler.request('queued', context(), async () => { events.push(['queued', Date.now()]); return Response.json({ queued: true }); });
  t.mock.timers.tick(1999); await flush();
  assert.deepEqual(events, [['limited', now]]);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(await limited, { ok: true }); assert.deepEqual(await queued, { queued: true });
  assert.ok(events.slice(1).every(([, at]) => at >= now + 2000));
});

test('TMDB long cooldown fails within the request budget and remains shared by later callers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1) });
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close()); let calls = 0;
  await assert.rejects(scheduler.request('first', context(), async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '60' } }); }), /tmdb-429/);
  await assert.rejects(scheduler.request('second', context(), async () => { calls++; return Response.json({}); }), /tmdb-429/);
  assert.equal(calls, 1);
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(await scheduler.request('third', context(), async () => { calls++; return Response.json({ recovered: true }); }), { recovered: true });
  assert.equal(calls, 2);
});

test('TMDB closes queued and active requests, aborts the transport and blocks later work', async t => {
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  const signals: AbortSignal[] = [];
  const requests = Array.from({ length: 7 }, (_, i) => scheduler.request(`request-${i}`, context(), async signal => { signals.push(signal); return new Promise<Response>(() => {}); }));
  const results = Promise.allSettled(requests);
  assert.equal(signals.length, 6);
  scheduler.close();
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok((await results).every(result => result.status === 'rejected' && /tmdb-closed/.test(String(result.reason))));
  await assert.rejects(scheduler.request('after-close', context(), async () => Response.json({})), /tmdb-closed/);
});

test('TMDB promotes shared queued work and gives background requests a finite opportunity', async t => {
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  const gates = Array.from({ length: 6 }, () => deferred<Response>());
  const active = gates.map((gate, i) => scheduler.request(`active-${i}`, context(), () => gate.promise));
  const events: string[] = [];
  const enqueue = (key: string, priority: TmdbWork['priority']) => scheduler.request(key, context(priority), async () => { events.push(key); return Response.json({ key }); });
  const background = enqueue('background', 'background');
  const foreground = Array.from({ length: 9 }, (_, i) => enqueue(`foreground-${i}`, 'foreground'));
  const promoted = enqueue('promoted', 'background');
  const subscriber = scheduler.request('promoted', context(), async () => { assert.fail('promoted request must stay shared'); });
  for (const gate of gates) gate.resolve(Response.json({}));
  await Promise.all([...active, background, ...foreground, promoted, subscriber]);
  assert.ok(events.indexOf('background') <= 4, JSON.stringify(events));
  assert.equal(events.filter(key => key === 'promoted').length, 1);
});

test('TMDB timeout releases waiters and distinguishes a successful empty result from failures', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1) });
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  const hung = scheduler.request('hung', context(), async () => new Promise<Response>(() => {}));
  const rejection = assert.rejects(hung, /tmdb-timeout/);
  t.mock.timers.tick(8000); await flush(); await rejection;
  assert.deepEqual(await scheduler.request('empty', context(), async () => Response.json({ results: [] })), { results: [] });
  await assert.rejects(scheduler.request('failed', context(), async () => new Response(null, { status: 500 })), /tmdb-500/);
  assert.equal(await scheduler.request('missing', context(), async () => new Response(null, { status: 404 })), null);
});

test('TMDB foreground subscriber promotes existing queued background work', async t => {
  const scheduler = new TmdbScheduler(); t.after(() => scheduler.close());
  const gates = Array.from({ length: 6 }, () => deferred<Response>());
  const active = gates.map((gate, i) => scheduler.request(`active-${i}`, context('background'), () => gate.promise));
  const events: string[] = [];
  const ordinary = scheduler.request('ordinary', context('background'), async () => { events.push('ordinary'); return Response.json({}); });
  const promoted = scheduler.request('promoted', context('background'), async () => { events.push('promoted'); return Response.json({}); });
  const foreground = scheduler.request('promoted', context(), async () => { assert.fail('promotion must not duplicate transport'); });
  for (const gate of gates) gate.resolve(Response.json({}));
  await Promise.all([...active, ordinary, promoted, foreground]);
  assert.deepEqual(events, ['promoted', 'ordinary']);
});

async function metadataFixture(t: Parameters<Parameters<typeof test>[1]>[0], fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'moa-tmdb-lifecycle-'));
  const db = new Store(dir, new DatabaseSync(':memory:'));
  db.run("INSERT INTO media VALUES('synthetic',NULL,'합성 작품','series','{}','2026')");
  const logs: unknown[] = [];
  const tmdb = new Tmdb(db, entry => logs.push(entry), { fetch: fetcher });
  tmdb.configure({ token: 'synthetic-original-token' });
  t.after(async () => { tmdb.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, tmdb, logs };
}

test('TMDB failed matching is retriable while a successful empty search uses the existing miss cache', async t => {
  let calls = 0;
  const { db, tmdb, logs } = await metadataFixture(t, async () => ++calls === 1 ? new Response(null, { status: 500 }) : Response.json({ results: [] }));
  await tmdb.ensure(['synthetic'], 100);
  assert.equal(db.get("SELECT * FROM tmdb_links WHERE media_id='synthetic'"), undefined);
  assert.equal(logs.length, 1);
  await tmdb.ensure(['synthetic'], 100);
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='synthetic'")?.status, 'none');
  assert.equal(calls, 2);
  await tmdb.ensure(['synthetic'], 100);
  assert.equal(calls, 2);
});

for (const malformed of ['missing-results', 'invalid-results', 'not-found'] as const) test(`TMDB ${malformed} response never becomes a cached normal miss`, async t => {
  let calls = 0;
  const { db, tmdb } = await metadataFixture(t, async () => {
    calls++;
    if (calls > 1) return Response.json({ results: [] });
    return malformed === 'not-found' ? new Response(null, { status: 404 }) : Response.json(malformed === 'missing-results' ? {} : { results: 'invalid' });
  });
  await tmdb.ensure(['synthetic'], 100);
  assert.equal(db.get("SELECT * FROM tmdb_links WHERE media_id='synthetic'"), undefined);
  assert.equal(db.get("SELECT * FROM tmdb_match_versions WHERE media_id='synthetic'"), undefined);
  await tmdb.ensure(['synthetic'], 100);
  assert.equal(calls, 2);
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='synthetic'")?.status, 'none');
});

test('TMDB configuration change aborts old work and prevents stale misses before a new generation starts', async t => {
  const gate = deferred<Response>(); let calls = 0; const signals: AbortSignal[] = []; const auth: Array<string | null> = [];
  const { db, tmdb } = await metadataFixture(t, async (_url, options) => {
    calls++; signals.push(options!.signal!); auth.push(new Headers(options?.headers).get('authorization'));
    return calls === 1 ? gate.promise : Response.json({ results: [] });
  });
  const old = tmdb.ensure(['synthetic'], 1000);
  assert.equal(calls, 1);
  tmdb.configure({ token: 'synthetic-replacement-token' });
  assert.equal(signals[0].aborted, true);
  await old;
  assert.equal(db.get("SELECT * FROM tmdb_links WHERE media_id='synthetic'"), undefined);
  await tmdb.ensure(['synthetic'], 1000);
  gate.resolve(Response.json({ results: [{ id: 99, media_type: 'tv', name: '합성 작품' }] })); await flush();
  assert.equal(calls, 2);
  assert.deepEqual(auth, ['Bearer synthetic-original-token', 'Bearer synthetic-replacement-token']);
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='synthetic'")?.status, 'none');
  assert.equal(db.get('SELECT * FROM tmdb_titles'), undefined);
});

test('TMDB old detail response cannot write a title or manual link after credential replacement', async t => {
  const gate = deferred<Response>();
  const { db, tmdb } = await metadataFixture(t, async () => gate.promise);
  const pending = tmdb.change('synthetic', { action: 'link', kind: 'tv', tmdbId: 123 });
  const rejected = assert.rejects(pending, /tmdb-closed|configuration-changed/);
  tmdb.configure({ token: 'synthetic-replacement-token' });
  await rejected;
  gate.resolve(Response.json({ id: 123, name: 'Old synthetic title', seasons: [] })); await flush();
  assert.equal(db.get('SELECT * FROM tmdb_titles'), undefined);
  assert.equal(db.get('SELECT * FROM tmdb_links'), undefined);
});

test('TMDB one caller budget expiring does not cancel a longer subscriber to the same match', async t => {
  const gate = deferred<Response>(); let calls = 0; let signal: AbortSignal | undefined;
  const { db, tmdb } = await metadataFixture(t, async (_url, options) => { calls++; signal = options!.signal!; return gate.promise; });
  const short = tmdb.ensure(['synthetic'], 1, 'background');
  const longer = tmdb.ensure(['synthetic'], 1000, 'foreground');
  await short;
  assert.equal(signal?.aborted, false);
  gate.resolve(Response.json({ results: [] }));
  await longer;
  assert.equal(calls, 1);
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='synthetic'")?.status, 'none');
});

test('TMDB manual and disabled matches remain unchanged during normal ensure', async t => {
  let calls = 0;
  const { db, tmdb } = await metadataFixture(t, async () => { calls++; return Response.json({ results: [] }); });
  db.run("INSERT INTO media VALUES('manual',NULL,'수동 작품','series','{}','2026')");
  db.run("INSERT INTO tmdb_links(media_id,status,checked_at) VALUES('synthetic','off',?)", Date.now());
  db.run("INSERT INTO tmdb_links VALUES('manual','tv',77,NULL,'manual',100,?)", Date.now());
  db.run("INSERT INTO tmdb_titles VALUES('tv',77,?,?,?)", JSON.stringify({ title: 'Saved manual title' }), JSON.stringify({ people: [], similar: [] }), Date.now());
  await tmdb.ensure(['synthetic', 'manual'], 100);
  assert.equal(calls, 0);
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='synthetic'")?.status, 'off');
  assert.equal(db.get("SELECT status FROM tmdb_links WHERE media_id='manual'")?.status, 'manual');
});
