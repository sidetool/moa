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
const bytes = await readFile(process.env.MOA_TEST_VIDEO);
const directory = await mkdtemp(path.join(tmpdir(), 'moa-title-download-'));
for (const name of ['data', 'media', 'downloads']) await mkdir(path.join(directory, name));
const env = await buildApp({ dataDir: path.join(directory, 'data'), mediaRoot: path.join(directory, 'media'), downloadRoot: path.join(directory, 'downloads'), requireAccount: false }, false, {
  tmdb: { token: '', key: '' },
  downloadTransport: async url => {
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
  await page.goto(web.resolvedUrls.local[0] + 'title/m');
  const setup = page.getByRole('link', { name: '1화 다운로드 설정', exact: true });
  await setup.waitFor(); assert.equal(await setup.getAttribute('href'), '/settings#downloads');
  assert.equal(env.db.get('SELECT count(*) AS n FROM download_jobs').n, 0);
  await env.downloads.configureSettings({ enabled: true, quotaBytes: 1024 ** 3 });
  await page.reload();
  await page.getByRole('button', { name: '1화 다운로드', exact: true }).click();
  await page.getByRole('link', { name: '1화 다운로드됨 · 다운로드 목록 보기', exact: true }).waitFor();
  assert.equal(env.db.get("SELECT state FROM download_jobs WHERE episode_id='e1'").state, 'ready');
  assert.equal(env.db.get("SELECT size FROM download_assets WHERE episode_id='e1'").size, bytes.length);
  await page.route('**/api/me', route => route.fulfill({ json: { id: 'member', username: 'Viewer', role: 'member', permissions: ['video.watch'] } }));
  await page.reload(); await page.locator('.episode-list').waitFor();
  assert.equal(await page.locator('.episode-save').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', actualServer: ['unconfigured setup link', 'episode button enqueues and saves MP4', 'ready state and saved bytes'], fixtureBoundary: ['source video extraction', 'HTTP video transport', 'member UI identity'] }));
} finally { await browser?.close(); await web?.close(); await env.app.close(); await rm(directory, { recursive: true, force: true }); }
