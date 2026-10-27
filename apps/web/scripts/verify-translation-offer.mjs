import { mockWatchUrl } from './mock-watch.mjs';
// Translation suggestion card: placement next to skip / next-up on desktop and phones, and TV remote use.
// Mock API (VITE_MOCK=1) with a local MP4 (MOA_TEST_VIDEO, 600 s). UI only: no translation results are checked.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const video = process.env.MOA_TEST_VIDEO;
assert.ok(video, 'MOA_TEST_VIDEO must point to a local 600-second MP4');
const size = (await stat(video)).size;
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.MOA_TRANSLATION_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'moa-translation-offer-'));
process.env.VITE_MOCK = '1';
const server = await createServer({
  root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), cacheDir: path.join(evidence, 'vite-cache'), logLevel: 'warn', server: { port: 0, open: false },
  plugins: [{ name: 'fixture', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (/^\/api\/playback\/mock-[^/]+\/subtitles\/s0\.vtt(?:\?.*)?$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
      res.end('WEBVTT\n\n00:00:01.000 --> 00:00:30.000\n日本語字幕\n');
      return;
    }
    if (!req.url?.startsWith('/__fixture.mp4')) return next();
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ''), start = range ? +range[1] : 0, end = range?.[2] ? +range[2] : size - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(video, { start, end }).pipe(res);
  }); } }]
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];

async function open(viewport, remote = false) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(remote => {
    localStorage.setItem('moa.profile', 'p1');
    localStorage.setItem('moa.fullscreenOnPlay', '0');
    localStorage.setItem('moa.mockVideo', '/__fixture.mp4');
    if (remote) localStorage.setItem('moa.remoteMode', 'on');
  }, remote);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/settings`);
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).waitFor();
  await page.evaluate(async () => {
    const send = (path, body) => fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await send('/api/admin/translation/config', { addKeys: ['AIza-offer-0001'], enabled: true });
    await send('/api/settings', { autoFetchSubtitles: false, translationMode: 'ask', skipTranslationWithoutSubtitles: false });
  });
  return page;
}
const box = locator => locator.boundingBox();
const overlaps = (a, b) => Boolean(a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
/** Offer with the opening skip button up (mock markers: intro 20–80 s), paused so nothing moves. */
async function offerWithSkip(page, episode) {
  await page.goto(`${base}/watch/${episode}`);
  const offer = page.locator('.translate-offer');
  await offer.waitFor({ timeout: 15000 });
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 30; v.pause(); });
  await page.locator('.player-skip').waitFor();
  await page.waitForTimeout(450);
  return offer;
}
let current;
async function checkLayout(name, viewport) {
  step = name;
  const page = current = await open(viewport);
  const offer = await offerWithSkip(page, 'demo-3-e1');
  const card = await box(offer);
  assert.ok(!overlaps(card, await box(page.locator('.player-skip'))), `${name}: suggestion and skip button do not overlap`);
  assert.ok(!overlaps(card, await box(page.locator('.player-bottom .player-controls'))), `${name}: suggestion stays clear of the controls`);
  assert.ok(card.x >= 0 && card.x + card.width <= viewport.width + 1 && card.y >= 0 && card.y + card.height <= viewport.height + 1, `${name}: suggestion is fully on screen`);
  await page.screenshot({ path: path.join(evidence, `${name}-skip.png`) });
  // Next-up card replaces the suggestion (mock has a post-credits scene, so next-up shows 15 s before the end).
  await page.goto(await mockWatchUrl(page, base, 'anime', 6));
  await offer.waitFor({ timeout: 15000 });
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 588; });
  await page.locator('.next-card').waitFor({ timeout: 8000 });
  assert.equal(await offer.count(), 0, `${name}: next-up hides the suggestion`);
  await page.evaluate(() => { document.querySelector('video').currentTime = 100; });
  await page.waitForTimeout(600);
  if (await offer.count() && await page.locator('.player-notice').count()) assert.ok(!overlaps(await box(offer), await box(page.locator('.player-notice'))), `${name}: suggestion and notice do not overlap`);
  await page.context().close();
}

let step = 'layout';
try {
  await checkLayout('desktop', { width: 1280, height: 800 });
  await checkLayout('tablet', { width: 820, height: 1180 });
  await checkLayout('phone-portrait', { width: 390, height: 844 });
  await checkLayout('phone-landscape', { width: 844, height: 390 });

  /* ---------- TV remote ---------- */
  step = 'remote';
  const tv = current = await open({ width: 1920, height: 1080 }, true);
  const offer = await offerWithSkip(tv, 'demo-3-e2');
  await offer.getByText('방향키로 선택 · 뒤로 버튼으로 닫기').waitFor();
  const focused = () => tv.evaluate(() => document.activeElement?.closest('.translate-offer') ? document.activeElement.textContent.trim() || document.activeElement.getAttribute('aria-label') : null);
  assert.equal(await focused(), null, 'the suggestion never takes focus on its own (OK must not start a paid translation)');
  // Walk to the card with the arrow keys; entering the group lands on the main action.
  let reached = null;
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowUp']) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(120);
    reached = await focused();
    if (reached) break;
  }
  assert.equal(reached, '번역하기', 'arrows reach the suggestion and land on its main action');
  await tv.screenshot({ path: path.join(evidence, 'tv-focus.png') });
  await tv.keyboard.press('ArrowRight');
  assert.equal(await focused(), '다른 자막');
  // Back closes the suggestion first and stays in the player.
  await tv.keyboard.press('Escape');
  await offer.waitFor({ state: 'detached' });
  assert.match(new URL(tv.url()).pathname, /^\/watch\//, 'Back closed the suggestion instead of leaving the player');
  await tv.keyboard.press('Escape');
  await tv.waitForTimeout(400);
  assert.match(new URL(tv.url()).pathname, /^\/watch\//, 'with the suggestion gone, Back works as before (hides controls first)');

  // Focus survives real control auto-hide and the suggestion's 25-second timeout.
  step = 'remote accept';
  const accept = await offerWithSkip(tv, 'demo-3-e3');
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowUp']) {
    await tv.keyboard.press(key); await tv.waitForTimeout(120);
    if (await focused()) break;
  }
  await tv.locator('video').evaluate(video => video.play());
  await tv.waitForFunction(() => document.querySelector('.player')?.classList.contains('is-idle'), null, {timeout:10000});
  assert.equal(await focused(), '번역하기', 'hiding controls retains focus on the offer');
  await tv.waitForTimeout(26000);
  assert.equal(await focused(), '번역하기', 'the suggestion stays while a TV viewer reads it');
  await tv.keyboard.press('Enter');
  await accept.waitFor({ state: 'detached', timeout: 5000 });
  await tv.locator('.player-notice').waitFor({ timeout: 15000 });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence }, null, 2));
} catch (error) {
  if (current) await current.screenshot({ path: path.join(evidence, `failed-${step}.png`) }).catch(() => {});
  console.error(`failed at: ${step}`);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
