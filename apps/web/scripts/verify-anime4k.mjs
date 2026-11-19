// Actual WatchPage, synthetic local video/audio, and Chromium's software WebGL implementation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, searchForWorkspaceRoot } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const dir = await mkdtemp(join(process.env.MOA_VERIFY_DIR || tmpdir(), 'anime4k-'));
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const settings = { defaultSubtitleLang: 'en', autoFetchSubtitles: false, autoplayNext: false };
const subtitles = [
  { id: 'vtt', lang: 'en', label: 'Fixture VTT', format: 'vtt', url: '/fixture/cues.vtt' },
  { id: 'ass', lang: 'ja', label: 'Fixture ASS', format: 'ass', url: '/fixture/cues.ass' }
];
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:02:00.000\nSynthetic subtitle\n';
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Pretendard,26,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:02:00.00,Default,,0,0,0,,Synthetic ASS
`;
let web, browser;
try {
  const clips = new Map();
  for (const [id, size] of [['first', '96x64'], ['second', '128x72']]) {
    const path = join(dir, id + '.mp4');
    execFileSync(process.env.MOA_FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=8`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '120', '-c:v', 'libx264',
      '-threads', '1', '-preset', 'ultrafast', '-g', '8', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path]);
    clips.set('/fixture/' + id + '.mp4', await readFile(path));
  }
  process.env.VITE_MOCK = '0';
  web = await createServer({
    root: webRoot, cacheDir: join(dir, 'vite'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false, fs: { allow: [searchForWorkspaceRoot(webRoot), dir] } },
    optimizeDeps: { include: ['anime4k.js', 'jassub', 'jassub/dist/worker/worker.js'] },
    plugins: [{ name: 'local-api-only', configureServer(server) {
      server.middlewares.use('/api', (_req, res) => { res.statusCode = 503; res.end(); });
    } }]
  });
  await web.listen();
  const base = new URL(web.resolvedUrls.local[0]).origin;
  // Full Chromium includes Document PiP. CI installs it alongside the default headless shell.
  browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: [
    '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'
  ] });
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
  let device = {}, sessions = 0;
  const errors = [], requests = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== base) return route.abort();
    requests.push(path);
    const clip = clips.get(path);
    if (clip) {
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(range?.[1] ?? 0), end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: clip.subarray(start, end + 1),
        headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${clip.length}` } : {}) } });
    }
    if (path === '/fixture/cues.vtt') return route.fulfill({ contentType: 'text/vtt', body: vtt });
    if (path === '/fixture/cues.ass') return route.fulfill({ contentType: 'text/plain', body: ass });
    if (!path.startsWith('/api/')) return route.continue();
    const json = data => route.fulfill({ json: data });
    if (path === '/api/settings') return json(settings);
    if (path === '/api/settings/device') {
      if (request.method() === 'PATCH') device = { ...device, ...request.postDataJSON().settings };
      return json({ settings: device });
    }
    if (path === '/api/admin/updates') return json({ configured: false, connected: false, state: 'idle', mode: null,
      current: 'unknown', latest: null, branch: null, ahead: 0, behind: 0, checkedAt: null, error: null });
    if (path === '/api/sources') return json([]);
    if (path === '/api/profiles') return json([{ id: 'test', name: 'Filter test', color: 'blue', kids: false, createdAt: '2026-01-01' }]);
    if (path === '/api/me') return json({ id: 'test', role: 'admin' });
    if (path === '/api/plugin-runtime') return json([]);
    if (path === '/api/translation/config') return json({ configured: false });
    if (path.endsWith('/preference')) return json({});
    if (path.endsWith('/markers')) return json({ status: 'unavailable' });
    if (path === '/api/media/m') return json({ id: 'm', title: 'Filter test', type: 'anime',
      provider: { id: 'local', name: 'Local fixture', kind: 'local' }, playTarget: null, seasons: [] });
    if (path === '/api/media/m/franchise') return json({ title: 'Filter test', seasons: [], complete: true });
    if (path === '/api/media/m/group') return json({ id: 'group', members: [] });
    if (path === '/api/playback' && request.method() === 'POST') {
      const body = request.postDataJSON(), streamId = body.streamId || 'first';
      return json({ sessionId: 's' + ++sessions, episodeId: body.episodeId, mediaId: 'm', mediaTitle: 'Filter test', mediaType: 'anime',
        streams: [{ id: 'first', label: 'First', height: 64 }, { id: 'second', label: 'Second', height: 72 }],
        streamId, mode: 'direct', mime: 'video/mp4', url: `/fixture/${streamId}.mp4`, duration: 120,
        startPosition: body.startPosition ?? 0, subtitles, audioTracks: [], next: null });
    }
    return route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /ErrorBoundary|React Router caught|TypeError|ReferenceError|Query data cannot be undefined/.test(message.text())) errors.push(message.text());
  });
  const video = page.locator('video.player-video'), layer = page.locator('canvas.player-anime4k');
  const showing = () => layer.waitFor({ state: 'visible' });
  const original = () => layer.waitFor({ state: 'hidden' });
  const change = patch => page.evaluate(async patch => {
    const { saveDevicePrefs } = await import('/src/lib/device-prefs.ts');
    await saveDevicePrefs(patch);
  }, patch);
  const playing = () => page.waitForFunction(() => {
    const v = document.querySelector('video'); return v && !v.paused && !v.seeking && v.currentTime > 0 && v.webkitAudioDecodedByteCount > 0;
  });
  const openPanel = name => page.getByRole('button', { name, exact: true }).dispatchEvent('click');

  await page.goto(base + '/watch/fixture?t=0');
  await playing();
  await page.waitForFunction(() => document.querySelector('video').textTracks[0]?.mode === 'showing');
  await video.evaluate(v => { window.initialVideo = v; });
  assert.ok(!requests.some(path => /anime4k-renderer|anime4k_js/.test(path)), 'disabled by default: no renderer download');
  assert.equal(await layer.count(), 0);
  await change({ experimentalAnime4k: true });
  assert.equal(await layer.count(), 0, 'native VTT uses original video');
  assert.ok(!requests.some(path => /anime4k-renderer|anime4k_js/.test(path)));

  // Hold the first dynamic import across an actual device toggle.
  let intercept;
  const pending = new Promise(resolve => { intercept = resolve; });
  await page.route('**/anime4k-renderer.ts*', route => intercept(route), { times: 1 });
  await change({ subtitleBackground: 'soft' });
  const delayed = await Promise.race([pending, page.waitForTimeout(15000).then(() => { throw new Error('Expected deferred renderer request'); })]);
  await change({ experimentalAnime4k: false });
  const loaded = page.waitForEvent('requestfinished', req => req.url() === delayed.request().url());
  await delayed.continue();
  await loaded;
  await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(() => v.requestVideoFrameCallback(resolve))));
  assert.equal(await layer.count(), 0, 'a stale import cannot attach');
  await change({ experimentalAnime4k: true });
  await showing();
  assert.deepEqual(await layer.evaluate(c => [c.width, c.height, getComputedStyle(c).pointerEvents]), [192, 128, 'none']);
  await page.getByText('Synthetic subtitle', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('.subtitle-overlay')).zIndex) > Number(getComputedStyle(document.querySelector('.player-anime4k')).zIndex)));
  assert.equal(sessions, 1);

  await video.evaluate(v => v.pause());
  await original();
  await video.evaluate(v => new Promise(resolve => { v.addEventListener('seeked', resolve, { once: true }); v.currentTime = 12; }));
  await original();
  assert.ok(await video.evaluate(v => v.paused && Math.abs(v.currentTime - 12) < .25));
  await page.locator('.center-play').dispatchEvent('click');
  await showing();
  await change({ subtitleBackground: 'original' });
  await original();
  await page.waitForFunction(() => document.querySelector('video').textTracks[0]?.mode === 'showing');
  await change({ subtitleBackground: 'soft', videoFill: true });
  await showing();
  await page.waitForFunction(() => {
    const v = document.querySelector('video'), c = document.querySelector('.player-anime4k');
    return v.style.transform && v.style.transform === c.style.transform;
  });
  await openPanel('자막 및 음성');
  await page.getByRole('button', { name: /Fixture ASS/ }).click();
  await page.locator('canvas.JASSUB').waitFor({ state: 'visible' });
  await showing();
  assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('canvas.JASSUB')).zIndex) > Number(getComputedStyle(document.querySelector('.player-anime4k')).zIndex)));
  await playing();
  assert.equal(await video.evaluate(v => v === window.initialVideo), true);
  assert.equal(sessions, 1);
  console.log('PASS default off, deferred import cancellation, 2× output, original audio/video clock, seek, fill, controls, native VTT, DOM subtitles and JASSUB stacking');

  // Use the product server switch, preserving time and reconstructing at the new decoded size.
  await openPanel('재생 설정');
  await page.getByRole('button', { name: '72p', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.player-anime4k:not([hidden])')?.width === 256);
  assert.equal(await layer.count(), 1);
  assert.equal(await layer.evaluate(c => c.height), 144);
  assert.ok(await video.evaluate(v => v.currentTime >= 12 && !v.paused));
  assert.equal(sessions, 2);
  // A real GPU context loss must affect only the optional layer, even after pause/resume.
  const atLoss = await layer.evaluate(c => {
    c.getContext('webgl').getExtension('WEBGL_lose_context').loseContext();
    return document.querySelector('video').currentTime;
  });
  await layer.waitFor({ state: 'detached' });
  await video.evaluate(async v => { v.pause(); await v.play(); });
  await page.waitForFunction(at => document.querySelector('video').currentTime > at + .5, atLoss);
  assert.equal(await layer.count(), 0);
  // Document PiP changes WatchPlayer props and reconstructs the optional attachment on return.
  // A session that has already lost its context must keep the original even across that transition.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.move(640, 360);
  await page.getByRole('button', { name: 'PIP', exact: true }).click();
  await page.waitForFunction(() => window.documentPictureInPicture?.window?.document.querySelector('video'));
  await page.evaluate(() => window.documentPictureInPicture.window.close());
  await page.waitForFunction(() => document.querySelector('video') === window.initialVideo);
  await video.evaluate(v => v.play());
  await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(() => v.requestVideoFrameCallback(resolve))));
  assert.equal(await layer.count(), 0, 'returning from Document PiP cannot retry a failed filter');
  assert.equal(sessions, 2);
  console.log('PASS product source switch and terminal context loss across playback and Document PiP');

  await change({ experimentalAnime4k: false });
  await change({ experimentalAnime4k: true });
  await showing();
  await page.evaluate(async () => { const { setRemotePreference } = await import('/src/lib/remote.ts'); setRemotePreference('on'); });
  assert.equal(await page.locator('html[data-tv]').count(), 1);
  await page.keyboard.press('ArrowDown');
  await showing();
  await playing();
  await page.evaluate(async () => { const { setRemotePreference } = await import('/src/lib/remote.ts'); setRemotePreference('off'); });
  await showing();
  // Report sustained decoder frame loss while media time advances; no timing-dependent busy loop.
  await video.evaluate(v => {
    const read = v.getVideoPlaybackQuality.bind(v);
    let dropped = read().droppedVideoFrames;
    v.getVideoPlaybackQuality = () => ({ ...read(), droppedVideoFrames: ++dropped });
  });
  await layer.waitFor({ state: 'detached' });
  await playing();
  assert.equal(sessions, 2, 'slow fallback never recreates the playback session');
  await video.evaluate(v => { delete v.getVideoPlaybackQuality; });
  await change({ experimentalAnime4k: false });
  await change({ experimentalAnime4k: true });
  await showing();
  await openPanel('뒤로');
  await page.waitForURL(base + '/title/m');
  await page.locator('.title-page .title-hero-copy').getByRole('heading', { name: 'Filter test' }).waitFor();
  assert.equal(await video.count(), 0);
  assert.equal(await layer.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS TV navigation, sustained frame-loss fallback and player teardown (software WebGL; hardware performance unmeasured)');
} finally {
  await browser?.close();
  await web?.close();
  await rm(dir, { recursive: true, force: true });
}
