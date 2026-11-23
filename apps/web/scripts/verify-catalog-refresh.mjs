import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verificationPath } from './verification-path.mjs';

// Run against the app with VITE_MOCK=1. Extend the existing mock for responses
// whose timing, profile or failure state must be deterministic.
const base = new URL(process.env.MOA_TEST_BASE || 'http://127.0.0.1:5187');
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const failures = [];

function installFixture() {
  if (!localStorage.getItem('moa.profile')) localStorage.setItem('moa.profile', 'p1');
  const state = window.catalogFixture = { titleReads: 0, sourceReads: 0, listReads: [], statusReads: 0, settingsReads: 0, refreshes: [], saves: [], observed: 1 };
  const wait = key => new Promise(resolve => { state[key] = resolve; });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  function withSeasons(detail) {
    if (localStorage.getItem('verify.episodeCase') === 'shrink') {
      const season = detail.seasons[0];
      const episodes = Array.from({ length: state.refreshes.length ? 60 : 150 }, (_, i) => ({
        ...season.episodes[0], id: `episode-${i + 1}`, number: i + 1, title: `${i + 1}화`
      }));
      return { ...detail, seasons: [{ ...season, episodes }] };
    }
    if (!state.layoutTitle) return detail;
    const second = { number: 2, title: '시즌 2 · 아주 긴 부제가 붙은 시즌', episodes: detail.seasons[0].episodes.slice(0, 2)
      .map(episode => ({ ...episode, id: `s2-${episode.id}`, season: 2 })) };
    return { ...detail, seasons: [...detail.seasons, second] };
  }
  let currentFetch = window.fetch.bind(window);
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    get: () => currentFetch,
    set: mock => {
      currentFetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
        const method = init?.method ?? 'GET';
        const profile = new Headers(init?.headers).get('x-moa-profile');
        if (url.pathname === '/api/admin/catalog-refresh') {
          if (method === 'GET') state.settingsReads++;
          if (method === 'PATCH') {
            const body = JSON.parse(init.body);
            state.saves.push(body.intervalMinutes);
            if (state.failSave) return json({ error: 'fixture-failure' }, 500);
            localStorage.setItem('verify.catalog.interval', String(body.intervalMinutes));
          }
          return json({ intervalMinutes: Number(localStorage.getItem('verify.catalog.interval') || 60) });
        }
        if (url.pathname === '/api/media/demo-1' && method === 'GET') {
          state.titleReads++;
          const response = await mock(input, init);
          const detail = await response.json();
          const episodeCase = localStorage.getItem('verify.episodeCase');
          if (episodeCase === 'empty') return json({ ...detail, seasons: [], playTarget: undefined, refreshing: false });
          if (episodeCase === 'live') return json({ ...detail, badge: 'LIVE', refreshing: false });
          return json({ ...withSeasons(detail), title: profile === 'p2' ? '가족의 작품' : !state.titleReady ? '저장한 작품' : state.layoutTitle || '확인한 작품',
            ...(state.titleReady && state.layoutLogo ? { logo: state.layoutLogo } : {}),
            refreshing: episodeCase !== 'shrink' && profile === 'p1' && !state.titleReady });
        }
        if (url.pathname === '/api/media/demo-1/refresh' && method === 'POST') {
          state.refreshes.push(profile);
          const partial = state.partial;
          const response = await mock('/api/media/demo-1', { method: 'GET' });
          const detail = await response.json();
          await wait('finishTitle');
          return json({ detail: { ...withSeasons(detail), title: '수동 갱신 작품', refreshing: false }, errors: partial ? ['metadata'] : [] });
        }
        if (url.pathname === '/api/sources/sample-kr/browse') {
          state.sourceReads++;
          const response = await mock('/api/media/demo-1', { method: 'GET' });
          const detail = await response.json();
          return json({ page: 1, hasNextPage: false, items: [{ ...detail, title: !state.sourceReady ? '저장한 소스 목록' : '확인한 소스 목록' }],
            refreshing: !state.sourceReady });
        }
        if (localStorage.getItem('verify.savedGroup') && url.pathname === '/api/watchlist') {
          const response = await mock(input, init);
          const [card] = await response.json();
          return json(localStorage.getItem('verify.groupRemoved') ? [] : [{ ...card, id: 'saved-edition', inWatchlist: true,
            groupId: 'manual:fixture', groupMemberIds: ['saved-edition'], watchlistMediaId: 'saved-edition', resumeMediaId: 'demo-1' }]);
        }
        // Writes that bypass the saved group; counted across reloads.
        if (localStorage.getItem('verify.savedGroup') && url.pathname === '/api/watchlist/demo-1' && method !== 'GET')
          localStorage.setItem('verify.ungroupedWrites', String(Number(localStorage.getItem('verify.ungroupedWrites') ?? 0) + 1));
        if (localStorage.getItem('verify.savedGroup') && url.pathname === '/api/watchlist/demo-1/group' && url.searchParams.get('savedEdition') === 'saved-edition') {
          if (method === 'GET') {
            if (localStorage.getItem('verify.failGroupRead')) return json({ error: 'fixture-unavailable' }, 503);
            const grouped = !localStorage.getItem('verify.groupSeparated');
            return json({ grouped, inWatchlist: grouped && !localStorage.getItem('verify.groupRemoved') });
          }
          if (method === 'DELETE') {
            if (localStorage.getItem('verify.failGroupWrite')) {
              state.groupWriteFailed = true;
              return json({ error: 'fixture-unavailable' }, 503);
            }
            localStorage.setItem('verify.groupRemoved', '1');
          } else if (method === 'PUT') localStorage.removeItem('verify.groupRemoved');
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/api/watchlist/refresh-status') {
          state.statusReads++;
          if (state.statusGate) await state.statusGate;
          return json({ running: profile === 'p1' && !state.idleList && state.observed === 1, revision: profile === 'p1' ? 'p1-' + state.observed : 'p2' });
        }
        if (url.pathname === '/api/watchlist') {
          const sort = url.searchParams.get('sort');
          state.listReads.push([profile, sort]);
          if (profile === 'p1' && state.holdList) await wait('finishList');
          const response = await mock(input, init);
          const [first, second] = await response.json();
          if (state.longList) {
            const cards = Array.from({ length: 72 }, (_, i) => ({
              ...first, id: i === 55 ? 'demo-1' : `list-${i}`, title: `작품 ${i + 1}`, resumeMediaId: undefined
            }));
            return json(sort === 'updated' ? cards.reverse() : cards);
          }
          const saved = profile === 'p2' ? { ...first, id: 'demo-1', title: '가족의 목록' } : { ...first, title: '먼저 저장한 작품' };
          const updated = { ...second, title: '회차 갱신 작품', unseenEpisodeCount: state.observed };
          return json(profile === 'p2' ? [saved] : sort === 'updated' ? [updated, saved] : [saved, updated]);
        }
        return mock(input, init);
      };
    }
  });
}

