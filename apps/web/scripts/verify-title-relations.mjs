import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const provider = { id: 'local', kind: 'local', name: '로컬' };
const episode = { id: 'opening', number: 1, title: '첫날' };
const items = [
  { key: 'prequel', relation: 'prequel', title: '첫 상영', year: 2022, mediaId: 'first:screening', query: '첫 상영', tmdb: { kind: 'movie', id: 19 } },
  { key: 'sequel', relation: 'sequel', title: '다음 상영', year: 2025, query: '다음 상영 & 앙코르' },
  { key: 'side', relation: 'sideStory', title: '영사실의 밤', query: '영사실의 밤' },
  { key: 'collection', relation: 'collection', title: '마지막 장면', query: '마지막 장면' },
  { key: 'season', relation: 'sequel', title: '상영관 2기', mediaId: 'season-two', query: '상영관 2기' },
];
const similar = [
  { kind: 'movie', id: 19, title: '첫 상영', year: 2022 },
  { kind: 'tv', id: 19, title: '다른 극장' },
];
const franchise = ['main', 'season-two'].map((mediaId, index) => ({
  key: mediaId, mediaId, seasonNumber: index + 1, label: `시즌 ${index + 1}`, provider, current: !index,
}));

async function fixture({ tv = false, mobile = false, switcher = true, gate } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 320, height: 720 } : { width: 1280, height: 800 },
    hasTouch: mobile, reducedMotion: 'reduce',
  });
  await context.addInitScript(({ tv, switcher }) => {
    localStorage.setItem('moa.profile', 'test');
    localStorage.setItem('moa.remoteMode', tv ? 'on' : 'off');
    localStorage.setItem('moa.deviceSettings:test', JSON.stringify({ value: { seasonSwitcher: switcher } }));
  }, { tv, switcher });
  const requests = new Set();
  let split = false;
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let json = [], status = 200;
    if (path === '/api/profiles') json = [{ id: 'test', name: '테스트' }];
    else if (path === '/api/settings') json = { navigation: [] };
    else if (path === '/api/settings/device') json = { settings: { seasonSwitcher: switcher } };
    else if (path === '/api/me') json = { role: 'member' };
    else if (path === '/api/search') json = { groups: [] };
    else if (path.endsWith('/group')) {
      if (route.request().method() === 'PATCH') split = true;
      json = { members: path === '/api/media/main/group' ? [{ id: 'main', title: '상영관', provider }] : [], manual: split };
    }
    else if (path.endsWith('/franchise')) json = { seasons: franchise, complete: true };
    else if (path.endsWith('/relations')) {
      const id = path.split('/')[3];
      requests.add(id);
      if (id === 'main') await gate;
      status = id === 'failure' ? 503 : 200;
      const resolved = split ? items.map(item => item.key === 'prequel' ? { ...item, mediaId: undefined } : item) : items;
      json = { items: id === 'main' ? resolved : [] };
    } else if (path.startsWith('/api/media/')) {
      const id = path.split('/').at(-1);
      json = {
        id, title: id === 'main' ? '상영관' : id, type: 'series', provider,
        metadata: id === 'unlinked' ? { status: 'pending' } : { status: 'auto', kind: 'tv', id: 12 },
        seasons: [{ number: 1, title: '시즌 1', episodes: [episode] }],
        playTarget: { episodeId: episode.id, position: 0, label: '재생' },
        similar: id === 'main' ? similar : [],
      };
    }
    return route.fulfill({ status, json });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  return { page, context, requests };
}
const row = page => page.getByRole('region', { name: '관련 작품' });
const suggestions = page => page.getByRole('region', { name: '비슷한 콘텐츠' });
const focused = locator => locator.evaluate(el => el === document.activeElement);
const focusVisible = locator => locator.evaluate(el => {
  const { top, left, bottom, right } = el.getBoundingClientRect();
  return document.activeElement === el && top >= 0 && bottom <= innerHeight && left >= 0 && right <= innerWidth &&
    getComputedStyle(el).outlineStyle !== 'none';
});

