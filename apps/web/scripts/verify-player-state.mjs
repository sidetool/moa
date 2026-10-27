import { verificationPath } from './verification-path.mjs';
// Browser regression checks with local video and intercepted API responses.
// MOA_VERIFY_URL must serve a real (VITE_MOCK unset) web build or Vite server.
// MOA_TEST_VIDEO must point to a locally generated 600-second MP4.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_VERIFY_URL || 'http://127.0.0.1:5181';
const videoBytes = await readFile(process.env.MOA_TEST_VIDEO);
const output = process.env.MOA_VERIFY_OUTPUT || verificationPath('verification-player-state');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const settings = { autoplayNext: true, autoplayDelay: 5, defaultSubtitleLang: 'ko', subtitleSize: 'medium', preferredQuality: 'auto', hardwareTranscoding: true, autoFetchSubtitles: true };
const track = { id: 'ja', label: '일본어 (파일)', lang: 'ja', format: 'vtt', url: '/fixture/subtitle.vtt', default: true };

async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: Boolean(options.mobile), isMobile: Boolean(options.mobile) });
  await context.addInitScript(() => localStorage.setItem('moa.profile', 'ui-test'));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const calls = { searches: [], applies: [], sessions: [] };
  const preferences = new Map(), titleChoices = new Map();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/fixture/video.mp4', route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return route.fulfill({ contentType: 'video/mp4', body: videoBytes, headers: { 'Accept-Ranges': 'bytes' } });
    const start = Number(range[1]), end = Math.min(videoBytes.length - 1, range[2] ? Number(range[2]) : videoBytes.length - 1);
    return route.fulfill({ status: 206, contentType: 'video/mp4', body: videoBytes.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${videoBytes.length}` } });
  });
  await context.route('**/fixture/subtitle.vtt', route => route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n자막 확인\n' }));
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = body => route.fulfill({ json: body }).catch(() => {});
    if (path === '/api/me') return json({ role: 'admin' });
    if (path === '/api/plugin-runtime') return json([]);
    if (path.endsWith('/markers')) return json({ status: 'matched', markers: { introStart: 20, introEnd: 80, creditsStart: 480, creditsEnd: 540 } });
    if (path.endsWith('/subtitles/preference')) {
      const episode = path.split('/')[3], media = episode === 'e3' ? 'm2' : 'm1';
      if (req.method() === 'PUT') { const { choice } = req.postDataJSON(); preferences.set(episode, choice); titleChoices.set(media, choice); }
      return json(preferences.has(episode) ? { choice: preferences.get(episode) } : titleChoices.get(media) === null ? { choice: null } : {});
    }
    if (path === '/api/settings') { await options.settingsGate?.promise; return json({ ...settings, ...options.settings }); }
    if (path === '/api/playback' && req.method() === 'POST') {
      const { episodeId } = req.postDataJSON(); calls.sessions.push(episodeId);
      if (episodeId === 'e2') await options.nextGate?.promise;
      return json({ sessionId: `s-${episodeId}`, episodeId, mediaId: episodeId === 'e3' ? 'm2' : 'm1', mediaTitle: '플레이어 검증', mediaType: 'anime', episodeLabel: episodeId === 'e1' ? 'S1:E1' : 'S1:E2', episodeTitle: episodeId === 'e1' ? '첫 번째 회차' : '두 번째 회차', mode: 'direct', url: '/fixture/video.mp4', mime: 'video/mp4', duration: 600, startPosition: 0, audioTracks: [{ id: 'a1', label: '일본어', default: true }], subtitles: [track], next: episodeId === 'e1' ? { episodeId: 'e2', title: '두 번째 회차', label: 'S1:E2' } : null, markers: { introStart: 20, introEnd: 80, creditsStart: 480, creditsEnd: 540 } });
    }
    if (path.includes('/subtitles/online')) {
      const episode = path.split('/')[3];
      if (req.method() === 'GET') {
        calls.searches.push(episode); await options.searchGate?.promise;
        return json({ searchId: `search-${episode}`, resolvedTitle: '플레이어 검증', candidates: [{ id: 'c1', creatorName: '검증 제작자', sourceUrl: 'https://example.com', filename: '01.vtt', format: 'vtt', matchedEpisode: 1, confidence: 0.95 }], partial: false, expiresAt: Date.now() + 60000 });
      }
      calls.applies.push(episode); await options.applyGate?.promise;
      return json({ ...track, id: `ko-${episode}`, lang: 'ko', label: `${episode} 한국어`, source: 'online', provenance: { creatorName: '검증 제작자', sourceUrl: 'https://example.com' } });
    }
    if (path === '/api/media/m1') return json({ id: 'm1', title: '플레이어 검증', type: 'anime', provider: { id: 'local', name: '로컬', kind: 'local' }, seasons: [{ number: 1, episodes: [{ id: 'e1', number: 1, title: '첫 번째 회차' }, { id: 'e2', number: 2, title: '두 번째 회차' }] }] });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${base}/watch/e1`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2).catch(async error => {
    console.error(await page.evaluate(() => ({ url: location.href, text: document.body.innerText, video: document.querySelector('video')?.currentSrc })), calls, errors);
    throw error;
  });
  const panel = page.getByRole('dialog', { name: '자막 및 음성' });
  const open = async () => { await page.mouse.move(200, 200); await page.getByRole('button', { name: '자막 및 음성', exact: true }).click(); await panel.waitFor(); };
  const off = () => panel.getByRole('button', { name: '끄기', exact: true });
  const close = async () => { for (const value of Object.values(options)) value?.release?.(); await context.close(); console.log(`PASS: ${results.at(-1)}`); };
  return { page, context, calls, panel, open, off, close };
}

