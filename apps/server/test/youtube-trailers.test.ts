import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { YouTubeTrailers } from '../src/metadata/youtube-trailers.js';
import { buildApp } from '../src/app.js';

const id = (s: string) => s.repeat(11);
const apiKey = 'fixture-youtube-key-not-a-real-key';
const video = (key: string, details: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
  id: key, contentDetails: details, status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', ...status }
});
async function fixture(options: ConstructorParameters<typeof YouTubeTrailers>[1]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-youtube-')), db = new Store(dir);
  const youtube = new YouTubeTrailers(db, options);
  return { youtube, db, close: async () => { youtube.close(); db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('no key keeps normal candidates and makes no upstream request', async () => {
  const f = await fixture({ fetch: async () => { throw new Error('must not fetch'); } });
  try {
    assert.deepEqual(await f.youtube.check([id('A'), 'bad', id('A'), null, id('B')]), { trailers: [id('A'), id('B')], checked: false });
    assert.equal(f.youtube.status().configured, false);
  } finally { await f.close(); }
});

test('known embedding restrictions are removed; regional restrictions only reorder; lookups coalesce/cache', async () => {
  let calls = 0;
  const f = await fixture({ apiKey, fetch: async (input, options) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/youtube/v3/videos');
    assert.equal(url.searchParams.get('key'), apiKey); assert.equal(url.searchParams.get('part'), 'contentDetails,status');
    assert.equal(url.searchParams.has('regionCode'), false); // That API parameter only applies to charts.
    assert.equal(options?.redirect, 'error');
    await new Promise(r => setTimeout(r, 5));
    return Response.json({ items: [video(id('A'), { regionRestriction: { allowed: ['US'] } }), video(id('B')),
      video(id('C'), {}, { embeddable: false }), video(id('D'), { contentRating: { ytRating: 'ytAgeRestricted' } })] });
  } });
  try {
    const ids = ['A', 'B', 'C', 'D', 'E'].map(id);
    const results = await Promise.all([f.youtube.check(ids), f.youtube.check(ids)]);
    assert.deepEqual(results[0], { trailers: [id('B'), id('A')], checked: true });
    assert.deepEqual(results[0], results[1]); await f.youtube.check(ids); assert.equal(calls, 1);
    f.youtube.configure({ regionCode: 'US' });
    assert.deepEqual((await f.youtube.check(ids)).trailers, [id('A'), id('B')]); assert.equal(calls, 2);
  } finally { await f.close(); }
});

test('API failure backs off across titles without poisoning normal candidates; cache expires', async () => {
  let now = 1_000_000, calls = 0;
  const f = await fixture({ apiKey, now: () => now, fetch: async () => {
    calls++; return calls === 1 ? Response.json({}, { status: 403 }) : Response.json({ items: [video(id('A'))] });
  } });
  try {
    assert.deepEqual(await f.youtube.check([id('A')]), { trailers: [id('A')], checked: false });
    assert.deepEqual(await f.youtube.check([id('B')]), { trailers: [id('B')], checked: false }); assert.equal(calls, 1);
    now += 5 * 60_000 + 1; assert.equal((await f.youtube.check([id('A')])).checked, true); assert.equal(calls, 2);
    await f.youtube.check([id('A')]); assert.equal(calls, 2);
    now += 6 * 60 * 60_000 + 1; await f.youtube.check([id('A')]); assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('malformed success falls back, whereas empty valid API response reports known unavailable videos', async () => {
  const f = await fixture({ apiKey, fetch: async () => Response.json({ items: [{ id: id('A') }] }) });
  const empty = await fixture({ apiKey, fetch: async () => Response.json({ items: [] }) });
  try {
    assert.deepEqual(await f.youtube.check([id('A')]), { trailers: [id('A')], checked: false });
    assert.deepEqual(await empty.youtube.check([id('A')]), { trailers: [], checked: true });
  } finally { await f.close(); await empty.close(); }
});

test('credential changes abort in-flight lookups and stale results cannot populate new config cache', async () => {
  let finish!: (r: Response) => void, signal: AbortSignal | undefined;
  const f = await fixture({ fetch: async (_input, options) => {
    signal = options?.signal as AbortSignal; return new Promise(r => { finish = r; });
  } });
  try {
    f.youtube.configure({ apiKey }); const pending = f.youtube.check([id('A')]);
    f.youtube.configure({ clear: true }); assert.equal(signal!.aborted, true);
    finish(Response.json({ items: [] }));
    assert.deepEqual(await pending, { trailers: [id('A')], checked: false });
    assert.deepEqual(await f.youtube.check([id('A')]), { trailers: [id('A')], checked: false });
  } finally { await f.close(); }
});

test('precheck concurrency is bounded and shutdown aborts active fetches', async () => {
  const signals: AbortSignal[] = [];
  const f = await fixture({ apiKey, fetch: async (_input, options) => new Promise((_resolve, reject) => {
    const signal = options!.signal!; signals.push(signal); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  try {
    const pending = ['A', 'B', 'C', 'D'].map(v => f.youtube.check([id(v)]));
    assert.deepEqual(await f.youtube.check([id('E')]), { trailers: [id('E')], checked: false });
    f.youtube.close(); assert.ok(signals.every(s => s.aborted));
    assert.ok((await Promise.all(pending)).every(r => !r.checked));
  } finally { await f.close(); }
});

test('config is admin-only and never returns credentials; title precheck keeps profile/kids protection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-youtube-route-'));
  let calls = 0;
  const { app, db } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true }, false, {
    youtube: { fetch: async () => { calls++; return Response.json({ items: [video(id('A'))] }); } }, tmdb: {}
  });
  const headers = { 'x-moa-account': 'admin', 'x-moa-role': 'admin' };
  const url = '/api/admin/youtube/config';
  try {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { ...headers, 'x-moa-role': 'member' } })).statusCode, 403);
    for (const payload of [{}, { clear: false }, { apiKey: 'bad' }, { apiKey, clear: true }, { regionCode: 'ZZZ' }, { unknown: true }]) {
      assert.equal((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode, 400);
    }
    const saved = await app.inject({ method: 'PATCH', url, headers, payload: { apiKey, regionCode: 'JP' } });
    assert.equal(saved.statusCode, 200); assert.equal(saved.headers['cache-control'], 'private, no-store');
    assert.deepEqual(saved.json(), { configured: true, source: 'database', hasSavedCredential: true, regionCode: 'JP' });
    assert.ok(!saved.body.includes(apiKey));
    const env = new YouTubeTrailers(db, { apiKey: 'different-environment-key' });
    assert.equal(env.status().source, 'environment');
    assert.throws(() => env.configure({ apiKey }), /youtube-managed-by-environment/); env.close();
    db.run("INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES('p','p','blue',0,'2026','admin')");
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'film', 'Fixture Film', 'movie', JSON.stringify({ trailers: [id('A')] }), '2026');
    const target = '/api/media/film/trailers';
    assert.equal((await app.inject({ url: target, headers })).statusCode, 401);
    const scoped = { ...headers, 'x-moa-profile': 'p' };
    const result = await app.inject({ url: target, headers: scoped });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { trailers: [id('A')], checked: true }); assert.equal(calls, 1);
    db.run("UPDATE profiles SET kids=1 WHERE id='p'");
    assert.equal((await app.inject({ url: target, headers: scoped })).statusCode, 403); assert.equal(calls, 1);
    await app.inject({ method: 'PATCH', url, headers, payload: { clear: true } });
    assert.equal((await app.inject({ url, headers })).json().configured, false);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
