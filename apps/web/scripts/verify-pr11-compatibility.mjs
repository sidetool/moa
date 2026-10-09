// Synthetic, loopback-only regression checks; no running MOA instance is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: {} } });
await server.listen();
const base = server.resolvedUrls.local[0], origin = new URL(base).origin;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { if (window !== window.top) return; localStorage.setItem('moa.profile', 'viewer'); localStorage.setItem('moa.remoteMode', 'off'); });
  const preferences = new Map(), writes = [], errors = [];
  let enabled = true;
  const tool = { id: 'fixture-html', name: 'Member HTML tool', kind: 'html', placements: ['app'], permissions: [], revision: 'v1', enabled: true };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) return route.abort();
    const json = value => route.fulfill({ json: value });
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/me') return json({ id: 'member', role: 'member', permissions: ['video.watch'] });
    if (path === '/api/profiles') return json([{ id: 'viewer', name: 'Viewer', color: 'blue', kids: false }]);
    if (path === '/api/settings') return json({ subtitleBackground: 'original', subtitleSize: 'medium', defaultSubtitleLang: 'ko', navigation: [], autoplayNext: false });
    if (path === '/api/sources') return json([]);
    if (path === '/api/plugin-runtime') return json(enabled ? [tool] : []);
    if (path === '/api/plugin-runtime/fixture-html') return json({ revision: 'v1', html: '<h1>Member tool opened</h1>' });
    if (path === '/api/translation/config') return json({ enabled: false, configured: false });
    if (path.endsWith('/subtitles/preference')) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON(); writes.push({ path, body });
        if (!body.migrate || !preferences.has(path)) preferences.set(path, body.choice);
      }
      return json(preferences.has(path) ? { choice: preferences.get(path) } : {});
    }
    return route.fulfill({ status: 403, json: { error: 'admin-required' } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}settings`);
  await page.getByRole('heading', { name: '설정', exact: true }).waitFor();
  // Old off/track choices migrate, server choices win, and a synced cache isn't imported again.
  preferences.set('/api/episodes/server/subtitles/preference', null);
  const imported = await page.evaluate(async () => {
    const module = await import('/src/player/subtitle-preference.ts');
    const load = id => module.loadSubtitlePreference(id, new AbortController().signal);
    const putLocal = (id, value) => localStorage.setItem(`moa.subtitleChoice:${JSON.stringify(['viewer', id])}`, JSON.stringify(value));
    const track = id => ({ id: 'extension-1', episodeId: id, label: 'English', lang: 'en', format: 'vtt', source: 'extension' });
    putLocal('off', null); putLocal('track', track('track')); putLocal('server', track('server'));
    const off = await load('off'), selected = await load('track'), server = await load('server');
    return { off, selected, server };
  });
  assert.equal(imported.off, null); assert.equal(imported.selected.label, 'English'); assert.equal(imported.server, null);
  assert.equal(writes.length, 2); assert.ok(writes.every(item => item.body.migrate === true));
  preferences.delete('/api/episodes/track/subtitles/preference');
  assert.equal(await page.evaluate(async () => (await import('/src/player/subtitle-preference.ts')).loadSubtitlePreference('track', new AbortController().signal)), undefined);
  assert.equal(writes.length, 2);
  // The dialog must outlive closing the profile menu; management remains admin-only.
  await page.getByRole('button', { name: '프로필 메뉴', exact: true }).click();
  await page.getByRole('menuitem', { name: tool.name, exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.frameLocator('iframe[title="Member HTML tool"]').getByRole('heading', { name: 'Member tool opened' }).waitFor();
  assert.equal(await page.getByRole('menu').count(), 0);
  await page.getByRole('button', { name: '플러그인 닫기' }).click();
  await page.goto(`${base}plugins`);
  await page.getByText('관리자만 볼 수 있어요', { exact: true }).waitFor();
  enabled = false;
  await page.reload();
  await page.getByRole('button', { name: '프로필 메뉴', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: tool.name }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: legacy migration, server precedence, no stale reimport, member HTML launch, management boundary and disabled tool');
} finally { await browser?.close(); await server.close(); }
