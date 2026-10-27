// Source icons on the source management screen against the development mock API (VITE_MOCK=1). UI only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.MOA_SOURCE_ICON_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'moa-source-icons-'));
process.env.VITE_MOCK = '1';
const syntheticSources = [
  { id: 'sample-kr', name: 'Sample KR', lang: 'ko', type: 'series', iconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>') },
  { id: 'example-en', name: 'Example Source A', lang: 'en', type: 'anime' },
  { id: 'multi-en', name: 'Sample Multilingual', lang: 'en', type: 'anime', iconUrl: '/api/images/source-icons/missing.png' },
  { id: 'multi-all', name: 'Sample Multilingual', lang: 'all', type: 'anime' },
].map(source => ({ version: '1.0', installed: true, enabled: true, live: false, repository: 'https://example.org/index.json', kind: 'mangayomi-js', ...source }));
const server = await createServer({ root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), cacheDir: path.join(evidence, 'vite-cache'), logLevel: 'warn', server: { port: 0, open: false },
  plugins: [{ name: 'synthetic-source-fixture', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/api/mock.ts')) return;
    return code.replace(/let videoSources: VideoSource\[\] = \[[\s\S]*?\n\];/, `let videoSources: VideoSource[] = ${JSON.stringify(syntheticSources)};`);
  } }],
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];

try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => localStorage.setItem('moa.profile', 'p1'));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/sources`);
    const entry = title => page.locator('.source-entry').filter({ has: page.locator('h2', { hasText: title }) });
    await page.locator('.source-entry').first().waitFor();
    await page.waitForLoadState('networkidle');

    // Loaded icon replaces the generic symbol.
    const loaded = entry('Sample KR').locator('.source-symbol');
    await loaded.locator('img').waitFor();
    await page.waitForFunction(() => document.querySelector('.source-symbol.has-icon img')?.naturalWidth > 0);
    assert.equal(await loaded.evaluate(el => el.classList.contains('has-icon')), true, `${name}: icon shown`);
    assert.equal(await loaded.locator('svg').count(), 0, `${name}: generic symbol removed once the icon loads`);

    // A broken icon URL falls back to the symbol; no broken image remains.
    const broken = entry('Sample Multilingual').filter({ has: page.locator('.source-lang', { hasText: '영어' }) }).locator('.source-symbol');
    await page.waitForFunction(el => !el.querySelector('img'), await broken.elementHandle(), { timeout: 10000 });
    assert.equal(await broken.locator('svg').count(), 1, `${name}: failed icon falls back to the symbol`);

    // No icon at all: the symbol, as before.
    const none = entry('Sample Multilingual').filter({ has: page.locator('.source-lang', { hasText: '다국어' }) }).locator('.source-symbol');
    assert.equal(await none.locator('img').count(), 0);
    assert.equal(await none.locator('svg').count(), 1);

    // Language: shown for same-name editions and non-Korean sources only.
    assert.equal(await entry('Sample Multilingual').count(), 2, 'two editions share the name');
    assert.equal(await entry('Sample KR').locator('.source-lang').count(), 0, `${name}: unique Korean source has no language label`);
    assert.equal(await entry('Example Source A').locator('.source-lang').innerText(), '영어');

    const broken_images = await page.evaluate(() => [...document.querySelectorAll('img')].filter(img => img.complete && !img.naturalWidth && img.getAttribute('src')).length);
    assert.equal(broken_images, 0, `${name}: no broken images on the page`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
    await page.locator('.source-entry').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `sources-${name}.png`), fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
