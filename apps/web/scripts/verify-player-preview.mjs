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
assert.ok(source, 'MOA_TEST_VIDEO must point to a local video at least 60 seconds long');
const fixture = await mkdtemp(join(tmpdir(), 'moa-preview-'));
execFileSync('ffmpeg', ['-v', 'error', '-i', source, '-t', '60', '-an', '-c:v', 'copy', '-hls_time', '4', '-hls_playlist_type', 'vod', join(fixture, 'video.m3u8')]);
execFileSync('ffmpeg', ['-v', 'error', '-ss', '20', '-i', source, '-frames:v', '1', '-vf', 'scale=160:-1', join(fixture, 'preview.jpg')]);
const bytes = await readFile(source), jpeg = await readFile(join(fixture, 'preview.jpg'));
process.env.VITE_MOCK = '0';
const web = process.env.MOA_VERIFY_URL ? null : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await web?.listen();
const base = process.env.MOA_VERIFY_URL || web.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], results = [];
try {
  for (const [width, mode] of [[1280, 'direct'], [1280, 'hls'], [1280, 'remux'], [390, 'direct']]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 600 });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
    const previews = [];
    await context.route(url => url.pathname.startsWith('/fixture/'), async route => {
      const name = basename(new URL(route.request().url()).pathname);
      if (name === 'video.mp4') {
        const match = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/), start = Number(match?.[1] || 0), end = Math.min(bytes.length - 1, match?.[2] ? Number(match[2]) : bytes.length - 1);
        return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
      }
      return route.fulfill({ contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: await readFile(join(fixture, name)) });
    });
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/playback' && route.request().method() === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 500));
        return route.fulfill({ json: { sessionId: 'preview-test', episodeId: 'ep', mediaId: 'm', mediaTitle: '미리보기 확인', mediaType: 'anime', mode: mode === 'remux' ? 'remux' : 'direct', mime: mode === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4', url: `/fixture/video.${mode === 'hls' ? 'm3u8' : 'mp4'}`, duration: mode === 'hls' ? 60 : 600, startPosition: 10, subtitles: [], audioTracks: [], next: null } });
      }
      if (path.endsWith('/preview')) { previews.push(Number(url.searchParams.get('at'))); return route.fulfill({ contentType: 'image/jpeg', body: jpeg }); }
      if (path.endsWith('/markers')) return route.fulfill({ json: { status: 'unavailable' } });
      if (path === '/api/settings') return route.fulfill({ json: { defaultSubtitleLang: 'ko', autoFetchSubtitles: false, autoplayNext: false, rememberSubtitles: false } });
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
    await page.waitForFunction(() => document.querySelector('.player-video')?.currentTime > 10);
    await page.locator('.player-video').evaluate(video => video.pause());
    await page.waitForFunction(() => !document.querySelector('.player-video').seeking);
    const before = await page.locator('.player-video').evaluate(video => video.currentTime);
    const seek = await page.locator('.seek').boundingBox();
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
    assert.equal(await page.locator('.player-video').evaluate(video => video.currentTime), before);
    const tip = await page.locator('.seek-tip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= width);
    await page.screenshot({ path: verificationPath(`verification-player-preview-${mode}-${width}.png`) });
    await page.mouse.move(4, 4);
    assert.equal(await page.locator('.seek-preview').count(), 0);
    assert.equal(await page.locator('video').count(), 1);
    await page.getByLabel('자막 파일 선택', { exact: true }).setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('unsupported subtitle') });
    const notice = page.locator('.player-notice');
    await notice.waitFor({ state: 'visible' });
    const noticeBox = await notice.boundingBox(), controls = await page.locator('.player-controls').boundingBox();
    assert.ok(noticeBox.y >= controls.y + controls.height);
    assert.ok(noticeBox.y + noticeBox.height <= 844);
    await page.screenshot({ path: verificationPath(`verification-player-notice-${width}.png`) });
    results.push({ width, mode, mainPosition: before, previewRequests: previews.length });
    await page.locator('.player-video').evaluate(video => { video.currentTime = 0; });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, results, errors }));
} finally { await browser.close(); await web?.close(); await rm(fixture, { recursive: true, force: true }); }
