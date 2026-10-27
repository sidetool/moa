import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { invokeMangayomi, type MangayomiInvocation, type SourceWebViewRequest } from '../src/sources/extensions/index.js';
import { SourceBrowser } from '../src/sources/browser.js';
import { Sources } from '../src/sources/service.js';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';

const request: SourceWebViewRequest = { url: 'https://example.com/page', headers: { Referer: 'https://example.com/' }, script: 'true', waitUntil: 'load', timeoutMs: 25_000 };
const signal = () => AbortSignal.timeout(10_000);
type Rpc = { scope: string; proxy: string; url: string; headers: Record<string, string>; script: string; timeoutMs: number; captureSession: boolean };
async function fixture(t: TestContext, handler: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'moa-source-browser-'));
  const secret = randomBytes(32).toString('hex'), secretFile = join(root, 'token');
  await writeFile(secretFile, secret + '\n', { mode: 0o600 });
  const calls: Rpc[] = [], transport: { path: string; method: string; authorization: string }[] = [];
  const server = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const rpc = JSON.parse(Buffer.concat(parts).toString()) as Rpc;
      calls.push(rpc);
      transport.push({ path: req.url!, method: req.method!, authorization: req.headers.authorization! });
      await handler(rpc, req, res);
    } catch { if (!res.destroyed) { res.statusCode = 500; res.end('{}'); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const browser = new SourceBrowser({ url, secretFile });
  t.after(() => browser.close());
  return { root, secret, secretFile, url, calls, transport, browser };
}

test('RPC authenticates a private administrator endpoint and picks host scope/proxy, headers and bounded timeout', async t => {
  const f = await fixture(t, (_rpc, _req, res) => { res.end(JSON.stringify({ result: { items: [1, null, true, '합성'], ok: true } })); });
  for (const endpoint of [f.url, f.url + '/evaluate']) {
    const browser = new SourceBrowser({ url: endpoint, secretFile: f.secretFile });
    t.after(() => browser.close());
    const result = await browser.evaluate('host-source', 'socks5://proxy.example.com:1080', { ...request, timeoutMs: 200_000, scope: 'guest-source', proxy: 'socks5://guest.example.com:9999' } as SourceWebViewRequest, signal());
    assert.deepEqual(result, { items: [1, null, true, '합성'], ok: true });
  }
  assert.deepEqual(f.calls[0], { scope: f.calls[0].scope, proxy: 'socks5://proxy.example.com:1080', url: request.url, headers: request.headers, script: request.script, timeoutMs: 90_000, captureSession: true });
  assert.match(f.calls[0].scope, /^host-source:[0-9a-f-]{36}$/);
  assert.notEqual(f.calls[0].scope, f.calls[1].scope);
  assert.deepEqual(f.transport, Array.from({ length: 2 }, () => ({ path: '/evaluate', method: 'POST', authorization: `Bearer ${f.secret}` })));
  assert.ok(!JSON.stringify(f.calls).includes(f.secret));
  await f.browser.evaluate('other-source', undefined, { ...request, headers: undefined }, signal());
  assert.match(f.calls[2].scope, /^other-source:[0-9a-f-]{36}$/);
  assert.equal(f.calls[2].proxy, '');
  assert.deepEqual(f.calls[2].headers, {});
});

test('disabled browser preserves unavailable behavior; partial, invalid and unreadable configuration fails closed without secrets', async t => {
  const f = await fixture(t, () => {});
  const disabled = new SourceBrowser({});
  assert.equal(disabled.configured, false);
  assert.deepEqual(disabled.invocation('source', undefined), {});
  await assert.rejects(disabled.evaluate('source', undefined, request, signal()), { message: 'source_browser_unavailable' });
  for (const config of [
    { url: f.url }, { secretFile: f.secretFile }, { url: '', secretFile: '' },
    { url: 'file:///private', secretFile: f.secretFile },
    { url: `http://user:${f.secret}@127.0.0.1/`, secretFile: f.secretFile },
    { url: f.url + '/other', secretFile: f.secretFile },
    { url: f.url + '?token=' + f.secret, secretFile: f.secretFile },
    { url: f.url + '#private', secretFile: f.secretFile },
    { url: f.url, secretFile: join(f.root, 'missing-private-file') },
  ]) assert.throws(() => new SourceBrowser(config), { message: 'invalid-source-browser-config' });
  await writeFile(f.secretFile, 'short');
  assert.throws(() => new SourceBrowser({ url: f.url, secretFile: f.secretFile }), { message: 'invalid-source-browser-config' });
  await writeFile(f.secretFile, f.secret + '\r\ninjected');
  assert.throws(() => new SourceBrowser({ url: f.url, secretFile: f.secretFile }), { message: 'invalid-source-browser-config' });
  assert.equal(f.calls.length, 0);
});

test('session capture stays on the host; clear rotates RPC generation and rejects stale capture', async t => {
  const session = { cookies: [{ name: 'session', value: 'private-cookie', domain: 'example.com', path: '/', secure: true, httpOnly: true, expires: -1 }], userAgent: 'Synthetic Browser', engine: 'synthetic' };
  let release!: () => void, started!: () => void, hold = false;
  const f = await fixture(t, async (_rpc, _req, res) => {
    if (hold) { started(); await new Promise<void>(resolve => { release = resolve; }); }
    res.end(JSON.stringify({ result: { guest: true }, session }));
  });
  const captures: unknown[] = [];
  const capture = f.browser.sessions.capture.bind(f.browser.sessions);
  t.mock.method(f.browser.sessions, 'capture', (...args: Parameters<typeof capture>) => { captures.push(args[3]); capture(...args); });
  assert.deepEqual(await f.browser.evaluate('source', undefined, request, signal()), { guest: true });
  assert.deepEqual(captures, [session]);
  await f.browser.evaluate('source', undefined, request, signal());
  assert.equal(f.calls[0].scope, f.calls[1].scope);
  hold = true;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = assert.rejects(f.browser.evaluate('source', undefined, request, signal()), /source_browser_failed/);
  await ready; f.browser.clear('source'); release(); await pending;
  assert.equal(captures.length, 2, 'cleared generation must not resurrect cookies');
  hold = false;
  await f.browser.evaluate('source', undefined, request, signal());
  assert.notEqual(f.calls.at(-1)!.scope, f.calls[0].scope);
});

test('publicUrl check and input/request limits reject before any browser RPC', async t => {
  const f = await fixture(t, () => {});
  for (const url of ['http://example.com/', 'file:///private', 'https://user:pass@example.com/', 'https://example.com/#fragment', 'not a URL'])
    await assert.rejects(f.browser.evaluate('source', undefined, { ...request, url }, signal()), { message: 'source_url_denied' });
  for (const input of [
    { ...request, timeoutMs: NaN }, { ...request, timeoutMs: 0 },
    { ...request, headers: { 'X-Test': 'value\r\ninjected' } },
    { ...request, headers: { 'bad:name': 'value' } },
  ]) await assert.rejects(f.browser.evaluate('source', undefined, input, signal()), { message: 'source_browser_failed' });
  await assert.rejects(f.browser.evaluate('source', undefined, { ...request, script: 'x'.repeat(512 * 1024) }, signal()), { message: 'source_body_limit' });
  await assert.rejects(f.browser.evaluate('bad scope', undefined, request, signal()), { message: 'source_browser_failed' });
  assert.equal(f.calls.length, 0);
});

test('RPC preserves safe service codes and normalizes malformed or private failures', async t => {
  let reply: unknown = { error: 'source_request_timeout' }, status = 200;
  const f = await fixture(t, (_rpc, _req, res) => { res.statusCode = status; res.end(typeof reply === 'string' ? reply : JSON.stringify(reply)); });
  for (const code of ['source_request_timeout', 'source_body_limit', 'source_address_denied', 'source_access_denied', 'source_browser_unavailable', 'source_connection_failed', 'source_rate_limited']) {
    reply = { error: code }; status = 503;
    await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: code });
  }
  for (const [code, normalized] of [['source_browser_busy', 'source_rate_limited'], ['source_browser_denied', 'source_access_denied']]) {
    reply = { error: code };
    await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: normalized });
  }
  for (const value of [{ error: 'source_' + f.secret }, { error: `private endpoint ${f.url} Bearer ${f.secret}` }, { error: {} }, null, [], {}, '{invalid', { error: '', result: true }]) {
    reply = value; status = 200;
    await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: 'source_browser_failed' });
  }
  reply = { result: 'wrong status' }; status = 500;
  await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: 'source_browser_failed' });
  reply = { result: null }; status = 200;
  assert.equal(await f.browser.evaluate('source', undefined, request, signal()), null);
});

