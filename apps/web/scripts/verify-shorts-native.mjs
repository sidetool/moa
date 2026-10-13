// Bounded synthetic smoke for experimental direct (native) Shorts playback. Locally generated video,
// fake YouTube API for the inline fallback, routed API, no external network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];

// Fake IFrame API: video id prefix picks behaviour. ok=plays, e101=per-video error, e153=environment error, blk=autoplay denied until muted.
const FAKE_YT = `(() => {
  const log = window.__yt = { created: [], destroyed: 0, live: new Set(), calls: [] };
  class Player {
    constructor(el, opts) {
      this.id = new URL(el.src).pathname.split('/').pop(); this.e = opts.events; this.muted = false; this.dead = false;
      log.created.push(this.id); log.live.add(this);
      setTimeout(() => this.boot(), 60);
    }
    fire(name, data) { if (!this.dead) this.e[name]?.({ target: this, data }); }
    boot() {
      this.fire('onReady');
      if (this.id.startsWith('e101')) return setTimeout(() => this.fire('onError', 101), 60);
      if (this.id.startsWith('e153')) return setTimeout(() => this.fire('onError', 153), 60);
      if (this.id.startsWith('blk')) return setTimeout(() => this.fire('onAutoplayBlocked'), 60);
      setTimeout(() => this.fire('onStateChange', 1), 60);
    }
    playVideo() { log.calls.push('play:' + this.id); if (!this.id.startsWith('blk') || this.muted) setTimeout(() => this.fire('onStateChange', 1), 30); }
    pauseVideo() { log.calls.push('pause:' + this.id); this.fire('onStateChange', 2); }
    mute() { this.muted = true; log.calls.push('mute:' + this.id); }
    unMute() { this.muted = false; log.calls.push('unmute:' + this.id); }
    destroy() { this.dead = true; log.destroyed++; log.live.delete(this); }
  }
  window.__ytEnd = () => [...log.live].at(-1)?.fire('onStateChange', 0);
  window.YT = { Player };
  window.onYouTubeIframeAPIReady?.();
})();`;

