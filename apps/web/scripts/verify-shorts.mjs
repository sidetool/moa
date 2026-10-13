// Synthetic loopback smoke for the experimental Shorts UI. Fake YouTube API, routed API, no external network.
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
  item('movie:1', '첫 작품', 'movie', { mediaId: 'm1', href: '/title/m1', reason: 'personal', year: 2024, overview: '대체 예고편으로 넘어가는 작품. 설명은 두 줄까지만 보이고 나머지는 작품 화면에서 이어서 읽어요.', poster: '/mock-art/0.svg' }),
  item('tv:2', '예고편 없음', 'series', { poster: '/mock-art/1.svg' }),
  item('movie:3', '자동 재생 거부', 'movie', { mediaId: 'm3', href: '/title/m3', year: 2023, overview: '소리 없이 시작하는 합성 예시.', poster: '/mock-art/2.svg' }),
  item('tv:4', '환경 오류', 'anime', { poster: '/mock-art/3.svg' }),
  item('tv:5', '둘째 페이지', 'anime', { poster: '/mock-art/4.svg' }),
  item('movie:6', '마지막', 'movie', { poster: '/mock-art/5.svg' })
];
const TRAILERS = { 'movie:1': ['e101aaaaaaa', 'okaaaaaaaaa'], 'tv:2': [], 'movie:3': ['blkcccccccc'], 'tv:4': ['e153ddddddd'], 'tv:5': ['okeeeeeeeee'], 'movie:6': ['okfffffffff'] };

let settings, kids, log;
const reset = () => { settings = { navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] }; kids = false; log = { feed: [], trailers: [], seen: [], skips: [], failures: [], patches: [] }; };
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

