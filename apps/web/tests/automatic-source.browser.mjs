// WatchPage integration against the existing mock API; all subtitle text is authored here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(path.join(process.env.MOA_VERIFY_DIR || tmpdir(), 'automatic-source-'));
process.env.VITE_MOCK = '1';
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), logLevel: 'warn', server: { port: 0, open: false, hmr: false } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], passed = [];
const track = (id, label, lang = 'en', source = 'extension') => ({ id, label, lang, source, format: 'vtt', url: `data:text/vtt,${encodeURIComponent(`WEBVTT\n\n00:00:01.000 --> 00:00:10.000\nSynthetic dialogue ${id}\n`)}` });
const partial = track('signs', 'English Signs & Songs');
const full = track('full', 'Japanese Full (Signs included)', 'ja');
const ordinary = track('ordinary', 'English');
const ai = track('ai', 'English AI Full');

async function scenario(name, options, check) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Match the established mock player tests: a synthetic playlist buffers forever, with usable controls.
  await context.route(url => url.hostname === 'test-streams.mux.dev', route => route.request().url().endsWith('.m3u8')
    ? route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:600\n#EXTINF:596,\nsegment.ts\n#EXT-X-ENDLIST\n' })
    : new Promise(() => {}));
  await context.addInitScript(options => {
    localStorage.setItem('moa.profile', 'p1'); localStorage.setItem('moa.fullscreenOnPlay', '0');
    window.__sourceRequests = []; window.__jimakuRequests = 0;
    const wrap = delegate => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.pathname === '/api/playback' && method === 'POST') {
        const response = await delegate(input, init), session = await response.json();
        const episode = JSON.parse(init.body).episodeId;
        window.__sourceEpisode = episode;
        return Response.json({ ...session, subtitles: episode === 'demo-3-e2' && options.nextTracks ? options.nextTracks : options.tracks });
      }
      if (/\/subtitles\/translations$/.test(url.pathname) && options.saved) return Response.json([options.saved]);
      if (/\/subtitles\/jimaku$/.test(url.pathname)) {
        window.__jimakuRequests++;
        if (options.jimaku === 'error') return Response.json({ error: 'jimaku-unavailable' }, { status: 503 });
        if (options.jimaku === 'empty') return Response.json({ searchId: 'synthetic-empty', query: { title: 'Synthetic work', season: 1, episode: 1 }, candidates: [] });
        if (options.jimaku === 'delayed') {
          const response = await delegate(input, init);
          return new Promise(resolve => { window.__releaseJimaku = () => resolve(response); });
        }
      }
      if (/\/subtitles\/(?:translate|jimaku\/translate)$/.test(url.pathname) && method === 'POST') {
        window.__sourceRequests.push({ path: url.pathname, body: JSON.parse(init.body) });
      }
      return delegate(input, init);
    };
    let fetch = wrap(window.fetch.bind(window));
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetch, set: value => { fetch = wrap(value); } });
  }, options);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${name}: ${error}`));
  try {
    await page.goto(`${base}/settings#subtitles`);
    await page.getByRole('combobox', { name: 'AI 자막 번역 방식' }).waitFor();
    await page.evaluate(async options => {
      const patch = (url, body) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await patch('/api/admin/translation/config', { addKeys: ['synthetic-translation-key'], enabled: true });
      await patch('/api/settings', { autoFetchSubtitles: false, translationMode: options.mode || 'auto', translationSourcePriority: options.priority || 'site', skipTranslationWithoutSubtitles: false });
    }, options);
    await page.goto(`${base}/watch/demo-3-e1`);
    await page.getByRole('button', { name: '자막 및 음성' }).waitFor();
    await check(page);
    passed.push(name);
    console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
const requests = page => page.evaluate(() => window.__sourceRequests);
const waitForStart = page => page.waitForFunction(() => window.__sourceRequests.length === 1);
const noCharge = async page => { await page.waitForTimeout(2400); assert.deepEqual(await requests(page), []); };

try {
  await scenario('Full dialogue wins even when signs and AI appear first', { tracks: [partial, ai, ordinary, full], jimaku: 'empty' }, async page => {
    await waitForStart(page);
    assert.equal((await requests(page))[0].body.sourceLabel, full.label);
    assert.equal(await page.evaluate(() => window.__jimakuRequests), 0);
  });
  await scenario('Only signs never create an automatic paid request and remain manually selectable', { tracks: [partial], jimaku: 'empty' }, async page => {
    await page.locator('.translate-offer').waitFor(); await noCharge(page);
    await page.getByRole('button', { name: '자막 및 음성' }).dispatchEvent('click');
    await page.locator('.translate-entry').click();
    await page.getByRole('radio', { name: /English Signs/ }).waitFor();
    assert.deepEqual(await requests(page), []);
  });
  await scenario('Jimaku failure falls back to full dialogue using the same policy', { tracks: [partial, ai, full], priority: 'jimaku', jimaku: 'error' }, async page => {
    await waitForStart(page);
    assert.equal((await requests(page))[0].body.sourceLabel, full.label);
    assert.equal(await page.evaluate(() => window.__jimakuRequests), 1);
  });
  await scenario('Jimaku verified candidate wins when the profile prefers Jimaku', { tracks: [partial, full], priority: 'jimaku' }, async page => {
    await waitForStart(page);
    assert.match((await requests(page))[0].path, /jimaku\/translate$/);
  });
  await scenario('Human Korean suppresses automatic charges', { tracks: [full, track('ko', '한국어', 'ko')], jimaku: 'empty' }, noCharge);
  await scenario('Completed saved translation is reused before choosing an original', { tracks: [full], saved: track('saved', '한국어 AI 번역', 'ko', 'translation'), jimaku: 'empty' }, async page => {
    await page.locator('.player-notice', { hasText: '저장된 AI 번역 자막을 적용했어요' }).waitFor(); await noCharge(page);
  });
  await scenario('Dismissing an offer prevents a later auto charge for the same episode', { tracks: [full], mode: 'ask', jimaku: 'empty' }, async page => {
    await page.getByRole('button', { name: '번역 제안 닫기' }).click();
    await page.evaluate(async () => { await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ translationMode: 'auto' }) }); });
    await page.reload(); await page.getByRole('button', { name: '자막 및 음성' }).waitFor(); await noCharge(page);
  });
  await scenario('Turning subtitles off while Jimaku is pending prevents a late automatic charge', { tracks: [full], priority: 'jimaku', jimaku: 'delayed' }, async page => {
    await page.waitForFunction(() => typeof window.__releaseJimaku === 'function');
    await page.getByRole('button', { name: '자막 및 음성' }).dispatchEvent('click');
    await page.getByRole('button', { name: '끄기', exact: true }).click();
    await page.evaluate(() => window.__releaseJimaku()); await noCharge(page);
  });
  await scenario('A late Jimaku response after episode transition never starts work for the old episode', { tracks: [full], nextTracks: [track('next-ko', '한국어', 'ko')], priority: 'jimaku', jimaku: 'delayed' }, async page => {
    await page.waitForFunction(() => typeof window.__releaseJimaku === 'function');
    await page.evaluate(() => { history.pushState({}, '', '/watch/demo-3-e2'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => window.__sourceEpisode === 'demo-3-e2');
    await page.evaluate(() => window.__releaseJimaku()); await noCharge(page);
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, pageErrors: errors }));
} finally { await browser.close(); await server.close(); await rm(output, { recursive: true, force: true }); }
