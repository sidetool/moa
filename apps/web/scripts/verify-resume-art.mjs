import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAuthServer } from '../../../deploy/auth/server.mjs';
import { passwordHash } from '../../../deploy/auth/accounts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const db = new DatabaseSync(':memory:');
const password = 'local-fixture-password', salt = 'ab'.repeat(30);
const auth = createAuthServer({ database: db, credentials: { users: [{ username: 'viewer', salt, hash: await passwordHash(password, salt) }], csrfSecret: 'fixture' }, origin: 'http://localhost', allowAnyHost: true, secure: false });
let scratch;
try {
  await new Promise(resolve => auth.listen(0, '127.0.0.1', resolve));
  const authOrigin = `http://127.0.0.1:${auth.address().port}`;
  scratch = await mkdtemp(join(tmpdir(), 'moa-resume-scene-'));
  const path = process.env.MOA_TEST_VIDEO || join(scratch, 'sample.mp4');
  if (!process.env.MOA_TEST_VIDEO) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=240x136:rate=2', '-t', '210', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-movflags', '+faststart', path]);
  const bytes = await readFile(path);
  const context = await browser.newContext();
  // Forward the gateway's auth paths to an isolated production auth server. Keep the
  // browser's host, Origin, cookies, redirects and repeated Set-Cookie headers intact.
  await context.route('**/__moa/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const response = await fetch(authOrigin + url.pathname + url.search, {
      method: request.method(), headers: { ...await request.allHeaders(), host: url.host },
      body: request.postDataBuffer(), redirect: 'manual'
    });
    const headers = Object.fromEntries(response.headers);
    if (response.headers.has('set-cookie')) headers['set-cookie'] = response.headers.getSetCookie().join('\n');
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route(url => url.pathname === '/settings', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('</head>', '<meta name="moa-auth" content="enabled"></head>') });
  });
  await context.addInitScript(() => {
    localStorage.setItem('moa.profile', 'viewer');
    window.capturedPositions = [];
    // Keepalive is a fetch option, so the mock server needs a tag to identify the exit save.
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (init?.keepalive && init.method === 'POST' && new URL(input instanceof Request ? input.url : input, location.href).pathname === '/api/progress') {
        const headers = new Headers(init.headers);
        headers.set('x-test-exit-save', '1');
        return fetch(input, { ...init, headers });
      }
      return fetch(input, init);
    };
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
  const backdrop = picture + '#backdrop', episodeThumb = picture + '#episode';
  card.backdrop = backdrop;
  const settings = { autoplayNext: false, autoFetchSubtitles: false, recommendationsEnabled: false };
  let account = 'local', count = 0, mediaRequests = 0, revision = 0, kind = 'resume', thumb = episodeThumb;
  let heldSave, heldSettings;
  const isExitSave = request => request.headers()['x-test-exit-save'] === '1';
  let progress = { position: 28, duration: 210, completed: false, updatedAt: '2026-10-01T00:00:00.000Z' };
  await context.route('**/fixture/video.mp4', route => {
    mediaRequests++;
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range && { 'content-range': `bytes ${start}-${end}/${bytes.length}` }) } });
  });
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
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
      if (heldSave && isExitSave(route.request())) {
        heldSave.committed.resolve();
        await heldSave.ack.promise;
      } else {
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      return route.fulfill({ json: saved });
    }
    if (url === '/api/me') return route.fulfill({ json: { id: account, role: 'admin', permissions: [] } });
    if (url === '/api/profiles') return route.fulfill({ json: [{ id: 'viewer', name: '테스트' }] });
    if (url === '/api/settings') {
      if (route.request().method() === 'PATCH') Object.assign(settings, route.request().postDataJSON());
      else if (heldSettings) await heldSettings.promise;
      return route.fulfill({ json: settings });
    }
    if (url === '/api/media/' + mediaId) return route.fulfill({ json: { ...card, id: mediaId, seasons: [], playTarget: null } });
    if (url.endsWith('/markers')) return route.fulfill({ json: { status: 'unavailable' } });
    if (url === '/api/plugin-runtime' || url === '/api/sources') return route.fulfill({ json: [] });
    if (url === '/api/translation/config') return route.fulfill({ json: { enabled: false } });
    if (/\/preview$/.test(url)) errors.push('Unexpected scrub preview on Home');
    return route.fulfill({ status: 204 });
  });

  await page.goto(base);
  const image = page.locator('.landscape-card img');
  const waitForArt = src => page.waitForFunction(url => document.querySelector('.landscape-card img')?.getAttribute('src') === url, src);
  await image.waitFor({ timeout: 12_000 }).catch(async err => { throw new Error([err.message, errors.join(' '), diagnostics.slice(0, 12).join(' '), (await page.locator('body').innerText()).slice(0, 800)].join('\n')); });
  await waitForArt(episodeThumb);
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
    const finalSave = page.waitForResponse(response => isExitSave(response.request()));
    await page.getByRole('button', { name: '뒤로', exact: true }).click({ force: true });
    const confirmed = await (await finalSave).json();
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
  const settingsTab = await context.newPage();
  await settingsTab.goto(base + '/settings#tabs');
  const toggle = settingsTab.getByRole('switch', { name: '이어보기에 마지막 장면 표시', exact: true });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'existing profiles default to showing scenes');
  const setShowResumeScene = async value => {
    const response = settingsTab.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH');
    await toggle.click();
    assert.ok((await response).ok());
    assert.equal(settings.showResumeScene, value);
  };
  await setShowResumeScene(false);
  await waitForArt(backdrop); // An existing frame is hidden as soon as another tab saves the preference.
  const requests = mediaRequests;
  await setShowResumeScene(true);
  account = 'other';
  await page.reload();
  await waitForArt(episodeThumb);
  account = 'local';
  progress = { ...progress, position: 8, updatedAt: '2026-11-02T00:00:00.000Z' };
  await page.reload();
  await waitForArt(episodeThumb);
  kind = 'next'; thumb = '/unseen-episode.png';
  await page.reload();
  await waitForArt(backdrop);
  assert.equal(await page.locator('.landscape-card .card-progress').count(), 0);
  assert.equal(mediaRequests, requests);
  assert.equal(count, 3);
  // Disable in a second tab after the player captured a frame and left, before its progress response arrives.
  kind = 'resume'; thumb = episodeThumb;
  await page.reload();
  await waitForArt(episodeThumb);
  const playerReady = (tab = page) => tab.waitForFunction(() => {
    const v = document.querySelector('.player-video');
    return v && !v.paused && !v.seeking && v.readyState >= 2 && v.currentTime > 1;
  });
  const back = () => page.getByRole('button', { name: '뒤로', exact: true }).click({ force: true });
  const sceneKey = saved => 'moa.resumeScene:' + JSON.stringify([saved.updatedAt, account, 'viewer', episodeId, saved.position]);
  await page.locator('.landscape-card .card-frame').click();
  await playerReady();
  heldSave = { committed: Promise.withResolvers(), ack: Promise.withResolvers() };
  await back();
  await heldSave.committed.promise;
  assert.ok(await page.evaluate(() => window.capturedPositions.length > 0));
  const lateKey = sceneKey(progress);
  await setShowResumeScene(false);
  await waitForArt(backdrop);
  const afterLateSave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home');
  heldSave.ack.resolve();
  await afterLateSave;
  assert.equal(await page.evaluate(key => localStorage.getItem(key), lateKey), null);
  heldSave = undefined;

  // A cold player still saves progress while settings are pending, and after the opt-out is confirmed.
  await page.locator('.landscape-card .card-frame').click();
  await playerReady();
  heldSettings = Promise.withResolvers();
  await page.reload();
  await playerReady();
  const pausedSave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/progress' && !isExitSave(r.request()));
  await page.locator('.player-video').evaluate(v => v.pause());
  assert.ok((await pausedSave).ok());
  assert.deepEqual(await page.evaluate(() => window.capturedPositions), []);
  const settingsLoaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/settings');
  heldSettings.resolve();
  heldSettings = undefined;
  await settingsLoaded;
  await page.locator('.player-video').evaluate(v => v.play());
  await playerReady();
  const disabledExit = page.waitForResponse(r => isExitSave(r.request()));
  await back();
  const disabledProgress = await (await disabledExit).json();
  await waitForArt(backdrop);
  assert.deepEqual(await page.evaluate(() => window.capturedPositions), []);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), sceneKey(disabledProgress)), null);
  const frame = page.locator('.landscape-card .card-frame');
  await page.waitForFunction(position => document.querySelector('.landscape-card .card-frame')?.href.endsWith(`?t=${position}&resume=1`), Math.floor(disabledProgress.position));
  assert.equal(await page.locator('.landscape-card .card-progress').count(), 1);
  delete card.backdrop;
  await page.reload();
  await waitForArt(picture); // With the preference off, a poster outranks even a valid episode thumbnail.
  kind = 'next';
  await page.reload();
  await waitForArt(picture);
  assert.ok((await frame.getAttribute('href')).endsWith('?t=0'));
  assert.equal(await page.locator('.landscape-card .card-progress').count(), 0);
  card.backdrop = backdrop;
  kind = 'resume';
  await page.reload();
  await waitForArt(backdrop);
  await setShowResumeScene(true);
  await waitForArt(episodeThumb);
  // A new player's first settings read was already on the wire when another tab disabled scenes.
  const coldTab = await context.newPage();
  const requested = Promise.withResolvers(), release = Promise.withResolvers();
  await coldTab.route('**/api/settings', async route => {
    const snapshot = { ...settings };
    if (snapshot.showResumeScene) {
      requested.resolve();
      await release.promise;
    }
    await route.fulfill({ json: snapshot });
  });
  // This player loads subtitle preferences only after its full profile settings are available.
  const coldSettingsApplied = coldTab.waitForResponse(r => r.url().endsWith('/subtitles/preference'));
  await coldTab.goto(base + '/watch/' + encodeURIComponent(episodeId));
  await requested.promise;
  await playerReady(coldTab);
  await coldTab.evaluate(() => {
    window.addEventListener('storage', event => {
      if (event.key === 'moa.showResumeScene:viewer' && event.newValue === 'false') window.receivedOptOut = true;
    });
  });
  await setShowResumeScene(false);
  await coldTab.waitForFunction(() => window.receivedOptOut);
  release.resolve();
  await coldSettingsApplied;
  const coldPause = coldTab.waitForResponse(r => r.url().endsWith('/api/progress') && !isExitSave(r.request()));
  await coldTab.locator('.player-video').evaluate(v => v.pause());
  assert.ok((await coldPause).ok());
  const coldExit = coldTab.waitForResponse(r => isExitSave(r.request()));
  await coldTab.getByRole('button', { name: '뒤로', exact: true }).click({ force: true });
  const confirmedColdExit = await coldExit;
  assert.ok(confirmedColdExit.ok());
  assert.deepEqual(await coldTab.evaluate(() => window.capturedPositions), [], 'a stale enabled response cannot override a confirmed opt-out');
  const coldKey = sceneKey(await confirmedColdExit.json());
  assert.equal(await coldTab.evaluate(key => localStorage.getItem(key), coldKey), null);
  await coldTab.close();
  await waitForArt(backdrop);
  await setShowResumeScene(true);
  await waitForArt(episodeThumb);
  await settingsTab.close();

  // Re-enabling restores real, newly saved scene artwork.
  await frame.click();
  await playerReady();
  const enabledExit = page.waitForResponse(r => isExitSave(r.request()));
  await back();
  const enabledProgress = await (await enabledExit).json();
  await page.waitForFunction(key => {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    return saved.image && document.querySelector('.landscape-card img')?.src === saved.image;
  }, sceneKey(enabledProgress));

  const authTab = await context.newPage();
  const scenes = () => authTab.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('moa.resumeScene:')).length);
  const generation = () => authTab.evaluate(() => localStorage.getItem('moa.resumeSceneLogout'));
  const login = async () => {
    await authTab.getByLabel('아이디').fill('viewer');
    await authTab.locator('#password').fill(password);
    await authTab.getByRole('button', { name: '로그인', exact: true }).click();
    await authTab.waitForURL(base + '/');
    await authTab.locator('.landscape-card img').waitFor();
  };
  await authTab.goto(base + '/__moa/login');
  assert.ok(await scenes(), 'visiting the form alone preserves scenes');
  await login();
  assert.equal(await scenes(), 0, 'issuing a new session resets artwork even if the old session expired with no app open');

  const saveScene = async () => {
    await page.reload();
    await frame.click();
    await playerReady();
    const exit = page.waitForResponse(r => isExitSave(r.request()));
    await back();
    const saved = await (await exit).json();
    await page.waitForFunction(key => document.querySelector('.landscape-card img')?.src === JSON.parse(localStorage.getItem(key) || '{}').image && localStorage.getItem(key), sceneKey(saved));
  };
  const holdExit = async () => {
    await frame.click();
    await playerReady();
    heldSave = { committed: Promise.withResolvers(), ack: Promise.withResolvers() };
    await back();
    await heldSave.committed.promise;
    await image.waitFor();
  };
  const releaseExit = async () => {
    const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home');
    const response = page.waitForResponse(r => isExitSave(r.request()));
    heldSave.ack.resolve();
    assert.ok((await response).ok());
    await refreshed;
    heldSave = undefined;
    assert.equal(await scenes(), 0, 'a late player acknowledgement cannot recreate images from the old session');
  };
  await saveScene();
  await authTab.evaluate(() => localStorage.setItem('test.unrelated', 'keep'));
  await holdExit();
  await authTab.goto(base + '/__moa/account');
  await authTab.getByRole('button', { name: '이 브라우저에서 로그아웃' }).click();
  await authTab.waitForURL(base + '/__moa/login');
  assert.equal(await scenes(), 0);
  assert.equal(await authTab.evaluate(() => localStorage.getItem('moa.profile')), 'viewer');
  await releaseExit();
  await login();
  await saveScene();

  // Use real account-scoped device DELETEs, including a retryable failure in the same dialog.
  const owner = db.prepare("SELECT id FROM accounts WHERE username='viewer'").get().id;
  const addDevice = name => {
    const token = crypto.randomUUID(), id = crypto.randomUUID();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(token, owner, Date.now() + 3600000, Date.now(), 0);
    db.prepare('INSERT INTO session_devices(id,token_hash,name,created_at,last_seen) VALUES(?,?,?,?,?)').run(id, token, name, Date.now(), Date.now());
  };
  addDevice('다른 브라우저');
  addDevice('다른 TV');
  await authTab.goto(base + '/settings#account');
  const sessionGroup = authTab.locator('.settings-group').filter({ has: authTab.getByRole('heading', { name: '로그인 기기' }) });
  const deviceLogout = label => sessionGroup.locator('.setting').filter({ hasText: label }).getByRole('button', { name: '로그아웃', exact: true });
  const confirm = authTab.getByRole('dialog').getByRole('button', { name: '로그아웃', exact: true });
  const before = await generation();
  await deviceLogout('다른 TV').click();
  await confirm.click();
  await deviceLogout('다른 TV').waitFor({ state: 'detached' });
  await sessionGroup.getByRole('button', { name: '다른 기기 모두 로그아웃' }).click();
  await confirm.click();
  await deviceLogout('다른 브라우저').waitFor({ state: 'detached' });
  assert.equal(await generation(), before);
  assert.ok(await scenes());

  await holdExit();
  await deviceLogout('현재 기기').click();
  await authTab.route('**/__moa/api/sessions/*', route => route.fulfill({ status: 503, json: { error: 'temporarily-unavailable' } }), { times: 1 });
  await confirm.click();
  await authTab.getByRole('alert').filter({ hasText: '다시 시도' }).waitFor();
  assert.equal(await generation(), before);
  assert.ok(await scenes());
  await confirm.click();
  await authTab.waitForURL(base + '/__moa/login');
  assert.notEqual(await generation(), before);
  assert.equal(await scenes(), 0);
  await login();
  await releaseExit();
  assert.equal(await authTab.evaluate(() => localStorage.getItem('test.unrelated')), 'keep');
  await waitForArt(episodeThumb);

  // A remote session revocation is confirmed by the protected sessions endpoint on return.
  await saveScene();
  db.prepare('DELETE FROM sessions WHERE account_id=?').run(owner);
  await authTab.goto(base + '/settings#account');
  await authTab.waitForURL(url => url.pathname === '/__moa/login' && url.searchParams.get('next') === '/settings#account');
  assert.equal(await scenes(), 0);
  await waitForArt(episodeThumb);
  await authTab.goto(base + '/__moa/login');
  await login();
  assert.equal(await scenes(), 0);

  // If scripts were disabled throughout the native logout/login, the next app load
  // receives the uncleared marker even when it never visited the scripted login form.
  await authTab.evaluate(() => {
    localStorage.setItem('moa.resumeScene:old', 'previous');
    document.cookie = 'moa_scene_reset=9769a57d-dd70-4601-96c7-13fbd53dadfe; Path=/';
  });
  await page.reload();
  await image.waitFor();
  assert.equal(await scenes(), 0);
  assert.equal(await authTab.evaluate(() => document.cookie.includes('moa_scene_reset=')), false);
  assert.equal(await authTab.evaluate(() => localStorage.getItem('moa.profile')), 'viewer');
  assert.deepEqual(errors, []);
  console.log('Resume artwork verified for active Back, paused Back, nearby scene change, reload, account isolation, rewind and unseen next episode, disabling and re-enabling in another tab, pending and stale settings, progress with capture disabled, native and current-device logout, revocation failure/retry, other devices, remote revocation, reauthentication and delayed progress after logout.');
} finally {
  await browser.close();
  if (auth.listening) await new Promise(resolve => auth.close(resolve));
  db.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
