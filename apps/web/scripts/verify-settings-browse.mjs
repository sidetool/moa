import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';
import { writeFile } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const plugin = { apiVersion: 1, id: 'drop-test', name: 'Drop test', version: '1.0.0', description: 'Drop preview', placements: ['player'], permissions: [], connect: [], script: '' };
async function slide(group, target) {
  await group.scrollIntoViewIfNeeded();
  await group.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
  const transform = () => group.evaluate(element => getComputedStyle(element, '::before').transform);
  const before = await transform();
  await target.click();
  await group.page().waitForFunction(element => element.getAnimations({ subtree: true }).some(animation => animation.transitionProperty === 'transform'), await group.elementHandle());
  const motion = await group.evaluateHandle(element => element.getAnimations({ subtree: true }).find(animation => animation.transitionProperty === 'transform'));
  await motion.evaluate(animation => { animation.pause(); animation.currentTime = 100; });
  const during = await transform();
  await motion.evaluate(animation => animation.finish());
  const after = await transform();
  assert.notEqual(before, after);
  assert.notEqual(during, before);
  assert.notEqual(during, after);
  const aligned = await group.evaluate(element => {
    const box = element.getBoundingClientRect(), active = element.querySelector('.is-active').getBoundingClientRect();
    const pill = getComputedStyle(element, '::before');
    return Math.abs(box.left + parseFloat(pill.left) + new DOMMatrix(pill.transform).m41 - active.left) < 1 && Math.abs(parseFloat(pill.width) - active.width) < 1;
  });
  assert.ok(aligned, 'the sliding background ends under the active button');
}
async function disclosure(details, width) {
  const page = details.page();
  const summary = details.locator(':scope > summary');
  await page.waitForTimeout(330);
  const height = () => details.evaluate(element => parseFloat(getComputedStyle(element, '::details-content').height));
  const full = await height();
  assert.ok(full > 0);
  await summary.click();
  const during = await details.evaluate(async element => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    return parseFloat(getComputedStyle(element, '::details-content').height);
  });
  assert.ok(during > 0 && during < full, `details closes through an intermediate height: ${during}/${full}`);
  await summary.press('Enter');
  assert.ok(await details.evaluate(element => element.open));
  await page.waitForFunction(({ element, full }) => Math.abs(parseFloat(getComputedStyle(element, '::details-content').height) - full) < 2, { element: await details.elementHandle(), full });
  await summary.press('Enter');
  await page.waitForFunction(element => parseFloat(getComputedStyle(element, '::details-content').height) === 0, await details.elementHandle());
  await page.screenshot({ path: verificationPath(`details-closed-${width}.png`) });
  await summary.press('Space');
  await page.waitForFunction(({ element, full }) => Math.abs(parseFloat(getComputedStyle(element, '::details-content').height) - full) < 2, { element: await details.elementHandle(), full });
}

