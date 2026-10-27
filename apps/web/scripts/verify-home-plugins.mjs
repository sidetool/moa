import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await web.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const plugin = { apiVersion: 1, id: 'home-test', name: '홈 테스트', version: '1.0.0', description: '', placements: ['home', 'app'], permissions: ['ui', 'app.context', 'app.navigate'], connect: ['https://example.org'], kind: 'script', revision: 'test', enabled: true };
const script = `moa.on('ready', async () => {
  await moa.fetch('https://example.org/boot');
  document.body.innerHTML = '<button>작품 검색</button><p>준비 완료</p>';
  document.querySelector('button').onclick = () => moa.app.navigate('/search?q=' + encodeURIComponent('요일 애니'));
  await moa.ui.resize(360);
});`;
try {
  for (const width of [1280, 390, 320]) {
    const touch = width === 390;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch });
    await context.addInitScript(() => { if (window === top) { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); } });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-26T03:00:00Z'));
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push(dialog.type()); await dialog.dismiss(); });
    let boots = 0, permissions = plugin.permissions, contentError = false, scheduleError = false;
    let activePlugin = plugin, activeScript = script, delayNext = false, lookupError = false, delayLookup = false, legacyLimit = false, busyRequests = 0, oneTitle = false;
    let releaseLookup, releasePoster, posterStarted, delayPoster = false, activeFetches = 0, maxFetches = 0, activePosters = 0, maxPosters = 0, holdPosters = 0;
    const heldPosters = [];
    const requests = [], lookups = [], resources = [];
    const poster = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === '/api/plugin-runtime' && delayNext) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 250)); }
      if (path === '/api/me') return route.fulfill({ json: { id: 'account', username: '테스트', role: 'member' } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
      if (path === '/api/settings') return route.fulfill({ json: { autoplayNext: false, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', translationMode: 'manual' } });
      if (path === '/api/home') return route.fulfill({ json: { hero: [], rows: [] } });
      if (path === '/api/search') return route.fulfill({ json: { query: '요일 애니', groups: [] } });
      if (/^\/api\/media\/anime(?::|%3A)linked\/group$/.test(path)) return route.fulfill({ json: { members: [], manual: false } });
      if (path === '/api/media/anime%3Alinked') return route.fulfill({ json: { id: 'anime:linked', title: '요일 신작', type: 'anime', provider: { id: 'local', name: '내 영상', kind: 'local' }, genres: [], seasons: [], playTarget: null } });
      if (path === '/api/plugin-runtime') return route.fulfill({ json: [{ ...activePlugin, permissions }, { ...plugin, id: 'disabled', name: '비활성 플러그인', enabled: false }, { ...plugin, id: 'player-only', name: '재생 전용', placements: ['player'] }] });
      if (path === `/api/plugin-runtime/${activePlugin.id}`) return route.fulfill(contentError ? { status: 500, json: { error: 'plugin-unavailable' } } : { json: { ...activePlugin, permissions, script: activeScript } });
      if (path === `/api/plugin-runtime/${activePlugin.id}/metadata/lookup`) {
        const body = route.request().postDataJSON();
        assert.equal(body.revision, activePlugin.revision);
        assert.equal(body.query.type, 'anime');
        lookups.push(body.query.title);
        if (delayLookup && body.query.title === '요일 신작') {
          delayLookup = false;
          await new Promise(resolve => { releaseLookup = resolve; });
        }
        const title = body.query.title;
        return route.fulfill(lookupError ? { status: 503, json: { error: 'metadata-unavailable' } } : { json: { provider: 'tmdb', status: 'ready', ...(title === '요일 신작' ? { mediaId: 'anime:linked', poster: 'https://image.tmdb.org/t/p/w342/poster.png' } : title.startsWith('미리보기 작품 ') ? {poster: `https://image.tmdb.org/t/p/w342/preview-${title.split(' ').at(-1)}.png`} : title === '이미지 오류 작품' ? {poster: 'https://image.tmdb.org/t/p/w342/broken.png'} : /^요일 [1-6] 작품$/.test(title) ? {poster: `https://image.tmdb.org/t/p/w342/day-${title.split(' ')[1]}.png`} : {}) } });
      }
      if (path === `/api/plugin-runtime/${activePlugin.id}/request`) {
        boots++;
        if (activePlugin.id === plugin.id) return route.fulfill({ json: { base64: Buffer.from('{}').toString('base64') } });
        const url = new URL(route.request().postDataJSON().url);
        resources.push(url.href);
        activeFetches++; maxFetches = Math.max(maxFetches, activeFetches);
        const isPoster = url.hostname === 'image.tmdb.org';
        if (isPoster) { activePosters++; maxPosters = Math.max(maxPosters, activePosters); }
        try {
          if (legacyLimit && activeFetches > 1) { busyRequests++; return await route.fulfill({ status: 429, json: { error: 'plugin-busy' } }); }
          await new Promise(resolve => setTimeout(resolve, 25));
          if (url.hostname === 'image.tmdb.org') {
            assert.match(url.pathname, /^\/t\/p\/w342\/(?:poster|preview-\d+|day-[1-6]|broken)\.png$/);
            if (holdPosters > 0) { holdPosters--; await new Promise(resolve => heldPosters.push(resolve)); }
            if (delayPoster && url.pathname.endsWith('/poster.png')) {
              delayPoster = false;
              await new Promise(resolve => { releasePoster = resolve; posterStarted(); });
            }
            return await route.fulfill({ json: { base64: url.pathname.endsWith('/broken.png') ? Buffer.from('invalid image').toString('base64') : poster, contentType: 'image/png' } });
          }
          assert.equal(url.origin, 'https://api.anissia.net');
          if (scheduleError) return await route.fulfill({ status: 502, json: { error: 'plugin-request-failed' } });
          const day = url.pathname.split('/').at(-1);
          assert.match(day, /^[0-6]$/);
          const rows = [{ animeNo: 1, week: day, status: 'ON', time: '09:30', subject: '요일 신작', originalSubject: '原題', startDate: '2020-01-01', endDate: '' }, { animeNo: 2, week: day, status: 'OFF', time: '12:00', subject: '결방 작품', startDate: '2020-01-01', endDate: '' }, { animeNo: 3, week: day, status: 'ON', time: '10:00', subject: '<img src=x onerror=alert(1)>', startDate: '2020-01-01', endDate: '' }, { animeNo: 4, week: day, status: 'ON', time: '10:00', subject: '종영 작품', startDate: '2020-01-01', endDate: '2020-01-02' }, ...Array.from({length: 8}, (_, index) => ({animeNo: 5 + index, week: day, status: 'ON', time: `${13 + index}:00`, subject: `미리보기 작품 ${index}`, startDate: '2020-01-01', endDate: ''})), {animeNo: 13, week: day, status: 'ON', time: '21:00', subject: '이미지 오류 작품', startDate: '2020-01-01', endDate: ''}, {animeNo: 20, week: day, status: 'ON', time: '22:00', subject: `요일 ${day} 작품`, startDate: '2020-01-01', endDate: ''}];
          return await route.fulfill({ json: { base64: Buffer.from(JSON.stringify({ code: 'ok', data: day === '0' ? [] : oneTitle ? rows.slice(0, 1) : rows })).toString('base64') } });
        } finally { activeFetches--; if (isPoster) activePosters--; }
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(web.resolvedUrls.local[0]);
    const frame = page.frameLocator('iframe[title="홈 테스트"]');
    const inline = page.locator('.home-plugin iframe[title="홈 테스트"]');
    await frame.getByText('준비 완료', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 360);
    assert.equal(boots, 1);
    assert.equal(await page.locator('iframe[title="홈 테스트"]').count(), 1);
    assert.equal(await inline.isVisible(), true);
    assert.equal(await inline.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await inline.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(requests.includes('/api/plugin-runtime/disabled'), false);
    assert.equal(requests.includes('/api/plugin-runtime/player-only'), false);
    const body = frame.locator('body');
    assert.equal(await body.evaluate(() => { try { return parent.document !== undefined; } catch { return false; } }), false);
    await body.evaluate(() => moa.ui.resize(1));
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 120);
    await body.evaluate(() => moa.ui.resize(9000));
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 1200);
    for (const height of [NaN, Infinity, '360', null]) {
      assert.equal(await body.evaluate(async (_, height) => { try { await moa.ui.resize(height); return false; } catch { return true; } }, height), true);
    }
    permissions = ['app.context', 'app.navigate'];
    assert.equal(await body.evaluate(async () => { try { await moa.ui.resize(400); return false; } catch { return true; } }), true);
    permissions = plugin.permissions;
    await body.evaluate(() => moa.ui.resize(360));
    assert.equal(await body.evaluate(async () => { try { await moa.app.navigate('https://example.org/'); return false; } catch { return true; } }), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: verificationPath(`home-plugin-${width}.png`) });
    await frame.getByRole('button', { name: '작품 검색', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === '요일 애니');
    await page.locator('.home-plugin').waitFor({ state: 'detached' });
    for (const path of ['tabs/anime', 'local']) {
      await page.goto(new URL(path, web.resolvedUrls.local[0]).href);
      await page.getByRole('navigation').first().waitFor();
      assert.equal(await page.locator('.home-plugin').count(), 0);
    }
    for (const path of ['tabs/home', 'Tabs/home', 'tabs/%68ome']) {
      await page.goto(new URL(path, web.resolvedUrls.local[0]).href);
      await inline.waitFor({ state: 'visible' });
      assert.equal(await page.locator('iframe[title="홈 테스트"]').count(), 1);
    }
    contentError = true;
    activePlugin = { ...plugin, revision: 'failed' };
    await page.reload();
    await page.locator('.home-plugin').getByRole('alert').waitFor();
    assert.equal(await inline.count(), 0);
    activePlugin = { ...JSON.parse(await readFile(new URL('../../../plugins/anime-schedule/manifest.json', import.meta.url), 'utf8')), kind: 'script', enabled: true, revision: 'schedule' };
    activeScript = await readFile(new URL('../../../plugins/anime-schedule/plugin.js', import.meta.url), 'utf8');
    permissions = activePlugin.permissions;
    contentError = false;
    const waitForPosters = () => Promise.all([...Array.from({ length: 6 }, (_, index) => `day-${index + 1}.png`), 'preview-7.png'].map(file => page.waitForResponse(response => response.url().endsWith(`/plugin-runtime/${activePlugin.id}/request`) && response.request().postDataJSON().url.endsWith(`/${file}`) && response.ok(), { timeout: 15000 })));
    const preloaded = waitForPosters();
    await page.goto(web.resolvedUrls.local[0]);
    const schedule = page.frameLocator(`iframe[title="${activePlugin.name}"]`);
    const tabs = schedule.getByRole('tab');
    const clickAnime = async title => {
      const button = schedule.locator('.anime').filter({ hasText: title });
      await button.waitFor();
      const height = await schedule.locator('#schedule').evaluate(element => Math.ceil(element.getBoundingClientRect().height));
      await page.waitForFunction(height => document.querySelector('.home-plugin iframe')?.clientHeight >= height, height);
      await button.click();
    };
    await tabs.last().waitFor();
    assert.deepEqual(await tabs.allTextContents(), ['월', '화', '수', '목', '금', '토', '일']);
    assert.equal(await schedule.locator('[role="tab"][aria-selected="true"]').count(), 1);
    await preloaded;
    assert.equal(new Set(resources.filter(url => url.startsWith('https://api.anissia.net/anime/schedule/'))).size, 7);
    assert.ok(maxPosters > 1 && maxPosters <= 4, `Expected bounded parallel posters, saw ${maxPosters}`);
    const initialPosters = resources.filter(url => url.startsWith('https://image.tmdb.org/'));
    assert.equal(new Set(initialPosters).size, initialPosters.length, 'each poster is fetched once across all days');
    assert.equal(await tabs.first().evaluate(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width >= 44 && Math.abs(box.width - box.height) <= 1 && (style.borderRadius === '50%' || parseFloat(style.borderRadius) >= box.width / 2);
    }), true, 'weekday buttons are circular touch targets');
    assert.equal(await schedule.locator('[role="tablist"]').evaluate(element => {
      const rows = new Map(), left = element.getBoundingClientRect().left;
      for (const tab of element.children) {
        if (!rows.has(tab.offsetTop)) rows.set(tab.offsetTop, []);
        rows.get(tab.offsetTop).push(tab.getBoundingClientRect());
      }
      return [...rows.values()].every(row => Math.abs(row[0].left - left) <= 1 && row.every((box, index) => !index || box.left - row[index - 1].right >= 0 && box.left - row[index - 1].right <= 12.5));
    }), true, 'weekday rows stay grouped against the left edge');
    for (const day of ['월', '화', '수', '목', '금', '토', '일']) {
      const tab = schedule.getByRole('tab', { name: day, exact: true });
      await tab.click();
      if (day === '일') await schedule.getByText('방영 예정인 작품이 없음', { exact: true }).waitFor();
      else await schedule.locator('.anime').filter({ hasText: '요일 신작' }).waitFor();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
    }
    assert.equal(resources.filter(url => url.startsWith('https://image.tmdb.org/')).length, initialPosters.length, 'changing weekdays reuses preloaded posters');
    await schedule.getByRole('tab', { name: '일', exact: true }).press('ArrowRight');
    assert.equal(await schedule.getByRole('tab', { name: '월', exact: true }).getAttribute('aria-selected'), 'true');
    await new Promise(resolve => setTimeout(resolve, 100));
    delayNext = true;
    const delayedResize = page.waitForRequest(request => new URL(request.url()).pathname === '/api/plugin-runtime');
    await schedule.getByRole('tab', { name: '일', exact: true }).click();
    await delayedResize;
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await schedule.getByText('종영 작품', { exact: true }).count(), 0);
    const artwork = schedule.locator('.anime').filter({ hasText: '요일 신작' }).locator('img[src^="blob:"]');
    await artwork.waitFor();
    assert.equal(await artwork.evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await schedule.locator('img:not([src^="blob:"]):not([src^="data:"])').count(), 0);
    await schedule.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    await schedule.getByText('결방', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await schedule.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const list = schedule.locator('#schedule-list'), previous = schedule.locator('#previous'), next = schedule.locator('#next');
    assert.equal(await list.evaluate(element => getComputedStyle(element).overflowX), 'hidden');
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await previous.isVisible(), false);
    assert.equal(await schedule.getByRole('button', { name: '이전 작품', exact: true }).count(), 0);
    assert.equal(await next.isEnabled(), true);
    assert.equal(await next.isVisible(), true);
    await schedule.getByRole('heading', { name: '요일별 신작', exact: true }).hover();
    await schedule.getByRole('tab', { name: '월', exact: true }).focus();
    assert.equal(await next.evaluate(() => matchMedia('(hover: none)').matches), touch);
    await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === (touch ? '1' : '0'), 'arrows remain visible on touch and hidden without hover on desktop');
    assert.equal(await next.evaluate(element => getComputedStyle(element).pointerEvents), touch ? 'auto' : 'none');
    if (!touch) {
      await artwork.hover();
      await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '1', 'thumbnail hover reveals paging arrows');
      assert.equal(await next.evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
      await schedule.getByRole('heading', { name: '요일별 신작', exact: true }).hover();
      await waitFor(async () => await next.evaluate(element => { const opacity = Number(getComputedStyle(element).opacity); return opacity > 0 && opacity < 1; }), 'leaving thumbnails fades paging arrows');
      await artwork.hover();
      await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '1', 'hover reentry restores the fading arrow');
      await schedule.getByRole('heading', { name: '요일별 신작', exact: true }).hover();
      await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '0', 'leaving thumbnails hides paging arrows');
      await schedule.getByRole('tab', { name: '월', exact: true }).press('Tab');
      assert.equal(await next.evaluate(element => element.matches(':focus-visible')), true, 'keyboard navigation reaches the next arrow');
      await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '1', 'keyboard focus reveals paging arrows');
    }
    const verifyPageEdges = async () => {
      const geometry = await list.evaluate(element => {
        const viewport = element.getBoundingClientRect(), poster = element.querySelector('.poster').getBoundingClientRect();
        const previous = document.querySelector('#previous').getBoundingClientRect(), next = document.querySelector('#next').getBoundingClientRect();
        const cards = [...element.querySelectorAll('.anime')].map(card => card.getBoundingClientRect()).filter(box => box.right > viewport.left + 2 && box.left < viewport.right - 2);
        return {
          controlEdges: [previous.left - viewport.left, next.right - viewport.right],
          cardEdges: [cards[0].left - viewport.left, cards.at(-1).right - viewport.right],
          fullHeight: [previous, next].every(box => box.width >= 44 && box.height >= 44 && Math.abs(box.top - poster.top) <= 2 && Math.abs(box.bottom - poster.bottom) <= 2),
          wholeCards: cards.every(box => box.left >= viewport.left - 2 && box.right <= viewport.right + 2),
        };
      });
      assert.equal(geometry.controlEdges.every(offset => Math.abs(offset) <= 1), true, `page controls meet both viewport edges: ${geometry.controlEdges}`);
      assert.equal(geometry.cardEdges.every(offset => Math.abs(offset) <= 2), true, `cards fill both viewport edges: ${geometry.cardEdges}`);
      assert.equal(geometry.fullHeight, true, 'page controls span the full poster height');
      assert.equal(geometry.wholeCards, true, 'pages show complete cards without peeking at adjacent cards');
    };
    await verifyPageEdges();
    assert.equal(await schedule.locator('.pages').evaluate(element => [...element.querySelectorAll('button')].every(button => {
      const style = getComputedStyle(button);
      const outer = button.id === 'previous' ? ['borderTopLeftRadius', 'borderBottomLeftRadius'] : ['borderTopRightRadius', 'borderBottomRightRadius'];
      const inner = button.id === 'previous' ? ['borderTopRightRadius', 'borderBottomRightRadius'] : ['borderTopLeftRadius', 'borderBottomLeftRadius'];
      return outer.every(corner => style[corner] === '0px') && inner.every(corner => style[corner] === '12px')
        && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every(side => style[side] === '0px');
    })), true, 'page controls round only their inner corners and have no border');
    const pageWidth = await list.evaluate(element => {
      const cards = [...element.querySelectorAll('.anime')], edge = element.getBoundingClientRect().right;
      return cards.find(card => card.getBoundingClientRect().left >= edge).getBoundingClientRect().left - cards[0].getBoundingClientRect().left;
    });
    if (touch) await next.tap();
    else await next.press('Enter');
    await waitFor(async () => Math.abs(await list.evaluate(element => element.scrollLeft) - pageWidth) < 2, 'next moves one page');
    assert.equal(await previous.isEnabled(), true);
    assert.equal(await previous.isVisible(), true);
    assert.equal(await next.isVisible(), true, 'both directions are visible on a middle page');
    await verifyPageEdges();
    await previous.click();
    await waitFor(async () => await list.evaluate(element => element.scrollLeft) < 2, 'previous returns to the first page');
    await waitFor(() => previous.isDisabled(), 'the previous arrow disables at the first page');
    assert.equal(await previous.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
    await waitFor(async () => await previous.evaluate(element => { const style = getComputedStyle(element), opacity = Number(style.opacity); return style.visibility === 'visible' && opacity > 0 && opacity < 1; }), 'a disabled arrow fades before becoming hidden');
    await previous.waitFor({ state: 'hidden' });
    await verifyPageEdges();
    if (!touch) {
      await schedule.getByRole('heading', { name: '요일별 신작', exact: true }).hover();
      await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '0', 'mouse paging does not keep arrows visible after leaving');
      await artwork.hover();
    }
    for (let index = 0; index < 20 && await next.isEnabled(); index++) {
      const target = await list.evaluate((element, distance) => Math.min(element.scrollLeft + distance, element.scrollWidth - element.clientWidth), pageWidth);
      const scrolled = list.evaluate(element => new Promise(resolve => element.addEventListener('scrollend', () => resolve(), { once: true })));
      await next.click();
      await scrolled;
      await waitFor(async () => Math.abs(await list.evaluate(element => element.scrollLeft) - target) < 2, 'page movement settles');
      if (target >= await list.evaluate(element => element.scrollWidth - element.clientWidth) - 1) await waitFor(() => next.isDisabled(), 'last page disables the next arrow');
    }
    assert.equal(await next.isDisabled(), true, 'last page cannot advance');
    await next.waitFor({ state: 'hidden' });
    assert.equal(await schedule.getByRole('button', { name: '다음 작품', exact: true }).count(), 0);
    assert.equal(await previous.isVisible(), true);
    await verifyPageEdges();
    await schedule.getByRole('tab', { name: '화', exact: true }).click();
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await artwork.waitFor();
    assert.equal(await list.evaluate(element => element.scrollLeft), 0, 'weekday changes reset the page');
    await previous.waitFor({ state: 'hidden' });
    assert.equal(await next.isVisible(), true);
    holdPosters = 3;
    const pendingNavigationArtwork = waitForPosters();
    await schedule.getByRole('button', { name: '새로고침', exact: true }).click();
    await waitFor(() => heldPosters.length === 3, 'three poster jobs occupy the preload queue');
    await clickAnime('요일 신작');
    await schedule.getByRole('tab', { name: '일', exact: true }).click();
    for (const release of heldPosters.splice(0)) release();
    await schedule.getByText('방영 예정인 작품이 없음', { exact: true }).waitFor();
    await pendingNavigationArtwork;
    assert.equal(new URL(page.url()).pathname, '/', 'a queued click cannot navigate after its weekday is removed');
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await artwork.waitFor();
    delayPoster = true;
    const pendingPoster = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Poster preload did not start')), 5000);
      posterStarted = () => { clearTimeout(timeout); resolve(); };
    });
    await schedule.getByRole('button', { name: '새로고침', exact: true }).click();
    await pendingPoster;
    const firstPoster = schedule.locator('.anime').filter({hasText:'요일 신작'}).locator('.poster');
    assert.equal(await firstPoster.getAttribute('data-loading') !== null, true);
    assert.equal(await firstPoster.locator('img').count(), 0);
    assert.equal(await firstPoster.evaluate(element => getComputedStyle(element).animationName !== 'none'), true);
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await firstPoster.evaluate(element => getComputedStyle(element).animationName), 'none');
    assert.equal(await next.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
    await firstPoster.hover();
    await next.click();
    await waitFor(() => previous.isEnabled(), 'reduced-motion paging reaches the next page');
    await previous.click();
    await waitFor(() => previous.isDisabled(), 'reduced-motion paging returns to the first page');
    assert.equal(await previous.evaluate(element => { const style = getComputedStyle(element); return style.visibility === 'hidden' && style.opacity === '0'; }), true, 'reduced motion hides disabled arrows immediately');
    await page.emulateMedia({reducedMotion:'no-preference'});
    assert.equal(await schedule.locator('#schedule-list').evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight <= element.clientHeight + 1), true);
    assert.equal(await schedule.locator('.anime').first().evaluate(element => {
      const poster = element.querySelector('.poster').getBoundingClientRect();
      const time = element.querySelector('.time').getBoundingClientRect();
      const title = element.querySelector('.title').getBoundingClientRect();
      return poster.width >= 140 && time.top >= poster.bottom && title.top >= time.bottom;
    }), true);
    releasePoster();
    await artwork.waitFor();
    assert.equal(await firstPoster.getAttribute('data-loading'), null);
    const nextCard = '미리보기 작품 7';
    assert.equal(await list.evaluate(element => {
      const card = element.querySelector('[data-title="미리보기 작품 7"]');
      return card.getBoundingClientRect().left >= element.getBoundingClientRect().right;
    }), true, 'last poster loads while offscreen');
    const initialScroll = await schedule.locator('#schedule-list').evaluate(element => element.scrollLeft);
    await schedule.locator('.anime').filter({hasText:nextCard}).locator('.poster:not([data-loading])').waitFor();
    await schedule.locator('.anime').filter({hasText:nextCard}).locator('img').waitFor();
    assert.equal(await schedule.locator('#schedule-list').evaluate(element => element.scrollLeft), initialScroll);
    assert.equal(await schedule.locator('.anime').filter({hasText:'결방 작품'}).locator('.poster').getAttribute('data-loading'), null);
    assert.equal(await schedule.locator('footer').count(), 0);
    await schedule.locator('.anime').filter({hasText:'이미지 오류 작품'}).focus();
    await schedule.locator('.anime').filter({hasText:'이미지 오류 작품'}).getByText('이미지 없음', {exact:true}).waitFor();
    assert.equal(await schedule.locator('#schedule-list').evaluate(element => element.scrollLeft > 0), true);
    await schedule.locator('.anime').filter({hasText:'요일 신작'}).focus();
    const height = await schedule.locator('#schedule').evaluate(element => Math.ceil(element.getBoundingClientRect().height));
    await page.waitForFunction(height => document.querySelector('.home-plugin iframe')?.clientHeight >= height, height, { timeout: 5000 });
    await artwork.hover();
    await waitFor(async () => await next.evaluate(element => getComputedStyle(element).opacity) === '1', 'paging arrow fade completes before capture');
    await page.screenshot({ path: verificationPath(`anime-schedule-${width}.png`) });
    for (let attempt = 0; attempt < 5; attempt++) {
      scheduleError = true;
      await schedule.getByRole('button', { name: '새로고침', exact: true }).click();
      await schedule.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
      scheduleError = false;
      const retryHeight = await schedule.locator('#schedule').evaluate(element => Math.ceil(element.getBoundingClientRect().height));
      await page.waitForFunction(height => Math.abs(document.querySelector('.home-plugin iframe')?.clientHeight - height) <= 1, retryHeight);
      await schedule.getByRole('button', { name: '다시 시도', exact: true }).click();
      await schedule.locator('.anime').filter({ hasText: '요일 신작' }).waitFor();
    }
    await clickAnime('요일 신작');
    await page.waitForURL(url => url.pathname === '/title/anime%3Alinked');
    await page.locator('.home-plugin').waitFor({ state: 'detached' });
    await page.goto(web.resolvedUrls.local[0]);
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await clickAnime('결방 작품');
    await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === '결방 작품');
    lookupError = true;
    await page.goto(web.resolvedUrls.local[0]);
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await clickAnime('요일 신작');
    await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === '요일 신작');
    lookupError = false;
    delayLookup = true;
    const pendingLookup = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/metadata/lookup') && request.postDataJSON().query.title === '요일 신작');
    await page.goto(web.resolvedUrls.local[0]);
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await pendingLookup;
    await schedule.getByRole('tab', { name: '일', exact: true }).click();
    await schedule.getByText('방영 예정인 작품이 없음', { exact: true }).waitFor();
    releaseLookup();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await schedule.locator('.anime').count(), 0);
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await artwork.waitFor();
    permissions = activePlugin.permissions.filter(permission => permission !== 'metadata.read');
    assert.equal(await schedule.locator('body').evaluate(async () => { try { await moa.metadata.lookup({ title: '권한 없는 요청', type: 'anime' }); return false; } catch { return true; } }), true);
    assert.equal(lookups.includes('권한 없는 요청'), false);
    permissions = activePlugin.permissions;
    oneTitle = true;
    await schedule.getByRole('button', { name: '새로고침', exact: true }).click();
    await artwork.waitFor();
    assert.equal(await list.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await previous.isVisible(), false);
    assert.equal(await next.isVisible(), false, 'a single poster needs no paging controls');
    oneTitle = false;
    if (width === 1280) {
      legacyLimit = true;
      const legacyPreloaded = waitForPosters();
      await page.goto(web.resolvedUrls.local[0]);
      await legacyPreloaded;
      assert.ok(busyRequests > 0, 'older servers trigger the serial fallback');
      await schedule.getByRole('tab', { name: '월', exact: true }).click();
      await artwork.waitFor();
      assert.equal(await schedule.getByRole('button', { name: '다시 시도', exact: true }).isVisible(), false);
      legacyLimit = false;
    }
    assert.ok(maxFetches > 1 && maxFetches <= 4, `Expected at most four parallel network requests, saw ${maxFetches}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Home plugin isolation, resize, permissions, navigation and errors; weekly schedule artwork, skeletons, preloading, arrow paging, direct details, search fallback, stale responses, bounded parallel weekly preloading, circular weekdays and responsive paging passed.');
} finally { await browser.close(); await web.close(); }
