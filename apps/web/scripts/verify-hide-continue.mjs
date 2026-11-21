// Local synthetic Home fixture. Exercise the actual row, cache updates, and remote navigation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
assert.match(base, /^http:\/\/127\.0\.0\.1:51\d\d$/);
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, headless: true });
const provider = { id: 'local', kind: 'local', name: '로컬' };
const card = (id, title) => ({ id, title, type: 'series', provider, groupId: 'g-' + id,
  resumeMediaId: 'watched-' + id, resume: { kind: 'resume', label: '이어보기 S1:E1', episodeId: 'ep-' + id, position: 120 } });

try {
  for (const remote of [true, false]) {
    const context = await browser.newContext({ viewport: remote ? { width: 1280, height: 800 } : { width: 360, height: 780 }, hasTouch: !remote, isMobile: !remote });
    const errors = [], hides = [];
    const cards = [card('a', '첫 작품'), card('b', '둘째 작품')], hidden = new Set();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(remote => {
      localStorage.setItem('moa.profile', 'viewer');
      localStorage.setItem('moa.remoteMode', remote ? 'on' : 'off');
    }, remote);
    let fail = true;
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname;
      const json = data => route.fulfill({ json: data });
      if (path === '/api/profiles') return json([{ id: 'viewer', name: '프로필', color: 'violet' }]);
      if (path === '/api/me') return json({ id: 'local', role: 'user' });
      if (path === '/api/settings/device') return json({ settings: {} });
      if (path === '/api/settings') return json({ recommendationsEnabled: false, navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] });
      if (path === '/api/home') {
        const items = cards.filter(c => !hidden.has(c.id));
        const rows = items.length ? [{ kind: 'continue', id: 'continue', title: '이어보기', layout: 'landscape', items }] : [];
        // The last-card fallback must also work on a Home with no other card to receive focus.
        if (remote) rows.push({ kind: 'watchlist', id: 'watchlist', title: '볼 목록', layout: 'poster', items: [cards[0]] });
        return json({ hero: [], rows });
      }
      if (path.startsWith('/api/home/continue/') && path.endsWith('/hidden')) {
        const id = path.split('/')[4];
        assert.equal(req.method(), 'PUT');
        assert.equal(req.headers()['x-moa-profile'], 'viewer');
        assert.equal(url.searchParams.get('groupId'), 'g-' + id);
        hides.push(id);
        if (fail) { fail = false; return route.fulfill({ status: 500, json: { error: 'test-hide-failed' } }); }
        hidden.add(id);
        return json({ mediaIds: [id, 'watched-' + id] });
      }
      if (path === '/api/recommendations') return json({ status: 'disabled' });
      return json([]);
    });

    await page.goto(base);
    const frames = page.locator('.landscape-card .card-frame');
    const more = name => page.getByRole('button', { name: name + ' 더 보기', exact: true });
    const dialog = page.getByRole('dialog');
    const hide = dialog.getByRole('button', { name: '홈 이어보기에서 숨기기' });
    assert.match(await frames.first().getAttribute('href'), /\/watch\/ep-a\?t=120&resume=1$/);
    if (remote) {
      await frames.first().focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await more('첫 작품').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
    } else {
      await more('첫 작품').tap();
    }
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('link', { name: '상세 정보' }).getAttribute('href'), '/title/a');
    if (remote) {
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await more('첫 작품').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await dialog.waitFor();
      await page.keyboard.press('ArrowDown');
      assert.equal(await hide.evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
    } else await hide.tap();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await frames.count(), 2);
    if (remote) await page.keyboard.press('Enter');
    else await hide.tap();
    await more('첫 작품').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('href')?.startsWith('/watch/ep-b'));
    await more('둘째 작품').click();
    await hide.click();
    await page.locator('.row[aria-labelledby="row-continue"]').waitFor({ state: 'hidden' });
    await page.waitForFunction(remote => remote ? !!document.activeElement?.closest('[aria-labelledby="row-watchlist"]') : !!document.activeElement?.closest('.section-chips'), remote);
    await page.reload();
    await page.getByRole('heading', { name: remote ? '볼 목록' : '로컬 라이브러리가 비어 있어요' }).waitFor();
    assert.equal(await frames.count(), 0);
    assert.deepEqual(hides, ['a', 'a', 'b']);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS', remote ? 'remote' : 'touch', 'Continue hide, retry, neighboring focus, empty row and reload');
  }
} finally { await browser.close(); }
