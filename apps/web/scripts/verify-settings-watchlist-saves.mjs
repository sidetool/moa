// Exercise overlapping profile saves and rejected watchlist actions against a routed loopback API.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(45000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('moa.profile')) localStorage.setItem('moa.profile', 'one');
    localStorage.setItem('moa.remoteMode', 'off');
  });
  const profileSettings = { one: { autoplayNext: true, hardwareTranscoding: false, preferredQuality: 'auto', shortsEnabled: true }, two: { autoplayNext: true, hardwareTranscoding: false, preferredQuality: 'auto' } };
  const devices = { one: {}, two: {} }, saved = new Set(), writes = [], watchWrites = [];
  const gates = new Map();
  // A gate pauses exactly one write until the browser has made the next selection.
  function hold(key) {
    const gate = Promise.withResolvers();
    gates.set(key, gate);
    return gate;
  }
  let failDevice = false, failWatchlist = false, failRead = false, failSettingsRead = false;
  await page.route(url => url.hostname !== '127.0.0.1', route => route.abort());
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    const profile = route.request().headers()['x-moa-profile'] ?? 'one';
    const json = value => route.fulfill({ json: value });
    const reject = () => route.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (path === '/api/me') return json({ id: 'test', username: 'Test', role: 'member' });
    if (path === '/api/profiles') return json(['one', 'two'].map(id => ({ id, name: id, color: 'blue' })));
    if (path === '/api/settings') {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON(), key = Object.keys(patch)[0];
        writes.push({ profile, patch });
        const gate = gates.get(key);
        gates.delete(key);
        if (gate && !(await gate.promise)) return reject();
        Object.assign(profileSettings[profile], patch);
      }
      if (route.request().method() === 'GET' && failSettingsRead) return reject();
      return json(profileSettings[profile]);
    }
    if (path === '/api/settings/device') {
      if (route.request().method() === 'PATCH') {
        if (failDevice) return reject();
        Object.assign(devices[profile], route.request().postDataJSON().settings);
      }
      return json({ settings: devices[profile] });
    }
    if (path === '/api/media/m/group') return json({ members: [] });
    if (path === '/api/media/m') {
      if (failRead) return reject();
      return json({ id: 'm', title: '영화', type: 'movie', provider: { id: 'local', name: 'Local', kind: 'local' }, seasons: [], inWatchlist: saved.has(profile) });
    }
    if (path === '/api/watchlist/m') {
      watchWrites.push(route.request().method());
      const gate = gates.get('watchlist');
      gates.delete('watchlist');
      if (gate) await gate.promise;
      if (failWatchlist) return reject();
      if (route.request().method() === 'PUT') saved.add(profile); else saved.delete(profile);
      return json({});
    }
    if (path === '/api/watchlist') return json(saved.has(profile) ? [{ id: 'm' }] : []);
    if (path === '/api/shorts') return json({ status: 'ready', items: [{ key: 'movie:1', title: '영화', category: 'movie', mediaId: 'm', href: '/title/m' }], nextCursor: null });
    if (path.endsWith('/trailers')) return json({ trailers: [], checked: true });
    if (path === '/api/home') return json({ hero: [], rows: [] });
    return json([]);
  });
  const base = server.resolvedUrls.local[0];
  await page.goto(base + 'settings#playback', { waitUntil: 'domcontentloaded' });
  const toggle = (name, checked) => page.getByRole('switch', { name, exact: true, checked });
  const retry = () => page.getByRole('alert').getByRole('button', { name: '다시 시도' }).click();
  const first = hold('autoplayNext'), second = hold('hardwareTranscoding');
  await toggle('다음 화 자동 재생', true).click();
  await toggle('다음 화 자동 재생', false).waitFor();
  await toggle('하드웨어 변환', false).click();
  await toggle('하드웨어 변환', true).waitFor();
  first.resolve(false);
  await page.getByRole('alert').waitFor();
  await toggle('다음 화 자동 재생', true).waitFor();
  assert.equal(await toggle('하드웨어 변환', true).count(), 1);
  second.resolve(true);
  await retry();
  await toggle('다음 화 자동 재생', false).waitFor();
  const deviceGate = page.waitForResponse(response => response.url().endsWith('/settings/device') && response.status() === 503);
  failDevice = true;
  await toggle('화면 채우기', false).click();
  await deviceGate;
  await page.getByText('이 기기에 적용했지만 서버에 저장하지 못했어요.', { exact: false }).waitFor();
  assert.equal(await toggle('화면 채우기', true).count(), 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moa.deviceSettings:one')).dirty.videoFill), true);
  failDevice = false;
  await retry();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('moa.deviceSettings:one')).dirty === null);
  assert.equal(devices.one.videoFill, true);
  assert.equal(profileSettings.one.autoplayNext, false);
  assert.equal(profileSettings.one.hardwareTranscoding, true);

  // Two changes to the same field. The earlier failure cannot reset the later choice or offer a stale retry.
  const older = hold('preferredQuality');
  const quality = page.getByRole('combobox', { name: 'preferredQuality' });
  await quality.click();
  await page.getByRole('option', { name: '720p' }).click();
  await quality.click();
  await page.getByRole('option', { name: '480p' }).click();
  const savedQuality = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH' && r.ok());
  older.resolve(false);
  await savedQuality;
  assert.equal(await quality.textContent(), '480p');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(profileSettings.one.preferredQuality, '480');

  // Both attempts fail and the follow-up GET fails too. The baseline is the last confirmed value.
  const firstFailure = hold('preferredQuality');
  const attempted = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PATCH');
  await quality.click();
  await page.getByRole('option', { name: '720p' }).click();
  await attempted;
  const lastFailure = hold('preferredQuality');
  await quality.click();
  await page.getByRole('option', { name: '1080p' }).click();
  failSettingsRead = true;
  firstFailure.resolve(false);
  lastFailure.resolve(false);
  await page.getByRole('alert').waitFor();
  assert.equal(await quality.textContent(), '480p');
  failSettingsRead = false;
  const recovered = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH' && r.ok());
  await retry();
  await recovered;
  assert.equal(profileSettings.one.preferredQuality, '1080');

  // Selecting a different profile clears the query client while an earlier write is still outstanding.
  const previousProfile = hold('autoplayNext');
  await toggle('다음 화 자동 재생', false).click();
  await toggle('다음 화 자동 재생', true).waitFor();
  const navigate = path => page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await navigate('/profiles');
  await page.getByRole('button', { name: 'two', exact: true }).click();
  await navigate('/settings#playback');
  await toggle('다음 화 자동 재생', true).waitFor();
  const previousRejected = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.status() === 503);
  previousProfile.resolve(false);
  await previousRejected;
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.ok(writes.every(write => write.profile === 'one'));
  assert.equal(await toggle('하드웨어 변환', false).count(), 1);

  await navigate('/title/m');
  const watchlist = pressed => page.locator('.hero-actions button[aria-pressed="' + pressed + '"]');
  await watchlist(false).waitFor();
  const attemptWithKeyboard = async button => {
    const gate = hold('watchlist');
    await button.focus();
    await page.keyboard.press('Enter');
    const pending = page.locator('button[aria-disabled="true"][aria-pressed]');
    await pending.waitFor();
    assert.ok(await pending.evaluate(el => el === document.activeElement && !el.disabled));
    await page.keyboard.press('Enter');
    gate.resolve();
  };
  const retryWatchlist = async () => {
    const button = page.getByRole('button', { name: '내 목록 변경 다시 시도' });
    assert.ok(await button.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Enter');
  };
  for (const add of [true, false]) {
    failWatchlist = true;
    failRead = true;
    await attemptWithKeyboard(watchlist(!add));
    await page.getByRole('alert').filter({ hasText: add ? '추가하지 못했어요' : '빼지 못했어요' }).waitFor();
    assert.equal(await watchlist(!add).count(), 1);
    failWatchlist = false;
    failRead = false;
    await retryWatchlist();
    await watchlist(add).waitFor();
    await page.waitForFunction(() => document.querySelector('.hero-actions button[aria-pressed]').getAttribute('aria-disabled') !== 'true');
    assert.ok(await watchlist(add).evaluate(el => el === document.activeElement));
    assert.equal(saved.has('two'), add);
  }

  assert.deepEqual(watchWrites, ['PUT', 'PUT', 'DELETE', 'DELETE']);

  // A rejected enable is recoverable on the Shorts landing page.
  const enable = hold('shortsEnabled');
  await navigate('/shorts');
  await page.getByRole('button', { name: '켜기' }).click();
  enable.resolve(false);
  await retry();
  await page.getByRole('feed', { name: '쇼츠' }).waitFor();
  failWatchlist = true;
  await attemptWithKeyboard(page.getByRole('button', { name: '내 목록에 추가' }));
  await page.getByRole('alert').filter({ hasText: '추가하지 못했어요' }).waitFor();
  failWatchlist = false;
  await retryWatchlist();
  const savedButton = page.getByRole('button', { name: '내 목록에서 빼기', pressed: true, disabled: false });
  await savedButton.waitFor();
  assert.ok(await savedButton.evaluate(el => el === document.activeElement));
  assert.deepEqual(watchWrites.slice(4), ['PUT', 'PUT']);
  assert.deepEqual(errors, []);
  console.log('PASS profile save overlap, same-field retry, dirty device recovery, profile switch, detail add/remove and Shorts retry');
} finally {
  await browser?.close();
  await server.close();
}
