// Browser smoke test for MOA's native title-people UI (PeopleRow + PeopleSheet + people-hooks registry) with a fake
// `title.people` source. Bundles the real components with the web app's Vite; all network outside the bundle is
// blocked and TMDB images are answered locally. Synthetic data only.
// Run: MOA_PLAYWRIGHT_PATH=/path/to/playwright-core [MOA_BROWSER_EXECUTABLE=/path/to/chrome] node plugins/title-people/test/host-ui.smoke.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core')); }
catch { console.log('SKIP: set MOA_PLAYWRIGHT_PATH to a playwright-core install'); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url)), web = path.resolve(here, '../../../apps/web');
const webRequire = createRequire(path.join(web, 'package.json'));
const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const react = (await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href)).default;
const out = await mkdtemp(path.join(tmpdir(), 'title-people-ui-'));
const alias = Object.fromEntries(['react', 'react-dom', 'react-router-dom', '@moa/shared'].map(name => [name, path.dirname(webRequire.resolve(`${name}/package.json`))]));
await build({ root: path.join(here, 'host'), base: './', logLevel: 'error', plugins: [react()], resolve: { alias, dedupe: ['react', 'react-dom'] }, build: { outDir: out, emptyOutDir: true, sourcemap: false } });

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ORIGIN = 'http://moa.test';

const person = (i, extra = {}) => ({ provider: 'tmdb', id: String(i), name: `배우 ${i}`, photo: `https://image.tmdb.org/t/p/w185/p${i}.jpg`, roles: [`캐릭터 ${i}`], ...extra });
const title = { mediaId: 'm1', provider: 'tmdb', kind: 'tv', id: '100', name: '검증 시리즈', scope: 'series' };
const credits = (extra = {}) => ({ provider: 'tmdb', status: 'ready', title, truncated: false,
  cast: [person('0042', { name: '배우 하나', roles: ['주인공 (voice)', '나레이션'] }), person(7, { name: '배우 둘', photo: undefined }), ...Array.from({ length: 14 }, (_, i) => person(i + 10)),
    { provider: 'tmdb', id: '9', name: '<img src=x onerror="window.xss=1">', roles: [] }, { provider: 'other', id: '8', name: '다른 출처' }, { provider: 'tmdb', id: 5, name: '숫자 ID' }],
  crew: [person('0042', { name: '배우 하나', roles: ['각본'] }), person(300, { name: '감독 한 명', roles: ['감독'] })], ...extra });
const works = (extra = {}) => ({ provider: 'tmdb', status: 'ready', title, truncated: true,
  person: person('0042', { name: '배우 하나', roles: ['주인공 (voice)', '각본'] }),
  items: [{ provider: 'tmdb', kind: 'tv', id: '100', title: '검증 시리즈' }, { provider: 'tmdb', kind: 'movie', id: '100', title: '같은 번호 영화', year: 2024, poster: 'https://image.tmdb.org/t/p/w342/m100.jpg' },
    { provider: 'tmdb', kind: 'tv', id: '0200', title: '다른 시리즈', year: 2022, poster: 'https://evil.example/t/p/w342/x.jpg' }, { provider: 'tmdb', kind: 'tv', id: '0200', title: '중복' },
    { provider: 'other', kind: 'movie', id: '1', title: '다른 출처 작품' }], ...extra });