try {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const { page, context, requests } = await fixture({ gate });
  await page.goto(base + '/title/main');
  const play = page.getByRole('button', { name: '재생', exact: true });
  assert.ok(await play.isEnabled());
  assert.equal(await row(page).count(), 0);
  const picker = page.getByRole('button', { name: /시즌 1/ });
  await picker.click();
  await page.getByRole('menuitemradio', { name: /시즌 2/ }).waitFor();
  await page.keyboard.press('Escape');
  const pendingCard = suggestions(page).getByRole('link', { name: '첫 상영 검색' });
  await pendingCard.focus();
  const response = page.waitForResponse(res => res.url().endsWith('/main/relations'));
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.ok(await focused(pendingCard), 'deferred results keep the focused recommendation');
  await page.keyboard.press('Tab');
  assert.ok(await focused(suggestions(page).getByRole('link', { name: '다른 극장 검색' })));
  await play.focus();

  const direct = row(page).getByRole('link', { name: /첫 상영.*전편.*상세 보기/ });
  const search = row(page).getByRole('link', { name: /다음 상영.*후속편.*제목 검색/ });
  await direct.waitFor();
  assert.equal(await row(page).getByRole('link').count(), 4);
  assert.equal(await suggestions(page).getByRole('link').count(), 1, 'de-duplicate by TMDB kind and ID');
  assert.equal(await direct.locator('.card-sub').innerText(), '전편 · 2022');
  assert.ok((await search.locator('.card-sub').innerText()).includes('제목 검색'));
  assert.equal(await direct.getAttribute('href'), '/title/first%3Ascreening');
  assert.equal(await search.getAttribute('href'), '/search?q=' + encodeURIComponent(items[1].query));
  await row(page).getByRole('link', { name: /외전.*제목 검색/ }).waitFor();
  await row(page).getByRole('link', { name: /같은 컬렉션.*제목 검색/ }).waitFor();
  await direct.focus();
  await page.keyboard.press('Tab');
  assert.ok(await focusVisible(search), 'Tab shows the focused card');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/search?*');
  assert.equal(new URL(page.url()).searchParams.get('q'), items[1].query);
  await page.goBack();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('다음 상영'));
  assert.ok(await focusVisible(search), 'Back restores the card and scroll position');

  await page.getByRole('button', { name: '같은 작품 묶기', exact: true }).click();
  await page.getByRole('button', { name: '이 작품 분리', exact: true }).click();
  await row(page).getByRole('link', { name: /첫 상영.*제목 검색/ }).waitFor();
  assert.equal(await direct.count(), 0, 'changing the local group refreshes an already-open relation destination');

  for (const id of ['empty', 'failure']) {
    const loaded = page.waitForResponse(res => res.url().endsWith(`/${id}/relations`));
    await page.goto(base + '/title/' + id);
    await loaded;
    assert.equal(await row(page).count(), 0);
    assert.ok(await play.isEnabled());
  }
  await page.goto(base + '/title/unlinked');
  await play.waitFor();
  assert.equal(await row(page).count(), 0);
  assert.ok(!requests.has('unlinked'), 'pending metadata does not start a relations request');
  await context.close();

  const { page: touch, context: phoneContext } = await fixture({ mobile: true, switcher: false });
  await touch.goto(base + '/title/main');
  await row(touch).getByRole('link', { name: /상영관 2기/ }).waitFor();
  assert.equal(await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await row(touch).getByRole('link', { name: /첫 상영/ }).tap();
  await touch.waitForURL('**/title/first%3Ascreening');
  await phoneContext.close();

  const { page: tv } = await fixture({ tv: true });
  await tv.goto(base + '/title/main');
  const first = row(tv).getByRole('link').first();
  const next = row(tv).getByRole('link').nth(1);
  await first.waitFor();
  await tv.waitForFunction(() => document.activeElement?.closest('.hero-actions'));
  await first.focus();
  await tv.keyboard.press('ArrowRight');
  assert.ok(await focusVisible(next), 'D-pad moves between related cards');
  await tv.keyboard.press('ArrowLeft');
  await tv.keyboard.press('Enter');
  await tv.waitForURL('**/title/first%3Ascreening');
  assert.deepEqual(errors, []);
  console.log('PASS title relations: direct/search, season and similar dedup, empty/failure, late metadata, touch, keyboard/back and D-pad');
} finally {
  await browser.close();
}
