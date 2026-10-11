// Browser smoke test for the trending-titles plugin with a fake MOA SDK and the host's iframe CSP.
// Run: MOA_PLAYWRIGHT_PATH=/path/to/node_modules/playwright-core node plugins/trending-titles/test/smoke.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core')); }
catch { console.log('SKIP: set MOA_PLAYWRIGHT_PATH to a playwright-core install'); process.exit(0); }

const root = new URL('..', import.meta.url);
const script = await readFile(new URL('plugin.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
assert.deepEqual(manifest.permissions, ['discovery.read', 'app.navigate', 'ui']);
assert.deepEqual(manifest.connect, ['https://image.tmdb.org']);
assert.deepEqual(manifest.placements, ['home']);
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

// Test double for the host SDK. Discovery requests stay pending until the test answers them.
// moa.fetch mirrors the host's one-pending-request-per-plugin limit and answers with a 1x1 PNG.
const sdk = `
  window.calls = { trending: [], navigate: [], resize: [], fetch: [] }; window.pending = []; window.errors = [];
  addEventListener('unhandledrejection', e => errors.push('unhandled ' + e.reason));
  const handlers = {}, png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  let inFlight = 0; window.fetchDelay = 20;
  window.moa = {
    on: (event, fn) => { handlers[event] = fn; return () => {}; },
    discovery: { trending: options => { calls.trending.push(options); return new Promise((resolve, reject) => pending.push({ options, resolve, reject })); } },
    app: { navigate: path => { calls.navigate.push(path); return Promise.resolve(); } },
    ui: { resize: height => { if (!(height >= 120 && height <= 1200)) return Promise.reject(new Error('out of range')); calls.resize.push(height); return Promise.resolve(); } },
    fetch: async url => {
      if (inFlight) { errors.push('concurrent fetch'); throw new Error('busy'); }
      if (!url.startsWith('https://image.tmdb.org/t/p/w342/')) errors.push('unexpected fetch ' + url);
      calls.fetch.push(url); inFlight++;
      try { await new Promise(r => setTimeout(r, fetchDelay)); if (url.includes('broken')) throw new Error('404'); return new Response(png); }
      finally { inFlight--; }
    },
  };
  window.fire = () => handlers.ready?.(null);
  window.answer = (index, value) => pending[index].resolve(value);
  window.fail = index => pending[index].reject(new Error('failed'));
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL; window.liveBlobs = new Set();
  URL.createObjectURL = blob => { const url = create(blob); liveBlobs.add(url); return url; };
  URL.revokeObjectURL = url => { liveBlobs.delete(url); revoke(url); };
`;
const page = html => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><style>:root{--moa-text:#fafafa;--moa-muted:#a1a1aa;--moa-accent:#ef4444;--moa-surface:#18181b;color-scheme:dark;font:15px/1.5 system-ui;background:#09090b;color:var(--moa-text)}body{margin:16px}button,input,textarea{font:inherit;max-width:100%;box-sizing:border-box}button{cursor:pointer}</style><script>${sdk}</script><body><script>${html.replace(/<\/script/gi, '<\\/script')}</script>`;

const items = (kind, count, extra = {}) => Array.from({ length: count }, (_, i) => ({ provider: 'tmdb', kind, id: String(i + 1), title: `${kind === 'tv' ? '시리즈' : '영화'} ${i + 1}`, ...(i === 0 ? { originalTitle: 'Original' } : {}), year: 2026, poster: `https://image.tmdb.org/t/p/w342/${kind}${i + 1}${i === 2 ? 'broken' : ''}.jpg`, overview: '소개', ...extra }));
const ready = (list, extra = {}) => ({ provider: 'tmdb', status: 'ready', items: list, updatedAt: '2026-10-11T03:00:00Z', stale: false, ...extra });

const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const pageErrors = [];
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 800 }]) {
    const tab = await browser.newPage({ viewport, hasTouch: viewport.width < 600 });
    tab.on('pageerror', error => pageErrors.push(String(error)));
    await tab.setContent(page(script));
    const state = () => tab.evaluate(() => ({ status: document.querySelector('#status').textContent, cards: document.querySelectorAll('.card').length, images: document.querySelectorAll('.poster img').length, retry: !document.querySelector('#retry').hidden, busy: document.querySelector('#panel').getAttribute('aria-busy') }));
    const until = fn => tab.waitForFunction(fn);
    const latest = (value) => tab.evaluate(v => answer(pending.length - 1, v), value);

    await tab.evaluate(() => fire());
    assert.match((await state()).status, /불러오는 중/);
    assert.equal((await state()).busy, 'true');
    assert.deepEqual(await tab.evaluate(() => calls.trending[0]), { kind: 'movie', window: 'day' });

    // Stale request guard: switch to TV and weekly before the first movie request completes.
    await tab.click('[data-kind=tv]');
    await tab.click('[data-window=week]');
    assert.deepEqual(await tab.evaluate(() => calls.trending.map(c => `${c.kind}:${c.window}`)), ['movie:day', 'tv:day', 'tv:week']);
    await tab.evaluate(list => answer(2, list), ready(items('tv', 20)));
    await until(() => document.querySelectorAll('.card').length === 20);
    await tab.evaluate(list => { answer(0, list); answer(1, list); }, ready(items('movie', 3)));
    await tab.waitForTimeout(50);
    assert.equal((await state()).cards, 20, 'late responses must not replace the selected list');
    assert.match(await tab.textContent('.card .name'), /시리즈 1/);
    assert.match(await tab.textContent('#scope'), /국내·OTT 시청 순위가 아님.*예능·애니메이션/);
    assert.match((await state()).status, /TV 20편 · .* 갱신/);

    // Posters load serially through moa.fetch as blob URLs, only for visible/nearby cards; failures keep the text fallback.
    await until(() => document.querySelectorAll('.poster img').length >= 4);
    await tab.waitForTimeout(200);
    const fetched = await tab.evaluate(() => calls.fetch.length);
    assert.ok(fetched < 20, `only nearby posters fetched (${fetched})`);
    assert.ok(await tab.evaluate(() => [...document.querySelectorAll('.poster img')].every(img => img.src.startsWith('blob:') && img.naturalWidth)));
    assert.equal(await tab.evaluate(() => !!document.querySelectorAll('.poster')[2].querySelector('.fallback')), true, 'failed poster keeps its text');
    await tab.evaluate(() => document.querySelector('#list').scrollTo({ left: 1e5 }));
    await until(() => calls.fetch.some(url => url.endsWith('/tv20.jpg')));

    // Same-key refresh: an older response that finishes after a newer refresh is ignored; blob URLs are revoked.
    const before = await tab.evaluate(() => calls.trending.length);
    await tab.click('#refresh');
    assert.equal(await tab.evaluate(() => liveBlobs.size), 0, 'blob URLs revoked on re-render');
    await tab.click('[data-window=day]'); await tab.click('[data-window=week]');
    assert.equal(await tab.evaluate(() => calls.trending.length), before + 3, 'no client data cache');
    await latest(ready(items('tv', 2)));
    await until(() => document.querySelectorAll('.card').length === 2);
    await tab.evaluate(([i, v]) => answer(i, v), [before, ready(items('tv', 9))]);
    await tab.waitForTimeout(50);
    assert.equal((await state()).cards, 2, 'older same-key refresh ignored');
    await tab.click('[data-kind=movie]'); await tab.click('[data-window=day]');
    await latest(ready(items('movie', 3)));
    await until(() => document.querySelectorAll('.card').length === 3 && document.querySelectorAll('.poster img').length === 2);
    assert.ok(await tab.evaluate(() => calls.fetch.every(url => /^https:\/\/image\.tmdb\.org\/t\/p\/w342\//.test(url))));

    // Attribution logo and notice.
    assert.equal(await tab.evaluate(() => { const img = document.querySelector('footer img'); return img.complete && img.naturalWidth > 0 && img.alt; }), 'TMDB');
    assert.match(await tab.textContent('footer'), /This product uses the TMDB API but is not endorsed or certified by TMDB\./);

    // Keyboard navigation and search navigation.
    await tab.focus('.card');
    await tab.keyboard.press('ArrowRight');
    assert.equal(await tab.evaluate(() => [...document.querySelectorAll('.card')].indexOf(document.activeElement)), 1);
    await tab.keyboard.press('End');
    assert.equal(await tab.evaluate(() => [...document.querySelectorAll('.card')].indexOf(document.activeElement)), 2);
    await tab.keyboard.press('Enter');
    assert.deepEqual(await tab.evaluate(() => calls.navigate), ['/search?q=%EC%98%81%ED%99%94%203']);

    if (shots) await tab.screenshot({ path: path.join(shots, `ready-${viewport.width}.png`), fullPage: true });

    // Untrusted text, duplicates, invalid IDs/kinds, off-allowlist posters, more than 20 items and a stale result.
    await tab.click('#refresh');
    const fetchesBefore = await tab.evaluate(() => calls.fetch.length);
    const hostile = [
      { provider: 'tmdb', kind: 'movie', id: '9', title: '<img src=x onerror="errors.push(1)">' }, { provider: 'tmdb', kind: 'movie', id: '9', title: 'dup' }, { provider: 'tmdb', kind: 'person', id: '1', title: 'x' },
      { provider: 'tmdb', kind: 'movie', id: '2' }, { provider: 'tmdb', kind: 'movie', id: 5, title: 'numeric id' }, { kind: 'movie', id: -1, title: 'negative' },
      { provider: 'tmdb', kind: 'movie', id: '3', title: 'bad posters', poster: 'javascript:alert(1)' }, { provider: 'tmdb', kind: 'movie', id: '4', title: 'other size', poster: 'https://image.tmdb.org/t/p/original/a.jpg' },
      { provider: 'tmdb', kind: 'movie', id: '6', title: 'other host', poster: 'https://evil.example/t/p/w342/a.jpg' }, { provider: 'tmdb', kind: 'movie', id: '7', title: 'traversal', poster: 'https://image.tmdb.org/t/p/w342/../a.jpg' },
      ...items('tv', 30).map(item => ({ ...item, id: String(Number(item.id) + 100), poster: undefined })),
    ];
    await latest(ready(hostile, { stale: true }));
    await until(() => document.querySelectorAll('.card').length === 20);
    assert.equal(await tab.textContent('.card .name'), '<img src=x onerror="errors.push(1)">');
    await tab.waitForTimeout(100);
    assert.equal(await tab.evaluate(() => calls.fetch.length), fetchesBefore, 'off-allowlist posters are never fetched');
    assert.match((await state()).status, /최신 정보가 아닐 수 있음/);
    assert.equal((await state()).retry, true);

    await tab.click('#refresh');
    await latest(ready(items('movie', 1).map(item => ({ ...item, provider: 'example-catalog' })), { provider: 'example-catalog' }));
    await until(() => /현재 TMDB 목록만/.test(document.querySelector('#status').textContent));
    assert.equal((await state()).cards, 0, 'unknown providers must not be mislabelled as TMDB');
    await tab.click('#refresh');
    await latest(ready([
      {provider:'tmdb',kind:'movie',id:'0007/a:b',title:'Opaque movie'},
      {provider:'tmdb',kind:'tv',id:'0007/a:b',title:'Opaque TV'},
      {provider:'tmdb',kind:'movie',id:'0007/a:b',title:'Duplicate'},
      {provider:'other',kind:'movie',id:'0007/a:b',title:'Wrong provider'},
      {kind:'movie',id:'1',title:'Missing provider'},
    ]));
    await until(() => document.querySelectorAll('.card').length === 2);

    // Host states, a rejected request, an invalid payload, and retry. No content is kept from earlier answers.
    const cases = [
      [{ provider: 'tmdb', status: 'unconfigured', items: [], updatedAt: null, stale: false }, /TMDB를 연결하면 표시됨/, true, 0],
      [{ provider: 'tmdb', status: 'restricted', items: items('movie', 2), updatedAt: null, stale: false }, /이 프로필에서는/, false, 0],
      [{ provider: 'tmdb', status: 'unavailable', items: [], updatedAt: null, stale: true }, /가져올 수 없음/, true, 0],
      [{ provider: 'tmdb', status: 'unavailable', items: items('movie', 2), updatedAt: '2026-10-10T00:00:00Z', stale: true }, /최신 정보가 아닐 수 있음/, true, 2],
      [{ provider: 'tmdb', status: 'ready', items: [], updatedAt: null, stale: false }, /표시할 작품이 없음/, false, 0],
      [{ provider: 'tmdb', status: 'weird' }, /불러올 수 없음/, true, 0],
      ['reject', /불러올 수 없음/, true, 0],
    ];
    for (const [value, message, retry, cards] of cases) {
      await tab.click('#refresh');
      const fetchesBeforeCase = await tab.evaluate(() => calls.fetch.length);
      if (value === 'reject') await tab.evaluate(() => fail(pending.length - 1)); else await latest(value);
      await until(() => document.querySelector('#panel').getAttribute('aria-busy') === 'false' && !document.querySelector('#refresh').disabled);
      await tab.waitForTimeout(150);
      const now = await state();
      assert.match(now.status, message, JSON.stringify(value));
      assert.equal(now.retry, retry, JSON.stringify(value));
      assert.equal(now.cards, cards, JSON.stringify(value));
      if (!cards) assert.equal(await tab.evaluate(() => calls.fetch.length), fetchesBeforeCase, 'no poster fetch without cards');
      if (shots && value !== 'reject') await tab.screenshot({ path: path.join(shots, `${value.status}-${now.cards}-${viewport.width}.png`) });
    }
    await tab.click('#retry');
    await latest(ready(items('movie', 20)));
    await until(() => document.querySelectorAll('.card').length === 20);

    // Height reports stay within bounds and track the content; mobile does not overflow horizontally.
    await tab.waitForTimeout(150);
    const sizes = await tab.evaluate(() => calls.resize);
    assert.ok(sizes.length && sizes.every(h => h >= 120 && h <= 1200), String(sizes));
    assert.equal(sizes.at(-1), await tab.evaluate(() => Math.ceil(document.querySelector('#trending').getBoundingClientRect().height)));
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page-level horizontal overflow');
    assert.deepEqual(await tab.evaluate(() => errors), []);
    console.log(`ok ${viewport.width}px: resize ${sizes.join(',')}; posters fetched ${await tab.evaluate(() => calls.fetch.length)}`);
    await tab.close();
  }
  assert.deepEqual(pageErrors, []);

  // Older hosts without moa.discovery report the unsupported state instead of throwing.
  const old = await browser.newPage();
  await old.setContent(page(script).replace('discovery: {', 'unused: {'));
  await old.evaluate(() => fire());
  await old.waitForFunction(() => /지원하지 않음/.test(document.querySelector('#status').textContent));
  assert.deepEqual(await old.evaluate(() => errors), []);
  console.log('ok unsupported host');
} finally {
  await browser.close();
}
console.log('trending-titles smoke passed');