test('RPC never follows redirects or forwards its Bearer secret to the redirect destination', async t => {
  let url = '';
  const f = await fixture(t, (_rpc, _req, res) => { res.writeHead(302, { Location: url + '/elsewhere' }); res.end('{"result":true}'); });
  url = f.url;
  await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: 'source_browser_failed' });
  assert.equal(f.calls.length, 1);
});

test('response body cap rejects both declared and streamed excess and accepts exactly 4 MiB', async t => {
  let mode = 'declared';
  const f = await fixture(t, (_rpc, _req, res) => {
    if (mode === 'declared') { res.writeHead(200, { 'Content-Length': 4 * 1024 * 1024 + 1 }); res.flushHeaders(); }
    else if (mode === 'streamed') { res.writeHead(200); res.write(' '.repeat(2 * 1024 * 1024)); res.end(' '.repeat(2 * 1024 * 1024 + 1)); }
    else { res.end('{"result":"' + 'x'.repeat(4 * 1024 * 1024 - 13) + '"}'); }
  });
  for (const value of ['declared', 'streamed']) {
    mode = value;
    await assert.rejects(f.browser.evaluate('source', undefined, request, signal()), { message: 'source_body_limit' });
  }
  mode = 'exact';
  assert.equal((await f.browser.evaluate('source', undefined, request, signal()) as string).length, 4 * 1024 * 1024 - 13);
});

