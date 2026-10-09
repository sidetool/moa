import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await web.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const base = web.resolvedUrls.local[0], errors = [];
const permissions = ['video.watch', 'subtitles.add', 'subtitles.translate'];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'p'); localStorage.setItem('moa.remoteMode', 'off'); });
    const changes = [], account = { id: 'member', username: 'member', role: 'member', permissions: [...permissions], disabled: false, createdAt: new Date().toISOString(), lastLoginAt: null, inviteLabel: null };
    let role = 'admin', pluginRequests = 0;
    await context.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/__moa/api/'), route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { id: role, username: role, role, permissions } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'p', name: '테스트', color: 'blue', kids: false }] });
      if (path === '/api/settings') return route.fulfill({ json: {} });
      if (path === '/api/plugins') { pluginRequests++; return route.fulfill({ json: [] }); }
      if (path === '/__moa/api/accounts') return route.fulfill({ json: [account] });
      if (path === '/__moa/api/accounts/member' && request.method() === 'PATCH') {
        const body = request.postDataJSON(); changes.push(body); Object.assign(account, body);
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: [] });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(base + 'accounts');
    await page.getByRole('button', { name: 'member 접속 기록 없음', exact: true }).click();
    const subtitles = page.getByRole('checkbox', { name: '자막 추가', exact: true });
    assert.equal(await subtitles.isChecked(), true);
    await subtitles.click();
    await page.locator('label.chip').filter({ hasText: '자막 추가' }).locator('input:not(:checked):enabled').waitFor();
    assert.deepEqual(changes, [{ permissions: ['video.watch', 'subtitles.translate'] }]);
    await page.reload();
    await page.getByRole('button', { name: 'member 접속 기록 없음', exact: true }).click();
    assert.equal(await subtitles.isChecked(), false);
    await page.getByRole('button', { name: '관리자로 지정', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: '관리자로 지정', exact: true });
    await dialog.waitFor();
    assert.equal(changes.length, 1);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await dialog.count(), 0); assert.equal(changes.length, 1);
    await page.getByRole('button', { name: '관리자로 지정', exact: true }).click();
    await page.screenshot({ path: verificationPath(`verification-account-confirm-${width}.png`), fullPage: true });
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await page.getByRole('button', { name: '관리자 해제', exact: true }).waitFor();
    assert.deepEqual(changes.at(-1), { role: 'admin' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    role = 'member'; pluginRequests = 0;
    await page.goto(base + 'plugins');
    await page.getByText('관리자만 볼 수 있어요', { exact: true }).waitFor();
    assert.equal(await page.locator('.plugin-row, .plugin-frame, .plugin-dialog').count(), 0);
    await page.goto(base + 'me');
    await page.getByRole('link', { name: '설정', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '플러그인', exact: true }).count(), 0);
    if (width === 1280) {
      await page.getByRole('button', { name: '프로필 메뉴', exact: true }).click();
      assert.equal(await page.getByRole('menuitem', { name: '플러그인', exact: true }).count(), 0);
    }
    assert.equal(pluginRequests, 0);
    await page.screenshot({ path: verificationPath(`verification-member-menu-${width}.png`), fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, widths: [1280, 390], errors }));
} finally { await browser.close(); await web.close(); }
