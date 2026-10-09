import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const plugin = { apiVersion: 1, id: 'drop-test', name: 'Drop test', version: '1.0.0', description: 'Drop preview', placements: ['player'], permissions: [], connect: [], script: '' };
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const pages = [], previews = [], installs = [];
    let fail = true, settings = { autoplayNext: true, autoplayDelay: 5, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', translationMode: 'manual', translationSourcePriority: 'site', navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] };
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { id: 'admin', username: '테스트', role: 'admin' } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
      if (path === '/api/settings') {
        if (route.request().method() === 'PATCH') settings = { ...settings, ...route.request().postDataJSON() };
        return route.fulfill({ json: settings });
      }
      if (path === '/api/sources') return route.fulfill({ json: [{ id: 'test-source', name: '테스트 소스', installed: true, enabled: true, type: 'anime', live: false }] });
      if (path.endsWith('/filters')) return route.fulfill({ json: { revision: 'one', filters: [], availableModes: ['popular', 'latest'] } });
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
    assert.equal(await page.locator('.settings-panel > .settings-group').count(), 1);
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
    await page.screenshot({ path: verificationPath(`settings-categories-${width}.png`), animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${base}settings/tabs?edit=home`);
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await title.textContent(), '홈 화면');
    await page.goto(`${base}settings#updates`);
    await page.getByRole('heading', { name: '시스템 정보', exact: true }).waitFor();
    await page.locator('#updates').waitFor();
    assert.equal(await title.textContent(), '정보');
    await page.goto(`${base}settings#subtitle-advanced`);
    await page.getByRole('region', { name: '자막 고급설정', exact: true }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(parseFloat(await page.locator('.settings-panel').evaluate(element => getComputedStyle(element).animationDuration)) <= .00001);
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
    await page.getByRole('button', { name: '최신', exact: true }).click();
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
    const dropzone = page.locator('.plugin-dropzone');
    await dropzone.waitFor();
    const transfer = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['fixture zip'], 'test.zip', { type: 'application/zip' })); return transfer; });
    await dropzone.dispatchEvent('dragover', { dataTransfer: transfer });
    assert.ok((await dropzone.getAttribute('class')).includes('is-dragging'));
    await dropzone.dispatchEvent('drop', { dataTransfer: transfer });
    await page.locator('.plugin-preview').waitFor();
    assert.deepEqual(previews, [{ archive: Buffer.from('fixture zip').toString('base64') }]);
    assert.equal(installs.length, 0);
    await page.getByRole('button', { name: '설치·업데이트', exact: true }).click();
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
  console.log('Settings categories, deep links, reduced motion, scroll pagination with retry, ZIP drop preview and size limits passed at 1280px and 390px.');
} finally {
  await browser.close();
  await server.close();
}
