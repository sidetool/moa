import { mockWatchUrl } from './mock-watch.mjs';
// Translation modes and live (partial) AI subtitles against the development mock API (VITE_MOCK=1).
// Uses a local MP4 (MOA_TEST_VIDEO, 600 s) for real seeking; no backend, Gemini key or Jimaku request.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const video = process.env.MOA_TEST_VIDEO;
assert.ok(video, 'MOA_TEST_VIDEO must point to a local 600-second MP4');
const size = (await stat(video)).size;
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.MOA_TRANSLATION_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'moa-translation-live-'));
process.env.VITE_MOCK = '1';
const server = await createServer({
  root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), cacheDir: path.join(evidence, 'vite-cache'), logLevel: 'warn', server: { port: 0, open: false },
  plugins: [{
    name: 'translation-live-fixture',
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__fixture.mp4')) return next();
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : size - 1;
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
        createReadStream(video, { start, end }).pipe(res);
      });
    }
  }]
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  localStorage.setItem('moa.profile', 'p1');
  localStorage.setItem('moa.fullscreenOnPlay', '0');
  localStorage.setItem('moa.mockVideo', '/__fixture.mp4');
  localStorage.setItem('moa.mockTranslationBatchMs', '4000');
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(String(error)));

const api = (path, method, body) => page.evaluate(([path, method, body]) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status === 204 ? null : r.json()), [path, method, body]);
const settings = body => api('/api/settings', 'PATCH', body);
const counters = () => page.evaluate(() => ({ jobs: window.__moaJobsCreated ?? 0, jimaku: window.__moaJimakuSearches ?? 0, priority: window.__moaPriority ?? [] }));
/** Cues of the subtitle track the player is showing (VTT). */
const shownCues = () => page.evaluate(() => {
  const track = [...document.querySelector('video').textTracks].find(t => t.mode === 'showing');
  return track?.cues ? [...track.cues].map(cue => ({ start: cue.startTime, text: cue.text })) : null;
});
const watch = async (episode, number = 1) => {
  await page.goto(episode === 'anime' || episode === 'movie' ? await mockWatchUrl(page, base, episode, number) : `${base}/watch/${episode}`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
};
const quiet = ms => page.waitForTimeout(ms);
const subsPanel = async () => {
  if (await page.locator('.player-panel').count()) return;
  // While playing, the controls hide; a positional click would land on the video surface instead.
  await page.getByRole('button', { name: '자막 및 음성' }).dispatchEvent('click');
  await page.locator('.player-panel').waitFor();
};
const activeSubtitle = async () => { await subsPanel(); const text = await page.locator('.panel-cols .opt.is-active').first().innerText(); await page.getByRole('button', { name: '닫기' }).first().dispatchEvent('click'); return text; };
const offer = page.locator('.translate-offer');

let step = 'setup';
try {
  /* ---------- setup: admin key, small batches so revisions are visible ---------- */
  await page.goto(`${base}/settings#subtitles`);
  await api('/api/admin/translation/config', 'PATCH', { addKeys: ['AIza-live-key-0001'], enabled: true, batchSize: 25 });
  await settings({ autoFetchSubtitles: false, translationMode: 'manual', skipTranslationWithoutSubtitles: false });

  /* ---------- settings: mode select and disclosure ---------- */
  step = 'settings'; console.log('STEP', step);
  await page.reload();
  const mode = page.getByRole('combobox', { name: 'AI 자막 번역 방식' });
  await mode.waitFor();
  assert.equal(await mode.textContent(), '직접 번역');
  await mode.click();
  await page.getByRole('option', { name: '자동 번역', exact: true }).click();
  await page.getByText('자막 내용과 작품 정보가 설정한 AI 서비스로 전송돼 사용료가 발생해요').waitFor();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('moa.mockTranslation') || '{}').settings?.translationMode === 'auto');
  await mode.click();
  await page.getByRole('option', { name: '번역할지 묻기', exact: true }).click();
  await page.getByText('‘번역하기’를 누를 때만 자막 내용과 작품 정보가 설정한 AI 서비스로 전송되고').waitFor();
  await page.locator('.setting-translation-mode').screenshot({ path: path.join(evidence, 'settings-mode.png') });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('moa.mockTranslation') || '{}').settings?.translationMode === 'ask');
  await mode.click();
  await page.getByRole('option', { name: '직접 번역', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('moa.mockTranslation') || '{}').settings?.translationMode === 'manual');

  /* ---------- manual: nothing is searched, suggested or translated ---------- */
  step = 'manual'; console.log('STEP', step);
  await watch('demo-3-e1');
  await quiet(3500);
  assert.equal(await offer.count(), 0, 'manual mode shows no suggestion');
  assert.deepEqual(await counters(), { jobs: 0, jimaku: 0, priority: [] }, 'manual mode makes no requests');

  /* ---------- Korean first: an existing Korean track wins in auto mode ---------- */
  step = 'korean first'; console.log('STEP', step);
  await settings({ translationMode: 'auto' });
  await watch('movie');
  await quiet(3000);
  assert.equal((await counters()).jobs, 0, 'no translation when a Korean track exists');
  assert.match(await activeSubtitle(), /^한국어/);
  // ...and so does a Korean subtitle the online search finds (anime).
  await settings({ autoFetchSubtitles: true });
  await watch('anime', 1);
  await page.locator('.player-notice', { hasText: '한국어 자막을 찾아 적용했어요' }).waitFor({ timeout: 15000 });
  await quiet(2000);
  assert.deepEqual(await counters(), { jobs: 0, jimaku: 0, priority: [] }, 'online Korean subtitle is used before any translation');
  await settings({ autoFetchSubtitles: false });

  /* ---------- auto: certain Japanese track, starts near the resume point, partial cues first ---------- */
  step = 'auto partial'; console.log('STEP', step);
  await watch('anime', 3); // resumes at 95 s
  await page.locator('.player-notice', { hasText: 'AI로 번역하고 있어요' }).waitFor({ timeout: 10000 });
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(t => t.mode === 'showing' && t.cues?.length && [...t.cues].every(c => c.text.startsWith('[AI]'))), null, { timeout: 15000 });
  let cues = await shownCues();
  assert.ok(cues.length >= 25 && cues.length < 60, 'translated cues are shown before the whole subtitle finishes');
  assert.ok(cues[0].start >= 85 && cues[0].start <= 100, `first batch starts near the resume point (got ${cues[0].start})`);
  await page.screenshot({ path: path.join(evidence, 'auto-partial.png') });
  // Seek into an untranslated stretch: that part is translated next.
  await page.evaluate(() => { document.querySelector('video').currentTime = 520; });
  await page.waitForFunction(() => (window.__moaPriority ?? []).some(at => at >= 515 && at <= 525), null, { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(t => t.mode === 'showing' && [...(t.cues ?? [])].some(c => c.startTime >= 515 && c.startTime <= 535)), null, { timeout: 8000 });
  cues = await shownCues();
  assert.ok(!cues.some(c => c.start > 360 && c.start < 500), 'the seek target was translated before the stretch in between');
  await page.locator('.player-notice', { hasText: 'AI 번역을 마쳤어요' }).waitFor({ timeout: 20000 });
  assert.equal((await shownCues()).length, 60, 'final revision holds every cue');
  assert.equal((await counters()).jobs, 1, 'one job for the episode');

  /* ---------- reload: the finished translation is reused, nothing new is charged ---------- */
  step = 'reuse'; console.log('STEP', step);
  await watch('anime', 3);
  await page.locator('.player-notice', { hasText: '저장된 AI 번역 자막을 적용했어요' }).waitFor({ timeout: 10000 });
  assert.equal((await counters()).jobs, 0, 'reloading reuses the saved translation');

  /* ---------- subtitles off during an auto translation stops it ---------- */
  step = 'off'; console.log('STEP', step);
  await watch('anime', 4);
  await page.locator('.player-notice', { hasText: 'AI로 번역하고 있어요' }).waitFor({ timeout: 10000 });
  await subsPanel();
  await page.getByRole('button', { name: '끄기', exact: true }).click();
  await page.locator('.player-notice', { hasText: '자막을 꺼서 자동 번역을 멈췄어요' }).waitFor();
  assert.equal(await page.locator('.translate-entry.is-busy').count(), 0);
  await page.getByRole('button', { name: '닫기' }).first().dispatchEvent('click');
  await quiet(2500);
  assert.equal(await shownCues(), null, 'subtitles stay off');

  // The off preference belongs to the whole title, including the next episode.
  await watch('anime', 7);
  await quiet(2500);
  assert.equal((await counters()).jobs, 0, 'subtitles off also prevents auto translation in another episode');
  assert.equal(await shownCues(), null);
  await subsPanel();
  await page.locator('.panel-cols > section').filter({has: page.getByRole('button', {name: '끄기', exact: true})}).getByRole('button', {name: /^일본어/}).click();
  await page.getByRole('button', {name: '닫기'}).first().dispatchEvent('click');

  /* ---------- cancel: never restarted automatically, even after a reload ---------- */
  step = 'cancel'; console.log('STEP', step);
  await watch('anime', 5);
  await page.locator('.player-notice', { hasText: 'AI로 번역하고 있어요' }).waitFor({ timeout: 10000 });
  await page.locator('.player-notice').getByRole('button', { name: '취소' }).click();
  await quiet(1000);
  await watch('anime', 5);
  await quiet(3500);
  assert.equal((await counters()).jobs, 0, 'a cancelled episode is not translated again automatically');
  assert.equal(await offer.count(), 0);

  /* ---------- ask: Jimaku suggestion, explicit press, partial result on screen ---------- */
  step = 'ask'; console.log('STEP', step);
  await settings({ translationMode: 'ask' });
  await watch('demo-3-e1');
  await offer.waitFor({ timeout: 15000 });
  await offer.getByText('Jimaku에서 일본어 자막을 찾았어요').waitFor();
  assert.equal((await counters()).jobs, 0, 'ask mode does not translate before a press');
  await page.screenshot({ path: path.join(evidence, 'ask-offer.png') });
  await offer.getByRole('button', { name: '번역하기' }).click();
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.mode === 'showing' && [...(track.cues ?? [])].some(cue => cue.text.startsWith('[AI]'))), null, {timeout: 15000});
  assert.equal(await page.locator('.player-notice', {hasText: '번역된 부분부터'}).count(), 0);
  assert.ok((await shownCues())?.length >= 25);
  await subsPanel();
  await page.locator('.panel-cols .opt.is-active', { hasText: '번역 중' }).waitFor();
  await page.locator('.translate-entry.is-busy').click();
  await page.locator('.translate-timeline').waitFor();
  await page.screenshot({ path: path.join(evidence, 'ask-progress.png') });
  await page.getByRole('button', { name: '닫기' }).first().dispatchEvent('click');

  /* ---------- ask: dismissal sticks for the episode ---------- */
  step = 'dismiss'; console.log('STEP', step);
  await watch('demo-3-e2');
  await offer.waitFor({ timeout: 15000 });
  await offer.getByRole('button', { name: '번역 제안 닫기' }).click();
  await watch('demo-3-e2');
  await quiet(4000);
  assert.equal(await offer.count(), 0, 'a dismissed suggestion does not come back');

  /* ---------- ask: an audio switch while the suggestion is up; accepting reads the new session's track ---------- */
  step = 'session switch'; console.log('STEP', step);
  await watch('anime', 6);
  await offer.waitFor({ timeout: 15000 });
  await offer.getByText(/일본어.*자막을 AI로 번역할까요/).waitFor();
  await subsPanel();
  await page.getByRole('button', { name: '영어', exact: true }).click(); // audio track: new playback session, old one retired
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await quiet(1500);
  if (await page.locator('.player-panel').count()) await page.getByRole('button', {name: '닫기'}).first().dispatchEvent('click');
  await offer.waitFor();
  await offer.getByRole('button', { name: '번역하기' }).click();
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.mode === 'showing' && [...(track.cues ?? [])].some(cue => cue.text.startsWith('[AI]'))), null, {timeout: 15000});
  assert.equal(await page.locator('.player-notice', {hasText: '번역된 부분부터'}).count(), 0);
  assert.equal(await page.evaluate(() => window.__moaStaleReads ?? 0), 0, 'the retired session\'s subtitle URL was not read');

  /* ---------- back to manual: no automatic work ---------- */
  step = 'manual menu'; console.log('STEP', step);
  await settings({ translationMode: 'manual' });
  await watch('demo-7-e2');
  await quiet(2500);
  assert.equal((await counters()).jobs, 0);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(evidence, `failed-${step.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  console.error(`failed at: ${step}`);
  console.error(JSON.stringify(await page.evaluate(() => ({
    settings: JSON.parse(sessionStorage.getItem('moa.mockTranslation') || '{}').settings,
    off: Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('moa.subtitlesOff'))),
    automatic: Object.fromEntries(Object.entries(sessionStorage).filter(([key])=>key.startsWith('moa.translationAuto'))),
    text: document.body.innerText.slice(0,1500), jobs: window.__moaJobsCreated
  }))));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
