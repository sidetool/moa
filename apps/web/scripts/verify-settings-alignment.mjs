import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';
import { iconBesideLabel, stepperCentered } from './alignment-checks.mjs';

// Real settings screens that use Button icons and NumberStepper, measured where they render.
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [], results = [];
const scenarios = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'narrow', width: 320, height: 640, mobile: true },
  { name: 'landscape', width: 740, height: 360, mobile: true },
  // Root text scaling only approximates an OS font-size setting.
  { name: 'large-text', width: 390, height: 844, mobile: true, fontSize: '200%' },
];
const tabs = ['홈', '시리즈', '영화', '애니'].map((name, index) => ({ id: ['home', 'series', 'movies', 'anime'][index], name, sourceIds: ['test-source'], includeLocal: true }));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.mobile, hasTouch: scenario.mobile, deviceScaleFactor: 2 });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let settings = { autoplayNext: true, autoplayDelay: 5, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', nextEpisodeLeadSeconds: 60, navigation: tabs };
    let defaults = null;
    const leadSaves = [], defaultSaves = [];
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { id: 'admin', username: '테스트', role: 'admin' } });
      if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
      if (path === '/api/settings') {
        if (request.method() === 'PATCH') { const patch = request.postDataJSON(); settings = { ...settings, ...patch }; if ('nextEpisodeLeadSeconds' in patch) leadSaves.push(patch.nextEpisodeLeadSeconds); }
        return route.fulfill({ json: settings });
      }
      if (path === '/api/settings/device') return route.fulfill({ json: { settings: {} } });
      if (path === '/api/sources') return route.fulfill({ json: [{ id: 'test-source', name: '테스트 소스', installed: true, enabled: true, type: 'anime', live: false }] });
      if (path === '/api/admin/default-navigation') {
        if (request.method() === 'PUT') { defaults = request.postDataJSON().navigation; defaultSaves.push(defaults && defaults.map(tab => tab.id)); }
        return route.fulfill({ json: { navigation: defaults } });
      }
      if (path.endsWith('/translation/config')) return route.fulfill({ json: { enabled: false, configured: false, keys: [], requestIntervalMs: 1000, retryCount: 2 } });
      if (path === '/api/admin/components') return route.fulfill({ json: { available: false, items: [] } });
      if (path === '/api/admin/subtitle-memory') return route.fulfill({ json: { retentionDays: 90, count: 3 } });
      if (path === '/api/admin/updates') return route.fulfill({ json: { configured: false, connected: false, state: 'idle', current: 'unknown' } });
      return route.fulfill({ json: [] });
    });
    const base = server.resolvedUrls.local[0];
    const enlarge = () => scenario.fontSize && page.evaluate(size => { document.documentElement.style.fontSize = size; }, scenario.fontSize);
    const result = { scenario: scenario.name };

    // Home tabs: choose the current tabs as the default, then return to automatic.
    await page.goto(`${base}settings#tabs`);
    const card = page.locator('.default-tabs');
    await card.waitFor();
    await enlarge();
    const choose = card.getByRole('button', { name: '이 구성을 기본으로', exact: true });
    await choose.scrollIntoViewIfNeeded();
    await choose.click();
    const chosen = card.getByRole('button', { name: '기본으로 지정됨', exact: true });
    await chosen.waitFor();
    assert.deepEqual(defaultSaves, [tabs.map(tab => tab.id)]);
    assert.equal(await chosen.isDisabled(), true);
    await page.evaluate(() => document.fonts.ready);
    result.defaultButton = await iconBesideLabel(chosen);
    assert.ok(result.defaultButton.ok, `${scenario.name}: check icon beside "기본으로 지정됨" ${JSON.stringify(result.defaultButton)}`);
    assert.ok(result.defaultButton.height >= 40, `${scenario.name}: default button touch height`);
    assert.ok(await noOverflow(page), `${scenario.name}: tabs overflow`);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: verificationPath(`settings-default-tabs-${scenario.name}.png`) });
    await card.getByRole('button', { name: '자동으로 되돌리기', exact: true }).click();
    await choose.waitFor();
    assert.deepEqual(defaultSaves, [tabs.map(tab => tab.id), null]);

    // Playback advanced: the lead stepper stays centered while values change and save.
    await page.goto(`${base}settings#playback-advanced`);
    const row = page.locator('.setting-next-lead');
    await row.waitFor();
    await enlarge();
    await page.evaluate(() => document.fonts.ready);
    const stepper = row.locator('.number-stepper');
    const field = stepper.getByRole('spinbutton', { name: '다음 화 안내 시점' });
    await stepper.scrollIntoViewIfNeeded();
    const measured = result.stepper = [];
    // Presses save together after a short pause.
    const saved = async expected => {
      for (let tries = 0; leadSaves.length < expected.length && tries < 50; tries++) await page.waitForTimeout(100);
      assert.deepEqual(leadSaves, expected);
    };
    const check = async label => {
      const value = await stepperCentered(stepper);
      measured.push({ label, ...value });
      assert.ok(value.ok, `${scenario.name}: stepper ${label} ${JSON.stringify(value)}`);
      assert.ok(value.height >= 40 && value.buttonWidth >= 40, `${scenario.name}: stepper touch target ${JSON.stringify(value)}`);
      // − and + stay put while the number changes, so repeated presses land on the same button.
      assert.ok(Math.abs(value.plus - measured[0].plus) <= .5, `${scenario.name}: + moved at ${label}`);
    };
    await check('60');
    await row.screenshot({ path: verificationPath(`settings-next-lead-${scenario.name}.png`) });
    await stepper.getByRole('button', { name: '10초 늘리기' }).click();
    assert.equal(await field.inputValue(), '70');
    await check('70');
    await saved([70]);
    await field.fill('5');
    await check('typing 5');
    await field.press('Enter');
    await saved([70, 5]);
    await check('5');
    await field.fill('9999');
    await check('typing 9999');
    await field.press('Enter');
    await page.getByRole('status').filter({ hasText: '가까운 값으로 맞췄어요' }).waitFor();
    await saved([70, 5, 600]);
    assert.equal(await field.inputValue(), '600');
    await check('600');
    await field.press('Home');
    await saved([70, 5, 600, 0]);
    await check('0');
    assert.ok(await noOverflow(page), `${scenario.name}: playback overflow`);
    await page.reload();
    await row.waitFor();
    assert.equal(await field.inputValue(), '0', `${scenario.name}: saved lead survives reload`);
    results.push(result);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scenarios: results.map(result => result.scenario) }));
} finally {
  await writeFile(verificationPath('settings-alignment.json'), JSON.stringify({ results, errors, limitations: ['Large text scales the root font size; it does not reproduce operating-system font scaling exactly.'] }, null, 2));
  await browser.close();
  await server.close();
}