const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const pageErrors = [], external = [];
try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  tab.on('pageerror', error => pageErrors.push(String(error)));
  tab.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  const images = [];
  await tab.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(`${ORIGIN}/`)) {
      const file = path.join(out, decodeURIComponent(new URL(url).pathname));
      try { return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    }
    if (url.startsWith('https://image.tmdb.org/')) { images.push(url); return route.fulfill({ body: png, contentType: 'image/png' }); }
    external.push(url); return route.abort();
  });
  await tab.goto(`${ORIGIN}/index.html`);
  const pending = () => tab.evaluate(() => pending.map(p => ({ value: p.value, aborted: p.aborted })));
  const answer = (index, value) => tab.evaluate(([i, v]) => answer(i, v), [index, value]);
  const last = async () => (await pending()).length - 1;
  const heading = () => tab.textContent('#people-sheet-title');
  const dialog = '[role=dialog]';

  // Without a source the native row is unchanged: no entry button, no person buttons.
  await tab.evaluate(() => mount());
  await tab.waitForSelector('.people .person');
  assert.equal(await tab.locator('.title-section-head .text-btn').count(), 0);
  assert.equal(await tab.locator('.people button').count(), 0);
  await tab.evaluate(() => mount({ people: [], linked: true }));
  assert.equal(await tab.locator('#people-title').count(), 0, 'no plugin and no people: no section');

  // Linked title without native cast still gets an entry when a source is registered; unlinked stays hidden.
  await tab.evaluate(() => register());
  await tab.waitForSelector('.people-empty');
  assert.equal(await tab.textContent('#people-title'), '출연·제작진');
  await tab.evaluate(() => mount({ people: [], linked: false }));
  assert.equal(await tab.locator('#people-title').count(), 0, 'unlinked without cast: no section');

  // Native row with a source: only stored, supported identities become buttons (never name matching).
  await tab.evaluate(() => mount());
  await tab.waitForSelector('.person-link');
  assert.deepEqual(await tab.$$eval('.person-link b', nodes => nodes.map(n => n.textContent)), ['배우 하나', '배우 둘']);
  if (shots) await tab.screenshot({ path: path.join(shots, 'row-desktop.png') });

  // Full list: a cancelled request (close then reopen) never overwrites the newer one.
  await tab.click('.title-section-head .text-btn');
  await tab.waitForSelector(dialog);
  assert.deepEqual((await pending())[0].value, { action: 'credits', mediaId: 'm1' });
  await tab.keyboard.press('Escape');
  assert.equal(await tab.locator(dialog).count(), 0);
  assert.equal(await tab.evaluate(() => document.activeElement?.textContent), '출연·제작진 전체', 'focus returns to the opener');
  assert.equal((await pending())[0].aborted, true);
  await tab.click('.title-section-head .text-btn');
  await tab.waitForFunction(() => pending.length === 2);
  await answer(0, credits({ cast: [person(1, { name: '늦은 응답' })] }));
  await answer(1, credits());
  await tab.waitForSelector('.credit-person');
  assert.equal(await tab.locator('text=늦은 응답').count(), 0);
  assert.equal(await tab.locator('.credit-person').count(), 17, 'other providers and numeric IDs are dropped');
  assert.match(await tab.textContent('.people-scope'), /시리즈 전체 기준.*특정 시즌이나 회차/);
  assert.match(await tab.textContent('.credit-person'), /주인공 \(voice\) · 나레이션/, 'raw TMDB role text kept');
  assert.equal(await tab.evaluate(() => window.xss), undefined);
  assert.ok(await tab.locator('text=<img src=x onerror="window.xss=1">').count());
  assert.deepEqual(await tab.$$eval('.people-tabs .chip', nodes => nodes.map(n => n.textContent)), ['출연17', '제작2']);
  assert.match(await tab.textContent('.people-sheet-foot'), /This product uses the TMDB API but is not endorsed or certified by TMDB\./);
  assert.ok(images.every(url => /^https:\/\/image\.tmdb\.org\/t\/p\/w185\/[\w-]+\.jpg$/.test(url)), images.join());
  if (shots) await tab.screenshot({ path: path.join(shots, 'credits-desktop.png') });
  await tab.click('.people-tabs .chip:nth-child(2)');
  assert.match(await tab.textContent('.credit-list'), /감독 한 명감독/);
  await tab.click('.people-tabs .chip:nth-child(1)');

  // Person view: exact opaque identity, only the chosen name while loading, no portrait until a successful answer.
  await tab.click('[data-person=\'["tmdb","0042"]\']');
  await tab.waitForFunction(() => pending.length === 3);
  assert.deepEqual((await pending())[2].value, { action: 'person', mediaId: 'm1', person: { provider: 'tmdb', id: '0042' } });
  assert.equal(await heading(), '배우 하나');
  assert.equal(await tab.locator(`${dialog} .person-photo img`).count(), 0);
  await answer(2, works());
  await tab.waitForSelector('.person-works .card');
  assert.equal(await tab.locator('.person-profile img').count(), 1);
  assert.deepEqual(await tab.$$eval('.person-roles div', nodes => nodes.map(n => n.textContent)), ['배역주인공 (voice) · 나레이션', '직무각본']);
  assert.deepEqual(await tab.$$eval('.person-works .card-title', nodes => nodes.map(n => n.textContent)), ['같은 번호 영화', '다른 시리즈'], 'current title, duplicates and other providers excluded');
  assert.ok(!images.some(url => url.includes('evil')), 'off-allowlist poster never requested');
  assert.match(await tab.textContent('.people-sheet-body'), /바로 재생하지는 않아요.*일부만 보여요/);
  if (shots) await tab.screenshot({ path: path.join(shots, 'person-desktop.png') });

  // Back restores the list and focuses the same person.
  await tab.click('[aria-label="출연·제작진 목록"]');
  await tab.waitForSelector('.credit-person');
  assert.equal(await tab.evaluate(() => document.activeElement?.dataset.person), '["tmdb","0042"]');
  assert.equal((await pending()).length, 3, 'valid credits are not re-requested on back');

  // Search navigation from a work closes the sheet and does not open playback.
  await tab.click('[data-person=\'["tmdb","0042"]\']');
  await tab.waitForFunction(() => pending.length === 4);
  await answer(3, works());
  await tab.click('.person-works .card >> nth=0');
  await tab.waitForFunction(() => document.querySelector('#location')?.textContent.startsWith('/search'));
  assert.equal(await tab.textContent('#location'), `/search?q=${encodeURIComponent('같은 번호 영화')}`);
  assert.equal(await tab.locator(dialog).count(), 0);

  // Direct native click opens the person view; a denial shows no earlier metadata and Back reloads credits.
  for (const [deny, label] of [[works({ status: 'restricted', title: null, person: null, items: [] }), 'restricted'], ['reject', 'error'], [works({ person: { ...person('0043'), name: '다른 사람' } }), 'mismatch'], [works({ items: 'x' }), 'malformed'], [works({ provider: 'example' }), 'provider']]) {
    await tab.evaluate(() => mount());
    await tab.click('.person-link >> nth=0');
    const index = await tab.waitForFunction(() => pending.length && pending.at(-1).value.action === 'person').then(last);
    assert.equal(await heading(), '배우 하나');
    if (deny === 'reject') await tab.evaluate(i => fail(i), index); else await answer(index, deny);
    await tab.waitForFunction(() => document.querySelector('#people-sheet-title')?.textContent === '인물 정보');
    assert.equal(await tab.locator(`${dialog} img:not(.people-sheet-foot img)`).count(), 0, label);
    assert.equal(await tab.locator('.person-roles').count(), 0, label);
    assert.equal(await tab.locator('.person-works').count(), 0, label);
    if (label !== 'restricted') {
      await tab.click('.people-notice button');
      const retried = await tab.waitForFunction(i => pending.length > i + 1, index).then(last);
      assert.deepEqual((await pending())[retried].value.person, { provider: 'tmdb', id: '0042' });
      await answer(retried, works());
      await tab.waitForSelector('.person-works .card');
      assert.deepEqual(await tab.$$eval('.person-roles div', nodes => nodes.map(n => n.textContent)), ['참여주인공 (voice) · 각본'], 'credits were discarded; roles come from the new answer');
    }
    if (shots && label === 'restricted') await tab.screenshot({ path: path.join(shots, 'person-restricted.png') });
    const before = (await pending()).length;
    await tab.click('[aria-label="출연·제작진 목록"]');
    await tab.waitForFunction(n => pending.length === n + 1, before);
    assert.equal((await pending()).at(-1).value.action, 'credits', `${label}: back reloads credits`);
    await tab.waitForSelector('.metadata-note');
    assert.equal(await tab.locator('.credit-person').count(), 0, `${label}: no old list while reloading`);
    await answer(before, credits());
    await tab.waitForSelector('.credit-person');
    await tab.keyboard.press('Escape');
  }

  // Credits states and invalid answers render a notice and no list.
  const cases = [
    [{ provider: 'tmdb', status: 'unlinked', title: null }, /연결되지 않아/, false], [{ provider: 'tmdb', status: 'unconfigured', title: null }, /관리자가/, true],
    [{ provider: 'tmdb', status: 'restricted', title: null }, /이 프로필에서는/, false], [{ provider: 'tmdb', status: 'unavailable', title: null }, /가져오지 못했어요/, true],
    [credits({ provider: 'example' }), /지원하지 않아요/, true], [credits({ title: { ...title, mediaId: 'other' } }), /불러오지 못했어요/, true],
    [credits({ title: { ...title, scope: 'movie' } }), /불러오지 못했어요/, true], [credits({ cast: [], crew: [] }), /출연진이 없어요/, false], ['reject', /불러오지 못했어요/, true],
    // Malformed replies throw in the parser and must reach the same error state instead of staying loading.
    [null, /불러오지 못했어요/, true], [{ provider: 'tmdb', status: 'ready', title, cast: 'x', crew: [] }, /불러오지 못했어요/, true], [{ provider: 'tmdb', status: 'weird' }, /불러오지 못했어요/, true],
  ];
  for (const [value, message, retry] of cases) {
    await tab.click('.title-section-head .text-btn');
    const index = await tab.waitForFunction(() => pending.at(-1)?.value.action === 'credits' && !pending.at(-1).settled).then(last);
    if (value === 'reject') await tab.evaluate(i => fail(i), index); else await answer(index, value);
    await tab.waitForFunction(() => !document.querySelector('[role=dialog] .metadata-note[role=status]'));
    assert.match(await tab.textContent('.people-sheet-body'), message, JSON.stringify(value).slice(0, 80));
    assert.equal(await tab.locator('.credit-person').count(), 0);
    assert.equal(await tab.locator('.people-notice button').count(), retry ? 1 : 0, JSON.stringify(value).slice(0, 80));
    await tab.evaluate(i => { pending[i].settled = true; }, index);
    await tab.keyboard.press('Escape');
  }

  // Desktop to mobile with the sheet open: it becomes a bottom sheet, nothing overflows, attribution stays visible.
  await tab.click('.title-section-head .text-btn');
  await answer(await tab.waitForFunction(() => pending.at(-1)?.value.action === 'credits' && !pending.at(-1).settled).then(last), credits());
  await tab.waitForSelector('.credit-person');
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.waitForTimeout(350);
  const box = await tab.evaluate(() => { const r = document.querySelector('.people-sheet').getBoundingClientRect(), f = document.querySelector('.people-sheet-foot').getBoundingClientRect(); return { bottom: r.bottom, top: r.top, foot: f.bottom, width: document.documentElement.scrollWidth, cols: getComputedStyle(document.querySelector('.credit-list')).gridTemplateColumns.split(' ').length }; });
  assert.ok(box.bottom <= 844.5 && box.top >= 0 && box.foot <= 844.5, JSON.stringify(box));
  assert.equal(box.width <= 390, true, 'no horizontal overflow');
  assert.equal(box.cols, 1);
  if (shots) await tab.screenshot({ path: path.join(shots, 'credits-mobile.png') });
  await tab.click('[data-person=\'["tmdb","0042"]\']');
  await answer(await tab.waitForFunction(() => pending.at(-1)?.value.action === 'person').then(last), works());
  await tab.waitForSelector('.person-works .card');
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (shots) await tab.screenshot({ path: path.join(shots, 'person-mobile.png') });
  await tab.keyboard.press('Escape');

  // Unregistering the plugin restores the plain native row and discards an open sheet; re-enabling does not reopen it.
  await tab.click('.person-link >> nth=0');
  await tab.waitForSelector(dialog);
  await tab.evaluate(() => unregister());
  await tab.waitForFunction(() => !document.querySelector('.person-link'));
  assert.equal(await tab.locator(dialog).count(), 0);
  assert.equal(await tab.locator('.title-section-head .text-btn').count(), 0);
  const requests = (await pending()).length;
  await tab.evaluate(() => register());
  await tab.waitForSelector('.person-link');
  await tab.waitForTimeout(100);
  assert.equal(await tab.locator(dialog).count(), 0, 're-enabling must not reopen the previous sheet');
  assert.equal((await pending()).length, requests, 'no request without a click');
  await tab.evaluate(() => unregister());
  await tab.waitForFunction(() => !document.querySelector('.person-link'));
  assert.deepEqual(external, [], 'no external requests');
  assert.deepEqual(pageErrors, []);
  console.log(`ok native UI: ${(await pending()).length} source requests; ${images.length} TMDB image requests (local)`);
} finally {
  await browser.close();
  await rm(out, { recursive: true, force: true });
}
console.log('title-people host UI smoke passed');
