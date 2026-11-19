import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
let scratch;
try {
  scratch = await mkdtemp(join(tmpdir(), 'moa-resume-scene-'));
  const path = process.env.MOA_TEST_VIDEO || join(scratch, 'sample.mp4');
  if (!process.env.MOA_TEST_VIDEO) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=240x136:rate=2', '-t', '210', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-movflags', '+faststart', path]);
  const bytes = await readFile(path);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('moa.profile', 'viewer');
    window.capturedPositions = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      if (source instanceof HTMLVideoElement && source.classList.contains('player-video')) window.capturedPositions.push(source.currentTime);
      return draw.call(this, source, ...args);
    };
  });
  const page = await context.newPage();
  const errors = [], diagnostics = [];
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) diagnostics.push(response.status() + ' ' + response.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const episodeId = 'watched-edition:1', mediaId = 'watched-edition';
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aakMAAAAASUVORK5CYII=';
  const card = { id: 'representative', title: '합성 시리즈', type: 'series', provider: { id: 'local', kind: 'local', name: '로컬' }, poster: picture };
  let account = 'local', count = 0, mediaRequests = 0, revision = 0, kind = 'resume', thumb = picture;
  let progress = { position: 28, duration: 210, completed: false, updatedAt: '2026-10-01T00:00:00.000Z' };
  await page.route('**/fixture/video.mp4', route => {
    mediaRequests++;
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range && { 'content-range': `bytes ${start}-${end}/${bytes.length}` }) } });
  });
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()).pathname;
    if (url === '/api/home') return route.fulfill({ json: { hero: [], rows: [{ id: 'continue', kind: 'continue', title: '이어보기', layout: 'landscape', items: [{ ...card, resume: { episodeId, position: kind === 'resume' ? progress.position : 0, label: '이어보기', kind, updatedAt: progress.updatedAt, thumb }, ...(kind === 'resume' && { progress: { episodeId, ratio: progress.position / progress.duration, label: '1화' } }) }] }] } });
    if (url === '/api/playback' && route.request().method() === 'POST') {
      count++;
      return route.fulfill({ json: { sessionId: 'session-' + count, episodeId, mediaId, mediaTitle: card.title, mediaType: 'series', mode: 'direct', mime: 'video/mp4', url: '/fixture/video.mp4', duration: 210, startPosition: progress.position, subtitles: [], audioTracks: [] } });
    }
    if (url === '/api/progress') {
      const { duration, position } = route.request().postDataJSON();
      progress = { duration, position, completed: false, updatedAt: new Date(Date.UTC(2026, 10, 1) + ++revision).toISOString() };
      // Another Home read can observe the committed revision before this HTTP acknowledgement arrives.
      const saved = { ...progress };
      await new Promise(resolve => setTimeout(resolve, 750));
      return route.fulfill({ json: saved });
    }
    if (url === '/api/me') return route.fulfill({ json: { id: account, role: 'admin', permissions: [] } });
    if (url === '/api/profiles') return route.fulfill({ json: [{ id: 'viewer', name: '테스트' }] });
    if (url === '/api/settings') return route.fulfill({ json: { autoplayNext: false, autoFetchSubtitles: false, recommendationsEnabled: false } });
    if (url === '/api/media/' + mediaId) return route.fulfill({ json: { ...card, id: mediaId, seasons: [], playTarget: null } });
    if (url.endsWith('/markers')) return route.fulfill({ json: { status: 'unavailable' } });
    if (url === '/api/plugin-runtime' || url === '/api/sources') return route.fulfill({ json: [] });
    if (url === '/api/translation/config') return route.fulfill({ json: { enabled: false } });
    if (/\/preview$/.test(url)) errors.push('Unexpected scrub preview on Home');
    return route.fulfill({ status: 204 });
  });

  await page.goto(base);
  const image = page.locator('.landscape-card img');
  await image.waitFor({ timeout: 12_000 }).catch(async err => { throw new Error([err.message, errors.join(' '), diagnostics.slice(0, 12).join(' '), (await page.locator('body').innerText()).slice(0, 800)].join('\n')); });
  assert.equal(await image.getAttribute('src'), picture);
  assert.equal(count + mediaRequests, 0);
  // In-page Back during active playback and after a manual pause both preserve a real decoded frame.
  for (const mode of ['playing', 'paused', 'resumed']) {
    await page.locator('.landscape-card .card-frame').click();
    await page.waitForFunction(() => { const v = document.querySelector('.player-video'); return v && !v.paused && !v.seeking && v.readyState >= 2 && v.currentTime > 26; });
    let pausedAt;
    if (mode !== 'playing') {
      pausedAt = await page.locator('.player-video').evaluate(video => { video.pause(); return video.currentTime; });
      await page.waitForFunction(at => window.capturedPositions.includes(at), pausedAt);
    }
    if (mode === 'resumed') {
      await page.locator('.player-video').evaluate(video => video.play());
      await page.waitForFunction(at => document.querySelector('.player-video').currentTime >= at + .3, pausedAt);
    }
    const finalSave = page.waitForRequest(request => new URL(request.url()).pathname === '/api/progress');
    await page.getByRole('button', { name: '뒤로', exact: true }).click({ force: true });
    const confirmed = await (await (await finalSave).response()).json();
    await page.waitForFunction(({ episodeId, confirmed }) => {
      const key = 'moa.resumeScene:' + JSON.stringify([confirmed.updatedAt, 'local', 'viewer', episodeId, confirmed.position]);
      const scene = JSON.parse(localStorage.getItem(key) || '{}').image;
      return scene && document.querySelector('.landscape-card img')?.src === scene;
    }, { episodeId, confirmed }, { timeout: 8000 }).catch(async error => {
      const view = await page.evaluate(() => ({
        at: location.pathname, captured: window.capturedPositions, images: Object.keys(localStorage).filter(key => key.startsWith('moa.resumeScene:')),
        shown: document.querySelector('.landscape-card img')?.src.slice(0, 30)
      }));
      throw new Error(`${mode}: ${JSON.stringify({ progress, view, errors })} (${error.message})`);
    });
    assert.equal(await page.locator('video').count(), 0);
    if (mode === 'resumed') {
      const last = await page.evaluate(() => window.capturedPositions.at(-1));
      assert.ok(last > pausedAt && last - pausedAt < 2, 'a fresh frame replaces the paused image even across a sub-two-second scene change');
      assert.ok(Math.abs(last - progress.position) < .1);
    }
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.landscape-card img')?.src.startsWith('data:image/jpeg;'));
  const requests = mediaRequests;
  account = 'other';
  await page.reload();
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), picture);
  account = 'local';
  progress = { ...progress, position: 8, updatedAt: '2026-11-02T00:00:00.000Z' };
  await page.reload();
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), picture);
  kind = 'next'; thumb = '/unseen-episode.png';
  await page.reload();
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), picture);
  assert.equal(await page.locator('.landscape-card .card-progress').count(), 0);
  assert.equal(mediaRequests, requests);
  assert.equal(count, 3);
  assert.deepEqual(errors, []);
  console.log('Resume artwork verified for active Back, paused Back, nearby scene change, reload, account isolation, rewind and unseen next episode.');
} finally {
  await browser.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
