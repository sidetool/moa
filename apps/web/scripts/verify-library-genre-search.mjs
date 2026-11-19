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
  const provider = { id: 'fixture', name: 'Fixture', kind: 'mangayomi-js', lang: 'en' };
  env.db.run('INSERT INTO source_entries(id,repository,entry,code,enabled) VALUES(?,?,?,?,1)', provider.id, 'synthetic', JSON.stringify(provider), 'fixture');
  const add = (id, title, metadata, type = 'movie') => env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, title, type, JSON.stringify(metadata), '2026');
  add('genre', '달빛 아래 시즌 1', { genres: ['미스터리'] }, 'series');
  add('edition', '달빛 아래 시즌 2', { genres: ['미스터리'] }, 'series');
  add('title', '미스터리 극장', { genres: ['미스터리'] });
  add('alias', '달빛 아래 시즌 2', { provider, altTitles: ['미스터리의 시작'] }, 'series');

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
  const assertOrder = async ids => {
    await page.waitForFunction(count => document.querySelectorAll('a.poster-card').length === count, ids.length);
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(a => a.getAttribute('href'))), ids.map(id => '/title/' + id));
  };
  // The local S2 edition represents both the genre-only local hit and the source's alias hit.
  await assertOrder(['title', 'edition', 'genre']);
  assert.deepEqual(resolved.at(-1), ['title', 'alias', 'edition', 'genre']);
  await page.evaluate(async () => { const { saveDevicePrefs } = await import('/src/lib/device-prefs.ts'); await saveDevicePrefs({ titleGrouping: false }); });
  const resolvesBefore = resolved.length;
  await page.reload();
  await assertOrder(['title', 'alias', 'genre', 'edition']);
  assert.equal(resolved.length, resolvesBefore);
  assert.ok(external.length > 0);
  assert.ok(external.every(body => body.mode === 'search' && body.q === '미스터리' && body.page === 1));
  await page.locator('a.poster-card[href="/title/genre"]').click();
  await page.waitForURL('**/title/genre');
  await page.getByRole('heading', { name: '달빛 아래 시즌 1' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Genre-only library results open from search and follow title and alias matches with grouping on and off.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
