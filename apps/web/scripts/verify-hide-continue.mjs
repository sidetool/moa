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
    context.setDefaultTimeout(8000);
    const errors = [], hides = [];
    const cards = [card('a', '첫 작품'), card('b', '둘째 작품')], hidden = new Set();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(remote => {
      localStorage.setItem('moa.profile', 'viewer');
      localStorage.setItem('moa.remoteMode', remote ? 'on' : 'off');
    }, remote);
    let fail = true;
    let peer, slowPeer, delayedHide;
    let failPeerHome = false;
    const releaseRead = Promise.withResolvers();
    let peerHomeReads = 0, holdPeerHome = false;
    const releaseHome = Promise.withResolvers();
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname;
      const json = data => route.fulfill({ json: data });
      if (path === '/api/profiles') return json([{ id: 'viewer', name: '프로필', color: 'violet' }]);
      if (path === '/api/me') return json({ id: 'local', role: 'user' });
      if (path === '/api/settings/device') return json({ settings: {} });
      if (path === '/api/settings') return json({ recommendationsEnabled: false, navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }, { id: 'local-tab', name: '로컬 탭', sourceIds: [], includeLocal: true }] });
      if (path === '/api/home') {
        const items = cards.filter(c => !hidden.has(c.id));
        const rows = items.length ? [{ kind: 'continue', id: 'continue', title: '이어보기', layout: 'landscape', items }] : [];
        // The last-card fallback must also work on a Home with no other card to receive focus.
        if (remote) rows.push({ kind: 'watchlist', id: 'watchlist', title: '볼 목록', layout: 'poster', items: [cards[0]] });
        const reader = req.frame().page();
        if (reader === peer) {
          peerHomeReads++;
          if (failPeerHome) return route.fulfill({ status: 503, json: { error: 'test-home-unavailable' } });
          if (holdPeerHome) {
            await releaseHome.promise;
          }
        }
        if (reader === slowPeer && !hidden.size) {
          await releaseRead.promise;
        }
        return json({ hero: [], rows });
      }
      if (path.startsWith('/api/home/continue/') && path.endsWith('/hidden')) {
        const id = path.split('/')[4];
        assert.equal(req.method(), 'PUT');
        assert.equal(req.headers()['x-moa-profile'], 'viewer');
        assert.equal(url.searchParams.get('groupId'), 'g-' + id);
        assert.equal(url.searchParams.get('resumeMediaId'), 'watched-' + id);
        hides.push(id);
        if (fail) { fail = false; return route.fulfill({ status: 500, json: { error: 'test-hide-failed' } }); }
        hidden.add(id);
        if (delayedHide) {
          delayedHide.committed.resolve();
          await delayedHide.reply.promise;
        }
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
      peer = await context.newPage();
      await peer.goto(base);
      await peer.getByRole('button', { name: '첫 작품 더 보기' }).waitFor();
      // Keep another MOA content tab active, leaving a freshly cached main Home behind.
      await peer.locator('a[href="/tabs/local-tab"]:visible').first().click();
      await peer.getByRole('button', { name: '첫 작품 더 보기' }).waitFor();
      slowPeer = await context.newPage();
      await Promise.all([
        slowPeer.waitForRequest(req => new URL(req.url()).pathname === '/api/home'),
        slowPeer.goto(base),
      ]);
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
    if (remote) {
      // A notification must supersede even an initial, unfinished Home GET.
      await slowPeer.getByRole('button', { name: '둘째 작품 더 보기' }).waitFor();
      releaseRead.resolve();
      await peer.getByRole('button', { name: '첫 작품 더 보기' }).waitFor({ state: 'hidden' });
      assert.equal(await slowPeer.getByRole('button', { name: '첫 작품 더 보기' }).count(), 0);
      // Revisiting the inactive content tab must not redisplay its previously cached card.
      holdPeerHome = true;
      await Promise.all([
        peer.waitForRequest(req => new URL(req.url()).pathname === '/api/home'),
        peer.locator('a[href="/"]:visible').first().click(),
      ]);
      assert.equal(await peer.getByRole('button', { name: '첫 작품 더 보기' }).count(), 0);
      holdPeerHome = false;
      releaseHome.resolve();
      await peer.getByRole('button', { name: '둘째 작품 더 보기' }).waitFor();
    }
    await more('둘째 작품').click();
    await hide.click();
    await page.locator('.row[aria-labelledby="row-continue"]').waitFor({ state: 'hidden' });
    await page.waitForFunction(remote => remote ? !!document.activeElement?.closest('[aria-labelledby="row-watchlist"]') : !!document.activeElement?.closest('.section-chips'), remote);
    await page.reload();
    await page.getByRole('heading', { name: remote ? '볼 목록' : '로컬 라이브러리가 비어 있어요' }).waitFor();
    assert.equal(await frames.count(), 0);
    if (remote) {
      await peer.getByRole('button', { name: '둘째 작품 더 보기' }).waitFor({ state: 'hidden' });
      hidden.delete('a'); // Playback has restored this edition on the server.
      const notify = profile => page.evaluate(id => {
        localStorage.setItem('moa.continueChanged:' + id, '1');
        localStorage.removeItem('moa.continueChanged:' + id);
      }, profile);
      const readsBefore = peerHomeReads;
      await peer.evaluate(() => {
        window.addEventListener('storage', function received(event) {
          if (event.key !== 'moa.continueChanged:other' || event.newValue) return;
          window.removeEventListener('storage', received);
          window.otherProfileSignalReceived = true;
        });
      });
      await notify('other');
      await peer.waitForFunction(() => window.otherProfileSignalReceived);
      assert.equal(peerHomeReads, readsBefore);
      await notify('viewer'); // Delayed notification must read the restored state.
      await peer.getByRole('button', { name: '첫 작품 더 보기' }).waitFor();
      await slowPeer.getByRole('button', { name: '첫 작품 더 보기' }).waitFor();
      // A delayed PUT reply must also preserve newer progress in the tab that issued it.
      delayedHide = { committed: Promise.withResolvers(), reply: Promise.withResolvers() };
      await peer.getByRole('button', { name: '첫 작품 더 보기' }).click();
      await peer.getByRole('dialog').getByRole('button', { name: '홈 이어보기에서 숨기기' }).click();
      await delayedHide.committed.promise;
      hidden.delete('a');
      cards[0].resume.position = 133;
      await notify('viewer');
      const resumed = peer.locator('.landscape-card a[href="/watch/ep-a?t=133&resume=1"]');
      await resumed.waitFor();
      failPeerHome = true;
      const failedRead = peer.waitForResponse(res => new URL(res.url()).pathname === '/api/home' && res.status() === 503);
      delayedHide.reply.resolve();
      await failedRead;
      await peer.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await resumed.count(), 1);
    }
    assert.deepEqual(hides, remote ? ['a', 'a', 'b', 'a'] : ['a', 'a', 'b']);
    assert.deepEqual(errors, []);
    await context.close();
    if (remote) console.log('PASS cross-tab hide, pending reads, inactive tabs, profile isolation, delayed notification and delayed hide reply');
    console.log('PASS', remote ? 'remote' : 'touch', 'Continue hide, retry, neighboring focus, empty row and reload');
  }
} finally { await browser.close(); }
