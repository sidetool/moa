import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Run against a Vite instance with VITE_MOCK unset. All API responses are local fixtures.
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const sentence = '극장이 문을 닫기 전날, 마을 사람들이 마지막 상영을 준비한다. ';
const texts = { long: sentence.repeat(40), medium: sentence.repeat(3), short: '마지막 상영을 준비한다.' };
texts.three = Array(3).fill('W'.repeat(26)).join(' ');
texts.refresh = texts.long;
const provider = { id: 'local', kind: 'local', name: '로컬' };
const errors = [];

async function fixture(mode, touch = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch, reducedMotion: 'reduce' });
  await context.addInitScript(mode => {
    localStorage.setItem('moa.profile', 'test');
    localStorage.setItem('moa.remoteMode', mode);
  }, mode);
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname;
    let body = [];
    if (path === '/api/profiles') body = [{ id: 'test', name: '테스트' }];
    else if (path === '/api/settings') body = { navigation: [] };
    else if (path === '/api/settings/device') body = { settings: {} };
    else if (path === '/api/me') body = { role: 'member' };
    else if (path.endsWith('/group')) body = { members: [] };
    else if (path.startsWith('/api/media/')) {
      const id = path.split('/').at(-1);
      body = { id, title: id, refreshing: id === 'refresh' && texts.refresh === texts.long, type: 'movie', provider, seasons: [], overview: texts[id] };
    }
    return route.fulfill({ json: body });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  return page;
}

const overview = page => page.locator('.title-overview p');
const toggle = (page, expanded) => page.getByRole('button', { name: expanded ? '줄거리 접기' : '줄거리 펼치기', exact: true });
async function assertToggle(page, expanded) {
  const button = toggle(page, expanded);
  await button.waitFor();
  assert.equal(await button.getAttribute('aria-expanded'), String(expanded));
  assert.ok(await button.evaluate(el => el === document.activeElement), 'focus stays on the overview action');
  assert.ok(await button.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }), 'focused toggle is visible and unobscured');
  assert.equal(await button.getAttribute('aria-controls'), await overview(page).getAttribute('id'));
}

try {
  const tv = await fixture('on');
  await tv.goto(base + '/title/long');
  await toggle(tv, false).waitFor();
  await tv.waitForFunction(() => document.activeElement?.closest('.hero-actions'));
  await tv.keyboard.press('ArrowDown');
  await assertToggle(tv, false);
  const closedHeight = await overview(tv).evaluate(el => el.clientHeight);
  // Android TV D-pad center reaches the app as keyCode 23 on some browsers.
  await tv.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 23, bubbles: true, cancelable: true })));
  await assertToggle(tv, true);
  const paragraph = overview(tv);
  assert.ok(await paragraph.evaluate(el => el.clientHeight) > closedHeight);
  const atEnd = () => paragraph.evaluate(el => el.scrollTop >= el.scrollHeight - el.clientHeight - 1);
  for (let i = 0; i < 20 && !await atEnd(); i++) {
    await tv.keyboard.press('ArrowDown');
    await assertToggle(tv, true);
  }
  assert.ok(await atEnd(), 'every line is reachable with the remote');
  assert.ok(await paragraph.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  }), 'the last screenful is visible');
  await tv.keyboard.press('ArrowDown');
  assert.ok(!await toggle(tv, true).evaluate(el => el === document.activeElement), 'D-pad exits the synopsis at its end');
  await tv.keyboard.press('ArrowUp');
  await assertToggle(tv, true);
  await tv.keyboard.press('ArrowUp');
  assert.ok(!await atEnd());
  await tv.keyboard.press('Enter');
  await assertToggle(tv, false);
  assert.equal(await paragraph.evaluate(el => el.scrollTop), 0);
  assert.equal(await paragraph.evaluate(el => el.clientHeight), closedHeight);
  await tv.keyboard.press('ArrowUp');
  assert.equal(await tv.evaluate(() => document.activeElement.textContent), '내 목록');

  const page = await fixture('off', true);
  await page.goto(base + '/title/medium');
  const text = overview(page);
  await text.waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await toggle(page, false).count(), 0, 'fitting text has no toggle');
  await page.setViewportSize({ width: 300, height: 650 });
  await toggle(page, false).waitFor();
  await page.getByRole('button', { name: '내 목록', exact: true }).focus();
  await page.keyboard.press('Tab');
  await assertToggle(page, false);
  await page.keyboard.press('Enter');
  await assertToggle(page, true);
  assert.equal(await text.evaluate(el => el.scrollHeight), await text.evaluate(el => el.clientHeight));
  await page.keyboard.press('Enter');
  await assertToggle(page, false);
  await text.tap({ position: { x: 12, y: 12 } });
  await toggle(page, true).waitFor();
  await toggle(page, true).tap();
  await toggle(page, false).tap();
  await page.setViewportSize({ width: 1280, height: 800 });
  await toggle(page, true).waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 300, height: 650 });
  await toggle(page, false).waitFor();
  await page.goto(base + '/title/long');
  await toggle(page, false).tap();
  await assertToggle(page, true);
  assert.ok(await text.evaluate(el => el.clientHeight > innerHeight && el.scrollHeight === el.clientHeight), 'touch shows the whole synopsis in the page');
  await page.goto(base + '/title/short');
  await overview(page).waitFor();
  assert.equal(await page.locator('.title-overview button').count(), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(base + '/title/three');
  await overview(page).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await overview(page).evaluate(el => Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight))), 3);
  assert.equal(await page.locator('.title-overview button').count(), 0, 'exactly three lines fit');
  await page.goto(base + '/title/refresh');
  await toggle(page, false).click();
  await toggle(page, true).waitFor();
  texts.refresh = texts.short;
  await page.getByText(texts.short, { exact: true }).waitFor();
  assert.equal(await page.locator('.title-overview button').count(), 0, 'metadata refresh remeasures the overview');
  assert.deepEqual(errors, []);
  console.log('PASS title overview: D-pad focus and scrolling, center/Enter, keyboard Tab/Enter, touch, resize and fitting text');
} finally {
  await browser.close();
}