try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 900 });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const pages = [], previews = [], installs = [], navigationSaves = [], deviceSaves = [];
    let device = {};
    let fail = true, settings = { autoplayNext: true, autoplayDelay: 5, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', translationMode: 'manual', translationSourcePriority: 'site', navigation: ['홈', '영화', '애니', '시리즈'].map((name, index) => ({ id: ['home', 'movies', 'anime', 'series'][index], name, sourceIds: ['test-source'], includeLocal: true })) };
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { id: 'admin', username: '테스트', role: 'admin' } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
      if (path === '/api/settings') {
        if (route.request().method() === 'PATCH') { const patch = route.request().postDataJSON(); settings = { ...settings, ...patch }; if (patch.navigation) navigationSaves.push(patch.navigation.map(tab => tab.id)); }
        return route.fulfill({ json: settings });
      }
      if (path === '/api/settings/device') {
        if (route.request().method() === 'PATCH') { const patch = route.request().postDataJSON(); device = { ...device, ...patch.settings }; deviceSaves.push(patch.settings); }
        return route.fulfill({ json: { settings: device } });
      }
      if (path === '/api/sources') return route.fulfill({ json: [{ id: 'test-source', name: '테스트 소스', installed: true, enabled: true, type: 'anime', live: false }] });
      if (path.endsWith('/filters')) return route.fulfill({ json: { revision: 'one', filters: ['Action', 'Adventure', 'Comedy', 'Drama'].map((label, position) => ({ id: String(position), position, kind: 'checkbox', label, defaultValue: false })), availableModes: ['popular', 'latest'] } });
      if (path === '/api/library/browse') return route.fulfill({ json: { path: '/media', dirs: [] } });
      if (path.endsWith('/browse') || path === '/api/media') {
        const { page: number, mode } = path === '/api/media' ? { page: Number(new URL(route.request().url()).searchParams.get('page')), mode: 'local' } : route.request().postDataJSON();
        pages.push([mode, number]);
        if (number === 2 && fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'source-unavailable' } }); }
        const items = number < 3 ? Array.from({ length: 24 }, (_, index) => ({ id: `${mode}-${(number - 1) * 24 + index}`, title: `${mode} 작품 ${(number - 1) * 24 + index}`, type: 'anime', provider: { id: 'test-source', name: '테스트 소스', kind: 'mangayomi-js', lang: 'ko' } })) : [];
        if (number === 2) items.unshift({ id: `${mode}-0`, title: `${mode} 작품 0`, type: 'anime', provider: { id: 'test-source', name: '테스트 소스', kind: 'mangayomi-js', lang: 'ko' } });
        return route.fulfill({ json: { items, page: number, hasNextPage: number < 3 } });
      }
      if (path === '/api/admin/plugins/preview') { previews.push(route.request().postDataJSON()); return route.fulfill({ json: plugin }); }
      if (path === '/api/admin/plugins') { installs.push(route.request().postDataJSON()); return route.fulfill({ json: plugin }); }
      if (path.endsWith('/translation/config')) return route.fulfill({ json: { enabled: false, configured: false, keys: [], requestIntervalMs: 1000, retryCount: 2 } });
      if (path === '/api/admin/components') return route.fulfill({ json: { available: false, items: [] } });
      if (path === '/api/admin/subtitle-memory') return route.fulfill({ json: { retentionDays: 90, count: 3 } });
      if (path === '/api/admin/default-navigation') return route.fulfill({ json: { navigation: null } });
      if (path === '/api/admin/updates') return route.fulfill({ json: { configured: false, connected: false, state: 'idle', current: 'unknown' } });
      if (path === '/api/admin/system') return route.fulfill({ json: { version: '0.1.0', revision: 'abcdef', os: 'Linux', kernel: '6.1', architecture: 'x64', nodeVersion: '22', deployment: 'Docker', cpuCount: 4, memoryUsed: 1024 ** 3, memoryTotal: 4 * 1024 ** 3, uptimeSeconds: 3600 } });
      return route.fulfill({ json: [] });
    });
    const base = server.resolvedUrls.local[0];
    await page.goto(`${base}settings`);
    const title = page.locator('.settings-panel-head h2');
    const menu = page.getByRole('navigation', { name: '설정 메뉴', exact: true });
    await menu.waitFor();
    assert.equal(await page.locator('.settings-panel > .settings-group').count(), 2);
    assert.equal(await page.getByRole('combobox', { name: 'defaultSubtitleLang', exact: true }).count(), 0);
    // Wide screens show a category beside the menu; narrow screens open on the menu alone.
    assert.equal(await title.isVisible(), width >= 900);
    await menu.getByRole('link', { name: '자막', exact: true }).click();
    await title.filter({ hasText: '자막' }).waitFor();
    if (width >= 900) await menu.locator('[aria-current="page"]').filter({ hasText: '자막' }).waitFor();
    else assert.equal(await page.locator('.settings-nav').isVisible(), false);
    if (width < 900) {
      await page.getByRole('link', { name: '설정', exact: true }).click();
      await menu.waitFor();
      assert.equal(await title.isVisible(), false);
      await menu.getByRole('link', { name: '자막', exact: true }).click();
      await title.filter({ hasText: '자막' }).waitFor();
    }
    await page.getByRole('combobox', { name: 'defaultSubtitleLang', exact: true }).waitFor();
    assert.ok(page.url().endsWith('#subtitles'));
    assert.equal(await page.getByRole('combobox', { name: 'preferredQuality', exact: true }).count(), 0);
    const background = page.getByRole('radiogroup', { name: '자막 배경' });
    await slide(background, background.getByRole('radio', { name: '진하게', exact: true }));
    await slide(background, background.getByRole('radio', { name: '없음', exact: true }));
    await page.screenshot({ path: verificationPath(`settings-categories-${width}.png`), animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${base}settings#library`);
    await page.getByRole('button', { name: '폴더 추가', exact: true }).click();
    const types = page.getByRole('radiogroup');
    await slide(types, types.getByRole('radio').last());
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.goto(`${base}settings/tabs?edit=home`);
    await page.getByRole('dialog').waitFor();
    await page.locator('.pick-conditions > summary').click();
    await page.locator('.filter-checkbox').first().waitFor();
    await page.waitForTimeout(300);
    const dialog = await page.getByRole('dialog').boundingBox();
    assert.ok(Math.abs(dialog.y + dialog.height / 2 - 422) < 2);
    assert.ok(await page.locator('.filter-checkbox input').evaluateAll(inputs => inputs.every(input => input.offsetWidth === 18 && input.offsetHeight === 18)));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: verificationPath(`tab-filters-${width}.png`) });
    await disclosure(page.locator('.pick-conditions'), width);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await title.textContent(), '홈 화면');
    const tabOrder = () => page.locator('.tab-item').evaluateAll(items => items.map(item => item.dataset.id));
    const tabList = page.locator('.tab-list');
    await page.getByRole('button', { name: '영화 아래로', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.tab-item')[2].dataset.id === 'movies');
    assert.ok(await tabList.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.effect.getKeyframes().some(frame => frame.transform?.startsWith('translateY(')))));
    await tabList.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    const grip = page.getByRole('button', { name: '영화 순서 변경', exact: true });
    await grip.focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelectorAll('.tab-item')[1].dataset.id === 'movies');
    await tabList.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    await grip.scrollIntoViewIfNeeded();
    const start = await grip.boundingBox(), target = await page.locator('.tab-item[data-id="series"]').boundingBox();
    const beforeDrag = navigationSaves.length;
    const x = start.x + start.width / 2, y = start.y + start.height / 2, endY = target.y + target.height * .8;
    const touch = width < 900 ? await context.newCDPSession(page) : null;
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    else { await page.mouse.move(x, y); await page.mouse.down(); }
    await page.waitForFunction(() => document.querySelector('.tab-item.is-dragging'));
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: endY }] });
    else await page.mouse.move(x, endY, { steps: 8 });
    await page.waitForFunction(() => document.querySelectorAll('.tab-item')[3].dataset.id === 'movies');
    assert.equal(navigationSaves.length, beforeDrag);
    assert.equal((await tabOrder())[0], 'home');
    await tabList.dispatchEvent('pointerup', { pointerId: 99, pointerType: 'touch', isPrimary: false });
    assert.equal(await page.locator('.tab-item.is-dragging').count(), 1);
    assert.equal(navigationSaves.length, beforeDrag);
    await page.screenshot({ path: verificationPath(`tabs-drag-${width}.png`) });
    const savedOrder = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.tab-item.is-dragging'));
    await savedOrder;
    assert.deepEqual(await tabOrder(), ['home', 'anime', 'series', 'movies']);
    assert.equal(navigationSaves.length, beforeDrag + 1);
    await page.reload();
    await tabList.waitFor();
    assert.deepEqual(await tabOrder(), ['home', 'anime', 'series', 'movies']);
    await grip.scrollIntoViewIfNeeded();
    const cancelStart = await grip.boundingBox(), cancelTarget = await page.locator('.tab-item[data-id="home"]').boundingBox();
    const cancelX = cancelStart.x + cancelStart.width / 2, cancelY = cancelStart.y + cancelStart.height / 2;
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cancelX, y: cancelY }] });
    else { await page.mouse.move(cancelX, cancelY); await page.mouse.down(); }
    await page.waitForFunction(() => document.querySelector('.tab-item.is-dragging'));
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cancelX, y: cancelTarget.y }] });
    else await page.mouse.move(cancelX, cancelTarget.y, { steps: 8 });
    await page.waitForFunction(() => document.querySelectorAll('.tab-item')[1].dataset.id === 'movies');
    assert.equal((await tabOrder())[0], 'home');
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    else { await page.keyboard.press('Escape'); await page.mouse.up(); }
    await page.waitForFunction(() => !document.querySelector('.tab-item.is-dragging'));
    assert.deepEqual(await tabOrder(), ['home', 'anime', 'series', 'movies']);
    assert.equal(navigationSaves.length, beforeDrag + 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await grip.focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelectorAll('.tab-item')[2].dataset.id === 'movies');
    assert.equal(await tabList.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.effect.getKeyframes().some(frame => frame.transform?.startsWith('translateY(')))), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${base}settings#controls`);
    const hold = page.getByRole('combobox', { name: '길게 누르기 배속', exact: true });
    await hold.waitFor();
    assert.match(await hold.textContent(), /2/);
    await hold.click();
    await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: '3배속', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="길게 누르기 배속"]').textContent.includes('3'));
    assert.ok(deviceSaves.some(patch => patch.holdSpeed === 3));
    await page.reload();
    await hold.waitFor();
    assert.match(await hold.textContent(), /3/);
    await page.goto(`${base}settings#subtitle-library`);
    await page.getByRole('combobox', { name: '자막 선택 보관 단위' }).click();
    await page.getByRole('option', { name: '개월 (30일)', exact: true }).click();
    const unit = await page.locator('.input-unit').boundingBox(), save = await page.locator('.retention-controls > .btn').boundingBox();
    const controls = await page.locator('.retention-controls').boundingBox();
    assert.ok(unit.x + unit.width <= save.x && save.x + save.width <= controls.x + controls.width + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${base}me`);
    await page.locator('.me-links').waitFor();
    assert.deepEqual(await page.locator('.me-links a').allTextContents(), ['시청 기록', '내 목록', '설정']);
    await page.goto(`${base}settings#updates`);
    await page.getByRole('heading', { name: '시스템 정보', exact: true }).waitFor();
    await page.locator('#updates').waitFor();
    assert.equal(await title.textContent(), '정보');
    await page.goto(`${base}settings#subtitle-advanced`);
    await page.getByRole('region', { name: '자막 고급설정', exact: true }).waitFor();
    await disclosure(page.locator('#subtitle-advanced'), width);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(parseFloat(await page.locator('.settings-panel').evaluate(element => getComputedStyle(element).animationDuration)) <= .00001);
    await page.locator('#subtitle-advanced > summary').click();
    assert.equal(await page.locator('#subtitle-advanced').evaluate(element => element.open), false);
    assert.equal(await page.locator('#subtitle-advanced').evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.transitionProperty === 'height')), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${base}sources/test-source`);
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 24);
    assert.deepEqual(pages, [['popular', 1]]);
    assert.equal(await page.getByRole('button', { name: '더 보기', exact: true }).count(), 0);
    await page.locator('.source-more').scrollIntoViewIfNeeded();
    await page.getByRole('heading', { name: '목록을 불러오지 못했습니다' }).waitFor();
    await page.waitForTimeout(200);
    assert.deepEqual(pages, [['popular', 1], ['popular', 2]]);
    assert.equal(await page.locator('.poster-card').count(), 24);
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 48);
    await page.locator('.source-more').scrollIntoViewIfNeeded();
    await page.locator('.source-more').waitFor({ state: 'detached' });
    assert.deepEqual(pages, [['popular', 1], ['popular', 2], ['popular', 2], ['popular', 3]]);
    await slide(page.locator('.segmented'), page.getByRole('radio', { name: '최신', exact: true }));
    await page.getByRole('link', { name: 'latest 작품 0', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'popular 작품 0', exact: true }).count(), 0);
    await page.goto(`${base}local/genre/드라마`);
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 24);
    await page.locator('.source-more').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 48);
    await page.locator('.source-more').scrollIntoViewIfNeeded();
    await page.locator('.source-more').waitFor({ state: 'detached' });
    assert.deepEqual(pages.filter(([mode, number]) => mode === 'local' && number > 1), [['local', 2], ['local', 3]]);
    await page.goto(`${base}plugins`);
    const dropzone = page.locator('.plugin-install');
    await dropzone.waitFor();
    const transfer = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['fixture zip'], 'test.zip', { type: 'application/zip' })); return transfer; });
    await dropzone.dispatchEvent('dragover', { dataTransfer: transfer });
    assert.ok((await dropzone.getAttribute('class')).includes('is-dragging'));
    await dropzone.dispatchEvent('drop', { dataTransfer: transfer });
    await page.locator('.plugin-preview').waitFor();
    assert.deepEqual(previews, [{ archive: Buffer.from('fixture zip').toString('base64') }]);
    assert.equal(installs.length, 0);
    await page.getByRole('button', { name: '설치', exact: true }).click();
    await page.locator('.plugin-preview').waitFor({ state: 'detached' });
    assert.deepEqual(installs, [plugin]);
    const oversized = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'large.zip')); return transfer; });
    await dropzone.dispatchEvent('drop', { dataTransfer: oversized });
    await page.getByRole('alert').waitFor();
    assert.equal(previews.length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: verificationPath(`plugin-drop-${width}.png`), animations: 'disabled' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(verificationPath('settings-results.json'), JSON.stringify({ passed: true, widths: [1280, 390, 320], checks: ['mouse and touch long-press reorder', 'save only on drop', 'fixed home', 'secondary pointer release ignored', 'button and keyboard order animation', 'reorder reload persistence', 'Escape and touch cancel restore order without save', 'reduced-motion reorder', 'details closing and reversal', 'details keyboard', 'reduced motion', 'hold speed device save and reload'], errors }, null, 2));
  console.log('Settings categories, deep links, reduced motion, scroll pagination with retry, ZIP drop preview and size limits and centered tab filters, sliding tabs, compact My menu passed at 1280px, 390px and 320px.');
} finally {
  await browser.close();
  await server.close();
}