test('caller abort reaches HTTP before headers and during body streaming, and pre-abort sends no RPC', async t => {
  let phase = 'headers', started!: () => void, closed!: () => void;
  const f = await fixture(t, (_rpc, _req, res) => {
    res.on('close', () => closed());
    if (phase === 'body') { res.writeHead(200); res.write('{"result":"'); }
    started();
  });
  for (const value of ['headers', 'body']) {
    phase = value;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const controller = new AbortController();
    const pending = f.browser.evaluate('source', undefined, request, controller.signal);
    const rejected = assert.rejects(pending, { message: 'cancelled' });
    await ready; controller.abort(new Error('private cancellation reason'));
    await rejected; await disconnected;
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.browser.evaluate('source', undefined, request, controller.signal), { message: 'cancelled' });
  assert.equal(f.calls.length, 2);
});

test('absolute RPC deadline also aborts a service that keeps the response body open', async t => {
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await fixture(t, (_rpc, _req, res) => { res.on('close', disconnected); res.write('{"result":"'); });
  await assert.rejects(f.browser.evaluate('source', undefined, { ...request, timeoutMs: 1 }, signal()), { message: 'source_request_timeout' });
  await closed;
});

test('unreachable administrator endpoint yields only the normalized unavailable code', async t => {
  const f = await fixture(t, () => {});
  // Acquire then release an ephemeral port, without contacting an external host.
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const browser = new SourceBrowser({ url: `http://127.0.0.1:${port}`, secretFile: f.secretFile });
  await assert.rejects(browser.evaluate('source', undefined, request, signal()), { message: 'source_browser_unavailable' });
});

