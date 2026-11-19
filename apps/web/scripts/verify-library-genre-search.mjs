import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const { tsImport } = createRequire(new URL('../../server/package.json', import.meta.url))('tsx/esm/api');
const { buildApp } = await tsImport('../../server/src/app.ts', import.meta.url);
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
assert.match(base, /^http:\/\/127\.0\.0\.1:51\d\d$/);
const directory = await mkdtemp(path.join(tmpdir(), 'moa-library-genre-'));
let app, browser;
try {
  const env = await buildApp({ dataDir: directory, mediaRoot: directory, webDir: path.join(directory, 'web'), requireAccount: false }, false, { tmdb: { token: '', key: '' } });
  app = env.app;
  const { id: profile } = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Viewer' } })).json();
  const provider = { id: 'fixture', name: 'Fixture', kind: 'mangayomi-js', lang: 'ko' };
  env.db.run('INSERT INTO source_entries(id,repository,entry,code,enabled) VALUES(?,?,?,?,1)', provider.id, 'synthetic', JSON.stringify(provider), 'fixture');
  const add = (id, title, metadata) => env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, title, 'movie', JSON.stringify(metadata), '2026');
  add('genre', '달빛 아래', { genres: ['미스터리'] });
  add('title', '미스터리 극장', { genres: ['미스터리'] });
  add('alias', '조용한 오후', { provider, altTitles: ['미스터리의 시작'] });

  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(id => localStorage.setItem('moa.profile', id), profile);
  const errors = [], resolved = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/sources/fixture/browse') {
      external.push(request.postDataJSON());
      return route.fulfill({ json: { items: [], page: 1, hasNextPage: false } });
    }
    if (url.pathname === '/api/media/groups/resolve') resolved.push(request.postDataJSON().ids);
    const result = await app.inject({ method: request.method(), url: url.pathname + url.search, headers: request.headers(), payload: request.postData() ?? undefined });
    await route.fulfill({ status: result.statusCode, contentType: result.headers['content-type'], body: result.rawPayload });
  });
  await page.goto(base + '/search');
  const input = page.locator('input[placeholder="제목, 장르 검색"]:visible');
  await input.fill('미스터리');
  await input.press('Enter');
  const cards = page.locator('a.poster-card');
  const expected = ['/title/title', '/title/alias', '/title/genre'];
  const assertOrder = async () => {
    await page.waitForFunction(() => document.querySelectorAll('a.poster-card').length === 3);
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(a => a.getAttribute('href'))), expected);
  };
  await assertOrder();
  assert.deepEqual(resolved.at(-1), ['title', 'alias', 'genre']);
  await page.evaluate(async () => { const { saveDevicePrefs } = await import('/src/lib/device-prefs.ts'); await saveDevicePrefs({ titleGrouping: false }); });
  const resolvesBefore = resolved.length;
  await page.reload();
  await assertOrder();
  assert.equal(resolved.length, resolvesBefore);
  assert.ok(external.length > 0);
  assert.ok(external.every(body => body.mode === 'search' && body.q === '미스터리' && body.page === 1));
  await cards.last().click();
  await page.waitForURL('**/title/genre');
  await page.getByRole('heading', { name: '달빛 아래' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Genre-only library results open from search and follow title and alias matches with grouping on and off.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
