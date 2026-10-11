// Bounded synthetic smoke for experimental direct (native) Shorts playback. Locally generated video,
// fake YouTube API for the inline fallback, routed API, no external network.
import assert from 'node:assert/strict';
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
let nativeAvailable = false, fixture;
let settings, kids, log;
const reset = () => { settings = { navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] }; kids = false; log = { feed: [], trailers: [], seen: [], skips: [], patches: [], prepare: [], closed: [], media: 0 }; };
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
    if (path === '/api/me') return r.fulfill({ json: { id: 'u', username: '테스트', role: 'member' } });
    if (path === '/api/profiles') return r.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue', kids }] });
    if (path === '/api/shorts') {
      log.feed.push(url.search);
      if (!settings.shortsEnabled) return r.fulfill({ json: { status: 'disabled', items: [], nextCursor: null } });
      const picked = settings.shortsCategories ?? ['movie', 'series', 'anime'], pool = POOL.filter(i => picked.includes(i.category));
      const start = Number(url.searchParams.get('cursor') ?? 0), end = start + 4;
      const hide = url.searchParams.get('replay') !== '1';
      return r.fulfill({ json: { status: 'ready', items: pool.slice(start, end).filter(i => !hide || !(log.seen.includes(i.key) || log.skips.includes(i.key))), nextCursor: end < pool.length ? String(end) : null } });
    }
    if (path === '/api/shorts/native') return r.fulfill({ json: { available: nativeAvailable } });
    const closed = /^\/api\/shorts\/native\/([^/]+)$/.exec(path);
    if (closed && method === 'DELETE') { log.closed.push(closed[1]); return r.fulfill({ json: { ok: true } }); }
    if (path.startsWith('/api/playback/')) { log.media++; return r.fulfill({ status: 200, contentType: 'video/webm', body: fixture }); }
    const prep = /^\/api\/shorts\/([^/]+)\/native$/.exec(path);
    if (prep && method === 'POST') {
      const key = decodeURIComponent(prep[1]); log.prepare.push(key);
      if (key === 'tv:2') return r.fulfill({ status: 503, json: { error: 'shorts-native-busy' } });
      const id = key === 'movie:1' ? 's1' : 's3';
      return new Promise(resolve => setTimeout(resolve, key === 'movie:3' ? 2000 : 300)).then(() => r.fulfill({ json: { sessionId: id, url: `/api/playback/${id}/shorts/a1`, mime: 'video/mp4' } })).catch(() => {});
    }
    const m = /^\/api\/shorts\/([^/]+)\/(trailers|seen|skip)$/.exec(path);
    if (m) { const key = decodeURIComponent(m[1]); if (m[2] !== 'trailers') { assert.equal(method, 'POST'); (m[2] === 'seen' ? log.seen : log.skips).push(key); return r.fulfill({ json: { ok: true } }); } log.trailers.push(key); return r.fulfill({ json: { trailers: TRAILERS[key] ?? [], checked: true } }); }
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
  return Buffer.from(data, 'base64');
};
const nativeState = page => page.evaluate(() => { const v = document.querySelector('.shorts-slide.is-active video'); return v ? { time: v.currentTime, src: Boolean(v.getAttribute('src')), muted: v.muted, fit: getComputedStyle(v).objectFit } : null; });

try {
  fixture = await makeFixture();
  assert.ok(fixture.length > 10_000, 'fixture recorded');

  // Settings: the option stays off and disabled until the server is configured.
  reset(); settings.shortsEnabled = true;
  let { context, page } = await open(390, 844);
  await page.goto(`${base}settings#experimental`);
  const toggle = page.getByRole('switch', { name: '직접 재생' });
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(), true, 'disabled while unavailable');
  nativeAvailable = true;
  await page.reload();
  await toggle.click();
  await until(() => settings.shortsPlayback === 'native', 'native saved');
  await page.screenshot({ path: verificationPath('native-settings.png') });

  // Direct playback of the settled work only; cover by default.
  await page.goto(`${base}shorts`);
  await page.locator('.shorts-slide.is-active.is-native').waitFor();
  await until(async () => ((await nativeState(page))?.time ?? 0) > .8, 'native playing', 10000);
  assert.deepEqual([...new Set(log.prepare)], ['movie:1'], 'only the active work is prepared');
  assert.equal(await page.locator('iframe').count(), 0, 'no YouTube iframe in direct mode');
  assert.equal((await nativeState(page)).fit, 'cover');
  await page.screenshot({ path: verificationPath('native-mobile.png') });
  await until(() => log.seen.includes('movie:1'), 'seen after 5s', 9000);

  // Leaving releases the lease. A busy server waits for the person, then the inline YouTube fallback.
  await page.locator('.shorts-slide.is-active').getByRole('button', { name: '다음 작품' }).click();
  await until(async () => (await activeTitle(page)) === '준비 실패', 'to failure');
  await until(() => log.closed.includes('s1'), 'lease closed on leave');
  await page.getByText('재생하지 못했어요').waitFor();
  await wait(2000);
  assert.equal(await activeTitle(page), '준비 실패', 'no automatic advance');
  assert.equal(log.prepare.filter(key => key === 'tv:2').length <= 2, true, 'no retry stampede'); // dev StrictMode may repeat once
  await page.getByRole('button', { name: 'YouTube로 재생' }).click();
  await until(async () => (await yt(page)).live === 1, 'inline fallback player');
  assert.equal(await page.locator('.shorts-slide.is-active.is-native').count(), 0, 'fallback uses the unobscured layout');
  await wait(300);
  await assertPlayerClear(page, 'fallback');
  await page.screenshot({ path: verificationPath('native-fallback.png') });

  // Moving on while preparing aborts the request (the server cancels extraction and frees the lease).
  const aborted = [];
  page.on('requestfailed', request => { if (/\/native$/.test(new URL(request.url()).pathname)) aborted.push(new URL(request.url()).pathname); });
  await page.keyboard.press('ArrowDown');
  await until(async () => (await activeTitle(page)) === '늦은 응답', 'to late');
  await until(() => log.prepare.includes('movie:3'), 'late prepare sent');
  await page.keyboard.press('ArrowDown');
  await page.getByText('새 예고편을 다 봤어요').waitFor();
  await until(() => aborted.some(path => path.includes('movie%3A3') || path.includes('movie:3')), 'pending prepare aborted', 5000);
  await wait(2200);
  assert.ok(!log.skips.includes('movie:1'), 'seen work not skipped');

  // Leaving the page stops media.
  await page.locator('.tabbar').getByRole('link', { name: '홈' }).click();
  await until(async () => !(await page.locator('video').count()), 'video gone');
  await context.close();

  // Desktop, contain mode: plain black letterbox.
  log.seen = []; log.skips = []; settings.shortsScreenFit = false;
  ({ context, page } = await open(1280, 800));
  await page.goto(`${base}shorts`);
  await until(async () => ((await nativeState(page))?.time ?? 0) > .5, 'desktop native playing', 10000);
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