const entry = { id: 'guest-advertised-id', name: 'Synthetic provider', lang: 'ko', version: '1', baseUrl: 'https://example.com/', sourceCodeUrl: 'https://repo.example.com/source.js', format: 'mangayomi-js' as const, itemType: 1 as const, isNsfw: false, hasCloudflare: false };
const guest = `class DefaultExtension extends MProvider {
  getSourcePreferences(){return [{key:'label',editTextPreference:{title:'Label',value:'Synthetic'}}];}
  async getFilterList(){return await evaluateJavascriptViaWebview('https://example.com/filters',{},["window.flutter_inappwebview.callHandler('setResponse',[])"]);}
  async getPopular(){const list=await evaluateJavascriptViaWebview('https://example.com/list',{'X-Fixture':'list'},["window.flutter_inappwebview.callHandler('setResponse',[{name:'Synthetic work',link:'/work'}])"]);return {list,hasNextPage:false};}
  async search(){return {list:[{name:'Without browser',link:'/search'}],hasNextPage:false};}
  async getDetail(url){return await sendMessage('evaluateJavascriptViaWebview',JSON.stringify(['https://example.com/detail',{},["window.flutter_inappwebview.callHandler('setResponse',{name:'Synthetic work',chapters:[{name:'1',url:'/episode'}]})"],5]));}
  async getVideoList(){return await evaluateJavascriptViaWebview('https://example.com/video',{},["window.flutter_inappwebview.callHandler('setResponse',[{url:'https://media.example.com/video.m3u8',quality:'720p'}])"],200);}
}`;

test('Sources installs async filters and executes real JS webview/sendMessage bridge through local RPC, with host row identity and proxy', async t => {
  const f = await fixture(t, async (rpc, _req, res) => {
    // Run the real wrapper against synthetic page globals, including setResponse and restoration.
    const original = { callHandler: async () => 'original' };
    const window = { flutter_inappwebview: original };
    const result = await runInNewContext(rpc.script, { window }, { timeout: 1000 });
    assert.equal(window.flutter_inappwebview, original);
    res.end(JSON.stringify({ result }));
  });
  const db = new Store(join(f.root, 'data')), catalog = new Catalog(db), seen: MangayomiInvocation[] = [];
  const environment = { MOA_SOURCE_BROWSER_URL: process.env.MOA_SOURCE_BROWSER_URL, MOA_SOURCE_BROWSER_SECRET_FILE: process.env.MOA_SOURCE_BROWSER_SECRET_FILE };
  process.env.MOA_SOURCE_BROWSER_URL = f.url + '/evaluate';
  process.env.MOA_SOURCE_BROWSER_SECRET_FILE = f.secretFile;
  t.after(() => { for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  // Exercise the same default constructor/environment wiring used by app.ts.
  const sources = new Sources(db, catalog, async input => { seen.push(input); return invokeMangayomi(input); },
    async () => ({ source: guest, sha256: 'synthetic-digest' }));
  const row = JSON.stringify(entry);
  db.run('INSERT INTO source_entries(id,repository,entry) VALUES(?,?,?)', 'host-row-a', 'https://repo.example.com/index.json', row);
  db.run('INSERT INTO source_entries(id,repository,entry) VALUES(?,?,?)', 'host-row-b', 'https://repo.example.com/index.json', row);
  for (const id of ['host-row-a','host-row-b']) db.run('INSERT INTO source_network VALUES(?,?,1)',id,'');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', 'p', 'p', 'blue', 0, '2026');
  t.after(async () => { await sources.close(); db.close(); });
  sources.saveNetwork('socks5://proxy.example.com:1080', 0);
  await sources.install('host-row-a');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].scope, /^host-row-a:[0-9a-f-]{36}$/);
  assert.ok(f.calls[0].url.endsWith('/filters'));
  await sources.install('host-row-b');
  assert.match(f.calls[1].scope, /^host-row-b:[0-9a-f-]{36}$/);
  const page = await sources.browse('host-row-a', 'p');
  assert.equal(page.items[0].title, 'Synthetic work');
  await sources.detail(page.items[0].id);
  const episodeId = db.get('SELECT id FROM episodes WHERE media_id=?', page.items[0].id)!.id;
  assert.equal((await sources.videos(episodeId))[0].url, 'https://media.example.com/video.m3u8');
  assert.ok(f.calls.some(rpc => rpc.url.endsWith('/detail') && rpc.timeoutMs === 5000));
  assert.ok(f.calls.some(rpc => rpc.url.endsWith('/video') && rpc.timeoutMs === 90_000));
  assert.ok(f.calls.every(rpc => rpc.proxy === 'socks5://proxy.example.com:1080' && rpc.scope !== entry.id));
  assert.deepEqual(f.calls.find(rpc => rpc.url.endsWith('/list'))!.headers, { 'X-Fixture': 'list' });
  const count = f.calls.length;
  await sources.preferences('host-row-a');
  const preferences = seen.find(input => input.action === 'preferences')!;
  assert.equal(preferences.webview, undefined);
  assert.equal(preferences.timeoutMs, undefined);
  assert.ok(seen.filter(input => input.action !== 'preferences').every(input => input.timeoutMs === 120_000 && typeof input.webview === 'function'));
  // Configured does not mean every source method uses the browser: search has only filter discovery.
  await sources.browse('host-row-a', 'p', 'search', 1, 'synthetic');
  assert.equal(f.calls.length, count + 1);
  sources.saveNetwork('', 1);
  await sources.capabilities('host-row-b');
  assert.equal(f.calls.at(-1)!.proxy, '');
  assert.match(f.calls.at(-1)!.scope, /^host-row-b:[0-9a-f-]{36}$/);
});