try {
  // OFF by default: no tab, no feed traffic, inline enable on the deep link.
  reset();
  let { context, page } = await open(390, 844);
  await page.goto(`${base}`);
  await page.locator('.tabbar').waitFor();
  assert.equal(await page.locator('.tabbar .tab').count(), 4);
  await page.goto(`${base}shorts`);
  await page.getByText('쇼츠가 꺼져 있어요').waitFor();
  assert.equal(log.feed.length, 0, 'OFF must not fetch the feed');
  await page.screenshot({ path: verificationPath('01-off-mobile.png') });

  // Settings: enable, category multiselect keeps at least one.
  await page.goto(`${base}settings#experimental`);
  await page.getByRole('switch', { name: '쇼츠' }).click();
  await until(() => settings.shortsEnabled === true, 'enable');
  await page.getByRole('button', { name: '세부 설정' }).click();
  const group = page.getByRole('group', { name: '종류' });
  await group.getByRole('button', { name: '애니' }).click();
  await group.getByRole('button', { name: '시리즈' }).click();
  await until(() => JSON.stringify(settings.shortsCategories) === '["movie"]', 'categories movie only');
  await until(async () => (await group.getByRole('button', { name: '시리즈' }).getAttribute('aria-pressed')) === 'false', 'ui follows');
  assert.equal(await group.getByRole('button', { name: '영화' }).isDisabled(), true, 'last category stays');
  await page.screenshot({ path: verificationPath('02-settings-mobile.png') });
  await group.getByRole('button', { name: '애니' }).click();
  await group.getByRole('button', { name: '시리즈' }).click();
  await until(() => JSON.stringify(settings.shortsCategories) === '["movie","series","anime"]', 'categories restored in order');
  await group.getByRole('button', { name: '애니' }).click();
  await until(() => JSON.stringify(settings.shortsCategories) === '["movie","series"]', 'two categories');
  await until(async () => (await group.locator('[aria-pressed="true"]').count()) === 2, 'two stay picked');
  assert.equal(await page.getByRole('switch', { name: '화면 맞춤' }).getAttribute('aria-checked'), 'true', 'fit on by default');
  await page.screenshot({ path: verificationPath('fit-settings.png') });
  await group.getByRole('button', { name: '애니' }).click();
  await until(() => settings.shortsCategories.length === 3, 'all three again');
  assert.equal(await page.locator('.tabbar .tab').count(), 5);
  assert.equal(log.feed.length, 0, 'settings never fetch the feed');

  // Feed on mobile.
  await page.locator('.tabbar').getByRole('link', { name: '쇼츠' }).click();
  await page.locator('.shorts-slide.is-active').waitFor();
  assert.equal(await page.locator('.topnav').isVisible(), false, 'mobile topnav hidden');
  assert.equal(await page.locator('.tabbar').isVisible(), true, 'bottom nav kept');
  assert.equal(await activeTitle(page), '첫 작품');
  await until(async () => (await yt(page)).created.join() === 'e101aaaaaaa,okaaaaaaaaa', 'same-work fallback');
  assert.deepEqual([...new Set(log.trailers)], ['movie:1'], 'only the active work asks for trailers'); // dev StrictMode may repeat an aborted request
  const stage = await page.locator('.shorts-slide.is-active .shorts-stage').boundingBox();
  assert.ok(await page.locator('.shorts.is-fit').count(), 'fit by default');
  assert.ok(stage.width >= 200 && stage.height >= 200 && Math.abs(stage.width / stage.height - 16 / 9) < .05, `fit preserves landscape viewport ${stage.width}x${stage.height}`);
  assert.ok(Math.abs(stage.width - page.viewportSize().width) < 1, "fit uses the available portrait width");
  assert.equal(await page.locator('.shorts-stage iframe + .shorts-overlay, .shorts-stage .shorts-overlay ~ iframe').count(), 0, 'no overlay over a live iframe');
  await wait(300);
  await assertPlayerClear(page, 'fit on');
  await page.screenshot({ path: verificationPath('fit-on.png') });
  await until(() => log.seen.includes('movie:1'), 'seen after 5s', 8000);
  await wait(800);
  assert.deepEqual(log.seen, ['movie:1'], 'seen reported once');

  // Stage mostly off screen while the slide is still the nearest one: the player goes.
  const offset = await page.evaluate(() => {
    const el = document.querySelector('.shorts'), stage = document.querySelector('.shorts-slide.is-active .shorts-stage').getBoundingClientRect();
    const by = Math.round(stage.top - el.getBoundingClientRect().top + stage.height * .55);
    el.style.scrollSnapType = 'none'; // hold a mid-drag position; mandatory snap would pull it back
    el.scrollTo({ top: by }); return by / el.clientHeight;
  });
  assert.ok(offset < .5, `slide still nearest (${offset})`);
  await until(async () => (await yt(page)).live === 0, 'stage half gone unmounts');
  await page.evaluate(() => { const el = document.querySelector('.shorts'); el.scrollTo({ top: 0 }); el.style.scrollSnapType = ''; });
  await until(async () => (await yt(page)).live === 1, 'stage back remounts');

  // Manual next from an already seen work sends nothing more. Empty work: bounded auto-advance, never seen/skipped.
  await page.locator('.shorts-slide.is-active').getByRole('button', { name: '다음 작품' }).click();
  await until(async () => (await activeTitle(page)) === '예고편 없음', 'to empty');
  await page.getByText('재생할 수 있는 예고편이 없어요').waitFor();
  await until(async () => (await activeTitle(page)) === '자동 재생 거부', 'auto next', 5000);
  assert.deepEqual(log.skips, [], 'seen and automatic moves are not skips');

  // Autoplay denial: muted retry, unmute outside the player.
  await until(async () => (await yt(page)).calls.includes('mute:blkcccccccc'), 'muted retry');
  const unmute = page.locator('.shorts-slide.is-active').getByRole('button', { name: '소리 켜기' });
  await unmute.waitFor();
  await assertPlayerClear(page, 'muted');
  await page.screenshot({ path: verificationPath('muted-rail.png') });
  await unmute.click();
  await until(async () => (await yt(page)).calls.includes('unmute:blkcccccccc'), 'unmute');

  // Manual next before five seconds: one skip.
  await page.keyboard.press('ArrowDown');
  await until(async () => (await activeTitle(page)) === '환경 오류', 'to env');
  await until(() => log.skips.length === 1, 'manual skip');
  assert.deepEqual(log.skips, ['movie:3']);
  assert.ok(!log.seen.includes('movie:3'));

  // Environment error stops; next page loaded ahead once.
  await page.getByText('YouTube 플레이어를 열지 못했어요').waitFor();
  await wait(2500);
  assert.equal(await activeTitle(page), '환경 오류', 'env error does not skip');
  assert.ok(log.feed.includes('?cursor=4'), 'second page requested');
  assert.ok(!log.seen.includes('tv:2') && !log.seen.includes('tv:4'), 'failures never seen');

  // Ended advances; cursor end stops fetching.
  await page.locator('.shorts-slide.is-active').getByRole('button', { name: '다음 작품' }).click();
  await until(async () => (await activeTitle(page)) === '둘째 페이지', 'page two');
  await until(async () => (await yt(page)).created.at(-1) === 'okeeeeeeeee', 'page two player');
  assert.deepEqual(log.skips, ['movie:3'], 'leaving a failed work is not a skip');
  // Hidden page: the player is removed, then comes back.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => (await yt(page)).live === 0 && !(await page.locator('.shorts iframe').count()), 'hidden unmount');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => (await yt(page)).live === 1, 'visible remount');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await until(async () => (await yt(page)).live === 0, 'pagehide unmount');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await until(async () => (await yt(page)).live === 1, 'pageshow remount');

  await page.setViewportSize({ width: 390, height: 700 });
  await wait(500);
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(500);
  assert.equal(await activeTitle(page), '둘째 페이지', 'resize keeps the work');
  await page.evaluate(() => window.__ytEnd());
  await until(async () => (await activeTitle(page)) === '마지막', 'ended advances');
  assert.ok((await yt(page)).live <= 1, 'one player at a time');
  await until(async () => (await yt(page)).created.at(-1) === 'okfffffffff', 'last player');
  await page.locator('.shorts-slide.is-active').getByRole('button', { name: '다음 작품' }).click();
  await page.getByText('새 예고편을 다 봤어요').waitFor();
  await until(() => log.skips.length === 2, 'second manual skip');
  await page.keyboard.press('ArrowUp');
  await until(async () => (await activeTitle(page)) === '마지막', 'back to last');
  await until(async () => (await yt(page)).live === 1, 'last player again');
  await page.keyboard.press('ArrowDown');
  await page.getByText('새 예고편을 다 봤어요').waitFor();
  await wait(500);
  assert.deepEqual(log.skips, ['movie:3', 'movie:6'], 'no skip for ended/resize/hidden, one per work');
  const feedCount = log.feed.length;
  await wait(600);
  assert.equal(log.feed.length, feedCount, 'finite end');
  assert.equal((await yt(page)).live, 0, 'end slide has no player');

  // Leaving destroys the player.
  await page.locator('.tabbar').getByRole('link', { name: '홈' }).click();
  await until(async () => (await yt(page)).live === 0, 'leave cleanup');

  assert.deepEqual(log.failures, [{key:'tv:2',reason:'unavailable'},{key:'tv:4',reason:'temporary'}], 'only exhausted candidates and environment failures, not autoplay/fallback');

  // Fit OFF keeps 16:9; a revisit leaves out seen and skipped works; replay brings them back.
  await page.goto(`${base}settings#experimental`);
  await page.getByRole('button', { name: '세부 설정' }).click();
  await page.getByRole('switch', { name: '화면 맞춤' }).click();
  await until(() => settings.shortsScreenFit === false, 'fit off');
  await page.goto(`${base}shorts`);
  await page.locator('.shorts-slide.is-active').waitFor();
  assert.deepEqual(await page.locator('article.shorts-slide h2').allTextContents(), ['둘째 페이지'], 'revisit excludes seen + skipped + failures');
  assert.equal(await page.locator('.shorts.is-fit').count(), 0);
  const plain = await page.locator('.shorts-slide.is-active .shorts-stage').boundingBox();
  assert.ok(Math.abs(plain.width / plain.height - 16 / 9) < .05, `16:9 when off ${plain.width}x${plain.height}`);
  await until(async () => (await activeTitle(page)) === '둘째 페이지', 'fit off playable');
  await until(async () => (await yt(page)).live === 1, 'fit off player');
  await wait(300);
  await assertPlayerClear(page, 'fit off');
  await page.screenshot({ path: verificationPath('fit-off.png') });
  const skipsBefore = log.skips.length;
  await page.evaluate(() => { const el = document.querySelector('.shorts'); el.scrollTo({ top: el.scrollHeight }); });
  await page.getByRole('button', { name: '본 것도 보기' }).click();
  await until(() => log.feed.at(-1) === '?replay=1', 'replay request');
  await until(async () => (await activeTitle(page)) === '첫 작품', 'replay restarts');
  assert.equal(log.skips.length, skipsBefore, 'programmatic scroll is not a skip');
  assert.ok(!(await page.locator('article.shorts-slide h2').allTextContents()).some(t => ['예고편 없음','환경 오류'].includes(t)), 'replay still excludes failures');
  await page.screenshot({ path: verificationPath('fit-replay.png') });
  await context.close();

  // Category selection reaches a fresh feed.
  settings.shortsCategories = ['anime'];
  ({ context, page } = await open(390, 844));
  await page.goto(`${base}shorts`);
  await page.locator('.shorts-slide.is-active').waitFor();
  assert.deepEqual(await page.locator('article.shorts-slide h2').allTextContents(), ['둘째 페이지']);
  await context.close();

  // Desktop: topnav link, side arrows, keyboard.
  ({ context, page } = await open(1280, 800));
  settings.shortsCategories = undefined; settings.shortsScreenFit = undefined; log.seen = []; log.skips = []; log.failures = [];
  await page.goto(`${base}shorts`);
  await page.locator('.topnav').getByRole('link', { name: '쇼츠' }).waitFor();
  await page.locator('.shorts-slide.is-active').waitFor();
  assert.equal(await activeTitle(page), '첫 작품');
  await until(async () => (await yt(page)).live === 1, 'desktop player');
  assert.equal(await page.locator('.shorts-nav').isVisible(), true);
  await wait(300);
  await assertPlayerClear(page, 'desktop');
  await page.screenshot({ path: verificationPath('fit-desktop.png') });
  await page.locator('.shorts-nav').getByRole('button', { name: '다음 작품' }).click();
  await until(async () => (await activeTitle(page)) === '예고편 없음', 'desktop next');
  await context.close();

  // Kids: hidden and no feed.
  reset(); settings.shortsEnabled = true; kids = true;
  ({ context, page } = await open(390, 844));
  await page.goto(`${base}shorts`);
  await page.getByText('어린이 프로필에서는 쓸 수 없어요').waitFor();
  assert.equal(await page.locator('.tabbar .tab').count(), 4);
  assert.equal(log.feed.length, 0);
  await context.close();

  assert.deepEqual(errors, []);
  console.log('shorts smoke ok');
} finally {
  await browser.close();
  await server.close();
}