// Synthetic artwork only: generated SVG posters and a clearly labelled mock video frame.
const ART = [['#3b1d6e', '#e0567a'], ['#0f3b4a', '#47c4a8'], ['#4a2a0c', '#f0a640'], ['#1b2350', '#7d8cff'], ['#3d0f24', '#ff7a59'], ['#16301c', '#b5e05a']];
const poster = n => `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ART[n][0]}"/><stop offset="1" stop-color="${ART[n][1]}"/></linearGradient></defs><rect width="500" height="750" fill="url(#g)"/><circle cx="360" cy="230" r="150" fill="#fff" opacity=".16"/><rect x="40" y="420" width="300" height="180" rx="20" fill="#000" opacity=".18"/><text x="40" y="690" font-family="sans-serif" font-size="44" font-weight="800" fill="#fff" opacity=".85">MOCK ART ${n + 1}</text></svg>`;
const MOCK_FRAME = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;font-family:sans-serif;color:#fff;overflow:hidden">
<div style="position:relative;width:100%;aspect-ratio:16/9;max-height:100vh;background:linear-gradient(120deg,#26324d,#6b3f6e 55%,#d0875a);display:grid;place-items:center">
<b style="font-size:6vw;letter-spacing:.08em;opacity:.9">MOCK VIDEO</b><small style="position:absolute;top:8px;left:10px;font-size:11px;opacity:.75">합성 프레임 · 실제 YouTube 아님</small></div>
<div id="controls" style="position:absolute;left:0;right:0;bottom:0;height:40px;background:rgba(0,0,0,.55);display:flex;align-items:center;gap:10px;padding:0 12px;font-size:12px">▶ <span style="flex:1;height:3px;background:#f33"></span> MOCK CONTROLS</div></body>`;
const item = (key, title, category, extra = {}) => ({ key, kind: key.split(':')[0], tmdbId: Number(key.split(':')[1]), title, category, href: `/search?q=${encodeURIComponent(title)}`, reason: 'popular', ...extra });
const POOL = [
  item('movie:1', '직접 재생', 'movie', { mediaId: 'm1', href: '/title/m1', reason: 'personal', year: 2024, overview: '서버가 준비한 합성 영상을 MOA 플레이어로 재생하는 예시예요.', poster: '/mock-art/0.svg' }),
  item('tv:2', '준비 실패', 'series', { year: 2023, poster: '/mock-art/1.svg' }),
  item('movie:3', '늦은 응답', 'movie', { poster: '/mock-art/2.svg' })
];
const TRAILERS = { 'movie:1': ['okaaaaaaaaa'], 'tv:2': ['okbbbbbbbbb'], 'movie:3': ['okccccccccc'] };
let nativeAvailable = false, fixture, fixtureType = 'video/webm', busy = true;
let settings, kids, log;
const reset = () => { settings = { navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] }; kids = false; log = { feed: [], trailers: [], seen: [], skips: [], failures: [], patches: [], prepare: [], closed: [], media: 0, warm: [], translate: [], cancelled: [] }; };
const route = async context => {
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), r => {
    const url = new URL(r.request().url());
    if (url.href === 'https://www.youtube.com/iframe_api') return r.fulfill({ contentType: 'text/javascript', body: FAKE_YT });
    if (url.hostname === 'www.youtube-nocookie.com') return r.fulfill({ contentType: 'text/html', body: MOCK_FRAME });
    return r.abort();
  });
  await context.route(url => url.pathname.startsWith('/mock-art/'), r => r.fulfill({ contentType: 'image/svg+xml', body: poster(Number(new URL(r.request().url()).pathname.match(/(\d+)/)[1])) }));
  await context.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/__moa/api/'), r => {
    const url = new URL(r.request().url()), path = url.pathname, method = r.request().method();
    if (path === '/api/settings') { if (method === 'PATCH') { log.patches.push(r.request().postDataJSON()); settings = { ...settings, ...r.request().postDataJSON() }; } return r.fulfill({ json: settings }); }
    if (path === '/api/home') return r.fulfill({ json: { hero: [], rows: [] } });
    if (path === '/api/me') return r.fulfill({ json: { id: 'u', username: '테스트', role: 'member', permissions: ['video.watch', 'subtitles.translate'] } });
    if (path === '/api/translation/config') return r.fulfill({ json: { provider: 'openai', baseUrl: '', configured: true, enabled: true, model: 'mock', batchSize: 120, requestIntervalMs: 0, retryCount: 0, keys: [] } });
    const vtt = (text) => `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n${text}\n`;
    if (path === '/api/test-subs/en.vtt') return r.fulfill({ contentType: 'text/vtt', body: vtt('Mock original caption') });
    if (path === '/api/test-subs/ko.vtt') return r.fulfill({ contentType: 'text/vtt', body: vtt('모의 번역 자막') });
    const job = { id: 'j1', episodeId: 'shorts', state: 'running', partial: true, revision: 1, translatedRanges: [{ start: 0, end: 60 }], done: 1, total: 2, model: 'mock', cached: false, track: { id: 'tr', label: '한국어', lang: 'ko', format: 'vtt', url: '/api/test-subs/ko.vtt', source: 'translation' } };
    const tr = /^\/api\/shorts\/native\/([^/]+)\/subtitles\/([^/]+)\/translate$/.exec(path);
    if (tr && method === 'POST') { log.translate.push(`${tr[1]}:${tr[2]}`); return r.fulfill({ json: job }); }
    if (path === '/api/translations/j1') { if (method === 'DELETE') { log.cancelled.push('j1'); return r.fulfill({ status: 204, body: '' }); } return r.fulfill({ json: job }); }
    const warmed = /^\/api\/shorts\/native\/([^/]+)\/warm$/.exec(path);
    if (warmed && method === 'POST') { log.warm.push(warmed[1]); return r.fulfill({ json: { ready: true } }); }
    if (path === '/api/profiles') return r.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue', kids }] });
    if (path === '/api/shorts') {
      log.feed.push(url.search);
      if (!settings.shortsEnabled) return r.fulfill({ json: { status: 'disabled', items: [], nextCursor: null } });
      const picked = settings.shortsCategories ?? ['movie', 'series', 'anime'], pool = POOL.filter(i => picked.includes(i.category));
      let end = Number(url.searchParams.get('cursor') ?? 0);
      const selected = [];
      const hide = url.searchParams.get('replay') !== '1';
      // Match production: scan excluded rows until a full page or the pool's end.
      for (; end < pool.length && selected.length < 4; end++) {
        const i = pool[end];
        if (!log.failures.some(f => f.key === i.key) && (!hide || !(log.seen.includes(i.key) || log.skips.includes(i.key)))) selected.push(i);
      }
      return r.fulfill({ json: { status: 'ready', items: selected, nextCursor: end < pool.length ? String(end) : null } });
    }
    if (path === '/api/shorts/native') return r.fulfill({ json: { available: nativeAvailable } });
    const closed = /^\/api\/shorts\/native\/([^/]+)$/.exec(path);
    if (closed && method === 'DELETE') { log.closed.push(closed[1]); return r.fulfill({ json: { ok: true } }); }
    if (path.startsWith('/api/playback/')) {
      // Range support like the real media route, so the clip is seekable.
      log.media++;
      const range = /bytes=(\d+)-(\d*)/.exec(r.request().headers().range ?? '');
      if (!range) return r.fulfill({ status: 200, contentType: fixtureType, headers: { 'Accept-Ranges': 'bytes' }, body: fixture });
      const from = Number(range[1]), to = range[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1;
      return r.fulfill({ status: 206, contentType: fixtureType, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${fixture.length}` }, body: fixture.subarray(from, to + 1) });
    }
    const prep = /^\/api\/shorts\/([^/]+)\/native$/.exec(path);
    if (prep && method === 'POST') {
      const key = decodeURIComponent(prep[1]); log.prepare.push(key);
      if (key === 'tv:2' && busy) return r.fulfill({ status: 503, json: { error: 'shorts-native-busy' } });
      const id = { 'movie:1': 's1', 'tv:2': 's2', 'movie:3': 's3' }[key];
      const subtitles = key === 'movie:1' ? [{ id: 'en', label: 'English', lang: 'en', auto: false, url: '/api/test-subs/en.vtt' }] : undefined;
      return new Promise(resolve => setTimeout(resolve, key === 'movie:3' ? 2000 : 300)).then(() => r.fulfill({ json: { sessionId: id, url: `/api/playback/${id}/shorts/a1`, mime: 'video/mp4', subtitles } })).catch(() => {});
    }
    const m = /^\/api\/shorts\/([^/]+)\/(trailers|seen|skip|failed)$/.exec(path);
    if (m) { const key = decodeURIComponent(m[1]); if (m[2] === 'failed') { assert.equal(method, 'POST'); log.failures.push({key, ...r.request().postDataJSON()}); return r.fulfill({json:{ok:true}}); } if (m[2] !== 'trailers') { assert.equal(method, 'POST'); (m[2] === 'seen' ? log.seen : log.skips).push(key); return r.fulfill({ json: { ok: true } }); } log.trailers.push(key); return r.fulfill({ json: { trailers: TRAILERS[key] ?? [], checked: true } }); }
    return r.fulfill({ json: [] });
  });
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, timeout = 6000) => { for (const end = Date.now() + timeout; !(await check()); await wait(40)) if (Date.now() > end) throw new Error(`Timed out: ${label}`); };
const yt = page => page.evaluate(() => window.__yt ? { created: [...window.__yt.created], live: window.__yt.live.size, calls: [...window.__yt.calls] } : { created: [], live: 0, calls: [] });
// Nothing of ours may cover the live player: no rect overlap, and hit-testing inside it reaches the iframe.
const assertPlayerClear = async (page, label) => {
  const result = await page.evaluate(() => {
    const frame = document.querySelector('.shorts-slide.is-active iframe');
    if (!frame) return { missing: true };
    const f = frame.getBoundingClientRect(), hits = [];
    const overlap = [...document.querySelectorAll('.shorts-rail, .shorts-rail-btn, .shorts-info, .shorts-open, .shorts-nav, .tabbar, .topnav, .update-notice')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => {
      const r = el.getBoundingClientRect();
      return { name: el.className, area: Math.max(0, Math.min(r.right, f.right) - Math.max(r.left, f.left)) * Math.max(0, Math.min(r.bottom, f.bottom) - Math.max(r.top, f.top)) };
    }).filter(item => item.area > 0);
    for (const [x, y] of [[.5, .5], [.04, .04], [.96, .04], [.04, .96], [.96, .96], [.5, .97]]) {
      const hit = document.elementFromPoint(f.left + f.width * x, f.top + f.height * y);
      if (hit !== frame) hits.push(`${x},${y}:${hit?.className}`);
    }
    return { overlap, hits, rect: [f.width, f.height] };
  });
  assert.ok(!result.missing, `${label}: player present`);
  assert.deepEqual(result.overlap, [], `${label}: nothing overlaps the player`);
  assert.deepEqual(result.hits, [], `${label}: player receives its own taps`);
  return result.rect;
};
const activeTitle = page => page.locator('.shorts-slide.is-active h2').textContent();
const open = async (width, height) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 700 });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
  await route(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  return { context, page };
};

