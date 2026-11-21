// Local-only regression suite; API responses and all media are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
assert.match(base, /^http:\/\/127\.0\.0\.1:51\d\d$/);
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, headless: true });
const errors = [], results = [];
const source = id => ({ id, name: id, lang: id === 'fast' ? 'en' : 'ko', type: 'anime', enabled: true, installed: true });
const card = (n, provider = 'fast') => ({ id: `${provider}-${n}`, title: `검증 작품 ${n}`, type: 'anime', provider: { ...source(provider), kind: 'mangayomi-js' }, groupId: `group-${n}`, groupMemberIds: [`fast-${n}`, `slow-${n}`], sourceCount: provider === 'slow' ? 2 : 1 });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture({ mode = 'off', mobile = false, incremental = false, split = false, overlap = false, failLate = false, completed = false, timed = false, grouped = true } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(({ mode, grouped }) => {
    localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', mode);
    localStorage.setItem('moa.deviceSettings:test', JSON.stringify({ value: { titleGrouping: grouped }, dirty: null }));
  }, { mode, grouped });
  const page = await context.newPage(), slow = gate(), firstGroups = gate(), finalGroups = gate();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const calls = { resolves: 0 };
  if (timed) await page.addInitScript(() => {
    window.searchVisit = 0;
    window.firstCards = [];
    window.finalCards = [];
    const observe = () => {
      if (location.pathname === '/search' && !window.firstCards[window.searchVisit]) {
        const card = document.querySelector('a.poster-card');
        const rect = card?.getBoundingClientRect();
        if (rect?.height && rect.top < innerHeight && rect.bottom > 0) window.firstCards[window.searchVisit] = performance.now();
      }
      if (location.pathname === '/search' && !window.finalCards[window.searchVisit] && document.querySelector('a.poster-card[aria-label="검증 작품 48"]')) {
        window.finalCards[window.searchVisit] = performance.now();
      }
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
    window.addEventListener('popstate', () => {
      if (location.pathname === '/search') { window.searchVisit++; window.searchReturnAt = performance.now(); }
    });
  });
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    let body = [];
    if (pathname === '/api/sources') body = incremental ? [source('fast'), source('slow')] : [source('fast')];
    else if (pathname === '/api/profiles') body = [{ id: 'test', name: '테스트', color: 'blue' }];
    else if (pathname === '/api/settings') body = { navigation: [] };
    else if (pathname === '/api/settings/device') body = { settings: { titleGrouping: grouped } };
    else if (pathname === '/api/me') body = { role: 'admin' };
    else if (pathname === '/api/admin/downloads') body = { enabled: false, allowed: false, storageReady: false, configured: false, quality: 'best', reason: null, quotaBytes: 0, usedBytes: 0, jobs: [], totalJobs: 0, activeJobs: 0, nextCursor: null };
    else if (pathname === '/api/search') body = { query: url.searchParams.get('q'), groups: [] };
    else if (pathname.endsWith('/browse')) {
      const provider = pathname.split('/')[3];
      if (timed) await new Promise(resolve => setTimeout(resolve, provider === 'fast' ? 100 : 300));
      else if (provider === 'slow') await slow.promise;
      body = { items: Array.from({ length: (timed || overlap) && provider === 'fast' ? 47 : 48 }, (_, n) => {
        const { groupId, groupMemberIds, sourceCount, ...raw } = card(n + 1, provider);
        return raw;
      }), page: 1, hasNextPage: false };
    } else if (pathname === '/api/media/groups/resolve') {
      calls.resolves++;
      if (timed) await new Promise(resolve => setTimeout(resolve, 350));
      const ids = route.request().postDataJSON().ids, late = ids.some(id => id.startsWith('slow-'));
      if (overlap) await (late ? finalGroups : firstGroups).promise;
      if (late && failLate) return route.fulfill({ status: 500, json: { error: 'synthetic-resolver-failure' } });
      body = Array.from({ length: (timed || overlap) && !late ? 47 : 48 }, (_, n) => card(n + 1, late ? 'slow' : 'fast'));
      if (late && split) {
        body[0] = { ...card(1, 'slow'), groupId: 'split-slow', groupMemberIds: ['slow-1'] };
        body.push({ ...card(1, 'fast'), groupId: 'split-fast', groupMemberIds: ['fast-1'] });
      }
      // A later resolver response may choose another representative and a different order.
      if (late) body.reverse();
      if (!split) body[0] = { ...body[0], resumeMediaId: 'watched', ...(!completed ? { resume: { episodeId: 'watched-1', position: 200, label: '이어보기 S1:E1', kind: 'resume' } } : {}) };
    } else if (pathname === '/api/media/popular') body = [];
    else if (pathname.endsWith('/group')) body = { id: 'group', manual: false, members: [] };
    else if (/^\/api\/media\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/').at(-1));
      body = { ...card(1), id, title: '상세 검증 작품', seasons: [{ number: 1, episodes: [{ id: `${id}-1`, mediaId: id, season: 1, number: 1, title: '1화', duration: 600 }] }], playTarget: { episodeId: `${id}-1`, position: id === 'watched' && !completed ? 200 : 0, label: id === 'watched' ? completed ? '다시 보기' : '이어보기' : '재생' } };
    }
    await route.fulfill({ json: body }).catch(() => {});
  });
  return { page, context, slow, firstGroups, finalGroups, calls, close: async () => { slow.release(); firstGroups.release(); finalGroups.release(); await context.close(); } };
}

