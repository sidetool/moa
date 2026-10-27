import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityHttp, type CompatibilityHttpInput } from '../src/sources/extensions/index.js';
import { SourceSessions, type BrowserState } from '../src/sources/session.js';

const url = 'https://example.com/read/page';
const input = (target = url): CompatibilityHttpInput => ({ url: target, options: { browserSession: { url } } });
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cookie = (name: string, value = 'private', extra: Partial<BrowserState['cookies'][number]> = {}) =>
  ({ name, value, domain: 'example.com', path: '/', secure: true, httpOnly: true, expires: -1, ...extra });
const state = (cookies = [cookie('session')]): BrowserState => ({ cookies, userAgent: 'Synthetic Browser/1', engine: 'synthetic' });
const response = (statusCode = 200, headers = {}, body = 'ok'): Awaited<ReturnType<typeof compatibilityHttp>> =>
  ({ bytes: Buffer.from(body), headers, statusCode, contentType: 'text/html' });
function fixture(t: TestContext, transport: typeof compatibilityHttp, authenticate?: ConstructorParameters<typeof SourceSessions>[0]) {
  let authentications = 0;
  const sessions = new SourceSessions(authenticate ?? (async (scope, proxy, request) => {
    authentications++; sessions.capture(scope, proxy, request.url, state());
  }), transport);
  t.after(() => sessions.close());
  return { sessions, authentications: () => authentications };
}

test('host cookies respect domain, path boundary and expiry; guest response hides Set-Cookie', async t => {
  const calls: CompatibilityHttpInput[] = [];
  const f = fixture(t, async request => { calls.push(request); return response(200, { 'set-cookie': ['session=renewed; Path=/; HttpOnly; Secure'], 'set-cookie2': ['private'], 'x-visible': 'yes' }); });
  const captured = state([
    cookie('root'), cookie('deep', 'private', { path: '/read' }),
    cookie('wrongPath', 'private', { path: '/reader' }), cookie('domain', 'private', { domain: '.example.com' }),
    cookie('foreign', 'private', { domain: 'other.example.com' }), cookie('expired', 'private', { expires: 1 }),
  ]);
  f.sessions.capture('source', undefined, url, captured);
  captured.cookies[0].value = 'mutated';
  const result = await f.sessions.request('source', undefined, input(), signal());
  assert.equal(calls[0].headers!.cookie, 'deep=private; root=private; domain=private');
  assert.equal(calls[0].headers!['user-agent'], 'Synthetic Browser/1');
  assert.deepEqual(result.headers, { 'x-visible': 'yes' });
  assert.equal(f.authentications(), 0);
  await f.sessions.request('source', undefined, input(), signal());
  assert.match(calls[1].headers!.cookie, /session=renewed/);
});

test('each redirect hop applies Set-Cookie and strips credentials at another origin', async t => {
  const calls: CompatibilityHttpInput[] = [];
  const f = fixture(t, async request => {
    calls.push(request);
    if (calls.length === 1) return response(302, { location: '/read/next', 'set-cookie': ['hop=second; Path=/read; Secure', 'session=gone; Max-Age=0; Path=/', 'foreign=bad; Domain=other.example.com'] });
    if (calls.length === 2) return response(302, { location: 'https://other.example.com/end' });
    return response(200, { 'set-cookie': ['outside=bad; Domain=example.com'] });
  });
  f.sessions.capture('source', undefined, url, state());
  const result = await f.sessions.request('source', undefined, { ...input(), headers: { Cookie: 'guest=bad', Authorization: 'private', Referer: url, Origin: 'https://example.com' } }, signal());
  assert.equal(calls[0].headers!.cookie, 'session=private');
  assert.equal(calls[1].headers!.cookie, 'hop=second');
  for (const name of ['cookie', 'authorization', 'referer', 'origin']) assert.equal(calls[2].headers![name], undefined);
  assert.ok(calls.every(call => call.options?.followRedirects === false && call.options.maxRedirects === 0));
  assert.equal(result.headers['set-cookie'], undefined);
});

test('redirect ceiling and cumulative body budget are enforced between hops', async t => {
  let calls = 0;
  const budgets: number[] = [];
  const f = fixture(t, async (_request, _signal, _origins, maximum) => { calls++; budgets.push(maximum!); return response(302, { location: '/read/next' }, '1234'); });
  f.sessions.capture('source', undefined, url, state());
  await assert.rejects(f.sessions.request('source', undefined, { ...input(), options: { ...input().options, maxRedirects: 1 } }, signal()), /source_redirect_limit/);
  assert.equal(calls, 2);
  calls = 0; budgets.length = 0;
  await assert.rejects(f.sessions.request('source', undefined, input(), signal(), 4), /source_body_limit/);
  assert.equal(calls, 1); assert.deepEqual(budgets, [4]);
});

test('expired clearance authenticates again; other expired cookies never reach transport', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sent: string[] = [];
  const f = fixture(t, async request => { sent.push(request.headers!.cookie); return response(); });
  f.sessions.capture('source', undefined, url, state([cookie('cf_clearance', 'old', { expires: now / 1000 + 1 }), cookie('old', 'old', { expires: now / 1000 + 1 })]));
  now += 2000;
  await f.sessions.request('source', undefined, input(), signal());
  assert.equal(f.authentications(), 1); assert.deepEqual(sent, ['session=private']);
  now += 31 * 60_000;
  await f.sessions.request('source', undefined, input(), signal());
  assert.equal(f.authentications(), 1, 'idle session is retained beyond the former 30-minute limit');
  now += 61 * 60_000;
  await f.sessions.request('source', undefined, input(), signal());
  assert.equal(f.authentications(), 2, 'idle session state expires after one hour even for session cookies');
});