test('unconfigured Sources keeps default invocation budget and reports browser unavailable through real guest', async t => {
  const f = await fixture(t, () => {}), db = new Store(join(f.root, 'data')), seen: MangayomiInvocation[] = [];
  const sources = new Sources(db, new Catalog(db), async input => { seen.push(input); return invokeMangayomi(input); }, undefined, undefined, undefined, new SourceBrowser({}));
  const row = JSON.stringify(entry);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'host-row', 'https://repo.example.com/index.json', row, row, guest);
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', 'p', 'p', 'blue', 0, '2026');
  t.after(async () => { await sources.close(); db.close(); });
  await assert.rejects(sources.browse('host-row', 'p'), { message: 'source_browser_unavailable' });
  assert.equal(seen[0].timeoutMs, undefined);
  assert.equal(seen[0].webview, undefined);
  assert.equal(f.calls.length, 0);
  await assert.rejects(sources.preferences('host-row', { __moa_browser:true }), { message:'source-browser-unavailable' });
  // A previously enabled preference can remain after the service is removed.
  db.run('INSERT INTO source_network VALUES(?,?,1)','host-row','');
  await assert.rejects(sources.browse('host-row','p'), { message:'source_browser_unavailable' });
  db.run('UPDATE source_entries SET code=? WHERE id=?', `class DefaultExtension extends MProvider { async getPopular(){return {list:[{name:'Ordinary JS',link:'/plain'}],hasNextPage:false};} }`, 'host-row');
  sources.invalidate('host-row');
  assert.equal((await sources.browse('host-row', 'p')).items[0].title, 'Ordinary JS');
  assert.ok(seen.every(input => input.webview === undefined && input.timeoutMs === undefined));
  assert.equal(f.calls.length, 0);
});

test('Sources shutdown aborts a real in-flight guest browser RPC', async t => {
  let started!: () => void, closed!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), disconnected = new Promise<void>(resolve => { closed = resolve; });
  const f = await fixture(t, (_rpc, _req, res) => { res.on('close', closed); started(); });
  const db = new Store(join(f.root, 'data')), sources = new Sources(db, new Catalog(db), undefined, undefined, undefined, undefined, f.browser);
  const row = JSON.stringify(entry);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'host-row', 'https://repo.example.com/index.json', row, row, guest);
  db.run('INSERT INTO source_network VALUES(?,?,1)','host-row','');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', 'p', 'p', 'blue', 0, '2026');
  t.after(async () => { await sources.close(); db.close(); });
  const browsing = sources.browse('host-row', 'p');
  // The read cache propagates the host AbortError; the HTTP transport still receives guest cancellation.
  const rejected = assert.rejects(browsing, (error: Error) => error.name === 'AbortError' || error.message === 'cancelled');
  await ready; await sources.close(); await rejected; await disconnected;
});
