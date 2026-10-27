import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const source = process.env.MOA_TEST_VIDEO;
assert.ok(source, 'MOA_TEST_VIDEO must point to a local video at least 600 seconds long');
const fixture = await mkdtemp(join(tmpdir(), 'moa-preview-'));
execFileSync('ffmpeg', ['-v', 'error', '-i', source, '-t', '60', '-an', '-c:v', 'copy', '-hls_time', '4', '-hls_playlist_type', 'vod', join(fixture, 'video.m3u8')]);
const clips = new Map();
for (const seconds of [20, 60, 1379, 1380, 1440, 1499, 1500]) {
  const filename = `short-${seconds}.mp4`;
  execFileSync('ffmpeg', ['-v', 'error', '-stream_loop', '-1', '-i', source, '-t', String(seconds), '-an', '-c:v', 'copy', join(fixture, filename)]);
  clips.set(filename, await readFile(join(fixture, filename)));
}
execFileSync('ffmpeg', ['-v', 'error', '-ss', '20', '-i', source, '-frames:v', '1', '-vf', 'scale=160:-1', '-pix_fmt', 'yuvj420p', join(fixture, 'preview.jpg')]);
const bytes = await readFile(source), jpeg = await readFile(join(fixture, 'preview.jpg'));
process.env.VITE_MOCK = '0';
const web = process.env.MOA_VERIFY_URL ? null : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await web?.listen();
const base = process.env.MOA_VERIFY_URL || web.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], results = [];
try {
  for (const [width, mode] of [[1280, 'direct'], [1280, 'hls'], [1280, 'remux'], [390, 'direct']]) {
    console.error(`Verifying ${mode} at ${width}px`);
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 600 });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
    const previews = [];
    const sessions = [];
    let videoRequests = 0, resumePosition = 10, autoplayNext = true, autoplayDelay = 5, ending = mode === 'remux' ? undefined : 600, markerDelay = 0, settingsDelay = 0, remoteMarkers = false, short = 0;
    let mediaType = 'anime', markerOverride;
    const markers = () => ({ source: 'aniskip', introStart: 20, introEnd: 80, creditsStart: 480, ...(ending === undefined ? {} : { creditsEnd: ending }) });
    await context.route(url => url.pathname.startsWith('/fixture/'), async route => {
      const name = basename(new URL(route.request().url()).pathname);
      videoRequests++;
      if (name === 'video.mp4' || clips.has(name)) {
        const body = clips.get(name) ?? bytes;
        const match = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/), start = Number(match?.[1] || 0), end = Math.min(body.length - 1, match?.[2] ? Number(match[2]) : body.length - 1);
        return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4', body: body.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}) } });
      }
      return route.fulfill({ contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: await readFile(join(fixture, name)) });
    });
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/playback' && route.request().method() === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 500));
        const { episodeId, startPosition } = route.request().postDataJSON();
        sessions.push(episodeId);
        return route.fulfill({ json: { sessionId: `preview-${episodeId}`, episodeId, episodeLabel: episodeId, mediaId: 'm', mediaTitle: '미리보기 확인', mediaType, mode: mode === 'remux' ? 'remux' : 'direct', mime: mode === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4', url: short ? `/fixture/short-${short}.mp4` : `/fixture/video.${mode === 'hls' ? 'm3u8' : 'mp4'}`, duration: short || (mode === 'hls' ? 60 : 600), startPosition: startPosition ?? (episodeId === 'ep' ? resumePosition : 10), subtitles: [], audioTracks: [], next: episodeId === 'ep' ? { episodeId: 'e2', title: '다음 회차', label: '2화' } : null, markers: markerOverride ?? (short || remoteMarkers ? undefined : markers()) } });
      }
      if (path.endsWith('/preview')) { previews.push(Number(url.searchParams.get('at'))); return route.fulfill({ contentType: 'image/jpeg', body: jpeg }); }
      if (path.endsWith('/markers')) { await new Promise(resolve => setTimeout(resolve, markerDelay)); return route.fulfill({ json: remoteMarkers ? { status: 'ready', markers: markers() } : { status: 'unavailable' } }); }
      if (path === '/api/settings') { await new Promise(resolve => setTimeout(resolve, settingsDelay)); return route.fulfill({ json: { defaultSubtitleLang: 'ko', autoFetchSubtitles: false, autoplayNext, autoplayDelay, rememberSubtitles: false } }); }
      if (path === '/api/me') return route.fulfill({ json: { id: 'admin', role: 'admin', permissions: ['video.watch', 'subtitles.add'] } });
      if (path === '/api/translation/config') return route.fulfill({ json: { enabled: false, configured: false } });
      if (path === '/api/plugin-runtime') return route.fulfill({ json: [] });
      if (path === '/api/episodes/ep/context') return route.fulfill({ json: { mediaId: 'm', season: 1, number: 1 } });
      if (path === '/api/media/m') return route.fulfill({ json: { id: 'm', title: '미리보기 확인', type: 'anime', seasons: [], playTarget: null } });
      return route.fulfill({ status: 204 });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(new URL('watch/ep', base).href);
    const loading = page.locator('.player-loading');
    await loading.waitFor({ state: 'visible' });
    assert.notEqual(await loading.evaluate(element => getComputedStyle(element).display), 'none');
    await page.waitForFunction(() => document.querySelector('.player-video')?.currentTime > 10).catch(async error => {
      console.error(await page.locator('.player-video').evaluate(video => ({ position: video.currentTime, duration: video.duration, paused: video.paused, readyState: video.readyState, error: video.error?.message })));
      throw error;
    });
    await page.locator('.player-video').evaluate(video => video.pause());
    await page.waitForFunction(() => !document.querySelector('.player-video').seeking);
    const before = await page.locator('.player-video').evaluate(video => video.currentTime);
    assert.equal(await page.locator('video').count(), 1);
    const seek = await page.locator('.seek').boundingBox();
    const previewStarted = performance.now();
    if (mode === 'remux') {
      await page.mouse.move(seek.x + seek.width * .1, seek.y + seek.height / 2);
      await page.mouse.move(seek.x + seek.width * .2, seek.y + seek.height / 2);
    }
    await page.mouse.move(seek.x + seek.width * .4, seek.y + seek.height / 2);
    if (mode === 'remux') {
      await page.waitForFunction(() => document.querySelector('.seek-preview img')?.naturalWidth > 0);
      assert.equal(previews.length, 1);
      assert.ok(Math.abs(previews[0] - 240) <= 2.1);
      assert.equal(await page.locator('video').count(), 1);
    } else {
      await page.waitForFunction(() => { const video = document.querySelector('.seek-preview video'); return video?.readyState >= 2 && getComputedStyle(video).opacity === '1'; });
      const current = await page.locator('.seek-preview video').evaluate(video => video.currentTime);
      assert.ok(Math.abs(current - (mode === 'hls' ? 24 : 240)) <= 2.1, `${mode}: unexpected preview position ${current}`);
      assert.equal(await page.locator('.seek-preview video').evaluate(video => video.paused), true);
      await page.mouse.move(seek.x + seek.width * .7, seek.y + seek.height / 2);
      await page.waitForFunction(at => { const video = document.querySelector('.seek-preview video'); return video?.readyState >= 2 && Math.abs(video.currentTime - at) <= 2.1 && getComputedStyle(video).opacity === '1'; }, mode === 'hls' ? 42 : 420);
    }
    const previewMs = Math.round(performance.now() - previewStarted);
    assert.equal(await page.locator('.player-video').evaluate(video => video.currentTime), before);
    await page.locator('.seek-preview').evaluate(element => { element.dataset.retained = 'yes'; });
    const tip = await page.locator('.seek-tip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= width);
    await page.screenshot({ path: verificationPath(`verification-player-preview-${mode}-${width}.png`) });
    await page.mouse.move(4, 4);
    assert.equal(await page.locator('.seek-preview').isVisible(), false);
    assert.equal(await page.locator('video').count(), mode === 'remux' ? 1 : 2);
    const requestsBeforeReturn = previews.length + videoRequests;
    await page.mouse.move(seek.x + seek.width * (mode === 'remux' ? .4 : .7), seek.y + seek.height / 2);
    assert.equal(await page.locator('.seek-preview').getAttribute('data-retained'), 'yes');
    assert.equal(await page.locator('.seek-preview').isVisible(), true);
    assert.equal(previews.length + videoRequests, requestsBeforeReturn);
    await page.mouse.move(4, 4);
    await page.getByLabel('자막 파일 선택', { exact: true }).setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('unsupported subtitle') });
    const notice = page.locator('.player-notice');
    await notice.waitFor({ state: 'visible' });
    const noticeBox = await notice.boundingBox();
    assert.ok(noticeBox.y + noticeBox.height <= (await page.locator('.seek').boundingBox()).y);
    assert.ok(noticeBox.y + noticeBox.height <= 844);
    await page.locator('.player-video').evaluate(video => video.play());
    await page.waitForFunction(() => document.querySelector('.player')?.classList.contains('is-idle'));
    assert.equal(await notice.evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await notice.locator('button').evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.player-controls-chrome')).opacity === '0');
    await page.screenshot({ path: verificationPath(`verification-player-notice-${width}.png`) });
    results.push({ width, mode, mainPosition: before, previewRequests: previews.length, previewMs, retainedOnReturn: true, noticeVisibleWithoutControls: true });
    if (mode !== 'hls') {
      await page.locator('.player-video').evaluate(video => { video.pause(); video.currentTime = 30; });
      await page.getByRole('button', { name: '오프닝 건너뛰기', exact: true }).click();
      await page.waitForFunction(() => { const video = document.querySelector('.player-video'); return video.paused && video.currentTime >= 80; });
      await page.locator('.player-video').evaluate(video => { video.currentTime = 490; });
      await page.getByRole('button', { name: '엔딩 건너뛰기', exact: true }).waitFor();
      assert.equal(await page.locator('.next-card').count(), 1);
      await page.locator('.player-video').evaluate(video => video.play());
      await page.locator('.next-countdown').waitFor();
      const button = await page.locator('.next-play').boundingBox(), progress = await page.locator('.next-countdown').boundingBox();
      assert.ok(Math.abs(button.y + button.height - progress.y - progress.height) < 2);
      assert.equal(await page.locator('.next-countdown').evaluate(element => element.offsetWidth), await page.locator('.next-play').evaluate(element => element.clientWidth));
      assert.notEqual(await page.locator('.next-card').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
      const card = await page.locator('.next-card').boundingBox(), notice = await page.locator('.player-notice').boundingBox();
      assert.ok(card.y + card.height + 8 <= notice.y);
      await page.screenshot({ path: verificationPath(`verification-player-next-${mode}-${width}.png`) });
      await page.mouse.move(30, 30);
      await page.waitForTimeout(1300);
      assert.equal(await page.locator('.next-countdown').count(), 0);
      assert.match(page.url(), /watch\/ep$/);
      await page.getByRole('button', { name: '엔딩 건너뛰기', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.player-video').ended);
      assert.match(page.url(), /watch\/ep$/);
      await page.getByRole('button', { name: '다음 화 재생', exact: true }).click();
      await page.waitForURL('**/watch/e2');
      await page.waitForFunction(() => document.querySelector('.player-title span')?.textContent.includes('e2') && document.querySelector('.player-video')?.readyState >= 2);
      await page.locator('.player-video').evaluate(video => { video.pause(); video.currentTime = 490; });
      await page.getByRole('button', { name: '엔딩 건너뛰기', exact: true }).click();
      await page.getByRole('button', { name: '다시 보기', exact: true }).waitFor();
      assert.equal(await page.locator('.next-card').count(), 0);
      results.push({ width, mode, pausedSkip: true, endingPrompt: true, nextCancelledByMouse: true, countdownAtButtonBottom: true, noticeSeparated: true, blurredCard: true, finalEndingSkip: true, missingEndingBoundary: mode === 'remux' });
    }
    if (width === 1280 && mode === 'direct') {
      assert.deepEqual(await page.evaluate(async () => {
        const { resumeTarget } = await import('/src/features/catalog/card-meta.ts');
        return ['resume', 'next'].map(kind => resumeTarget({ resume: { episodeId: 'ep', label: '1화', position: kind === 'resume' ? 500 : 0, kind } }).path);
      }), ['/watch/ep?t=500&resume=1', '/watch/ep?t=0']);
      autoplayDelay = 30;
      const cases = [
        { name: 'server resume', saved: 500, next: true },
        { name: 'home resume', saved: 500, query: '?t=500&resume=1', next: true },
        { name: 'explicit restart', saved: 500, query: '?t=0' },
        { name: 'explicit position', saved: 500, query: '?t=500' },
        { name: 'autoplay disabled', saved: 500, autoplay: false },
        { name: 'postcredits preserved', saved: 500, ending: 540 },
        { name: 'postcredits tail resume', saved: 590, ending: 540, next: true },
        { name: 'delayed postcredits markers', saved: 575, ending: 540, markerDelay: 1400 },
        { name: 'delayed autoplay disabled', saved: 590, autoplay: false, settingsDelay: 1400 },
        { name: '20s middle resume', saved: 10, short: 20 },
        { name: '20s tail resume', saved: 19, short: 20, next: true },
        { name: '60s middle resume', saved: 35, short: 60 },
        { name: '60s tail resume', saved: 57, short: 60, next: true }
      ];
      for (const test of cases) {
        console.error(`Verifying ${test.name}`);
        resumePosition = test.saved;
        autoplayNext = test.autoplay !== false;
        ending = test.ending ?? 600;
        markerDelay = test.markerDelay ?? 0;
        settingsDelay = test.settingsDelay ?? 0;
        remoteMarkers = Boolean(test.markerDelay);
        short = test.short ?? 0;
        sessions.length = 0;
        await page.goto(new URL(`watch/ep${test.query ?? ''}`, base).href);
        if (test.next) {
          await page.waitForURL('**/watch/e2', { timeout: 5000 });
          await page.waitForFunction(() => document.querySelector('.player-title span')?.textContent.includes('e2') && document.querySelector('.player-video')?.readyState >= 2);
        } else {
          await page.waitForFunction(() => document.querySelector('.player-title span')?.textContent.includes('ep') && document.querySelector('.player-video')?.readyState >= 2);
          await page.locator('.player-video').evaluate(video => video.pause());
          await page.waitForTimeout(Math.max(markerDelay, settingsDelay) + 500);
          assert.ok(new URL(page.url()).pathname.endsWith('/watch/ep'), test.name);
          assert.equal(sessions.includes('e2'), false, test.name);
          if (test.ending || test.short) assert.equal(await page.locator('.next-card').count(), 0, test.name);
        }
        results.push({ resume: test.name, advanced: Boolean(test.next), passed: true });
      }
      resumePosition = 0;
      autoplayNext = true;
      autoplayDelay = 1;
      markerDelay = settingsDelay = 0;
      remoteMarkers = false;
      short = 20;
      await page.goto(new URL('watch/ep', base).href);
      await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2);
      await page.locator('.player-video').evaluate(video => { video.currentTime = 19.5; void video.play(); });
      await page.waitForURL('**/watch/e2', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.player-title span')?.textContent.includes('e2') && document.querySelector('.player-video')?.readyState >= 2);
      results.push({ shortVideoEndedAutoplay: true, passed: true });
      autoplayNext = false;
      for (const test of [
        { duration: 1379, promptAt: 1349 },
        { duration: 1380, promptAt: 1320 },
        { duration: 1440, promptAt: 1320 },
        { duration: 1499, promptAt: 1320 },
        { duration: 1500, promptAt: 1470 },
        { duration: 1440, type: 'series', promptAt: 1410 },
        { duration: 1440, markers: { source: 'aniskip', creditsStart: 1390, creditsEnd: 1440 }, promptAt: 1390 },
        { duration: 1440, markers: { source: 'aniskip', creditsStart: 1290, creditsEnd: 1340 }, promptAt: 1425 }
      ]) {
        console.error(`Verifying ${test.type ?? 'anime'} ${test.duration}s prompt at ${test.promptAt}s`);
        short = test.duration;
        mediaType = test.type ?? 'anime';
        markerOverride = test.markers;
        await page.goto(new URL('watch/ep?t=0', base).href);
        await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2);
        await page.locator('.player-video').evaluate((video, at) => { video.pause(); video.currentTime = at; }, test.promptAt - 1);
        await page.waitForFunction(() => !document.querySelector('.player-video').seeking);
        assert.equal(await page.locator('.next-card').count(), 0);
        await page.locator('.player-video').evaluate((video, at) => { video.currentTime = at; }, test.promptAt);
        await page.locator('.next-card').waitFor();
        assert.equal(await page.locator('.next-countdown').count(), 0);
        if (test.duration === 1440 && !test.type && !test.markers) {
          await page.waitForFunction(() => getComputedStyle(document.querySelector('.next-card')).opacity === '1');
          await page.screenshot({ path: verificationPath('player-anime-22m.png') });
        }
        results.push({ animePrompt: test, passed: true });
      }
    }
    await page.locator('.player-video').evaluate(video => { video.currentTime = 0; });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, results, errors }));
} finally { await browser.close(); await web?.close(); await rm(fixture, { recursive: true, force: true }); }
