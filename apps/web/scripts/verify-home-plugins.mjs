import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await web.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const plugin = { apiVersion: 1, id: 'home-test', name: '홈 테스트', version: '1.0.0', description: '', placements: ['home', 'app'], permissions: ['ui', 'app.context', 'app.navigate'], connect: ['https://example.org'], kind: 'script', revision: 'test', enabled: true };
const script = `moa.on('ready', async () => {
  await moa.fetch('https://example.org/boot');
  document.body.innerHTML = '<button>작품 검색</button><p>준비 완료</p>';
  document.querySelector('button').onclick = () => moa.app.navigate('/search?q=' + encodeURIComponent('요일 애니'));
  await moa.ui.resize(360);
});`;
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => { if (window === top) { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push(dialog.type()); await dialog.dismiss(); });
    let boots = 0, permissions = plugin.permissions, contentError = false, scheduleError = false;
    let activePlugin = plugin, activeScript = script, delayNext = false;
    const requests = [];
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === '/api/plugins' && delayNext) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 250)); }
      if (path === '/api/me') return route.fulfill({ json: { id: 'account', username: '테스트', role: 'member' } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
      if (path === '/api/settings') return route.fulfill({ json: { autoplayNext: false, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', translationMode: 'manual' } });
      if (path === '/api/home') return route.fulfill({ json: { hero: [], rows: [] } });
      if (path === '/api/search') return route.fulfill({ json: { query: '요일 애니', groups: [] } });
      if (path === '/api/plugins') return route.fulfill({ json: [{ ...activePlugin, permissions }, { ...plugin, id: 'disabled', name: '비활성 플러그인', enabled: false }, { ...plugin, id: 'player-only', name: '재생 전용', placements: ['player'] }] });
      if (path === `/api/plugins/${activePlugin.id}`) return route.fulfill(contentError ? { status: 500, json: { error: 'plugin-unavailable' } } : { json: { ...activePlugin, permissions, script: activeScript } });
      if (path === `/api/plugins/${activePlugin.id}/request`) {
        boots++;
        if (activePlugin.id === plugin.id) return route.fulfill({ json: { base64: Buffer.from('{}').toString('base64') } });
        if (scheduleError) return route.fulfill({ status: 502, json: { error: 'plugin-request-failed' } });
        const day = new URL(route.request().postDataJSON().url).pathname.split('/').at(-1);
        assert.match(day, /^[0-6]$/);
        const rows = [{ animeNo: 1, week: day, status: 'ON', time: '23:30', subject: '요일 신작', originalSubject: '原題', startDate: '2020-01-01', endDate: '' }, { animeNo: 2, week: day, status: 'OFF', time: '12:00', subject: '결방 작품', startDate: '2020-01-01', endDate: '' }, { animeNo: 3, week: day, status: 'ON', time: '10:00', subject: '<img src=x onerror=alert(1)>', startDate: '2020-01-01', endDate: '' }, { animeNo: 4, week: day, status: 'ON', time: '10:00', subject: '종영 작품', startDate: '2020-01-01', endDate: '2020-01-02' }];
        return route.fulfill({ json: { base64: Buffer.from(JSON.stringify({ code: 'ok', data: day === '0' ? [] : rows })).toString('base64') } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(web.resolvedUrls.local[0]);
    const frame = page.frameLocator('iframe[title="홈 테스트"]');
    const inline = page.locator('.home-plugin iframe[title="홈 테스트"]');
    await frame.getByText('준비 완료', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 360);
    assert.equal(boots, 1);
    assert.equal(await page.locator('iframe[title="홈 테스트"]').count(), 1);
    assert.equal(await inline.isVisible(), true);
    assert.equal(await inline.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await inline.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(requests.includes('/api/plugins/disabled'), false);
    assert.equal(requests.includes('/api/plugins/player-only'), false);
    const body = frame.locator('body');
    assert.equal(await body.evaluate(() => { try { return parent.document !== undefined; } catch { return false; } }), false);
    await body.evaluate(() => moa.ui.resize(1));
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 120);
    await body.evaluate(() => moa.ui.resize(9000));
    await page.waitForFunction(() => document.querySelector('.home-plugin iframe')?.clientHeight === 1200);
    for (const height of [NaN, Infinity, '360', null]) {
      assert.equal(await body.evaluate(async (_, height) => { try { await moa.ui.resize(height); return false; } catch { return true; } }, height), true);
    }
    permissions = ['app.context', 'app.navigate'];
    assert.equal(await body.evaluate(async () => { try { await moa.ui.resize(400); return false; } catch { return true; } }), true);
    permissions = plugin.permissions;
    await body.evaluate(() => moa.ui.resize(360));
    assert.equal(await body.evaluate(async () => { try { await moa.app.navigate('https://example.org/'); return false; } catch { return true; } }), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: verificationPath(`home-plugin-${width}.png`) });
    await frame.getByRole('button', { name: '작품 검색', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === '요일 애니');
    await page.locator('.home-plugin').waitFor({ state: 'detached' });
    for (const path of ['tabs/anime', 'local']) {
      await page.goto(new URL(path, web.resolvedUrls.local[0]).href);
      await page.getByRole('navigation').first().waitFor();
      assert.equal(await page.locator('.home-plugin').count(), 0);
    }
    for (const path of ['tabs/home', 'Tabs/home', 'tabs/%68ome']) {
      await page.goto(new URL(path, web.resolvedUrls.local[0]).href);
      await inline.waitFor({ state: 'visible' });
      assert.equal(await page.locator('iframe[title="홈 테스트"]').count(), 1);
    }
    contentError = true;
    activePlugin = { ...plugin, revision: 'failed' };
    await page.reload();
    await page.locator('.home-plugin').getByRole('alert').waitFor();
    assert.equal(await inline.count(), 0);
    activePlugin = { ...JSON.parse(await readFile(new URL('../../../plugins/anime-schedule/manifest.json', import.meta.url), 'utf8')), kind: 'script', enabled: true, revision: 'schedule' };
    activeScript = await readFile(new URL('../../../plugins/anime-schedule/plugin.js', import.meta.url), 'utf8');
    permissions = activePlugin.permissions;
    contentError = false;
    await page.goto(web.resolvedUrls.local[0]);
    const schedule = page.frameLocator(`iframe[title="${activePlugin.name}"]`);
    const tabs = schedule.getByRole('tab');
    await tabs.last().waitFor();
    assert.deepEqual(await tabs.allTextContents(), ['월', '화', '수', '목', '금', '토', '일']);
    assert.equal(await schedule.locator('[role="tab"][aria-selected="true"]').count(), 1);
    for (const day of ['월', '화', '수', '목', '금', '토', '일']) {
      const tab = schedule.getByRole('tab', { name: day, exact: true });
      await tab.click();
      if (day === '일') await schedule.getByText('방영 예정인 작품이 없음', { exact: true }).waitFor();
      else await schedule.getByRole('button', { name: '23:30 요일 신작 MOA에서 검색', exact: true }).waitFor();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
    }
    await schedule.getByRole('tab', { name: '일', exact: true }).press('ArrowRight');
    assert.equal(await schedule.getByRole('tab', { name: '월', exact: true }).getAttribute('aria-selected'), 'true');
    await new Promise(resolve => setTimeout(resolve, 100));
    delayNext = true;
    const delayedResize = page.waitForRequest(request => new URL(request.url()).pathname === '/api/plugins');
    await schedule.getByRole('tab', { name: '일', exact: true }).click();
    await delayedResize;
    await schedule.getByRole('tab', { name: '월', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await schedule.getByText('종영 작품', { exact: true }).count(), 0);
    assert.equal(await schedule.locator('img').count(), 0);
    await schedule.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    await schedule.getByText('결방', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await schedule.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const height = await schedule.locator('#schedule').evaluate(element => Math.ceil(element.getBoundingClientRect().height));
    await page.waitForFunction(height => document.querySelector('.home-plugin iframe')?.clientHeight >= height, height, { timeout: 5000 });
    await page.screenshot({ path: verificationPath(`anime-schedule-${width}.png`) });
    scheduleError = true;
    await schedule.getByRole('button', { name: '새로고침', exact: true }).click();
    await schedule.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
    scheduleError = false;
    await schedule.getByRole('button', { name: '다시 시도', exact: true }).click();
    await schedule.getByRole('button', { name: '23:30 요일 신작 MOA에서 검색', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === '요일 신작');
    await page.locator('.home-plugin').waitFor({ state: 'detached' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Home plugin isolation, resize, permissions, navigation and errors; weekly schedule tabs, safe titles, filtering, retry and responsive layout passed.');
} finally { await browser.close(); await web.close(); }
