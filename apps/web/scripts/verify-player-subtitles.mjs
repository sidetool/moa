import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const bytes = await readFile(process.env.MOA_TEST_VIDEO);
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', plugins: [{ name: 'isolated-api', configureServer(server) { server.middlewares.use('/api', (_req, res) => { res.statusCode = 503; res.end(); }); } }], server: { port: 0, open: false, hmr: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], results = [];
const own = { id: 'site-en', source: 'site', label: 'English', lang: 'en', format: 'vtt', url: '/fixture/subtitle.vtt' };
const online = { id: 'online-ko', source: 'online', label: '한국어', lang: 'ko', format: 'vtt', url: '/fixture/subtitle.vtt' };
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Pretendard,26,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,{\\pos(320,320)}원본 위치 자막
`;
async function fixture(options = {}) {
  const width = options.width ?? 1280;
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 600 });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'subtitle-test'); localStorage.setItem('moa.remoteMode', 'off'); });
  if (options.interactive) await context.addInitScript(() => { window.fullscreenRequests = 0; Element.prototype.requestFullscreen = function () { window.fullscreenRequests++; return Promise.resolve(); }; });
  const calls = { searches: [], applies: [], preferences: [], translations: 0 };
  let device = { subtitleSize: 'medium', subtitleScale: 100, subtitleHeight: options.ass ? 30 : 0, subtitleBackground: 'original', subtitleShadow: null, subtitleOutline: null, subtitlePadding: 6, holdSpeed: options.holdSpeed ?? 2 };
  let releaseSearch;
  const searchGate = options.searchGate ? new Promise(resolve => { releaseSearch = resolve; }) : Promise.resolve();
  await context.route('**/fixture/**', route => {
    if (route.request().url().endsWith('/master.m3u8')) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' + options.qualities.map(height => `#EXT-X-STREAM-INF:BANDWIDTH=${height * 1000},RESOLUTION=${Math.round(height * 16 / 9)}x${height},CODECS="avc1.42e01e"\n${height}.m3u8\n`).join('') });
    if (route.request().url().endsWith('.m3u8')) return new Promise(() => {});
    if (route.request().url().endsWith('.vtt')) return route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n자막 검증\n' });
    if (route.request().url().endsWith('.ass')) return route.fulfill({ contentType: 'text/plain', body: ass });
    const match = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/), start = Number(match?.[1] || 0), end = Math.min(bytes.length - 1, match?.[2] ? Number(match[2]) : bytes.length - 1);
    return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = data => route.fulfill({ json: data }).catch(() => {});
    if (path === '/api/settings') return json({ defaultSubtitleLang: 'ko', autoFetchSubtitles: !options.ass && !options.interactive, autoplayNext: false, translationMode: 'auto', ...device });
    if (path === '/api/settings/device') { if (req.method() === 'PATCH') device = { ...device, ...req.postDataJSON().settings }; return json({ settings: device }); }
    if (path === '/api/me') { if (options.accountDelay) await new Promise(resolve => setTimeout(resolve, options.accountDelay)); return json({ id: 'admin', role: 'admin' }); }
    if (path === '/api/plugin-runtime') return json([]);
    if (path === '/api/translation/config') return json({ enabled: !options.ass && !options.interactive, configured: true });
    if (path === '/api/playback' && req.method() === 'POST') {
      const { episodeId } = req.postDataJSON();
      return json({ sessionId: `session-${episodeId}`, episodeId, mediaId: 'm', mediaTitle: '자막 검증', episodeLabel: '1화', episodeTitle: '회차 이름도 함께 표시합니다', mediaType: 'anime', mode: 'direct', mime: options.qualities ? 'application/vnd.apple.mpegurl' : 'video/mp4', url: options.qualities ? '/fixture/master.m3u8' : '/fixture/video.mp4', duration: 600, startPosition: 1, streams: [{ id: '0', label: '720p' }], streamId: '0', subtitles: options.ass ? [{ ...own, id: 'ass', format: 'ass', url: '/fixture/subtitle.ass' }] : [own], audioTracks: [], next: null });
    }
    if (path === '/api/media/m') return json({ id: 'm', type: 'anime', title: '자막 검증', provider: { id: 'fixture', name: '테스트 소스', kind: 'extension' }, seasons: [] });
    if (path.endsWith('/markers')) return json({ status: 'unavailable' });
    if (path.endsWith('/preference')) {
      if (req.method() === 'PUT') { calls.preferences.push(req.postDataJSON()); return json({}); }
      return json({ ...(options.choice !== undefined ? { choice: options.choice } : {}) });
    }
    if (path.endsWith('/subtitles/online')) {
      if (req.method() === 'POST') { calls.applies.push(path); return json(online); }
      calls.searches.push(path);
      await searchGate;
      return json({ searchId: 'search', resolvedTitle: '자막 검증', candidates: [{ id: 'candidate', creatorName: '검증', filename: '01.vtt', format: 'vtt', matchedEpisode: 1, confidence: .95 }], partial: false, expiresAt: Date.now() + 60000 });
    }
    if (path.endsWith('/subtitles/translations') || path.endsWith('/subtitles/uploads')) return json([]);
    if (path === '/api/translation/jobs' && req.method() === 'POST') calls.translations++;
    return route.fulfill({ status: 204 }).catch(() => {});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  const levelsReady = options.qualities ? page.waitForRequest(request => /\/\d+\.m3u8$/.test(request.url())) : null;
  await page.goto(new URL('tests/fixtures/player.html', base).href);
  if (levelsReady) { await levelsReady; await page.locator('.player-video').dispatchEvent('loadedmetadata'); }
  else await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2);
  return { page, calls, releaseSearch, close: async () => { releaseSearch?.(); await context.close(); } };
}
async function waitFor(check, message) {
  for (let attempt = 0; attempt < 60; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(message);
}
async function openSubs(page) {
  await page.getByRole('button', { name: '자막 및 음성', exact: true }).dispatchEvent('click');
  await page.getByRole('dialog', { name: '자막 및 음성', exact: true }).waitFor();
}
try {
  if (!process.argv.includes('--subtitles-only')) {
  for (const width of [1280, 390, 320]) {
    const f = await fixture({ interactive: true, width, qualities: [240, 360, 480, 720, 1080, 1440, 2160] }), page = f.page;
    await page.getByRole('button', { name: '재생 설정', exact: true }).dispatchEvent('click');
    for (const name of ['재생 속도', '화질']) {
      const group = page.getByRole('group', { name, exact: true });
      assert.equal(await group.getByRole('button').count(), name === '화질' ? 8 : 6);
      const before = await group.evaluate(element => getComputedStyle(element, '::before').transform);
      await group.getByRole('button').last().click();
      await page.waitForFunction(element => element.getAnimations({ subtree: true }).some(animation => animation.transitionProperty === 'transform'), await group.elementHandle());
      const motion = await group.evaluateHandle(element => element.getAnimations({ subtree: true }).find(animation => animation.transitionProperty === 'transform'));
      await motion.evaluate(animation => { animation.pause(); animation.currentTime = 100; });
      const during = await group.evaluate(element => getComputedStyle(element, '::before').transform);
      await motion.evaluate(animation => animation.finish());
      const after = await group.evaluate(element => getComputedStyle(element, '::before').transform);
      assert.notEqual(before, after); assert.notEqual(during, before); assert.notEqual(during, after);
      const geometry = await group.evaluate(element => {
        const box = element.getBoundingClientRect(), active = element.querySelector('.is-active').getBoundingClientRect(), pill = getComputedStyle(element, '::before');
        const labels = [...element.querySelectorAll('button')].map(button => { const range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect(), rect = button.getBoundingClientRect(); return { text: text.toJSON(), button: rect.toJSON() }; });
        return { left: box.left + parseFloat(pill.left) + new DOMMatrix(pill.transform).m41, width: parseFloat(pill.width), active: active.toJSON(), labels };
      });
      assert.ok(Math.abs(geometry.left - geometry.active.left) < 1 && Math.abs(geometry.width - geometry.active.width) < 1, `${name}: background alignment at ${width}px`);
      for (const { text, button } of geometry.labels) assert.ok(text.left >= button.left - 1 && text.right <= button.right + 1, `${name}: label fits its button at ${width}px: ${JSON.stringify({ text, button })}`);
      const title = await group.locator('..').locator('.pf-label').boundingBox();
      assert.ok(title.x >= 0 && title.x + title.width <= width, `${name}: section title stays visible after horizontal scrolling`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: verificationPath(`player-segments-${width}.png`) });
    await f.close(); results.push(`Speed and quality backgrounds slide and labels fit at ${width}px`);
  }
  {
    const f = await fixture({ interactive: true }), page = f.page;
    const video = page.locator('.player-video'), surface = page.locator('.player-surface');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await video.evaluate(video => { video.playbackRate = 1.5; });
    const hold = async () => { await page.mouse.move(120, 180); await page.mouse.down(); await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2); };
    const pen = await page.context().newCDPSession(page);
    for (const paused of [true, false]) {
      await pen.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 180, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
      await pen.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 180, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
      await page.waitForFunction(paused => document.querySelector('.player-video').paused === paused, paused, { timeout: 5000 });
    }
    await pen.detach();
    await hold();
    await page.mouse.move(360, 300);
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.mouse.click(120, 180);
    assert.equal(await page.evaluate(() => window.fullscreenRequests), 0);
    assert.equal(await video.evaluate(video => video.paused), true);
    await video.evaluate(video => video.play());
    await hold();
    await page.keyboard.press('Space');
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await video.evaluate(video => video.play());
    await hold();
    await surface.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.waitForTimeout(550);
    await page.mouse.dblclick(120, 180);
    assert.equal(await page.evaluate(() => window.fullscreenRequests), 1);
    await hold();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.mouse.move(120, 180); await page.mouse.down(); await page.mouse.move(360, 300);
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2);
    await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    const seek = await page.locator('.seek').boundingBox();
    await page.mouse.move(seek.x + seek.width / 3, seek.y + seek.height / 2); await page.mouse.down();
    await page.waitForTimeout(550);
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    await page.mouse.up();
    await page.mouse.click(120, 180);
    await page.waitForFunction(() => document.querySelector('.player-video').paused);
    await page.getByRole('button', { name: '재생', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.player-bigplay .lucide-pause') && getComputedStyle(document.querySelector('.player-bigplay')).opacity === '1');
    await page.screenshot({ path: verificationPath('verification-player-pause-feedback.png') });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.player-bigplay')).opacity === '0');
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.getByLabel('자막 파일 선택', { exact: true }).setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
    const notice = await page.locator('.player-notice').boundingBox(), bar = await page.locator('.seek').boundingBox();
    assert.ok(notice.y + notice.height <= bar.y);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.player-notice')).opacity === '1');
    await page.screenshot({ path: verificationPath('verification-player-notice-above-seek.png') });
    await hold();
    await page.evaluate(() => { window.previousVideo = document.querySelector('.player-video'); window.testNavigate('/watch/e2'); });
    await page.waitForFunction(() => document.querySelector('.player-video') !== window.previousVideo);
    assert.equal(await page.evaluate(() => window.previousVideo.playbackRate), 1.5);
    await page.mouse.up();
    await f.close(); results.push('Mouse hold restores speed on release, pause, cancel, blur and unmount; hold survives pointer movement without triggering double-click fullscreen; seek stays independent; pause feedback fades and notices sit above seek');
  }
  {
    const f = await fixture({ interactive: true }), page = f.page;
    const video = page.locator('.player-video');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await video.evaluate(video => { video.playbackRate = 1.5; });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.player-video').paused);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.keyboard.down('Space');
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    await video.dispatchEvent('pause');
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    await page.mouse.move(120, 180); await page.mouse.down(); await page.mouse.move(360, 300); await page.mouse.up();
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    await page.locator('.player-surface').dispatchEvent('pointercancel', { pointerId: 99, pointerType: 'mouse' });
    assert.equal(await video.evaluate(video => video.playbackRate), 2);
    await page.keyboard.up('Space');
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.keyboard.down('Space');
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.up('Space');
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.getByRole('button', { name: '일시정지 (K)', exact: true }).focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(550);
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.keyboard.up('Space');
    await page.waitForFunction(() => document.querySelector('.player-video').paused);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await openSubs(page);
    await page.getByRole('button', { name: /^자막 설정/ }).click();
    const scale = page.getByRole('spinbutton', { name: '자막 크기', exact: true });
    await scale.focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(550);
    await page.keyboard.up('Space');
    assert.equal(await video.evaluate(video => video.playbackRate), 1.5);
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.getByRole('dialog', { name: '자막 및 음성', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.down('Space');
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2);
    await page.evaluate(() => { window.previousVideo = document.querySelector('.player-video'); window.testNavigate('/watch/e2'); });
    await page.waitForFunction(() => document.querySelector('.player-video') !== window.previousVideo);
    assert.equal(await page.evaluate(() => window.previousVideo.playbackRate), 1.5);
    await page.keyboard.up('Space');
    await f.close(); results.push('Space tap toggles once, hold and repeat keep the configured speed, release and blur restore speed, inputs do not start holds, and navigation restores the old video');
  }
  {
    const f = await fixture({ interactive: true }), page = f.page;
    const video = page.locator('.player-video');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await video.evaluate(video => { video.pause(); video.playbackRate = 1; });
    await page.keyboard.press('Shift+Period');
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 1.25);
    await page.keyboard.press('Shift+Comma');
    assert.equal(await video.evaluate(video => video.playbackRate), 1);
    await openSubs(page);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('dialog', { name: '자막 및 음성', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('BracketRight');
    await page.locator('.player-flash', { hasText: '자막 +0.5초' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('moa.subtitleEpisodeOffset:["subtitle-test","e1"]')), '0.5');
    await page.keyboard.press('BracketLeft');
    assert.equal(await page.evaluate(() => localStorage.getItem('moa.subtitleEpisodeOffset:["subtitle-test","e1"]')), '0');
    await page.evaluate(async () => {
      const { devicePrefs, saveDevicePrefs } = await import('/src/lib/device-prefs.ts');
      await saveDevicePrefs({ playerShortcuts: { ...devicePrefs().playerShortcuts, playPause: 'KeyP', speedUp: 'KeyU', mute: null } });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2 && !document.querySelector('.player-video').paused);
    assert.equal(await page.getByRole('button', { name: '일시정지 (P)', exact: true }).getAttribute('title'), '일시정지 (P)');
    assert.equal(await page.getByRole('button', { name: '음소거', exact: true }).getAttribute('title'), '음소거');
    await page.keyboard.press('k');
    assert.equal(await video.evaluate(video => video.paused), false);
    await page.keyboard.down('p');
    await page.keyboard.down('p');
    await page.keyboard.up('p');
    await page.waitForFunction(() => document.querySelector('.player-video').paused);
    const muted = await video.evaluate(video => video.muted);
    await page.keyboard.press('m');
    assert.equal(await video.evaluate(video => video.muted), muted);
    await page.keyboard.press('Shift+Period');
    assert.equal(await video.evaluate(video => video.playbackRate), 1);
    await page.keyboard.press('u');
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 1.25);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await openSubs(page);
    await page.keyboard.press('p');
    assert.equal(await video.evaluate(video => video.paused), false);
    await f.close(); results.push('Speed and subtitle sync shortcuts work; rebound keys survive reload, old and disabled keys do nothing, repeated toggles and open panels stay safe, and Space remains available');
  }
  {
    const f = await fixture({ interactive: true, width: 390 }), page = f.page;
    const cdp = await page.context().newCDPSession(page);
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await page.locator('.player-video').evaluate(video => { video.playbackRate = 1.5; });
    const point = (id, x) => ({ id, x, y: 280, radiusX: 5, radiusY: 5, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 120)] });
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 120), point(2, 270)] });
    assert.equal(await page.locator('.player-video').evaluate(video => video.playbackRate), 1.5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.locator('.player-video').evaluate(video => video.pause());
    const tap = async x => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, x)] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    await tap(195); await page.waitForTimeout(400);
    assert.equal(await page.locator('.player.is-idle').count(), 1);
    await tap(195); await page.waitForTimeout(400);
    assert.equal(await page.locator('.player.is-chrome').count(), 1);
    const before = await page.locator('.player-video').evaluate(video => video.currentTime);
    await tap(335); await tap(335);
    await page.waitForFunction(before => document.querySelector('.player-video').currentTime >= before + 9.9, before);
    assert.equal(await page.locator('.player-video').evaluate(video => video.paused), true);
    await cdp.detach(); await f.close(); results.push('Touch hold, pinch cancellation, control toggle and double-tap seek are preserved');
  }
  for (const [width, holdSpeed] of [[1280, 3], [390, 1.25]]) {
    const f = await fixture({ interactive: true, width, holdSpeed }), page = f.page;
    await page.waitForFunction(() => !document.querySelector('.player-video').paused);
    await page.locator('.player-video').evaluate(video => { video.playbackRate = 1.5; });
    await page.mouse.move(120, 180); await page.mouse.down();
    await page.waitForFunction(speed => document.querySelector('.player-video').playbackRate === speed, holdSpeed);
    assert.equal(await page.locator('.player-boost').textContent(), `${holdSpeed}배속`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.player-boost')).opacity === '1');
    await page.screenshot({ path: verificationPath(`player-hold-${width}.png`) });
    const badge = await page.locator('.player-boost').boundingBox();
    assert.ok(badge.y >= 0 && badge.y < 70, `Hold badge is higher and stays on screen at ${width}px`);
    assert.ok(badge.x >= 0 && badge.x + badge.width <= width);
    const title = await page.locator('.player-title').boundingBox();
    const titleVisible = await page.locator('.player-title').evaluate(element => getComputedStyle(element).visibility !== 'hidden' && Number(getComputedStyle(element).opacity) > 0 && Number(getComputedStyle(element.closest('.player-top')).opacity) > 0);
    assert.ok(!titleVisible || badge.x + badge.width <= title.x || badge.x >= title.x + title.width || badge.y + badge.height <= title.y || badge.y >= title.y + title.height, `Hold badge does not cover the title at ${width}px`);
    assert.notEqual(await page.locator('.player-boost').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
    await page.mouse.up();
    assert.equal(await page.locator('.player-video').evaluate(video => video.playbackRate), 1.5);
    await page.evaluate(async () => { const { saveDevicePrefs } = await import('/src/lib/device-prefs.ts'); await saveDevicePrefs({ holdSpeed: 2.5 }); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2 && !document.querySelector('.player-video').paused);
    await page.locator('.player-video').evaluate(video => { video.playbackRate = 1.5; });
    await page.mouse.move(120, 180); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.player-video').playbackRate === 2.5);
    await page.mouse.up();
    assert.equal(await page.locator('.player-video').evaluate(video => video.playbackRate), 1.5);
    await f.close(); results.push(`Configured hold speed and blurred notice persist at ${width}px and release restores playback speed`);
  }
  for (const source of ['site', 'online', 'upload']) {
    const f = await fixture({ choice: { ...own, id: 'missing', label: '사라진 자막', source, episodeId: 'e1' } });
    await waitFor(() => f.calls.applies.length === 1, `${source}: missing remembered track blocked automatic search`);
    assert.equal(f.calls.searches.length, 1);
    assert.equal(f.calls.translations, 0);
    await f.page.waitForFunction(() => document.querySelector('track')?.src.includes('subtitle.vtt'));
    await f.close(); results.push(`Missing ${source} subtitle falls back to online Korean`);
  }
  {
    const f = await fixture({ choice: null });
    await openSubs(f.page);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.match(await f.page.getByRole('button', { name: '끄기', exact: true }).getAttribute('class'), /is-active/);
    assert.equal(f.calls.searches.length, 0);
    await f.close(); results.push('Explicit off remains off');
  }
  {
    const f = await fixture({ accountDelay: 1000, searchGate: true });
    await waitFor(() => f.calls.searches.length === 1, 'Delayed account should still start online search');
    await openSubs(f.page);
    await f.page.getByRole('button', { name: '끄기', exact: true }).click();
    f.releaseSearch();
    await f.page.getByRole('button', { name: /검증/ }).first().waitFor();
    assert.equal(f.calls.applies.length, 0);
    assert.equal(f.calls.translations, 0);
    await f.close(); results.push('Delayed account and manual off during search are preserved');
  }
  {
    const f = await fixture();
    await waitFor(() => f.calls.applies.length === 1, 'First episode search');
    await f.page.evaluate(() => window.testNavigate('/watch/e2'));
    await waitFor(() => f.calls.applies.length === 2, 'Next episode search');
    assert.ok(f.calls.searches[1].includes('/e2/'));
    await f.close(); results.push('Fresh episode independently searches');
  }
  }
  for (const width of [1280, 390, 320]) {
    const f = await fixture({ ass: true, width });
    await f.page.waitForFunction(width => document.querySelector('canvas.JASSUB')?.getBoundingClientRect().width === width, width);
    const canvas = f.page.locator('canvas.JASSUB');
    assert.equal(await canvas.evaluate(element => getComputedStyle(element).transform), 'none');
    const before = await canvas.boundingBox();
    await f.page.locator('.player.is-idle').waitFor();
    await f.page.waitForFunction(() => getComputedStyle(document.querySelector('.player-top')).opacity === '0');
    assert.deepEqual(await canvas.boundingBox(), before);
    await f.page.screenshot({ path: verificationPath(`verification-ass-idle-${width}.png`) });
    await f.page.mouse.move(50, 50);
    await f.page.locator('.player.is-chrome').waitFor();
    await f.page.waitForFunction(() => getComputedStyle(document.querySelector('.player-top')).opacity === '1');
    assert.deepEqual(await canvas.boundingBox(), before);
    await f.page.screenshot({ path: verificationPath(`verification-ass-controls-${width}.png`) });
    assert.match(await f.page.locator('.player-title').innerText(), /소스: 테스트 소스 · 720p/);
    await f.page.locator('.player-video').evaluate(video => video.pause());
    await openSubs(f.page);
    await f.page.getByRole('button', { name: /^자막 설정/ }).click();
    const style = f.page.locator('.sub-style');
    const preserve = style.getByRole('switch', { name: 'ASS 원본 효과 유지' });
    // Existing records omit the opt-in flag and must keep their custom appearance editable.
    assert.equal(await preserve.getAttribute('aria-checked'), 'false');
    assert.equal(await style.getByRole('slider', { name: '자막 크기', exact: true }).isDisabled(), false);
    assert.equal(await style.locator('input[type=range]:visible').count(), 1);
    await f.page.screenshot({ path: verificationPath(`verification-subtitle-controls-compact-${width}.png`) });
    assert.equal(await style.getByRole('combobox', { name: '슬라이더 간격' }).innerText(), '5% · 0.5px');
    await style.getByRole('slider', { name: '자막 크기', exact: true }).press('ArrowRight');
    await f.page.waitForFunction(() => document.querySelector('input[type=number][aria-label="자막 크기"]')?.value === '105');
    assert.equal(await style.getByRole('spinbutton', { name: '자막 크기', exact: true }).inputValue(), '105');
    await style.locator('summary').click();
    assert.equal(await style.getByRole('slider', { name: '자막 높이', exact: true }).isDisabled(), true);
    await style.getByRole('slider', { name: '자막 그림자', exact: true }).press('ArrowRight');
    await f.page.waitForFunction(() => document.querySelector('input[type=number][aria-label="자막 그림자"]')?.value === '0.5');
    assert.equal(await style.getByRole('spinbutton', { name: '자막 그림자', exact: true }).inputValue(), '0.5');
    const input = style.getByRole('spinbutton', { name: '자막 크기', exact: true });
    await input.fill('112.5'); await input.press('Enter');
    assert.equal(await style.getByRole('slider', { name: '자막 크기', exact: true }).inputValue(), '112.5');
    await style.getByRole('slider', { name: '자막 크기', exact: true }).press('ArrowRight');
    await f.page.waitForFunction(() => document.querySelector('input[type=number][aria-label="자막 크기"]')?.value === '117.5');
    assert.equal(await input.inputValue(), '117.5');
    const box = await style.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    await f.page.screenshot({ path: verificationPath(`verification-subtitle-controls-${width}.png`) });
    await preserve.click();
    await f.page.waitForFunction(() => document.querySelector('.sub-style-custom')?.disabled);
    assert.equal(await style.getByRole('slider', { name: '자막 크기', exact: true }).isDisabled(), true);
    await f.close(); results.push(`${width}px: original ASS toggle, source label, compact controls and numeric step`);
  }
  for (const width of [1280, 390]) {
    const f = await fixture({ interactive: true, width }), page = f.page;
    const showStyle = async () => { await openSubs(page); await page.getByRole('button', { name: /^자막 설정/ }).click(); };
    await showStyle();
    const step = page.getByRole('combobox', { name: '슬라이더 간격' });
    assert.equal(await step.innerText(), '5% · 0.5px');
    await step.click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/device') && response.request().method() === 'PATCH');
    await page.getByRole('option', { name: '10% · 1px', exact: true }).click();
    assert.equal((await (await saved).json()).settings.subtitleStep, 10);
    await page.getByRole('dialog', { name: '자막 및 음성', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
    await showStyle();
    assert.equal(await step.innerText(), '10% · 1px');
    await page.getByRole('slider', { name: '자막 크기', exact: true }).press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('input[type=number][aria-label="자막 크기"]')?.value === '110');
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('moa.deviceSettings:')) localStorage.removeItem(key); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.player-video')?.readyState >= 2);
    await showStyle();
    assert.equal(await step.innerText(), '10% · 1px');
    await page.screenshot({ path: verificationPath(`subtitle-step-saved-${width}.png`) });
    await f.close(); results.push(`${width}px: default 5% subtitle step, panel reopen and server restore preserve 10%`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