// The fixture is recorded in this browser from a canvas: synthetic, local, a few seconds long.
const makeFixture = async () => {
  const page = await browser.newPage();
  const data = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 }), g = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const started = performance.now();
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      const grad = g.createLinearGradient(0, 0, 1280, 720); grad.addColorStop(0, '#24345a'); grad.addColorStop(1, `hsl(${20 + t * 30},70%,55%)`);
      g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(200 + t * 120, 360, 160, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.fillText('MOCK NATIVE VIDEO', 640, 330);
      g.font = '28px sans-serif'; g.fillText(`합성 영상 · ${t.toFixed(1)}s`, 640, 390);
      if (recorder.state === 'recording') requestAnimationFrame(draw);
    };
    recorder.start(); draw();
    await new Promise(resolve => setTimeout(resolve, 7000));
    recorder.stop();
    await new Promise(resolve => { recorder.onstop = resolve; });
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  await page.close();
  return withDuration(Buffer.from(data, 'base64'), 7000);
};
// MediaRecorder WebM has no Duration; add one to the Info element so the seek bar has a finite length.
function withDuration(buf, ms) {
  const at = buf.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
  if (at < 0) return buf;
  const first = buf[at + 4]; let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let size = first & (0xff >> len); for (let i = 1; i < len; i++) size = size * 256 + buf[at + 4 + i];
  const start = at + 4 + len, body = buf.subarray(start, start + size);
  if (body.includes(Buffer.from([0x44, 0x89]))) return buf;
  const duration = Buffer.alloc(11); duration[0] = 0x44; duration[1] = 0x89; duration[2] = 0x88; duration.writeDoubleBE(ms, 3);
  const next = size + 11, header = Buffer.alloc(len); let v = next;
  for (let i = len - 1; i >= 0; i--) { header[i] = v & 0xff; v = Math.floor(v / 256); }
  header[0] |= 0x80 >> (len - 1);
  return Buffer.concat([buf.subarray(0, at + 4), header, body, duration, buf.subarray(start + size)]);
}
const nativeState = page => page.evaluate(() => { const v = document.querySelector('.shorts-slide.is-active video'); return v ? { time: v.currentTime, src: Boolean(v.getAttribute('src')), muted: v.muted, fit: getComputedStyle(v).objectFit } : null; });