test('source, proxy and origin isolate cookies; clear discards only the selected source', async t => {
  const sent: { cookie: string; proxy?: string }[] = [];
  const f = fixture(t, async (request, _signal, _origins, _maximum, proxy) => { sent.push({ cookie: request.headers!.cookie, proxy }); return response(); });
  for (const [scope, proxy, value] of [['a', undefined, 'a'], ['b', undefined, 'b'], ['a', 'socks5://proxy.example.com:1080', 'proxy']] as const)
    f.sessions.capture(scope, proxy, url, state([cookie('session', value)]));
  await f.sessions.request('a', undefined, input(), signal());
  await f.sessions.request('b', undefined, input(), signal());
  await f.sessions.request('a', 'socks5://proxy.example.com:1080', input(), signal());
  const other = 'https://other.example.com/read';
  await f.sessions.request('a', undefined, { url: other, options: { browserSession: { url: other } } }, signal());
  assert.deepEqual(sent.slice(0, 3).map(call => call.cookie), ['session=a', 'session=b', 'session=proxy']);
  assert.equal(sent[2].proxy, 'socks5://proxy.example.com:1080');
  assert.equal(f.authentications(), 1);
  f.sessions.clear('a');
  await f.sessions.request('b', undefined, input(), signal());
  assert.equal(sent.at(-1)!.cookie, 'session=b');
  await f.sessions.request('a', undefined, input(), signal());
  assert.equal(f.authentications(), 2);
});

test('concurrent challenges coalesce; cancelling the first waiter preserves the second', async t => {
  let release!: () => void, authSignal!: AbortSignal, authCalls = 0;
  const f = fixture(t, async request => request.headers!.cookie === 'session=old' ? response(403, { 'cf-mitigated': 'challenge' }) : response(),
    async (scope, proxy, request, authenticationSignal) => {
      authCalls++; authSignal = authenticationSignal;
      await new Promise<void>((resolve, reject) => { release = resolve; authenticationSignal.addEventListener('abort', () => reject(authenticationSignal.reason), { once: true }); });
      f.sessions.capture(scope, proxy, request.url, state());
    });
  f.sessions.capture('source', undefined, url, state([cookie('session', 'old')]));
  const first = new AbortController();
  const a = assert.rejects(f.sessions.request('source', undefined, input(), first.signal), /source_cancelled/);
  const b = f.sessions.request('source', undefined, input(), signal());
  await tick(); assert.equal(authCalls, 1);
  first.abort(Error('source_cancelled')); await a;
  assert.equal(authSignal.aborted, false);
  release(); assert.equal((await b).statusCode, 200); assert.equal(authCalls, 1);
});

test('last waiter cancellation and clear abort pending authentication before HTTP', async t => {
  let authSignal!: AbortSignal, transports = 0;
  const f = fixture(t, async () => { transports++; return response(); }, async (_scope, _proxy, _request, authenticationSignal) => {
    authSignal = authenticationSignal;
    await new Promise((_resolve, reject) => authenticationSignal.addEventListener('abort', () => reject(authenticationSignal.reason), { once: true }));
  });
  for (const mode of ['cancel', 'clear']) {
    const controller = new AbortController();
    const pending = assert.rejects(f.sessions.request(mode, undefined, input(), controller.signal), /source_cancelled/);
    await tick();
    if (mode === 'cancel') controller.abort(Error('source_cancelled')); else f.sessions.clear(mode);
    await pending; assert.equal(authSignal.aborted, true);
  }
  assert.equal(transports, 0);
});

test('clear during HTTP rejects the stale response and next request authenticates anew', async t => {
  let release!: () => void, hold = true;
  const f = fixture(t, async () => {
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return response();
  });
  f.sessions.capture('source', undefined, url, state());
  const pending = assert.rejects(f.sessions.request('source', undefined, input(), signal()), /source_cancelled/);
  await tick(); f.sessions.clear('source'); release(); await pending;
  hold = false;
  assert.equal((await f.sessions.request('source', undefined, input(), signal())).statusCode, 200);
  assert.equal(f.authentications(), 1);
});

test('POST requires explicit readOnly and challenges permit exactly one replay', async t => {
  const calls: CompatibilityHttpInput[] = [];
  const f = fixture(t, async request => { calls.push(request); return response(503, {}, '<title>Just a moment</title><div id="challenge-form"></div>'); });
  for (const denied of [{ ...input(), method: 'POST' }, { ...input(), method: 'DELETE' }, { ...input(), options: { browserSession: { url: 'https://other.example.com/' } } }])
    await assert.rejects(f.sessions.request('source', undefined, denied, signal()), /source_access_denied/);
  assert.equal(calls.length, 0); assert.equal(f.authentications(), 0);
  const post = { ...input(), method: 'POST', body: 'query=synthetic', options: { browserSession: { url, readOnly: true } } };
  await assert.rejects(f.sessions.request('source', undefined, post, signal()), /source_access_denied/);
  assert.equal(calls.length, 2); assert.equal(f.authentications(), 2);
  assert.ok(calls.every(call => call.method === 'POST' && call.body === post.body));
});

test('ordinary 403 returns unchanged without reauthentication; missing capture fails closed', async t => {
  const f = fixture(t, async () => response(403, {}, 'Forbidden'));
  f.sessions.capture('source', undefined, url, state());
  assert.equal((await f.sessions.request('source', undefined, input(), signal())).statusCode, 403);
  assert.equal(f.authentications(), 0);
  let sent = false;
  const legacy = fixture(t, async () => { sent = true; return response(); }, async () => true);
  await assert.rejects(legacy.sessions.request('source', undefined, input(), signal()), /source_browser_failed/);
  assert.equal(sent, false);
});
