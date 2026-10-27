import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { buildApp } from '../../server/src/app.ts';
import { fetchPluginPackage, unpackPlugin } from '../../server/src/plugins/service.ts';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-install-'));
const env = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: false, downloadsEnabled: false }, false, { tmdb: { token: '', key: '' } });
const manifest = { apiVersion: 1, id: 'install-check', name: 'Installation check', version: '1.0.0', description: 'Package preview fixture', placements: ['home'], permissions: [], connect: [] };
const script = 'document.body.textContent = "Installed";';
const files = [{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'plugin.js', content: script }];
let web, browser;
try {
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  process.env.VITE_MOCK = '0';
  web = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false, hmr: false, proxy: { '/api': `http://127.0.0.1:${env.app.server.address().port}` } } });
  await web.listen();
  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
  const profile = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Install verification' } })).json();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(id => localStorage.setItem('moa.profile', id), profile.id);
  const page = await context.newPage(), errors = [], previews = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type()) && /Encountered two children with the same key|unique ["']?key["']? prop/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/plugins/preview') previews.push(request.postDataJSON()); });
  await page.goto(web.resolvedUrls.local[0] + 'plugins');
  const input = page.getByLabel('플러그인 파일', { exact: true }), preview = page.locator('.plugin-preview');
  const installed = id => env.db.get('SELECT package FROM website_plugins WHERE id=?', id)?.package;
  const chooseFiles = selected => input.setInputFiles(selected.map(file => ({ name: file.name, mimeType: 'text/plain', buffer: Buffer.from(file.content) })));
  await chooseFiles(files);
  await preview.getByText(`${manifest.name} · 1.0.0`, { exact: true }).waitFor();
  assert.equal(installed(manifest.id), undefined);
  assert.deepEqual(previews.at(-1), { files });
  await preview.getByRole('button', { name: '취소', exact: true }).click();
  await chooseFiles(files.slice(0, 1));
  await page.getByRole('alert').filter({ hasText: '실행 파일이 없거나 여러 개예요' }).waitFor();
  assert.equal(await preview.count(), 0);

  const drop = async (entries, useEntries = true) => page.locator('.plugin-install').evaluate((element, { entries, useEntries }) => {
    const transfer = new DataTransfer();
    window.pluginDropReads = 0;
    const entry = value => value.children ? {
      name: value.name, isFile: false, isDirectory: true,
      createReader() {
        let index = 0;
        return { readEntries(resolve) { window.pluginDropReads++; queueMicrotask(() => resolve(value.children.slice(index, ++index).map(entry))); } };
      }
    } : { name: value.name, isFile: true, isDirectory: false, file(resolve) { queueMicrotask(() => resolve(new File([value.content], value.name))); } };
    for (const value of entries) transfer.items.add(new File([value.content || ''], value.name));
    if (useEntries) Object.defineProperty(transfer, 'items', { value: entries.map(value => ({ webkitGetAsEntry: () => entry(value) })) });
    else Object.defineProperty(transfer, 'items', { value: [] });
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { entries, useEntries });
  await drop([{ name: 'release', children: [{ name: 'README.md', content: 'Ignored' }, { name: '__MACOSX', children: [{ name: 'manifest.json', content: '{}' }] }, { name: 'nested', children: [{ name: '._manifest.json', content: 'Ignored' }, ...files] }] }]);
  await preview.getByText(`${manifest.name} · 1.0.0`, { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1).files, files.map(file => ({ ...file, name: `release/nested/${file.name}` })));
  assert.ok(await page.evaluate(() => window.pluginDropReads) >= 8);
  await preview.getByRole('button', { name: '설치', exact: true }).click();
  await page.locator('.plugin-row').filter({ hasText: manifest.name }).waitFor();
  assert.equal(JSON.parse(installed(manifest.id)).script, script);
  const beforeBounded = previews.length;
  await drop([{ name: 'oversized', children: Array.from({ length: 513 }, (_, index) => ({ name: String(index), children: [] })) }]);
  await page.getByRole('alert').filter({ hasText: '플러그인 폴더에 파일이 너무 많아요' }).waitFor();
  assert.equal(previews.length, beforeBounded);
  assert.equal(await preview.count(), 0);
  await drop(files, false);
  await preview.getByText(`${manifest.name} · 1.0.0`, { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1), { files });
  await preview.getByRole('button', { name: '취소', exact: true }).click();

  const folder = path.join(directory, 'selected-folder');
  await mkdir(folder);
  for (const file of files) await writeFile(path.join(folder, file.name), file.content);
  await page.getByLabel('플러그인 폴더', { exact: true }).setInputFiles(folder);
  await preview.getByText(`${manifest.name} · 1.0.0`, { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1).files.map(file => file.name).sort(), ['selected-folder/manifest.json', 'selected-folder/plugin.js']);
  await preview.getByRole('button', { name: '취소', exact: true }).click();
  let zip = process.env.MOA_TEST_PLUGIN_ZIP;
  if (!zip) { zip = path.join(directory, 'plugin.zip'); execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: folder }); }
  const bytes = await readFile(zip), zipped = await unpackPlugin({ archive: bytes.toString('base64') });
  await input.setInputFiles({ name: 'package.zip', mimeType: 'application/zip', buffer: bytes });
  await preview.getByText(`${zipped.name} · ${zipped.version}`, { exact: true }).waitFor();
  assert.equal(previews.at(-1).archive, bytes.toString('base64'));
  await preview.getByRole('button', { name: installed(zipped.id) ? '업데이트' : '설치', exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(installed(zipped.id)).version, zipped.version);

  const link = 'https://plugins.example.org/latest.json';
  const packageAtLink = await fetchPluginPackage(link, AbortSignal.timeout(1000), async request => ({ statusCode: 200, headers: {}, url: request.url, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ ...manifest, version: '1.1.0', script })) }));
  await page.route('**/api/admin/plugins/preview', async route => {
    if (!route.request().postDataJSON().url) return route.continue();
    assert.equal(route.request().postDataJSON().url, link);
    await route.fulfill({ status: 200, json: packageAtLink });
  });
  await page.getByLabel('플러그인 업데이트 링크').fill(link);
  await page.getByRole('button', { name: '링크 불러오기', exact: true }).click();
  await preview.getByText(`${manifest.name} · 1.1.0`, { exact: true }).waitFor();
  await preview.getByText(`업데이트 링크: ${link}`, { exact: true }).waitFor();
  assert.equal(JSON.parse(installed(manifest.id)).version, '1.0.0');
  await preview.getByRole('button', { name: '업데이트', exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(installed(manifest.id)).version, '1.1.0');
  assert.equal(JSON.parse(installed(manifest.id)).updateUrl, link);
  await page.route(`**/api/admin/plugins/${manifest.id}/preview`, route => route.fulfill({ status: 409, json: { error: 'plugin-id-mismatch' } }));
  await page.locator('.plugin-row').filter({ hasText: manifest.name }).getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '플러그인을 처리하지 못했어요' }).waitFor();
  assert.equal(await preview.count(), 0);
  assert.equal(JSON.parse(installed(manifest.id)).version, '1.1.0');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', actualServer: ['loose files', 'nested batched folder drop', 'bounded directory traversal', 'file drop fallback', 'folder picker', 'ZIP preview and install', 'review before install'], fixtureTransport: ['link package parser and review', 'ID mismatch rejection UI'], zip: zipped.id }));
} finally {
  await browser?.close();
  await web?.close();
  await env.app.close();
  await rm(directory, { recursive: true, force: true });
}
