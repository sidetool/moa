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

async function fixture({ mode = 'off', mobile = false, incremental = false, split = false, failLate = false, completed = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(mode => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', mode); }, mode);
  const page = await context.newPage(), slow = gate();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const calls = { resolves: 0 };
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    let body = [];
    if (pathname === '/api/sources') body = incremental ? [source('fast'), source('slow')] : [source('fast')];
    else if (pathname === '/api/profiles') body = [{ id: 'test', name: '테스트', color: 'blue' }];
    else if (pathname === '/api/settings') body = { navigation: [] };
    else if (pathname === '/api/settings/device') body = { settings: { titleGrouping: true } };
    else if (pathname === '/api/me') body = { role: 'admin' };
    else if (pathname === '/api/admin/downloads') body = { enabled: false, allowed: false, storageReady: false, configured: false, quality: 'best', reason: null, quotaBytes: 0, usedBytes: 0, jobs: [], totalJobs: 0, activeJobs: 0, nextCursor: null };
    else if (pathname === '/api/search') body = { query: url.searchParams.get('q'), groups: [] };
    else if (pathname.endsWith('/browse')) {
      const provider = pathname.split('/')[3];
      if (provider === 'slow') await slow.promise;
      body = { items: Array.from({ length: 48 }, (_, n) => {
        const { groupId, groupMemberIds, sourceCount, ...raw } = card(n + 1, provider);
        return raw;
      }), page: 1, hasNextPage: false };
    } else if (pathname === '/api/media/groups/resolve') {
      calls.resolves++;
      const ids = route.request().postDataJSON().ids, late = ids.some(id => id.startsWith('slow-'));
      if (late && failLate) return route.fulfill({ status: 500, json: { error: 'synthetic-resolver-failure' } });
      body = Array.from({ length: 48 }, (_, n) => card(n + 1, late ? 'slow' : 'fast'));
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
  return { page, context, slow, calls, close: async () => { slow.release(); await context.close(); } };
}

try {
  {
    const f = await fixture({ mode: 'on', incremental: true }), p = f.page;
    try {
      await p.goto(`${base}/search?q=검증`);
      await p.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 48);
      const target = p.locator('a.poster-card').nth(13);
      await target.focus();
      await target.evaluate(el => { window.keptSearchCard = el; });
      const identity = await target.getAttribute('data-remote-id');
      assert.ok(identity, 'search cards have a stable remote identity');
      const oldOrder = await p.locator('a.poster-card').evaluateAll(nodes => nodes.map(el => el.dataset.remoteId));
      f.slow.release();
      await p.waitForFunction(() => document.querySelector('.search-sources')?.textContent.includes('slow48'));
      await p.waitForFunction(() => [...document.querySelectorAll('a.poster-card')].every(el => el.getAttribute('href').includes('slow-') || el.getAttribute('href').includes('watched')));
      assert.equal(await p.evaluate(() => window.keptSearchCard.isConnected), true, 'representative changes preserve the existing card DOM node');
      assert.equal(await p.evaluate(() => document.activeElement === window.keptSearchCard), true, 'late source preserves focused card');
      assert.deepEqual(await p.locator('a.poster-card').evaluateAll(nodes => nodes.map(el => el.dataset.remoteId)), oldOrder, 'late source does not reorder already shown card slots');
      results.push('incremental representatives preserve DOM nodes, stable order and TV focus');
    } catch (error) { console.error({ url: p.url(), body: await p.locator('body').innerText(), errors }); throw error; }
    finally { await f.close(); }
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
