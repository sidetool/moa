// Synthetic local video only. Verifies restarting both before and after media is ready.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_VERIFY_URL || 'http://127.0.0.1:18834';
const bytes = await readFile(process.env.MOA_TEST_VIDEO);
assert.ok(bytes.length > 0, 'provide a nonempty synthetic MP4 longer than 45 seconds');
const modes = process.env.MOA_TEST_HLS ? ['direct', 'hls'] : ['direct'];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const mode of modes) for (const early of [true, false]) for (const query of ['', '?t=40', '?t=0']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(() => localStorage.setItem('moa.profile', 'test'));
    const calls = [], errors = [];
    let release;
    const mediaGate = new Promise(resolve => { release = resolve; });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (url.pathname.startsWith('/fixture/hls/')) {
        if (early && url.searchParams.get('session') === '1') await mediaGate;
        const name = path.basename(url.pathname);
        if (!/^(master\.m3u8|part-\d+\.ts)$/.test(name)) return route.abort();
        const body = await readFile(path.join(process.env.MOA_TEST_HLS, name));
        return route.fulfill({ contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body }).catch(() => {});
      }
      if (url.pathname === '/fixture/video.mp4') {
        if (early && url.searchParams.get('session') === '1') await mediaGate;
        const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } }).catch(() => {});
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/playback' && request.method() === 'POST') {
        const body = request.postDataJSON(); calls.push(body);
        return json({ sessionId: `session-${calls.length}`, episodeId: 'ep', mediaId: 'm', mediaTitle: 'Restart fixture', mediaType: 'movie', mode: 'direct', mime: mode === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4', url: `/fixture/${mode === 'hls' ? 'hls/master.m3u8' : 'video.mp4'}?session=${calls.length}`, duration: 70, startPosition: body.startPosition ?? 40, subtitles: [], audioTracks: [], next: null });
      }
      if (url.pathname === '/api/settings') return json({ autoFetchSubtitles: false, autoplayNext: false, defaultSubtitleLang: 'ko', subtitleSize: 'medium', generalSkipEnabled: false });
      if (url.pathname === '/api/me') return json({ role: 'admin' });
      if (url.pathname === '/api/plugin-runtime') return json([]);
      if (url.pathname === '/api/media/m') return json({ id: 'm', title: 'Restart fixture', type: 'movie', seasons: [] });
      if (url.pathname.endsWith('/markers')) return json({ status: 'unavailable' });
      return route.fulfill({ status: 204 });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e))); page.setDefaultTimeout(10000);
    try {
      await page.goto(`${base}/watch/ep${query}`);
      if (query === '?t=0') {
        release();
        await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3);
        assert.equal(calls[0].startPosition, 0);
        assert.equal(await page.getByRole('button', { name: '처음부터', exact: true }).count(), 0);
        assert.deepEqual(errors, []);
        console.log(`PASS: ${mode} explicit zero has no resume prompt`);
        continue;
      }
      await page.getByRole('button', { name: '처음부터', exact: true }).waitFor();
      if (early) {
        assert.equal(await page.locator('video').evaluate(v => v.readyState), 0);
        if (query) {
          await page.waitForTimeout(7500);
          assert.ok(await page.getByRole('button', { name: '처음부터', exact: true }).isVisible(), 'loading must not consume the restart prompt');
        }
      }
      else await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime >= 40; });
      await page.getByRole('button', { name: '처음부터', exact: true }).click();
      release();
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 3 && !v.paused && v.currentTime > .1; });
      const position = await page.locator('video').evaluate(v => v.currentTime);
      assert.ok(position < 3, `restart must stay near zero, got ${position} (early=${early})`);
      assert.equal(calls.at(-1).startPosition, 0, 'explicit zero supersedes saved progress');
      assert.equal(await page.getByRole('button', { name: '처음부터', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${mode} restart ${early ? 'before metadata' : 'during playback'} ${query || 'saved history'} starts at zero`);
    } finally { release(); await context.close(); }
  }
} finally { await browser.close(); }