async function scenario(name, width, run, seed) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
  await context.addInitScript(installFixture);
  if (seed) await context.addInitScript(seed);
  const page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, [], 'uncaught browser errors');
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
    await screenshot(page, `${name}-failure`);
  } finally {
    await context.close();
  }
}

const screenshot = (page, name) => process.env.MOA_VERIFY_DIR
  ? page.screenshot({ path: verificationPath(`catalog-refresh-${name}.png`), animations: 'disabled' }) : undefined;
const heading = (page, name) => page.getByRole('heading', { name, exact: true }).waitFor();
const control = (page, name) => page.getByRole('combobox', { name, exact: true });
const alert = (page, text) => page.getByRole('alert').filter({ hasText: text }).waitFor();
const fixture = (page, fn, argument) => page.evaluate(fn, argument);
const open = (page, path) => page.goto(new URL(path, base).href);

async function choose(page, name, option, keyboard) {
  const trigger = control(page, name);
  if (keyboard) {
    await trigger.focus();
    await trigger.press('Enter');
    await page.getByRole('listbox', { name, exact: true }).waitFor();
    await trigger.press('End');
    const active = await trigger.getAttribute('aria-activedescendant');
    assert.equal((await page.getByRole('option', { name: option, exact: true }).getAttribute('id')), active);
    await trigger.press('Enter');
  } else {
    await trigger.click();
    const menu = page.getByRole('listbox', { name, exact: true });
    assert.ok(await menu.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }), `${name} fits the viewport`);
    await menu.getByRole('option', { name: option, exact: true }).click();
  }
}

