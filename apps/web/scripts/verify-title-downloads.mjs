import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { buildApp } from '../../server/src/app.ts';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
// Media transfer is optional; visibility/configuration checks need no ffmpeg or external video.
const bytes = process.env.MOA_TEST_VIDEO ? await readFile(process.env.MOA_TEST_VIDEO) : null;
const directory = await mkdtemp(path.join(tmpdir(), 'moa-title-download-'));
for (const name of ['data', 'media', 'downloads']) await mkdir(path.join(directory, name));
const env = await buildApp({ dataDir: path.join(directory, 'data'), mediaRoot: path.join(directory, 'media'), downloadRoot: path.join(directory, 'downloads'), requireAccount: false }, false, {
  tmdb: { token: '', key: '' },
  downloadTransport: async url => {
    assert.ok(bytes, "visibility-only run must not download video");
    const response = new IncomingMessage(new Socket());
    response.statusCode = 200; response.headers = { 'content-type': 'video/mp4', 'content-length': String(bytes.length) };
    let sent = false; response._read = () => { if (!sent) { sent = true; response.push(bytes); response.push(null); } };
    return { url, response };
  }
});
let browser, web;
try {
  const profile = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Download test' } })).json();
  const entry = JSON.stringify({ name: 'Fixture source', version: '1', baseUrl: 'https://fixture.example/' });
  env.db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'source', 'fixture', entry, entry, 'fixture');
  env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'm', '회차 다운로드 확인', 'anime', JSON.stringify({ provider: { id: 'source', name: 'Fixture source', kind: 'mangayomi-js' } }), '2026');
  env.db.run("INSERT INTO episodes VALUES('e1','m',1,1,'1화',600,NULL)");
  env.db.run('INSERT INTO source_media VALUES(?,?,?,?)', 'm', 'source', '/title', Date.now());
  env.db.run("INSERT INTO source_episodes VALUES('e1','/episode')");
  env.db.run("INSERT INTO episodes VALUES('e2','m',1,2,'2화',600,NULL)");
  env.db.run("INSERT INTO source_episodes VALUES('e2','/episode-2')");
  env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'movie', '영화 다운로드 확인', 'movie', JSON.stringify({ provider: { id: 'source', name: 'Fixture source', kind: 'mangayomi-js' } }), '2026');
  env.db.run("INSERT INTO episodes VALUES('movie-e','movie',1,1,'영화',600,NULL)");
  env.db.run('INSERT INTO source_media VALUES(?,?,?,?)', 'movie', 'source', '/movie', Date.now());
  env.db.run("INSERT INTO source_episodes VALUES('movie-e','/movie-video')");
  env.sources.videos = async () => [{ url: 'https://fixture.example/video.mp4', quality: '720p' }];
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  process.env.VITE_MOCK = '0';
  web = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false, hmr: false, proxy: { '/api': `http://127.0.0.1:${env.app.server.address().port}` } } });
  await web.listen();
  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(id => localStorage.setItem('moa.profile', id), profile.id);
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const navigate = async destination => {
    await page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, destination);
  };
  const hidden = async () => {
    assert.equal(await page.locator('.episode-save, .batch-save, .hero-download-status, .movie-download').count(), 0);
    assert.equal(await page.locator('a[href="/settings#downloads"]').count(), 0);
    assert.equal(await page.getByText('다운로드 설정', { exact: true }).count(), 0);
  };
  await page.goto(web.resolvedUrls.local[0] + 'title/m');
  await page.locator('.episode-list').waitFor(); await hidden();
  assert.equal(env.db.get('SELECT count(*) AS n FROM download_jobs').n, 0);
  await env.downloads.configureSettings({ quotaBytes: 1024 ** 3 });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await navigate('/settings#downloads');
    const toggle = page.getByRole('switch', { name: '서버 다운로드 사용' });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/admin/downloads/config') && r.request().method() === 'PUT' && r.ok()), toggle.click()]);
    await navigate('/title/m');
    await page.getByRole('button', { name: '2화 다운로드', exact: true }).waitFor();
    assert.equal(await page.locator('.batch-save').count(), 1);
    if (bytes && width === 1280) {
      await page.getByRole('button', { name: '1화 다운로드', exact: true }).click();
      await page.getByRole('link', { name: '1화 다운로드됨 · 다운로드 목록 보기', exact: true }).waitFor();
      assert.equal(env.db.get("SELECT state FROM download_jobs WHERE episode_id='e1'").state, 'ready');
      assert.equal(env.db.get("SELECT size FROM download_assets WHERE episode_id='e1'").size, bytes.length);
    }
    await navigate('/title/movie');
    await page.getByRole('button', { name: '다운로드', exact: true }).waitFor();
    await navigate('/settings#downloads');
    await toggle.waitFor();
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/admin/downloads/config') && r.request().method() === 'PUT' && r.ok()), toggle.click()]);
    assert.equal(env.downloads.enabled(), false);
    // Retain the React Query cache: revisit both titles without a full reload.
    await navigate('/title/m'); await page.locator('.episode-list').waitFor(); await hidden();
    await navigate('/title/movie'); await page.getByRole('heading', { name: '영화 다운로드 확인', exact: true }).waitFor(); await hidden();
    await page.reload(); await page.getByRole('heading', { name: '영화 다운로드 확인', exact: true }).waitFor(); await hidden();
  }
  await navigate('/title/m');
  await env.downloads.configureSettings({ enabled: true });
  await page.route('**/api/me', route => route.fulfill({ json: { id: 'member', username: 'Viewer', role: 'member', permissions: ['video.watch'] } }));
  await page.reload(); await page.locator('.episode-list').waitFor();
  assert.equal(await page.locator('.episode-save').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', actualServer: ['OFF hides series/movie/batch controls', 'ON reveals download controls', 'OFF updates cached titles without reload', 'OFF survives reload', 'desktop and mobile'], mediaTransfer: bytes ? 'saved MP4 verified' : 'not exercised', fixtureBoundary: ['source video extraction', 'HTTP video transport', 'member UI identity'] }));
} finally { await browser?.close(); await web?.close(); await env.app.close(); await rm(directory, { recursive: true, force: true }); }