try {
  {
    const settingsGate = gate();
    const f = await fixture({ settingsGate, settings: { defaultSubtitleLang: 'off' } });
    await sleep(400); assert.equal(f.calls.searches.length, 0, 'Search must wait for settings');
    settingsGate.release(); await f.open(); await sleep(500);
    assert.match(await f.off().getAttribute('class'), /is-active/);
    assert.equal(f.calls.searches.length, 0, 'Off must prevent automatic subtitle search');
    results.push('Delayed settings: subtitles off stays off, no automatic search'); await f.close();
  }
  {
    const searchGate = gate(); const f = await fixture({ searchGate });
    await until(() => f.calls.searches.length > 0, 'search started');
    await f.open(); await f.off().click(); searchGate.release();
    await f.panel.getByRole('button', { name: /검증 제작자/ }).waitFor(); await sleep(300);
    assert.equal(f.calls.applies.length, 0); assert.match(await f.off().getAttribute('class'), /is-active/);
    results.push('Manual off during search survives late search results'); await f.close();
  }
  {
    const applyGate = gate(); const f = await fixture({ applyGate });
    await until(() => f.calls.applies.length > 0, 'apply started');
    await f.open(); await f.off().click(); applyGate.release(); await sleep(500);
    assert.match(await f.off().getAttribute('class'), /is-active/);
    assert.equal(await f.page.locator('.player-notice').count(), 0);
    results.push('Manual off during apply survives late subtitle download'); await f.close();
  }
  {
    const searchGate = gate(); const f = await fixture({ searchGate });
    await f.open(); await f.off().click();
    await f.panel.getByRole('button', { name: '닫기', exact: true }).click();
    await f.page.getByRole('button', { name: '다음 화 (N)', exact: true }).click();
    await f.page.waitForURL('**/watch/e2');
    await f.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    searchGate.release(); await f.open();
    assert.match(await f.off().getAttribute('class'), /is-active/);
    assert.equal(f.calls.searches.includes('e2'), false, 'Disabled title never starts automatic lookup');
    await f.page.reload(); await f.open();
    assert.match(await f.off().getAttribute('class'), /is-active/);
    assert.equal(f.calls.searches.includes('e2'), false, 'Choice survives reload');
    await f.page.goto(base+'/watch/e3');
    await until(() => f.calls.applies.includes('e3'), 'Other title uses its usual subtitles');
    await f.page.goto(base+'/watch/e2'); await f.open();
    assert.match(await f.off().getAttribute('class'), /is-active/);
    await f.panel.getByRole('button', { name: '일본어 (파일)' }).click();
    await f.page.reload();
    await f.open();
    assert.match(await f.panel.getByRole('button', { name: '일본어 (파일)' }).getAttribute('class'), /is-active/);
    await f.page.goto(base+'/watch/e4');
    await until(() => f.calls.applies.includes('e4'), 'Explicit subtitle selection clears title off preference for another episode');
    results.push('Title subtitle off survives next/reload, isolates other titles and clears on manual enable'); await f.close();
  }
  {
    const searchGate = gate(), nextGate = gate(); const f = await fixture({ searchGate, nextGate });
    await f.open(); await f.panel.getByRole('button', { name: '일본어 (파일)' }).click();
    await f.panel.getByRole('button', { name: /자막 설정/ }).click();
    await f.panel.getByRole('button', { name: '+0.5', exact: true }).click();
    await f.panel.getByRole('button', { name: '닫기', exact: true }).click();
    await f.page.getByRole('button', { name: '다음 화 (N)', exact: true }).click();
    await f.page.waitForURL('**/watch/e2');
    await until(() => f.calls.sessions.includes('e2'), 'new episode session requested');
    assert.equal(await f.page.locator('.player-title').innerText(), '');
    nextGate.release(); await f.page.getByText('S1:E2 두 번째 회차', { exact: true }).waitFor();
    searchGate.release(); await until(() => f.calls.applies.includes('e2'), 'second episode subtitles');
    await f.open(); await f.panel.getByRole('button', { name: 'e2 한국어' }).waitFor();
    assert.equal(f.calls.applies.includes('e1'), false);
    await f.panel.getByRole('button', { name: /자막 설정/ }).click();
    assert.match(await f.panel.locator('.sync-value').innerText(), /^0\.0초$/);
    results.push('Next episode resets state and ignores old episode subtitle results'); await f.close();
  }
  {
    const f = await fixture({ settings: { autoFetchSubtitles: false }, mobile: true });
    await f.page.locator('video').evaluate(v => { v.currentTime = 490; });
    await f.page.getByRole('button', { name: '엔딩 건너뛰기', exact: true }).waitFor().catch(async error => {
      console.error(await f.page.locator('video').evaluate(v => ({ time: v.currentTime, duration: v.duration, ready: v.readyState, error: v.error?.message })), await f.page.locator('.player').innerText());
      throw error;
    });
    assert.equal(await f.page.getByRole('dialog', { name: '다음 화', exact: true }).count(), 0);
    await f.page.screenshot({ path: `${output}/mobile-ending.png` });
    await f.page.getByRole('button', { name: '엔딩 건너뛰기', exact: true }).click();
    await until(() => f.page.locator('video').evaluate(v => v.currentTime >= 540 && v.currentTime < 545), 'credits end seek');
    await f.open(); await f.page.locator('video').evaluate(v => { v.currentTime = 587; });
    await f.page.getByRole('dialog', { name: '다음 화', exact: true }).waitFor();
    await sleep(3100);
    assert.equal(await f.page.locator('.next-countdown').count(), 0);
    assert.match(await f.page.locator('.player').getAttribute('class'), /is-chrome/);
    await f.page.screenshot({ path: `${output}/mobile-subtitles.png` });
    await f.panel.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await f.page.locator('.next-countdown').count(), 0, 'closing the panel keeps the dismissed countdown stopped');
    results.push('Post-credits content preserved; an open panel and interaction stop next-up'); await f.close();
  }
  {
    const f = await fixture({ settings: { autoFetchSubtitles: false }, mobile: true });
    await f.page.locator('video').evaluate(v => { v.currentTime = 587; void v.play(); });
    await f.page.locator('.next-countdown').waitFor();
    await f.page.locator('video').evaluate(v => v.dispatchEvent(new Event('waiting')));
    await until(async () => await f.page.locator('.next-countdown').count() === 0, 'buffering pauses countdown');
    results.push('Buffering pauses an active next-up countdown'); await f.close();
  }
  for (const automatic of [false, true]) {
    const nextGate = gate();
    const f = await fixture({ mobile: true, nextGate, settings: { autoFetchSubtitles: false, autoplayDelay: 1 } });
    await f.page.evaluate(() => {
      window.fullscreenEvents = [];
      window.fullscreenHost = document.querySelector('.watch-fullscreen-host');
      document.addEventListener('fullscreenchange', () => window.fullscreenEvents.push(Boolean(document.fullscreenElement)));
    });
    await f.page.getByRole('button', { name: '전체 화면 (F)', exact: true }).click();
    await f.page.waitForFunction(() => document.fullscreenElement === window.fullscreenHost);
    if (automatic) {
      await f.page.locator('video').evaluate(v => { v.currentTime = 590; void v.play(); });
    } else {
      await f.page.getByRole('button', { name: '다음 화 (N)', exact: true }).click();
    }
    await f.page.waitForURL('**/watch/e2');
    await until(() => f.calls.sessions.includes('e2'), 'next fullscreen episode loading');
    assert.equal(await f.page.evaluate(() => document.fullscreenElement === window.fullscreenHost), true);
    nextGate.release();
    await f.page.getByText('S1:E2 두 번째 회차', { exact: true }).waitFor();
    await f.page.waitForFunction(() => document.querySelector('video')?.currentTime > 0);
    assert.deepEqual(await f.page.evaluate(() => window.fullscreenEvents), [true], 'No exit or re-entry between episodes');
    assert.equal(await f.page.evaluate(() => document.fullscreenElement === window.fullscreenHost), true);
    await f.page.mouse.move(200, 200);
    await f.page.getByRole('button', { name: '전체 화면 (F)', exact: true }).click();
    await f.page.waitForFunction(() => !document.fullscreenElement);
    results.push(`${automatic ? 'Automatic' : 'Manual'} next episode preserves real fullscreen through loading and playback`);
    await f.close();
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, output }, null, 2));
} finally { await browser.close(); }
