// Bounded synthetic smoke: direct-mode Shorts fill/whole-video per device, the pinch gesture (real CDP
// multi-touch) and its noninterference with scroll, skip, pause, seek and hold-2x. Local media, routed API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
assert.ok(process.env.MOA_NATIVE_FIXTURE, 'Set MOA_NATIVE_FIXTURE to a seekable synthetic MP4 longer than 45 seconds');
const fixture = readFileSync(process.env.MOA_NATIVE_FIXTURE);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];

const item = (key, title) => ({ key, kind: key.split(':')[0], tmdbId: Number(key.split(':')[1]), title, category: 'movie', href: `/search?q=${encodeURIComponent(title)}`, reason: 'popular' });
const POOL = [item('movie:1', '첫 작품'), item('movie:2', '둘째 작품'), item('movie:3', '셋째 작품')];
// Legacy profile: the old shared default "fill" is still stored on the profile.
const settings = { navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }], shortsEnabled: true, shortsPlayback: 'native', shortsScreenFit: true };
const devices = new Map(); // X-Moa-Device → stored device settings (absent = first visit)
const log = { profilePatches: [], devicePatches: [], skips: [] };

const route = async context => {
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), r => r.abort());
  await context.route(url => url.pathname.startsWith('/api/'), r => {
    const request = r.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (path === '/api/settings') { if (method === 'PATCH') { log.profilePatches.push(request.postDataJSON()); Object.assign(settings, request.postDataJSON()); } return r.fulfill({ json: settings }); }
    if (path === '/api/settings/device') {
      const id = request.headers()['x-moa-device'];
      if (method === 'PATCH') { const body = request.postDataJSON(); log.devicePatches.push({ id, ...body }); devices.set(id, { ...devices.get(id), ...body.settings }); }
      return r.fulfill({ json: { settings: devices.get(id) ?? null } });
    }
    if (path === '/api/me') return r.fulfill({ json: { id: 'u', username: '테스트', role: 'member', permissions: ['video.watch'] } });
    if (path === '/api/profiles') return r.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue', kids: false }] });
    if (path === '/api/home') return r.fulfill({ json: { hero: [], rows: [] } });
    if (path === '/api/shorts') return r.fulfill({ json: { status: 'ready', items: POOL, nextCursor: null } });
    if (path === '/api/shorts/native') return r.fulfill({ json: { available: true } });
    const prep = /^\/api\/shorts\/([^/]+)\/native$/.exec(path);
    if (prep && method === 'POST') return r.fulfill({ json: { sessionId: `s${decodeURIComponent(prep[1]).split(':')[1]}`, url: `/api/playback/${prep[1]}/shorts/a1`, mime: 'video/mp4' } });
    if (/^\/api\/shorts\/native\/[^/]+(\/warm)?$/.test(path)) return r.fulfill({ json: { ok: true, ready: true } });
    if (path.startsWith('/api/playback/')) {
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers().range ?? '');
      if (!range) return r.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: fixture });
      const from = Number(range[1]), to = range[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1;
      return r.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${fixture.length}` }, body: fixture.subarray(from, to + 1) });
    }
    const m = /^\/api\/shorts\/([^/]+)\/(seen|skip)$/.exec(path);
    if (m) { if (m[2] === 'skip') log.skips.push(decodeURIComponent(m[1])); return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ json: [] });
  });
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, timeout = 8000) => { for (const end = Date.now() + timeout; !(await check()); await wait(40)) if (Date.now() > end) throw new Error(`Timed out: ${label}`); };
const open = async mobile => {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
  await route(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  return { context, page };
};
const state = page => page.evaluate(() => {
  const v = document.querySelector('.shorts-slide.is-active video'), feed = document.querySelector('.shorts');
  return v && { fit: getComputedStyle(v).objectFit, time: v.currentTime, paused: v.paused, rate: v.playbackRate, scroll: feed.scrollTop, title: document.querySelector('.shorts-slide.is-active h2')?.textContent };
});
const playing = async page => { await page.goto(`${base}shorts`); await until(async () => ((await state(page))?.time ?? 0) > .5, 'playing'); };
const devicePatchesOf = page => page.evaluate(() => localStorage.getItem('moa.deviceId')).then(id => log.devicePatches.filter(p => p.id === id && !p.migrate));

try {
  // Desktop, first visit: whole video despite the legacy profile "fill".
  let { context, page } = await open(false);
  await playing(page);
  assert.equal((await state(page)).fit, 'contain', 'desktop default shows the whole video');
  await page.goto(`${base}settings#experimental`);
  await page.getByRole('button', { name: '세부 설정' }).click();
  const toggle = page.getByRole('switch', { name: '화면 맞춤' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  await until(async () => (await devicePatchesOf(page)).some(p => p.settings.shortsScreenFit === true), 'desktop toggle saved per device');
  await playing(page);
  assert.equal((await state(page)).fit, 'cover', 'desktop fill after toggle');
  await page.evaluate(() => localStorage.removeItem('moa.deviceSettings:test')); // the server copy carries it
  await playing(page);
  assert.equal((await state(page)).fit, 'cover', 'desktop choice survives reload');
  await context.close();

  // Phone, first visit: fill, unaffected by the desktop choice.
  ({ context, page } = await open(true));
  await playing(page);
  const before = await state(page);
  assert.equal(before.fit, 'cover', 'phone default fills');
  const cdp = await context.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const box = await page.locator('.shorts-slide.is-active video').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height * .4;
  const pinch = async (fromGap, toGap) => {
    // One finger first (hold timer armed), a second joins late, they close/open, one lifts, the other pans up hard.
    await touch('touchStart', [{ x: cx, y: cy - fromGap / 2, id: 1 }]);
    await wait(250);
    await touch('touchStart', [{ x: cx, y: cy - fromGap / 2, id: 1 }, { x: cx, y: cy + fromGap / 2, id: 2 }]);
    for (let i = 1; i <= 8; i++) { const g = fromGap + (toGap - fromGap) * i / 8; await touch('touchMove', [{ x: cx, y: cy - g / 2, id: 1 }, { x: cx, y: cy + g / 2, id: 2 }]); await wait(30); }
    await wait(500); // past the hold delay with two fingers down
    await touch('touchMove', [{ x: cx, y: cy - toGap / 2, id: 1 }]); // finger 2 lifts
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: cx, y: cy - toGap / 2 - i * 50, id: 1 }]); await wait(20); }
    await touch('touchEnd', []);
    await wait(700); // past the scroll settle
  };
  const unchanged = async (label, fit) => {
    const now = await state(page);
    assert.equal(now.fit, fit, `${label}: fit`);
    assert.equal(now.title, before.title, `${label}: same work`);
    assert.equal(now.scroll, before.scroll, `${label}: feed did not scroll`);
    assert.equal(now.paused, false, `${label}: still playing`);
    assert.equal(now.rate, 1, `${label}: no 2x`);
    assert.ok(now.time > before.time && now.time - before.time < 6, `${label}: no seek`);
    assert.deepEqual(log.skips, [], `${label}: nothing marked skipped`);
    assert.equal(await page.locator('.shorts-fast').count(), 0);
  };
  await pinch(300, 120);
  await unchanged('pinch in', 'contain');
  await until(async () => (await devicePatchesOf(page)).some(p => p.settings.shortsScreenFit === false), 'pinch saved per device');
  await page.screenshot({ path: verificationPath('shorts-fit-pinched-in.png') });
  await pinch(120, 320);
  await unchanged('pinch out', 'cover');
  await until(async () => (await devicePatchesOf(page)).at(-1)?.settings.shortsScreenFit === true, 'restored fill saved');
  await pinch(300, 120);
  await playing(page);
  assert.equal((await state(page)).fit, 'contain', 'phone pinch survives reload');

  // Still usable afterwards: one-finger hold 2x, seek bar, and a one-finger swipe moves on and counts as skipped.
  const hb = await page.locator('.shorts-slide.is-active video').boundingBox();
  await touch('touchStart', [{ x: hb.x + hb.width / 2, y: hb.y + hb.height * .35, id: 1 }]);
  await wait(700);
  assert.equal((await state(page)).rate, 2, 'one-finger hold still 2x');
  await touch('touchEnd', []);
  await wait(150);
  assert.deepEqual([(await state(page)).rate, (await state(page)).paused], [1, false], 'hold released');
  const seek = page.locator('.shorts-slide.is-active .shorts-seek');
  await seek.evaluate(el => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '30'); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await state(page)).time >= 30, 'seek works');
  await touch('touchStart', [{ x: hb.x + hb.width / 2, y: hb.y + hb.height * .7, id: 1 }]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: hb.x + hb.width / 2, y: hb.y + hb.height * .7 - i * 45, id: 1 }]); await wait(16); }
  await touch('touchEnd', []);
  await until(async () => (await state(page))?.title === '둘째 작품', 'one-finger swipe moves on');
  await until(() => log.skips.includes('movie:1'), 'manual swipe still counts as skipped');
  await context.close();

  assert.deepEqual(log.profilePatches.filter(p => 'shortsScreenFit' in p), [], 'fit never goes to the shared profile');
  assert.deepEqual(errors, []);
  console.log('shorts fit smoke ok', { devicePatches: log.devicePatches.filter(p => !p.migrate).map(p => p.settings), devices: devices.size });
} finally {
  await browser.close();
  await server.close();
}