try {
  for (const grouped of [true, false]) {
    const f = await fixture({ timed: true, incremental: true, grouped }), p = f.page;
    try {
      await p.goto(`${base}/search?q=검증`);
      await p.waitForFunction(grouped => window.finalCards[0] && document.querySelector('a.poster-card[href^="/title/slow-"]') && document.querySelectorAll('a.poster-card').length === (grouped ? 48 : 95) && !document.querySelector('.grid .sk.art-poster'), grouped);
      await p.locator('a.poster-card').first().click();
      await p.locator('.title-page:not(.title-skeleton)').waitFor();
      const refresh = p.waitForResponse(response => response.url().endsWith('/fast/browse') && response.status() === 200);
      await p.goBack();
      await (await refresh).finished();
      await p.waitForFunction(() => window.finalCards[1] && performance.getEntriesByType('resource').filter(e => e.name.endsWith('/fast/browse') && e.responseStatus === 200).length >= 2);
      const timing = await p.evaluate(() => {
        const responses = performance.getEntriesByType('resource').filter(e => e.name.endsWith('/fast/browse') && e.responseStatus === 200).map(e => e.responseEnd);
        return {
          coldMsAfterFirstResponse: Math.round(window.firstCards[0] - responses[0]),
          warmMsAfterFirstResponse: Math.round(window.firstCards[1] - responses[1]),
          warmMsFromBack: Math.round(window.firstCards[1] - window.searchReturnAt),
          coldFinalMsAfterFirstResponse: Math.round(window.finalCards[0] - responses[0]),
          warmFinalMsAfterFirstResponse: Math.round(window.finalCards[1] - responses[1]),
          warmFinalMsFromBack: Math.round(window.finalCards[1] - window.searchReturnAt)
        };
      });
      assert.ok(timing.warmMsAfterFirstResponse < 0, 'cached cards are visible before the warm source refresh returns');
      console.log(JSON.stringify({ grouped, ...timing }));
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ mode: 'on', incremental: true, overlap: true }), p = f.page;
    try {
      const firstRequest = p.waitForRequest(req => req.url().endsWith('/media/groups/resolve'));
      const laterRequest = p.waitForRequest(req => req.url().endsWith('/media/groups/resolve') && req.postDataJSON().ids.includes('slow-48'));
      await p.goto(`${base}/search?q=검증`);
      await firstRequest;
      f.slow.release();
      await laterRequest; // The latest request also starts before the first batch resolves.
      f.firstGroups.release();
      // The first batch must remain usable even if a second source arrived before it resolved.
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 47);
      const target = p.locator('a.poster-card').nth(13);
      await target.focus();
      await target.evaluate(el => { window.keptSearchCard = el; });
      const identity = await target.getAttribute('data-remote-id');
      assert.ok(identity, 'search cards have a stable remote identity');
      const oldOrder = await p.locator('a.poster-card').evaluateAll(nodes => nodes.map(el => el.dataset.remoteId));
      f.finalGroups.release();
      await p.waitForFunction(() => [...document.querySelectorAll('a.poster-card')].every(el => el.getAttribute('href').includes('slow-') || el.getAttribute('href').includes('watched')));
      assert.equal(await p.evaluate(() => window.keptSearchCard.isConnected), true, 'representative changes preserve the existing card DOM node');
      assert.equal(await p.evaluate(() => document.activeElement === window.keptSearchCard), true, 'late source preserves focused card');
      assert.equal(await p.getByRole('link', { name: '검증 작품 48', exact: true }).count(), 1, 'new title from the later source appears once');
      assert.deepEqual(await p.locator('a.poster-card').evaluateAll(nodes => nodes.slice(0, 47).map(el => el.dataset.remoteId)), oldOrder, 'late source does not reorder already shown card slots');
      results.push('incremental representatives preserve DOM nodes, stable order and TV focus');
    } catch (error) { console.error({ url: p.url(), body: await p.locator('body').innerText(), errors }); throw error; }
    finally { await f.close(); }
  }
  {
    const f = await fixture({ incremental: true, overlap: true }), p = f.page;
    try {
      const firstRequest = p.waitForRequest(req => req.url().endsWith('/media/groups/resolve'));
      await p.goto(`${base}/search?q=검증`);
      await firstRequest;
      f.slow.release(); f.finalGroups.release();
      const distinct = p.getByRole('link', { name: '검증 작품 48', exact: true });
      await distinct.waitFor();
      await distinct.focus();
      f.firstGroups.release();
      await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await distinct.evaluate(el => el === document.activeElement), true, 'older response never replaces the completed latest batch');
      assert.equal(f.calls.resolves, 2, 'observers share identical requests');
    } finally { await f.close(); }
  }
  for (const grouped of [true, false]) {
    const f = await fixture({ incremental: true, mode: 'on', grouped }), p = f.page;
    const failed = new Set(['library', 'directory', 'slow']);
    const calls = { library: 0, directory: 0, fast: 0, slow: 0 };
    let noSources = false, holdSlow = false;
    const retry = gate();
    f.slow.release();
    await p.route(url => ['/api/search', '/api/sources'].includes(url.pathname) || url.pathname.endsWith('/browse'), async route => {
      const path = new URL(route.request().url()).pathname;
      const key = path === '/api/search' ? 'library' : path === '/api/sources' ? 'directory' : path.split('/')[3];
      calls[key]++;
      if (failed.has(key)) return route.fulfill({ status: 400, json: { error: 'fixture-failure' } });
      if (key === 'directory' && noSources) return route.fulfill({ json: [] });
      if (key === 'slow' && holdSlow) await retry.promise;
      await route.fallback();
    });
    const failure = p.locator('.search-error'), cards = p.locator('a.poster-card');
    try {
      await p.goto(`${base}/search?q=검증`);
      await failure.filter({ hasText: '내 라이브러리, 설치된 소스 목록' }).waitFor();
      assert.equal(await p.locator('.search-empty').count(), 0);
      failed.delete('library'); failed.delete('directory');
      await failure.getByRole('button').click();
      await failure.filter({ hasText: 'slow 조회에 실패' }).waitFor();
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 48);
      const before = { ...calls };
      const target = cards.nth(8);
      await target.focus();
      await target.evaluate(el => { window.faultFocus = el; });
      failed.clear(); holdSlow = true;
      await failure.getByRole('button').click();
      await target.focus();
      retry.release();
      await failure.waitFor({ state: 'hidden' });
      await p.waitForFunction(() => !!document.querySelector('a.poster-card[href^="/title/slow-"]'));
      assert.equal(await p.evaluate(() => document.activeElement === window.faultFocus), true, 'successful card stays focused through retry');
      assert.deepEqual(calls, { ...before, slow: before.slow + 1 }, 'partial retry fetches only the failed source');
      assert.equal(await cards.count(), grouped ? 48 : 96);

      // A failed background refresh on Back still has usable cards in the query cache.
      await cards.nth(8).click();
      await p.locator('.title-page:not(.title-skeleton)').waitFor();
      failed.add('fast'); failed.add('library');
      await p.goBack();
      await failure.filter({ hasText: '내 라이브러리, fast' }).waitFor();
      assert.equal(await cards.count(), grouped ? 48 : 96, 'cached source cards survive a failed refresh');
      const cached = { ...calls };
      failed.clear();
      await failure.getByRole('button').click();
      await failure.waitFor({ state: 'hidden' });
      assert.deepEqual(calls, { ...cached, fast: cached.fast + 1, library: cached.library + 1 });
      await p.waitForFunction(() => document.activeElement?.matches('a.poster-card'));

      noSources = true;
      await p.goto(`${base}/search?q=빈결과`);
      await p.locator('.search-empty').waitFor();
      assert.equal(await p.locator('.search-page').getByText(/결과가 없/).count(), 1, 'one empty message when every lookup succeeds');
      assert.equal(await failure.count(), 0);
      results.push(`grouping ${grouped ? 'on' : 'off'} distinguishes all failures, partial failures and empty success; targeted retries retain cached cards and TV focus`);
    } catch (error) { console.error({ grouped, calls, url: p.url(), body: await p.locator('body').innerText(), errors }); throw error; }
    finally { retry.release(); await f.close(); }
  }
  for (const options of [{ mode: 'off' }, { mode: 'off', mobile: true }, { mode: 'on' }]) {
    const f = await fixture(options), p = f.page;
    try {
      await p.goto(`${base}/search?q=검증`);
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 48);
      const target = p.locator('a.poster-card').nth(35);
      await target.scrollIntoViewIfNeeded();
      await target.focus();
      const scroll = await p.evaluate(() => window.scrollY), identity = await target.getAttribute('data-remote-id');
      assert.ok(scroll > 300, 'search fixture is scrolled deeply');
      await target.click();
      await p.waitForURL('**/title/fast-36');
      await p.getByRole('button', { name: '이전 화면', exact: true }).waitFor();
      if (options.mode === 'on') { await p.waitForTimeout(100); await p.keyboard.press('Escape'); }
      else if (options.mobile) await p.goBack();
      else {
        await p.locator('.title-page:not(.title-skeleton)').waitFor();
        await p.getByRole('button', { name: '이전 화면', exact: true }).click();
      }
      await p.waitForURL('**/search?q=*');
      await p.waitForFunction(({ scroll, identity }) => Math.abs(window.scrollY - scroll) < 3 && document.activeElement?.getAttribute('data-remote-id') === identity, { scroll, identity });
      assert.equal(await p.locator('.searchbox-page input').inputValue(), '검증');
      // Repeating the same trip exercises the same history entry rather than a new entry.
      await p.keyboard.press('Enter');
      await p.waitForURL('**/title/fast-36');
      await p.goBack();
      await p.waitForFunction(scroll => Math.abs(window.scrollY - scroll) < 3, scroll);
      results.push(`${options.mobile ? 'mobile browser' : options.mode === 'on' ? 'TV remote' : 'desktop button'} Back restores search text, scroll and selected card`);
    } catch (error) { console.error({ options, url: p.url(), body: await p.locator('body').innerText(), errors }); throw error; }
    finally { await f.close(); }
  }
  for (const failLate of [false, true]) {
    const f = await fixture({ incremental: true, split: !failLate, failLate }), p = f.page;
    try {
      await p.goto(`${base}/search?q=검증`);
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 48);
      f.slow.release();
      const expected = failLate ? 96 : 49;
      await p.waitForFunction(expected => document.querySelectorAll('a.poster-card').length === expected, expected);
      const identities = await p.locator('a.poster-card').evaluateAll(cards => cards.map(card => card.dataset.remoteId));
      assert.equal(new Set(identities).size, expected, 'split or fallback results each own a unique card slot');
      assert.equal(await p.locator('a.poster-card[href="/title/fast-1"]').count(), 1);
      assert.equal(await p.locator('a.poster-card[href="/title/slow-1"]').count(), 1);
      results.push(failLate ? 'late resolver failure exposes every distinct raw card' : 'a group split preserves both resulting cards without slot collisions');
    } finally { await f.close(); }
  }
  for (const completed of [false, true]) {
    const f = await fixture({ completed }), p = f.page;
    try {
      await p.goto(`${base}/search?q=검증`);
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 48);
      const resumed = p.locator('a.poster-card').first();
      assert.equal(await resumed.getAttribute('href'), '/title/watched');
      await resumed.click();
      await p.waitForURL('**/title/watched');
      await p.waitForFunction(() => !!document.querySelector('a[href="/watch/watched-1"]'));
      results.push(completed ? 'completed grouped search opens the last watched source for rewatch' : 'searched grouped card opens latest watched source detail and resume target');
    } finally { await f.close(); }
  }
  {
    const f = await fixture(), p = f.page;
    try {
      await p.goto(`${base}/profiles`);
      await p.getByRole('button', { name: '테스트', exact: true }).waitFor();
      await p.evaluate(async () => {
        const dependency = name => import(performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname.endsWith(`/${name}`)).name);
        const react = await dependency('react.js'), React = react.default || react;
        const dom = await dependency('react-dom_client.js'), { createRoot } = dom.default || dom;
        const { MemoryRouter, Routes, Route, Link, useNavigate } = await dependency('react-router-dom.js');
        const { useBrowsingPosition } = await import('/src/lib/browsing-position.ts');
        document.getElementById('root').style.display = 'none';
        const mount = document.createElement('div'); document.body.prepend(mount);
        let visits = 0;
        function Layout() { useBrowsingPosition(); return React.createElement('main', { className: 'page' }, React.createElement(Routes, null, React.createElement(Route, { path: '/', element: React.createElement(List) }), React.createElement(Route, { path: '/detail', element: React.createElement(Detail) }))); }
        function List() {
          const [loaded, setLoaded] = React.useState(false);
          React.useEffect(() => { const timer = setTimeout(() => setLoaded(true), visits++ ? 700 : 0); return () => clearTimeout(timer); }, []);
          return React.createElement('div', { 'data-async-list': loaded ? 'loaded' : 'pending' }, loaded ? Array.from({ length: 60 }, (_, i) => React.createElement(Link, { key: i, to: '/detail', 'data-remote-id': `async-${i}`, style: { display: 'block', height: '100px' } }, `비동기 카드 ${i}`)) : '불러오는 중');
        }
        function Detail() { const navigate = useNavigate(); return React.createElement('button', { 'data-async-back': true, onClick: () => navigate(-1) }, '비동기 뒤로'); }
        createRoot(mount).render(React.createElement(MemoryRouter, { initialEntries: [{ pathname: '/', key: 'async-test' }] }, React.createElement(Layout)));
      });
      const target = p.locator('[data-remote-id="async-40"]');
      await target.waitFor(); await target.scrollIntoViewIfNeeded(); await target.focus();
      const scroll = await p.evaluate(() => window.scrollY);
      await target.click();
      await p.locator('[data-async-back]').click();
      await p.locator('[data-async-list="pending"]').waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.hasAttribute('data-restoring-position')), true, 'POP restoration remains pending while card DOM is unavailable');
      await p.waitForFunction(scroll => Math.abs(window.scrollY - scroll) < 3 && document.activeElement?.getAttribute('data-remote-id') === 'async-40', scroll);
      results.push('asynchronous POP waits for the selected card and sufficient page height before restoring');
      await target.click();
      await p.locator('[data-async-back]').click();
      await p.locator('[data-async-list="pending"]').waitFor();
      await p.mouse.wheel(0, -100);
      await p.waitForFunction(() => !document.documentElement.hasAttribute('data-restoring-position'));
      await p.locator('[data-async-list="loaded"]').waitFor();
      assert.ok(await p.evaluate(() => window.scrollY) < 100, 'user wheel cancels pending restoration and prevents a delayed jump');
      results.push('user input cancels pending asynchronous restoration');
    } finally { await f.close(); }
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