async function setupSettings(page) {
  await open(page, '/settings#library');
  await control(page, '정보 갱신 빈도').filter({ hasText: '기본' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="정보 갱신 빈도"]')?.disabled);
}

async function switchProfile(page) {
  await page.getByRole('button', { name: '프로필 메뉴' }).click();
  await page.getByRole('menuitem', { name: '프로필 전환' }).click();
  await page.getByRole('button', { name: '가족', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
}

async function assertPollingStops(page, counter, cachedReads) {
  const settledReads = await fixture(page, key => window.catalogFixture[key], counter);
  assert.ok(settledReads > cachedReads, 'refreshing=true led to another read');
  await page.waitForTimeout(2500);
  assert.equal(await fixture(page, key => window.catalogFixture[key], counter), settledReads, 'polling stops after refreshing=false');
}

async function openList(page) {
  await page.locator('nav a[href="/my-list"]:visible').click();
  await heading(page, '내 목록');
}

try {
  for (const width of [320, 390, 1280]) {
    await scenario(`settings-${width}`, width, async page => {
      await setupSettings(page);
      await control(page, '정보 갱신 빈도').scrollIntoViewIfNeeded();
      await screenshot(page, `settings-${width}`);
      await choose(page, '정보 갱신 빈도', '드물게', width === 1280);
      await control(page, '정보 갱신 빈도').filter({ hasText: '드물게' }).waitFor();
      assert.deepEqual(await fixture(page, () => window.catalogFixture.saves), [360]);
      await fixture(page, () => { window.catalogFixture.failSave = true; });
      await choose(page, '정보 갱신 빈도', '자주', false);
      await alert(page, '갱신 설정을 저장하지 못했어요.');
      await control(page, '정보 갱신 빈도').filter({ hasText: '드물게' }).waitFor();
      await page.reload();
      await control(page, '정보 갱신 빈도').filter({ hasText: '드물게' }).waitFor();
    });

    await scenario(`title-${width}`, width, async page => {
      await open(page, '/title/demo-1');
      await heading(page, '저장한 작품');
      const longTitle = '새벽 기차를 타고 도시를 지나 작은 바닷가 마을에 도착하기까지의 아주 긴 이야기';
      const cachedReads = await fixture(page, ({ width, longTitle }) => {
        const state = window.catalogFixture;
        state.titleReady = true;
        state.layoutTitle = longTitle;
        if (width === 390) state.layoutLogo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="180"><text x="0" y="135" font-size="128" fill="white">작품 로고</text></svg>');
        return state.titleReads;
      }, { width, longTitle });
      await heading(page, longTitle);
      if (width === 390) await page.waitForFunction(() => document.querySelector('.title-name img')?.naturalWidth > 0);
      const refresh = page.getByRole('button', { name: '회차 새로고침', exact: true });
      const panel = page.getByRole('region', { name: '회차', exact: true });
      const picker = panel.locator('button.season-trigger');
      await picker.click();
      await page.getByRole('menuitemradio', { name: /시즌 2/ }).click();
      await panel.locator('li[data-episode^="s2-"]').first().waitFor();
      const layout = await refresh.evaluate(button => {
        const icon = button.querySelector('svg').getBoundingClientRect(), box = button.getBoundingClientRect();
        const head = button.closest('.episodes-head'), sort = head.querySelector('[aria-label="최신화부터 보기"]').getBoundingClientRect();
        return { iconOnly: !button.textContent.trim() && icon.width <= 20 && !document.querySelector('.title-hero .episode-refresh-button'),
          transparent: getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)',
          touchTarget: box.width >= 44 && box.height >= 44,
          beforeSort: box.right <= sort.left && sort.left - box.right <= 8 && box.top < sort.bottom && box.bottom > sort.top,
          fits: [...head.querySelectorAll('button')].every(el => el.getBoundingClientRect().right <= innerWidth) };
      });
      assert.deepEqual(layout, { iconOnly: true, transparent: true, touchTarget: true, beforeSort: true, fits: true });
      if (width === 1280) {
        await assertPollingStops(page, 'titleReads', cachedReads);
        await panel.getByRole('button', { name: '최신화부터 보기' }).focus();
        await page.keyboard.press('ArrowLeft');
        assert.ok(await refresh.evaluate(button => button === document.activeElement), 'the remote moves left from sort to refresh');
        await page.keyboard.press('Enter');
      } else {
        await refresh.tap();
      }
      await page.getByRole('status').filter({ hasText: '갱신 중…' }).waitFor();
      assert.ok(await refresh.isDisabled());
      assert.equal(await refresh.getAttribute('aria-busy'), 'true');
      await page.waitForFunction(() => typeof window.catalogFixture.finishTitle === 'function');
      await fixture(page, () => window.catalogFixture.finishTitle());
      await heading(page, '수동 갱신 작품');
      assert.match(await picker.textContent(), /시즌 2/);
      await page.getByRole('status').filter({ hasText: '갱신 완료' }).waitFor();
      await fixture(page, () => { window.catalogFixture.partial = true; window.catalogFixture.finishTitle = null; });
      await refresh.click();
      await page.waitForFunction(() => typeof window.catalogFixture.finishTitle === 'function');
      await fixture(page, () => window.catalogFixture.finishTitle());
      await alert(page, '일부 정보를 갱신하지 못했어요.');
      assert.deepEqual(await fixture(page, () => window.catalogFixture.refreshes), ['p1', 'p1']);
      await screenshot(page, `title-${width}`);
    }, width === 1280 ? () => localStorage.setItem('moa.remoteMode', 'on') : undefined);

    await scenario(`list-${width}`, width, async page => {
      await open(page, '/my-list');
      const cards = page.locator('main a.poster-card');
      await cards.first().waitFor();
      assert.equal(await cards.first().getAttribute('aria-label'), '먼저 저장한 작품');
      await page.getByText('안 본 회차 1개', { exact: true }).waitFor();
      await fixture(page, () => { window.catalogFixture.observed = 2; });
      await page.getByText('안 본 회차 2개', { exact: true }).waitFor();
      await choose(page, '내 목록 정렬', '회차 업데이트순', width === 1280);
      await page.waitForFunction(() => document.querySelector('main .poster-card')?.getAttribute('aria-label') === '회차 갱신 작품');
      const updatedCard = page.getByRole('link', { name: '회차 갱신 작품', exact: true });
      const describedBy = await updatedCard.getAttribute('aria-describedby');
      assert.ok(describedBy, 'the title-only link exposes the unseen count as a description');
      assert.equal(await page.locator(`[id="${describedBy}"]`).textContent(), '안 본 회차 2개');
      assert.equal(await cards.filter({ hasText: '안 본 회차' }).count(), 1);
      assert.ok((await fixture(page, () => window.catalogFixture.listReads)).some(([id, sort]) => id === 'p1' && sort === 'updated'));
      await screenshot(page, `list-${width}`);
    });
  }

  await scenario('list-remote-navigation', 1280, async page => {
    await open(page, '/');
    await openList(page);
    const cards = page.locator('main a.poster-card');
    const sort = control(page, '내 목록 정렬');
    const menu = page.getByRole('listbox', { name: '내 목록 정렬' });
    const remoteKey = (key, keyCode) => page.evaluate(({ key, keyCode }) =>
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })), { key, keyCode });
    await sort.focus();
    await page.keyboard.press('ArrowDown');
    await menu.waitFor();
    assert.equal(await page.locator('html[data-tv]').count(), 0, 'keyboard selection does not activate spatial navigation');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await cards.first().focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('html[data-tv]').count(), 1, 'directional navigation from a poster activates TV mode');
    assert.ok(await sort.evaluate(el => el === document.activeElement));
    await remoteKey('Select', 23);
    await menu.waitFor();
    await page.keyboard.press('ArrowRight');
    assert.ok(await sort.evaluate(el => el === document.activeElement));
    await page.keyboard.press('ArrowDown');
    await fixture(page, () => { window.catalogFixture.holdList = true; });
    await remoteKey('Select', 23);
    await page.waitForFunction(() => typeof window.catalogFixture.finishList === 'function');
    assert.ok(await sort.evaluate(el => el === document.activeElement && el.getAttribute('aria-expanded') === 'false'));
    await fixture(page, () => {
      window.catalogFixture.holdList = false;
      window.catalogFixture.finishList();
    });
    await cards.first().filter({ hasText: '회차 갱신 작품' }).waitFor();
    await sort.filter({ hasText: '회차 업데이트순' }).waitFor();
    await page.keyboard.press('ArrowDown');
    assert.ok(await cards.evaluateAll(els => els.includes(document.activeElement)), 'down returns to a poster');
    await page.keyboard.press('ArrowUp');
    for (const [key, code] of [['Unidentified', 461], ['BrowserBack', 0], ['Backspace', 8]]) {
      await page.keyboard.press('Enter');
      await menu.waitFor();
      await page.keyboard.press('ArrowUp');
      await remoteKey(key, code);
      await menu.waitFor({ state: 'hidden' });
      assert.ok(await sort.evaluate(el => el === document.activeElement && el.textContent === '회차 업데이트순'));
      assert.equal(new URL(page.url()).pathname, '/my-list');
    }
    await remoteKey('Unidentified', 10009);
    await page.waitForURL(url => url.pathname === '/');
    await openList(page);
    await sort.filter({ hasText: '담은 순' }).waitFor();
  });

  for (const width of [390, 1280]) {
    await scenario(`list-history-${width}`, width, async page => {
      await open(page, '/');
      await fixture(page, () => { window.catalogFixture.longList = true; });
      await openList(page);
      await choose(page, '내 목록 정렬', '회차 업데이트순', width === 1280);
      const cards = page.locator('main a.poster-card');
      await cards.first().filter({ hasText: '작품 72' }).waitFor();
      const cardOrder = () => cards.evaluateAll(els => els.map(el => el.getAttribute('aria-label')));
      const beforeOrder = await cardOrder();
      const selected = cards.nth(16);
      assert.equal(await selected.evaluate(link => link.pathname), '/title/demo-1');
      await selected.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const before = await selected.evaluate(el => ({ top: el.getBoundingClientRect().top, scroll: scrollY }));
      assert.ok(before.scroll > 0 && before.top >= 0);
      if (width === 1280) {
        await selected.focus();
        await page.keyboard.press('Enter');
      } else await selected.tap();
      await heading(page, '저장한 작품');
      if (width === 1280) await page.keyboard.press('Escape');
      else await page.goBack();
      await control(page, '내 목록 정렬').filter({ hasText: '회차 업데이트순' }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '작품 56');
      assert.deepEqual(await cardOrder(), beforeOrder, 'Back restores the same order');
      const after = await selected.evaluate(el => ({ top: el.getBoundingClientRect().top, scroll: scrollY }));
      assert.ok(Math.abs(after.scroll - before.scroll) <= 2 && Math.abs(after.top - before.top) <= 2,
        JSON.stringify({ before, after }));
      assert.ok(after.top >= 0 && after.top < 900, 'focused card remains in view');
    }, width === 1280 ? () => localStorage.setItem('moa.remoteMode', 'on') : undefined);
  }

  await scenario('episode-range-shrinks', 390, async page => {
    await open(page, '/title/demo-1');
    await page.getByRole('tab', { name: '101–150', exact: true }).click();
    await page.locator('li[data-episode="episode-101"]').waitFor();
    await page.getByRole('button', { name: '회차 새로고침', exact: true }).click();
    await page.waitForFunction(() => typeof window.catalogFixture.finishTitle === 'function');
    await fixture(page, () => window.catalogFixture.finishTitle());
    await page.getByRole('tab', { name: '51–60', selected: true, exact: true }).waitFor();
    assert.equal(await page.locator('.episode-list > li').count(), 10);
    await page.locator('li[data-episode="episode-60"]').waitFor();
  }, () => localStorage.setItem('verify.episodeCase', 'shrink'));

  await scenario('empty-episodes', 320, async page => {
    await open(page, '/title/demo-1');
    const panel = page.getByRole('region', { name: '회차', exact: true });
    await panel.getByText('아직 제공된 회차가 없습니다.').waitFor();
    assert.equal(await panel.getByRole('button', { name: '최신화부터 보기' }).count(), 0);
    await panel.getByRole('button', { name: '회차 새로고침' }).tap();
    await page.waitForFunction(() => typeof window.catalogFixture.finishTitle === 'function');
    await fixture(page, () => window.catalogFixture.finishTitle());
    await panel.locator('li[data-episode]').first().waitFor();
    await panel.getByRole('button', { name: '최신화부터 보기' }).waitFor();
  }, () => localStorage.setItem('verify.episodeCase', 'empty'));

  await scenario('movie-and-live', 390, async page => {
    for (const [id, name] of [['demo-2', '여름의 끝에서'], ['demo-1', '밤의 도시를 걷다']]) {
      await open(page, '/title/' + id);
      await heading(page, name);
      assert.equal(await page.getByRole('button', { name: '회차 새로고침' }).count(), 0);
    }
  }, () => localStorage.setItem('verify.episodeCase', 'live'));

  await scenario('watched-detail-manages-saved-edition', 1280, async page => {
    await open(page, '/my-list');
    const card = page.locator('main a.poster-card').first();
    const path = '/title/demo-1?savedEdition=saved-edition';
    assert.equal(await card.getAttribute('href'), path);
    await card.click();
    const saved = page.getByRole('button', { name: '내 목록에 있음', exact: true });
    await saved.waitFor();
    assert.equal(await saved.getAttribute('aria-pressed'), 'true');
    const direct = await page.context().newPage();
    await open(direct, path);
    await direct.getByRole('button', { name: '내 목록에 있음', exact: true }).waitFor();
    await direct.close();
    await fixture(page, () => localStorage.setItem('verify.failGroupWrite', '1'));
    await saved.click();
    await page.waitForFunction(() => window.catalogFixture.groupWriteFailed && document.querySelector('.hero-actions [aria-pressed]')?.disabled === false);
    assert.equal(await saved.getAttribute('aria-pressed'), 'true');
    await fixture(page, () => localStorage.removeItem('verify.failGroupWrite'));
    await saved.click();
    const removed = page.getByRole('button', { name: '내 목록', exact: true });
    await removed.waitFor();
    assert.equal(await removed.getAttribute('aria-pressed'), 'false');
    await page.reload();
    await removed.waitFor();
    await removed.click();
    await saved.waitFor();
    await fixture(page, () => localStorage.setItem('verify.failGroupRead', '1'));
    await page.reload();
    // An unreadable group keeps the same "내 목록" button without a pressed state and a short note;
    // pressing it only checks again and never writes to the ungrouped edition.
    const ungrouped = () => fixture(page, () => localStorage.getItem('verify.ungroupedWrites'));
    const ungroupedBefore = await ungrouped();
    await page.getByRole('alert').filter({ hasText: '내 목록 상태를 확인하지 못했어요' }).waitFor({ timeout: 10_000 });
    const unknown = page.locator('.hero-actions').getByRole('button', { name: '내 목록', exact: true });
    assert.equal(await unknown.getAttribute('aria-pressed'), null);
    await unknown.click();
    // Let the re-check and its quiet retries finish before the fixture recovers.
    await page.locator('.hero-actions button[aria-disabled="true"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('.hero-actions button[aria-disabled="true"]') && document.querySelector('.title-action-note'), null, { timeout: 10_000 });
    assert.equal(await fixture(page, () => localStorage.getItem('verify.groupRemoved')), null);
    assert.equal(await ungrouped(), ungroupedBefore, 'no write to another edition while the group is unknown');
    await fixture(page, () => localStorage.removeItem('verify.failGroupRead'));
    await unknown.click();
    await saved.waitFor();
    assert.equal(await ungrouped(), ungroupedBefore);
    await fixture(page, () => localStorage.setItem('verify.groupSeparated', '1'));
    await page.reload();
    await removed.waitFor();
    await removed.click();
    await saved.waitFor();
    assert.equal(await fixture(page, () => localStorage.getItem('verify.groupRemoved')), null);
  }, () => localStorage.setItem('verify.savedGroup', '1'));

  await scenario('idle-list-shared-edition', 1280, async page => {
    await page.clock.install();
    await open(page, '/');
    await fixture(page, () => { window.catalogFixture.idleList = true; });
    await openList(page);
    await page.getByText('안 본 회차 1개', { exact: true }).waitFor();
    await page.clock.runFor(250);
    const polls = await fixture(page, () => window.catalogFixture.statusReads);
    await fixture(page, () => { window.catalogFixture.observed = 3; });
    await page.clock.fastForward(55_000);
    assert.equal(await fixture(page, () => window.catalogFixture.statusReads), polls, 'idle viewers retain the minute interval');
    await page.clock.fastForward(5_100);
    await page.getByText('안 본 회차 3개', { exact: true }).waitFor();
    assert.equal(await fixture(page, () => window.catalogFixture.statusReads), polls + 1);
  });

  await scenario('list-already-refreshed', 1280, async page => {
    await open(page, '/');
    await fixture(page, () => {
      const state = window.catalogFixture;
      state.statusGate = new Promise(resolve => { state.releaseStatus = resolve; });
    });
    await openList(page);
    await page.getByText('안 본 회차 1개', { exact: true }).waitFor();
    await fixture(page, () => {
      const state = window.catalogFixture;
      state.observed = 2;
      state.releaseStatus();
    });
    // The first status reply already reports completion. There will be no running poll.
    await page.getByText('안 본 회차 2개', { exact: true }).waitFor();
  });

  await scenario('member-settings', 1280, async page => {
    await open(page, '/settings#library');
    await heading(page, '설정');
    assert.equal(await control(page, '정보 갱신 빈도').count(), 0);
    assert.equal(await fixture(page, () => window.catalogFixture.settingsReads), 0);
  }, () => localStorage.setItem('moa.mockRole', 'member'));

  await scenario('source-revalidation', 1280, async page => {
    await open(page, '/sources/sample-kr');
    await page.getByRole('link', { name: '저장한 소스 목록', exact: true }).waitFor();
    const cachedReads = await fixture(page, () => {
      window.catalogFixture.sourceReady = true;
      return window.catalogFixture.sourceReads;
    });
    await page.getByRole('link', { name: '확인한 소스 목록', exact: true }).waitFor();
    await assertPollingStops(page, 'sourceReads', cachedReads);
  });

  await scenario('late-profile-title', 1280, async page => {
    await open(page, '/title/demo-1');
    await heading(page, '저장한 작품');
    await page.getByRole('button', { name: '회차 새로고침', exact: true }).click();
    await page.waitForFunction(() => typeof window.catalogFixture.finishTitle === 'function');
    await switchProfile(page);
    await openList(page);
    await page.getByRole('link', { name: '가족의 목록', exact: true }).click();
    await heading(page, '가족의 작품');
    await fixture(page, () => window.catalogFixture.finishTitle());
    await page.waitForTimeout(900);
    assert.equal(await page.getByRole('heading', { name: '가족의 작품', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: '수동 갱신 작품', exact: true }).count(), 0);
  });

  await scenario('late-profile-list', 1280, async page => {
    await open(page, '/');
    await fixture(page, () => { window.catalogFixture.holdList = true; });
    await openList(page);
    await page.waitForFunction(() => typeof window.catalogFixture.finishList === 'function');
    await switchProfile(page);
    await openList(page);
    await page.getByRole('link', { name: '가족의 목록', exact: true }).waitFor();
    await fixture(page, () => window.catalogFixture.finishList());
    await page.waitForTimeout(900);
    assert.equal(await page.getByText('안 본 회차 1개', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '가족의 목록', exact: true }).count(), 1);
  });
} finally {
  await browser.close();
}
assert.deepEqual(failures, []);
