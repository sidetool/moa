// Actual player, synthetic 24-minute MP4 and isolated API responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const bytes = await readFile(process.env.MOA_TEST_VIDEO);
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', plugins: [{ name: 'isolated-api', configureServer(server) { server.middlewares.use('/api', (_req, res) => { res.statusCode = 503; res.end(); }); } }], server: { host: '127.0.0.1', port: 0, open: false, hmr: false } });
await web.listen();
const base = web.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const ending = { source: 'aniskip', creditsStart: 1320, creditsEnd: 1440 };
try {
  for (const scenario of [
    { name: 'unmarked anime does not skip at 22 minutes', at: 1321 },
    { name: 'intro-only markers do not authorize early transition', at: 1321, markers: { source: 'aniskip', introStart: 0, introEnd: 90 } },
    { name: 'unmarked history resume stays on its episode', resume: 1351 },
    { name: 'configured 90-second lead counts down', at: 1351, lead: 90, auto: true },
    { name: 'untouched card automatically advances after the configured five seconds', at: 1351, lead: 90, delay: 5, auto: true },
    { name: 'configured lead resume counts down instead of jumping immediately', resume: 1351, lead: 90, auto: true },
    { name: 'a countdown crossing EOF is not restarted', at: 1439.1, lead: 1, auto: true, crossesEnd: true },
    { name: 'AniSkip ending keeps early autoplay', at: 1321, markers: ending, auto: true },
    { name: 'AniSkip timing overrides an unmarked lead setting', at: 1321, lead: 30, markers: ending, auto: true },
    { name: 'PC mouse movement cancels autoplay but keeps the card through idle and reentry', at: 1351, lead: 90, cancel: 'mouse', width: 1280 },
    { name: 'PC mouse cancellation persists through AniSkip reentry', at: 1321, markers: ending, cancel: 'mouse', width: 1280 },
    { name: 'mobile tap cancels countdown', at: 1351, lead: 90, cancel: 'touch' },
    { name: 'mobile card body tap dismisses the card', at: 1351, lead: 90, cancel: 'card' },
    { name: 'TV Up immediately dismisses the card', at: 1351, lead: 90, cancel: 'remote', width: 1280 },
    { name: 'TV Left dismisses the card while seeking', at: 1351, lead: 90, cancel: 'remoteLeft', width: 1280 },
    { name: 'TV Back dismisses the card without leaving playback', at: 1351, lead: 90, cancel: 'remoteBack', width: 1280 },
    { name: 'PC focused next button still activates on Enter', at: 1351, lead: 90, action: 'next', keyboard: true, width: 1280 },
    { name: 'PC mouse can select next after cancelling the countdown', at: 1351, lead: 90, action: 'next', mouseCancel: true, width: 1280 },
    { name: 'mobile next button still activates on tap', at: 1351, lead: 90, action: 'next' },
    { name: 'TV focused next button still activates on Enter', at: 1351, lead: 90, action: 'next', remote: true, width: 1280 },
    { name: 'PC focused continue button dismisses the card', at: 1351, lead: 90, action: 'dismiss', keyboard: true, width: 1280 },
    { name: 'PC mouse can explicitly dismiss the cancelled card', at: 1351, lead: 90, action: 'dismiss', mouseCancel: true, width: 1280 },
    { name: 'mobile continue button dismisses the card', at: 1351, lead: 90, action: 'dismiss' },
    { name: 'TV focused continue button dismisses the card', at: 1351, lead: 90, action: 'dismiss', remote: true, width: 1280 },
    { name: 'mobile close at EOF stays closed without autoplay', at: 1439.6, action: 'dismiss', atEnd: true },
    { name: 'EOF advances while marker lookup is pending', at: 1439.6, pending: true, auto: true },
    { name: 'autoplay off remains off at EOF', at: 1351, lead: 90, disabled: true },
  ].filter(scenario => !process.env.MOA_NEXT_SCENARIO || scenario.name.includes(process.env.MOA_NEXT_SCENARIO))) {
    const context = await browser.newContext({ viewport: { width: scenario.width ?? 390, height: 844 }, hasTouch: !scenario.width });
    await context.addInitScript(remote => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', remote ? 'on' : 'off'); }, scenario.cancel?.startsWith('remote') || scenario.remote === true);
    const sessions = [], errors = [];
    let releaseMarkers;
    const pendingMarkers = new Promise(resolve => { releaseMarkers = resolve; });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/fixture/video.mp4') {
        const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/playback' && request.method() === 'POST') {
        const body = request.postDataJSON(); sessions.push(body.episodeId);
        return json({ sessionId: `session-${sessions.length}`, episodeId: body.episodeId, episodeLabel: body.episodeId, mediaId: 'm', mediaTitle: 'Next-up fixture', mediaType: 'anime', mode: 'direct', mime: 'video/mp4', url: '/fixture/video.mp4', duration: 1440, startPosition: body.startPosition ?? (body.episodeId === 'ep' ? scenario.resume ?? 0 : 0), resumeFromHistory: Boolean(scenario.resume), subtitles: [], audioTracks: [], next: body.episodeId === 'ep' ? { episodeId: 'ep2', label: '2화', title: '다음 회차' } : null, markers: scenario.markers });
      }
      if (url.pathname === '/api/settings') return json({ autoFetchSubtitles: false, autoplayNext: !scenario.disabled, autoplayDelay: scenario.delay ?? 2, nextEpisodeLeadSeconds: scenario.lead ?? 0, defaultSubtitleLang: 'ko', subtitleSize: 'medium' });
      if (url.pathname === '/api/me') return json({ role: 'admin' });
      if (url.pathname === '/api/plugin-runtime') return json([]);
      if (url.pathname === '/api/translation/config') return json({ configured: false });
      if (url.pathname === '/api/media/m') return json({ id: 'm', title: 'Next-up fixture', type: 'anime', seasons: [] });
      if (url.pathname === '/api/media') return json({ items: [], total: 0 });
      if (url.pathname.endsWith('/markers')) { if (scenario.pending) await pendingMarkers; return json({ status: 'unavailable' }).catch(() => {}); }
      return route.fulfill({ status: 204 });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(`${base}/watch/ep${scenario.resume ? '' : '?t=0'}`);
      await page.waitForFunction(() => { const video = document.querySelector('.player-video'); return video?.readyState >= 2 && !video.paused; });
      if (scenario.at) await page.locator('.player-video').evaluate((video, at) => { video.currentTime = at; }, scenario.at);
      if (scenario.auto) {
        if (!scenario.pending) {
          await page.locator('.next-countdown').waitFor();
          if (!scenario.crossesEnd) await page.locator('.next-card').getByRole('button', { name: scenario.markers?.creditsStart !== undefined ? '엔딩 보기' : '계속 보기', exact: true }).waitFor();
          assert.deepEqual(sessions, ['ep'], 'countdown must precede transition');
          if (scenario.delay === 5) { await page.waitForTimeout(3500); assert.deepEqual(sessions, ['ep'], 'configured five-second delay must be honored'); }
        }
        await page.waitForURL('**/watch/ep2', scenario.crossesEnd ? { timeout: 2600 } : {});
      } else if (scenario.action) {
        await page.locator('.next-countdown').waitFor();
        if (scenario.mouseCancel) {
          await page.mouse.move(200, 200);
          await page.locator('.next-countdown').waitFor({ state: 'detached' });
          await page.waitForTimeout(3500);
          assert.equal(await page.locator('.next-card').count(), 1, 'the cancelled card must remain available');
          assert.deepEqual(sessions, ['ep']);
        }
        const button = scenario.action === 'next' ? page.locator('.next-play') : page.locator('.next-card').getByRole('button', { name: scenario.atEnd ? '닫기' : '계속 보기', exact: true });
        if (scenario.remote || scenario.keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
        else if (scenario.width) await button.click();
        else await button.tap();
        if (scenario.action === 'next') await page.waitForURL('**/watch/ep2');
        else {
          await page.waitForTimeout(2400);
          assert.deepEqual(sessions, ['ep']);
          assert.equal(await page.locator('.next-card').count(), 0);
          assert.equal(await page.locator('.player-video').evaluate(video => video.paused), Boolean(scenario.atEnd), 'dismissing must leave an unfinished video running');
        }
      } else if (scenario.cancel) {
        await page.locator('.next-countdown').waitFor();
        if (scenario.cancel === 'mouse') await page.mouse.move(200, 200);
        else if (scenario.cancel === 'touch') await page.touchscreen.tap(180, 220);
        else if (scenario.cancel === 'card') await page.locator('.next-card b').tap();
        else if (scenario.cancel === 'remoteBack') await page.keyboard.press('Backspace');
        else if (scenario.cancel === 'remoteLeft') await page.keyboard.press('ArrowLeft');
        else await page.keyboard.press('ArrowUp');
        if (scenario.cancel === 'mouse') {
          await page.locator('.next-countdown').waitFor({ state: 'detached', timeout: 750 });
          await page.waitForTimeout(3500);
          assert.equal(await page.locator('.player.is-idle').count(), 1, 'exercise the hidden-controls state');
          assert.equal(await page.locator('.next-card').isVisible(), true, 'idle must not hide the cancelled card');
          assert.deepEqual(sessions, ['ep']);
          await page.locator('.player-video').evaluate((video, at) => { video.currentTime = at - 30; }, scenario.at);
          await page.locator('.next-card').waitFor({ state: 'detached' });
          await page.locator('.player-video').evaluate((video, at) => { video.currentTime = at; }, scenario.at);
          await page.locator('.next-card').waitFor();
          await page.waitForTimeout(2400);
          assert.equal(await page.locator('.next-countdown').count(), 0, 'reentry must not restart cancelled autoplay');
          assert.deepEqual(sessions, ['ep']);
          assert.equal(await page.locator('.player-video').evaluate(video => video.paused), false);
          await page.locator('.player-video').evaluate(video => { video.currentTime = video.duration - .3; });
          await page.waitForFunction(() => document.querySelector('.player-video')?.ended);
          await page.waitForTimeout(2400);
          assert.equal(await page.locator('.next-card').isVisible(), true, 'beta.1 keeps the cancelled card at EOF');
          assert.equal(await page.locator('.next-countdown').count(), 0);
          assert.deepEqual(sessions, ['ep'], 'EOF must not restart cancelled autoplay');
          await page.locator('.next-card').getByRole('button', { name: '닫기', exact: true }).click();
          await page.getByRole('button', { name: '다시 보기', exact: true }).waitFor();
          assert.equal(await page.locator('.next-card').count(), 0);
        } else {
          await page.locator('.next-card').waitFor({ state: 'detached', timeout: 750 });
          await page.waitForTimeout(2400);
          assert.deepEqual(sessions, ['ep']);
          assert.equal(await page.locator('.next-countdown').count(), 0);
          assert.equal(await page.locator('.next-card').count(), 0, 'cancelling must remove the card, not leave an inert prompt over the video');
          await page.locator('.player-video').evaluate(video => { video.currentTime += 10; });
          await page.waitForTimeout(600);
          assert.equal(await page.locator('.next-card').count(), 0, 'the dismissed card must not reappear in the same ending');
          assert.equal(await page.locator('.player-video').evaluate(video => video.paused), false, 'cancelling must leave playback running');
          await page.locator('.player-video').evaluate(video => { video.currentTime = video.duration - .3; });
          await page.getByRole('button', { name: '다시 보기', exact: true }).waitFor();
          await page.waitForTimeout(2400);
          assert.deepEqual(sessions, ['ep'], 'a cancelled transition must not restart at EOF');
          assert.equal(await page.locator('.next-card').count(), 0);
        }
      } else {
        await page.waitForTimeout(2400);
        assert.deepEqual(sessions, ['ep']);
        assert.equal(await page.locator('.next-countdown').count(), 0);
        if (!scenario.disabled) assert.equal(await page.locator('.next-card').count(), 0);
        await page.locator('.player-video').evaluate(video => { video.currentTime = video.duration - .3; void video.play(); });
        if (scenario.disabled) {
          await page.getByRole('button', { name: '다시 보기', exact: true }).waitFor();
          await page.waitForTimeout(2400);
          assert.deepEqual(sessions, ['ep']);
        } else await page.waitForURL('**/watch/ep2');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: ${scenario.name}`);
    } finally { releaseMarkers(); await context.close(); }
  }
} finally { await browser.close(); await web.close(); }
