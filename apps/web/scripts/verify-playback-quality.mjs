// Real hls.js/video decoding and WatchPage fallback, isolated from production and external sources.
// MOA_TEST_MEDIA_DIR contains master.m3u8 (360/720/1080 variants) and video.mp4 (at least 40s).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const media = resolve(process.env.MOA_TEST_MEDIA_DIR);
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', plugins: [{ name: 'isolated-api', configureServer(server) { server.middlewares.use('/api', (_req, res) => { res.statusCode = 503; res.end(); }); } }], server: { host: '127.0.0.1', port: 0, open: false, hmr: false } });
await web.listen();
const base = web.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
async function serveMedia(route) {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/fixture/')) return route.fallback();
  const path = resolve(media, url.pathname.slice('/fixture/'.length));
  assert.ok(path.startsWith(media + sep));
  const bytes = await readFile(path);
  const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
  return route.fulfill({ status: range ? 206 : 200, contentType: path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
}

try {
  const context = await browser.newContext();
  await context.route('**/*', serveMedia);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/engine-fixture', route => route.fulfill({ contentType: 'text/html', body: '<video muted></video>' }));
  await page.goto(`${base}/engine-fixture`);
  await page.evaluate(async () => {
    const { attach } = await import('/src/player/playback/engine.ts');
    window.failures = [];
    window.startEngine = async height => {
      window.engine?.destroy();
      const video = document.querySelector('video');
      window.engine = await attach(video, { mime: 'application/vnd.apple.mpegurl', url: '/fixture/master.m3u8' }, 0, message => window.failures.push(message), false, { preferredHeight: height });
      await video.play();
    };
  });
  async function expectHeight(height, level) {
    await page.waitForFunction(({ height, level }) => document.querySelector('video').videoHeight === height && window.engine.level() === level, { height, level });
  }
  await page.evaluate(() => window.startEngine(720));
  await expectHeight(720, 1);
  await page.evaluate(() => window.engine.setPreferredHeight(1080));
  await expectHeight(1080, 2);
  await page.evaluate(() => { window.engine.setLevel(0); window.engine.setPreferredHeight(720); });
  await expectHeight(360, 0);
  await page.evaluate(() => { window.engine.setLevel(-1); window.engine.setPreferredHeight(1080); });
  assert.equal(await page.evaluate(() => window.engine.level()), -1, 'late preference must not replace manual auto');
  await page.evaluate(() => window.startEngine(480));
  await expectHeight(360, 0);
  await page.evaluate(() => window.startEngine(1080));
  await expectHeight(1080, 2);
  await page.evaluate(() => window.startEngine());
  await page.waitForFunction(() => document.querySelector('video').videoHeight > 0);
  assert.equal(await page.evaluate(() => window.engine.level()), -1);
  assert.deepEqual(await page.evaluate(() => window.failures), []);
  assert.deepEqual(errors, []);
  console.log('PASS: decoded HLS default, lower available resolution, late preference, manual override and fresh session');
  await context.close();

  const fallbackContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await fallbackContext.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
  const sessions = [];
  await fallbackContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = value => route.fulfill({ json: value });
    if (url.pathname === '/api/playback' && request.method() === 'POST') {
      const body = request.postDataJSON(), streamId = body.streamId ?? '2';
      sessions.push({ ...body, selected: streamId });
      return json({ sessionId: `session-${sessions.length}`, episodeId: body.episodeId, mediaId: 'm', mediaTitle: 'Quality fixture', mediaType: 'anime', mode: 'direct', mime: 'video/mp4', url: `/fixture/video.mp4?session=${sessions.length}`, duration: 1440, startPosition: body.startPosition ?? 0, subtitles: [], audioTracks: [], streams: [{ id: '0', label: 'A', height: 1080 }, { id: '1', label: 'B', height: 360 }, { id: '2', label: 'C', height: 720 }], streamId });
    }
    if (url.pathname === '/api/settings') return json({ preferredQuality: '720', autoFetchSubtitles: false, autoplayNext: false, defaultSubtitleLang: 'ko', subtitleSize: 'medium' });
    if (url.pathname === '/api/me') return json({ role: 'admin' });
    if (url.pathname === '/api/plugin-runtime') return json([]);
    if (url.pathname === '/api/translation/config') return json({ configured: false });
    if (url.pathname === '/api/media/m') return json({ id: 'm', title: 'Quality fixture', type: 'anime', seasons: [] });
    if (url.pathname === '/api/media') return json({ items: [], total: 0 });
    if (url.pathname.endsWith('/markers')) return json({ status: 'unavailable' });
    return route.fulfill({ status: 204 });
  });
  await fallbackContext.route('**/fixture/**', serveMedia);
  const fallbackPage = await fallbackContext.newPage();
  fallbackPage.on('pageerror', error => errors.push(error.message));
  await fallbackPage.goto(`${base}/watch/ep?t=0`);
  const ready = (expected = sessions.length) => fallbackPage.waitForFunction(count => { const v = document.querySelector('.player-video'); return v?.readyState >= 2 && !v.paused && v.currentSrc.includes(`?session=${count}`); }, expected);
  await ready(1);
  await fallbackPage.locator('video').evaluate(video => { video.currentTime = 30; });
  for (const [index, expected] of ['0', '1'].entries()) {
    await fallbackPage.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
    for (let n = 0; n < 100 && sessions.length < index + 2; n++) await fallbackPage.waitForTimeout(50);
    assert.equal(sessions.at(-1).selected, expected);
    await ready();
  }
  await fallbackPage.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
  await fallbackPage.getByText('영상 데이터를 재생하지 못했습니다.', { exact: true }).waitFor();
  await fallbackPage.waitForTimeout(500);
  assert.deepEqual(sessions.map(session => session.selected), ['2', '0', '1']);
  assert.ok(sessions.slice(1).every(session => session.startPosition >= 29), 'fallback preserves playback position');
  await fallbackPage.getByRole('button', { name: '다시 시도', exact: true }).click();
  await ready(4);
  await fallbackPage.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
  for (let n = 0; n < 100 && sessions.length < 5; n++) await fallbackPage.waitForTimeout(50);
  assert.deepEqual(sessions.map(session => session.selected), ['2', '0', '1', '1', '2'], 'manual retry starts a fresh fallback attempt');
  assert.deepEqual(errors, []);
  console.log('PASS: nonzero default tries earlier servers once, preserves position, stops after exhaustion and supports retry');
  await fallbackContext.close();
} finally { await browser.close(); await web.close(); }