try {
  // MOA_NATIVE_FIXTURE: optional local synthetic MP4 (seekable); otherwise a clip recorded in the browser.
  if (process.env.MOA_NATIVE_FIXTURE) { fixture = readFileSync(process.env.MOA_NATIVE_FIXTURE); fixtureType = 'video/mp4'; }
  else fixture = await makeFixture();
  assert.ok(fixture.length > 1_000, 'fixture ready');

  // Settings: the option stays off and disabled until the server is configured.
  reset(); settings.shortsEnabled = true;
  let { context, page } = await open(390, 844);
  await page.goto(`${base}settings#experimental`);
  await page.getByRole('button', { name: '세부 설정' }).click();
  const toggle = page.getByRole('switch', { name: '직접 재생' });
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(), true, 'disabled while unavailable');
  nativeAvailable = true;
  await page.reload();
  await page.getByRole('button', { name: '세부 설정' }).click();
  await toggle.click();
  await until(() => settings.shortsPlayback === 'native', 'native saved');
  await page.screenshot({ path: verificationPath('native-settings.png') });

  // Direct playback of the settled work only; cover by default.
  settings.translationMode = 'auto';
  await page.goto(`${base}shorts`);
  await page.locator('.shorts-slide.is-active.is-native').waitFor();
  await until(async () => ((await nativeState(page))?.time ?? 0) > .8, 'native playing', 10000);
  await until(() => log.prepare.includes('movie:3'), 'two ahead prefetched after playing');
  assert.deepEqual(log.prepare, ['movie:1', 'tv:2', 'movie:3'], 'current first, then next, then the one after');
  await until(() => log.warm.includes('s3'), 'prefetched lease warmed');
  assert.ok(!log.warm.includes('s1'), 'the playing work is not warmed');

  assert.equal(await page.locator('iframe').count(), 0, 'no YouTube iframe in direct mode');
  assert.equal((await nativeState(page)).fit, 'cover');
  await page.screenshot({ path: verificationPath('native-mobile.png') });
  await until(() => log.seen.includes('movie:1'), 'seen after 5s', 9000);

  // Paused for the checks below (the synthetic clip is only 7s long).
  await page.locator('.shorts-slide.is-active video').click();
  await until(async () => page.locator('.shorts-slide.is-active video').evaluate(v => v.paused), 'paused');

  // Captions: no Korean track, so auto mode translates the original once and shows it; CC can turn it off.
  const captions = page.locator('.shorts-slide.is-active .shorts-captions');
  await until(async () => (await captions.textContent().catch(() => '')).includes('모의 번역 자막'), 'translated caption shown', 8000);
  assert.deepEqual(log.translate, ['s1:en'], 'one translation request');
  const cue = await captions.boundingBox(), title = await page.locator('.shorts-slide.is-active .shorts-info').boundingBox();
  assert.ok(cue.y + cue.height <= title.y, 'captions stay above the title');
  await page.screenshot({ path: verificationPath('native-captions.png') });
  await page.locator('.shorts-slide.is-active').getByRole('button', { name: '자막' }).click();
  const menu = page.getByRole('menu');
  assert.deepEqual(await menu.getByRole('menuitemradio').allTextContents(), ['끄기', 'English', '한국어 번역 50%']);
  await page.screenshot({ path: verificationPath('native-cc-menu.png') });
  await menu.getByRole('menuitemradio', { name: '끄기' }).click();
  await until(async () => !(await captions.count()), 'captions off');
  await until(() => log.cancelled.includes('j1'), 'turning captions off stops the translation');
  await wait(1800);
  assert.deepEqual(log.translate, ['s1:en'], 'no automatic restart');

  // Seek: a real range; paused stays paused, the position is clamped, and a touch on it is not a feed swipe.
  await page.evaluate(() => { window.__feedTouch = 0; document.querySelector('.shorts').addEventListener('touchstart', () => window.__feedTouch++, { passive: true }); });
  const setSeek = value => page.locator('.shorts-slide.is-active .shorts-seek').evaluate((el, v) => {
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [], changedTouches: [] }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await setSeek(3);
  await until(async () => Math.abs((await nativeState(page)).time - 3) < .3, 'seeked to 3s');
  assert.equal(await page.locator('.shorts-slide.is-active video').evaluate(v => v.paused), true, 'still paused after seek');
  await setSeek(999);
  const clip = await page.locator('.shorts-slide.is-active video').evaluate(v => v.duration);
  assert.ok((await nativeState(page)).time <= clip, 'clamped to duration');
  assert.equal(await page.evaluate(() => window.__feedTouch), 0, 'seek touch stays out of the feed');
  await setSeek(1);
  await page.locator('.shorts-slide.is-active video').click();
  await until(async () => !(await page.locator('.shorts-slide.is-active video').evaluate(v => v.paused)), 'resumed');

  assert.deepEqual(log.failures, [], 'failed prefetch is not reported before visiting it');

  // The end advances and releases the lease. A busy server waits for the person, then the inline YouTube fallback.
  await until(async () => (await activeTitle(page)) === '준비 실패', 'ended advances', 12000);
  await until(() => log.closed.includes('s1'), 'lease closed on leave');
  await page.getByText('재생하지 못했어요').waitFor();
  await wait(2000);
  assert.equal(await activeTitle(page), '준비 실패', 'no automatic advance');
  assert.equal(log.prepare.filter(key => key === 'tv:2').length, 1, 'the failed prefetch is shown, not repeated');
  assert.deepEqual(log.failures,[{key:'tv:2',reason:'temporary'}], 'active failed work reported once');
  await page.getByRole('button', { name: 'YouTube로 재생' }).click();
  await until(async () => (await yt(page)).live === 1, 'inline fallback player');
  assert.equal(await page.locator('.shorts-slide.is-active.is-native').count(), 0, 'fallback uses the unobscured layout');
  await wait(300);
  await assertPlayerClear(page, 'fallback');
  await page.screenshot({ path: verificationPath('native-fallback.png') });

  // The work two ahead was kept through the hand-over and is consumed as is; leaving it releases it.
  await page.keyboard.press('ArrowDown');
  await until(async () => (await activeTitle(page)) === '늦은 응답', 'to two-ahead');
  await until(async () => ((await nativeState(page))?.time ?? 0) > .3, 'two-ahead plays', 10000);
  assert.equal(log.prepare.filter(key => key === 'movie:3').length, 1, 'two-ahead lease reused');
  await page.keyboard.press('ArrowDown');
  await page.getByText('새 예고편을 다 봤어요').waitFor();
  await until(() => log.closed.includes('s3'), 'released after leaving');
  assert.ok(!log.skips.includes('movie:1'), 'seen work not skipped');

  // Leaving the page stops media.
  await page.locator('.tabbar').getByRole('link', { name: '홈' }).click();
  await until(async () => !(await page.locator('video').count()), 'video gone');
  await context.close();

  // Desktop, contain mode: plain black letterbox. A ready prefetch is consumed, not requested again.
  reset(); settings.shortsEnabled = true; settings.shortsPlayback = 'native'; settings.shortsScreenFit = false; busy = false;
  ({ context, page } = await open(1280, 800));
  await page.goto(`${base}shorts`);
  await until(async () => ((await nativeState(page))?.time ?? 0) > .5, 'desktop native playing', 10000);
  await until(() => log.prepare.includes('tv:2'), 'desktop prefetch');
  await wait(500); // let the prefetch answer arrive
  const mediaBefore = log.media;
  await page.keyboard.press('ArrowDown');
  await until(async () => (await activeTitle(page)) === '준비 실패', 'to prefetched');
  await until(async () => ((await nativeState(page))?.time ?? 0) > .3, 'prefetched plays', 10000);
  assert.equal(log.prepare.filter(key => key === 'tv:2').length, 1, 'prefetched lease reused');
  assert.ok(log.media > mediaBefore && log.closed.includes('s1') && !log.closed.includes('s2'), 'old released, new kept');
  await until(() => log.prepare.includes('movie:3'), 'following prefetch');
  const dropped = [];
  page.on('requestfailed', request => { if (/movie(%3A|:)3\/native$/.test(new URL(request.url()).pathname)) dropped.push(1); });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => dropped.length > 0 || log.closed.includes('s3'), 'hidden drops the pending prefetch', 4000);
  await until(() => log.closed.includes('s2'), 'hidden releases the playing lease');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => ((await nativeState(page))?.time ?? 0) > .3, 'back to playing', 10000);
  const desk = await nativeState(page);
  assert.equal(desk.fit, 'contain');
  assert.equal(await page.locator('.shorts-slide.is-active video').evaluate(v => getComputedStyle(v).backgroundColor), 'rgb(0, 0, 0)');
  await page.screenshot({ path: verificationPath('native-desktop-contain.png') });
  await context.close();

  assert.deepEqual(errors, []);
  console.log('native shorts smoke ok', { prepare: log.prepare, closed: log.closed, media: log.media });
} finally {
  await browser.close();
  await server.close();
}
