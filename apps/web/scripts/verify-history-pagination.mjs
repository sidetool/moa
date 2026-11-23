// Run against local Vite without VITE_MOCK. The browser only receives synthetic API data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
assert.match(base, /^http:\/\/127\.0\.0\.1:51\d\d$/);
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
try {
  const page = await browser.newPage();
  const errors = [], reads = [], deletions = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('moa.profile', 'viewer'));

  const media = n => ({ id: `show-${n}`, title: `검증 작품 ${n}`, type: 'series', provider: { id: 'local', name: '로컬', kind: 'local' } });
  function entry(n, number = 1) {
    const card = media(n);
    return { media: card, episode: { id: `ep-${n}-${number}`, mediaId: card.id, season: 1, number, title: `${number}화`, duration: 600 }, watchedAt: '2026-01-01T00:00:00Z' };
  }
  let records = [...Array.from({ length: 47 }, (_, i) => entry(i + 1)), entry(46, 2), entry(47, 2)];
  let grouping = true, failFirstPage = true, failSave = true, saveCount = 0;
  let releaseSettings;
  const pendingSettings = new Promise(resolve => { releaseSettings = resolve; });
  const failOnce = new Set(['true:2']);
  let releaseSave;
  const pendingSave = new Promise(resolve => { releaseSave = resolve; });
  let blockedDelete;
  let deleteAttempts = 0;
  const unseenUpdate = new Set(['true', 'false']);
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let body = [];
    if (path === '/api/me') body = { role: 'user' };
    if (path === '/api/profiles') body = [{ id: 'viewer', name: '테스트', color: 'blue' }];
    if (path === '/api/settings/device') body = { settings: {} };
    if (path === '/api/settings') {
      if (request.method() === 'GET') {
        await pendingSettings;
        return route.fulfill({ status: 403, json: { error: 'settings-unavailable' } });
      }
      saveCount++;
      if (failSave) {
        await pendingSave;
        return route.fulfill({ status: 503, json: { error: 'save-failed' } });
      }
      grouping = request.postDataJSON().groupHistory;
      body = { groupHistory: grouping };
    }
    if (path === '/api/history') {
      assert.equal(request.headers()['x-moa-profile'], 'viewer');
      const page = Number(url.searchParams.get('page')), mode = url.searchParams.get('groupHistory') ?? String(grouping);
      if (page > 1) assert.ok(url.searchParams.has('groupHistory'), 'later pages keep their original mode');
      reads.push(`${mode}:${page}`);
      if (failFirstPage || failOnce.delete(reads.at(-1))) return route.fulfill({ status: 503, json: { error: 'synthetic-failure' } });
      // A new record ahead of page one pushes its last row onto page two.
      if (page === 2 && unseenUpdate.delete(mode)) records.unshift(entry(mode === 'true' ? 48 : 49));
      const grouped = new Map();
      for (const row of records) {
        const found = grouped.get(row.media.id);
        if (found) found.groupedCount++;
        else grouped.set(row.media.id, { ...row, groupedCount: 1 });
      }
      const all = mode === 'true' ? [...grouped.values()] : records;
      body = { page, total: all.length, hasNextPage: page * 40 < all.length, items: all.slice((page - 1) * 40, page * 40) };
    }
    if (path.startsWith('/api/history/') && request.method() === 'DELETE') {
      deleteAttempts++;
      if (blockedDelete) {
        await blockedDelete.promise;
        return route.fulfill({ status: 503, json: { error: 'delete-failed' } });
      }
      deletions.push(path);
      const id = path.split('/').at(-1);
      records = records.filter(row => (path.startsWith('/api/history/media/') ? row.media.id : row.episode.id) !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/media/show-47') body = { ...media(47), seasons: [{ number: 1, episodes: records.filter(r => r.media.id === 'show-47').map(r => r.episode) }] };
    if (path.endsWith('/group')) body = { members: [], manual: false };
    return route.fulfill({ json: body });
  });

  const rows = page.locator('.history-item');
  const waitRows = n => page.waitForFunction(n => document.querySelectorAll('.history-item').length === n, n);
  const toggle = page.getByRole('switch', { name: '작품별로 보기' });
  const retry = page.getByRole('button', { name: '다시 시도' });
  async function failDelete(button, nextFocus = button) {
    blockedDelete = Promise.withResolvers();
    const before = deleteAttempts;
    await button.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-disabled') === 'true');
    await page.keyboard.press('Space');
    if (nextFocus !== button) await nextFocus.focus();
    blockedDelete.resolve();
    await page.getByRole('alert').filter({ hasText: '기록을 삭제하지 못했어요' }).waitFor();
    blockedDelete = undefined;
    assert.equal(deleteAttempts, before + 1, 'repeat activation sent only one DELETE');
    assert.ok(await nextFocus.evaluate(el => el === document.activeElement), 'a failed delete preserves the chosen focus');
  }
  await page.goto(`${base}/history`);
  await retry.waitFor();
  failFirstPage = false;
  const failedReads = reads.length;
  await retry.click();
  await waitRows(40);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'history is usable while settings are pending');
  releaseSettings();
  await rows.last().locator('.history-body').focus();
  await retry.waitFor();
  assert.equal(await rows.count(), 40, 'page one stays readable if page two fails');
  await retry.click();
  await waitRows(47);
  assert.deepEqual(reads.slice(failedReads), ['true:1', 'true:2', 'true:2']);
  assert.equal(await rows.locator('.history-body[href="/title/show-40"]').count(), 1);

  await page.getByRole('button', { name: '검증 작품 46 작품 기록 모두 삭제' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: '취소' }).click();
  assert.deepEqual(deletions, []);
  await page.getByRole('button', { name: '검증 작품 46 작품 기록 모두 삭제' }).click();
  await dialog.getByRole('button', { name: '모두 삭제' }).click();
  await rows.locator('.history-body[href="/title/show-48"]').waitFor();
  await waitRows(47);
  assert.equal(await rows.locator('.history-body[href="/title/show-46"]').count(), 0);
  assert.deepEqual(deletions, ['/api/history/media/show-46']);

  const singleTitle = rows.first();
  await failDelete(singleTitle.getByRole('button'), singleTitle.locator('.history-body'));
  assert.equal(await page.getByRole('heading', { name: '시청 기록을 불러오지 못했어요' }).count(), 0);
  await toggle.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-disabled') === 'true');
  await page.keyboard.press('Space');
  releaseSave();
  await page.getByRole('alert').filter({ hasText: '설정을 저장하지 못했어요' }).waitFor();
  assert.equal(saveCount, 1, 'a pending switch accepts only one activation');
  assert.ok(await toggle.evaluate(el => el === document.activeElement), 'failed save keeps switch focus');
  failSave = false;
  await page.keyboard.press('Space');
  await waitRows(40);
  assert.ok(await toggle.evaluate(el => el === document.activeElement), 'successful save keeps switch focus');
  const boundary = rows.nth(39).locator('.history-body');
  await boundary.focus();
  await waitRows(48);
  assert.ok(await boundary.evaluate(el => el === document.activeElement), 'appending keeps focus on the selected row');
  const oldEpisode = page.locator('[data-remote-id="history-title:episode:ep-47-2"]');
  await oldEpisode.click();
  await page.waitForURL('**/title/show-47');
  await page.goBack();
  await page.waitForFunction(() => document.activeElement?.dataset.remoteId === 'history-title:episode:ep-47-2');

  const neighbor = rows.nth(46).locator('.history-body');
  const expectedFocus = await neighbor.getAttribute('data-remote-id');
  await failDelete(rows.last().getByRole('button', { name: '기록에서 삭제' }));
  await page.keyboard.press('Space');
  await rows.locator('.history-thumb[href="/watch/ep-49-1"]').waitFor();
  await waitRows(48);
  assert.deepEqual(deletions, ['/api/history/media/show-46', '/api/history/ep-47-2']);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.remoteId), expectedFocus, 'successful retry moves focus to a remaining row');
  const links = await rows.locator('.history-thumb').evaluateAll(links => links.map(link => link.getAttribute('href')));
  assert.deepEqual(links, records.map(row => `/watch/${row.episode.id}`), 'page boundaries and the other episode survive deletion');
  await toggle.click();
  await waitRows(40);
  assert.equal(reads.at(-1), 'true:1', 'returning to the other view starts at its first page');
  assert.deepEqual(errors, []);
  console.log('History pagination passed for 47 grouped titles, 48 individual episodes, overlapping pages, retry, focus restoration, switching and deletion.');
} finally {
  await browser.close();
}
