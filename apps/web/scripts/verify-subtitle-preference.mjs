import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const video = await readFile(process.env.MOA_TEST_VIDEO);
process.env.VITE_MOCK = '0';
const server = await createServer({ configFile: false, plugins: [react()], root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
let session = 0, resolved = 0, reordered = false, resolveGate, preferenceGate, deviceReplayGate, recommendation, retentionDays = 90, failDeviceSave = false;
const lookups = [], errors = [], preferences = new Map(), profileSettings = new Map(), deviceSettings = new Map();
const upload = () => ({ id: 'upload-stable', source: 'upload', label: '선택한 파일.srt', format: 'vtt', url: `/fixture/upload-${++resolved}.vtt` });
const translated = () => ({ id: 'translation-stable', source: 'translation', label: '한국어 · AI 번역', lang: 'ko', format: 'vtt', url: `/fixture/translation-${++resolved}.vtt` });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => { if (!localStorage.getItem('moa.profile')) localStorage.setItem('moa.profile', 'first'); localStorage.setItem('moa.fullscreenOnPlay', '0'); });
  const videoFixture = route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] || 0), end = Math.min(video.length - 1, range?.[2] ? Number(range[2]) : video.length - 1);
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: video.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
  };
  const subtitleFixture = route => route.fulfill({ contentType: 'text/vtt', body: `WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n${new URL(route.request().url()).pathname}\n` });
  const apiFixture = async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = body => route.fulfill({ json: body });
    if (pathname.endsWith('/subtitles/preference')) {
      const key = request.headers()['x-moa-profile'] + pathname;
      if (request.method() === 'PUT') preferences.set(key, request.postDataJSON().choice);
      const result = preferences.has(key) ? {choice:preferences.get(key)} : recommendation ? { recommendation } : {};
      if (request.method() === 'GET') await preferenceGate;
      return json(result);
    }
    if (pathname === '/api/settings/device') {
      if (request.method() === 'PATCH' && failDeviceSave) return route.fulfill({ status: 503, json: { error: 'fixture-offline' } });
      const key = request.headers()['x-moa-profile'] + ':' + request.headers()['x-moa-device'];
      assert.match(request.headers()['x-moa-device'], /^[0-9a-f-]{36}$/i);
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON();
        const gate = deviceReplayGate; deviceReplayGate = undefined;
        await gate;
        if (!body.migrate || !deviceSettings.has(key)) deviceSettings.set(key, { ...deviceSettings.get(key), ...body.settings });
      }
      return json({ settings: deviceSettings.get(key) ?? null });
    }
    if (pathname === '/api/settings') {
      const profile = request.headers()['x-moa-profile'];
      if (request.method() === 'PATCH') profileSettings.set(profile, { ...profileSettings.get(profile), ...request.postDataJSON() });
      return json({ defaultSubtitleLang: 'ja', subtitleSize: 'medium', autoFetchSubtitles: false, autoplayNext: false, translationMode: 'manual', ...profileSettings.get(profile) });
    }
    if (pathname === '/api/admin/updates') return json({ mode: 'none', state: 'unsupported', current: 'fixture', restartRequired: false, available: false });
    if (pathname === '/api/admin/subtitles') return json([]);
    if (pathname === '/api/admin/subtitle-memory') {
      if (request.method() === 'PATCH') retentionDays = request.postDataJSON().retentionDays;
      if (request.method() === 'DELETE') preferences.clear();
      return json({ retentionDays, count: preferences.size });
    }
    if (pathname === '/api/profiles') return json([{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }]);
    if (pathname === '/api/me') return json({ role: 'admin' });
    if (pathname === '/api/plugin-runtime' || pathname === '/api/plugins' || pathname === '/api/sources') return json([]);
    if (pathname === '/api/translation/config') return json({ configured: false, enabled: false });
    if (pathname.endsWith('/markers')) return json({ markers: null, status: 'unavailable' });
    if (pathname.endsWith('/subtitles/uploads') || pathname.endsWith('/subtitles/translations')) {
      lookups.push(pathname);
      if (pathname.endsWith('/uploads')) await resolveGate;
      const episode = pathname.split('/')[3];
      return json(episode === 'e1' ? [pathname.endsWith('/uploads') ? upload() : translated()] : []);
    }
    if (pathname === '/api/playback' && request.method() === 'POST') {
      const { episodeId } = request.postDataJSON();
      session++;
      const originals = [{ id: `extension-${reordered ? 1 : 0}`, source: 'extension', label: 'English', lang: 'en', format: 'vtt', url: `/fixture/english-${session}.vtt` }, { id: `extension-${reordered ? 0 : 1}`, source: 'extension', label: '日本語', lang: 'ja', format: 'vtt', url: `/fixture/japanese-${session}.vtt` }];
      return json({ sessionId: `session-${session}`, episodeId, mediaId: episodeId === 'e1' ? 'm1' : 'm2', mediaTitle: '선택 기억 검증', mediaType: 'anime', mode: 'direct', mime: 'video/mp4', url: '/fixture/video.mp4', duration: 600, markers: {introStart:15,introEnd:85,creditsStart:490,creditsEnd:560,source:'aniskip'}, startPosition: 0, subtitles: [...originals, ...(episodeId === 'e1' ? [upload(), translated()] : [])], audioTracks: [], streams: [{ id: 'a', label: '서버 A' }] });
    }
    if (pathname.endsWith('/context')) return json({ mediaId: pathname.includes('/e1/') ? 'm1' : 'm2', season: 1, number: pathname.includes('/e3/') ? 2 : 1 });
    if (pathname.endsWith('/group')) return json({ members: [{ id: 'm1', provider: { name: '소스 A' } }, { id: 'm2', provider: { name: '소스 B' } }] });
    if (pathname.startsWith('/api/media/')) return json({ id: pathname.split('/').at(-1), title: '선택 기억 검증', type: 'anime', provider: { id: 'local', name: '로컬', kind: 'local' }, seasons: [{ number: 1, episodes: [{ id: 'e2', season: 1, number: 1, title: '같은 회차' }, { id: 'e3', season: 1, number: 2, title: '다른 회차' }] }] });
    return route.fulfill({ status: 204 });
  };
  const fixtures = async target => {
    await target.route('**/fixture/video.mp4', videoFixture);
    await target.route('**/fixture/*.vtt', subtitleFixture);
    await target.route(url => url.pathname.startsWith('/api/'), apiFixture);
  };
  await fixtures(page);
  const base = server.resolvedUrls.local[0];
  const ready = async () => { await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2); await page.locator('video').evaluate(element => element.pause()); };
  const open = async () => { await page.mouse.move(100, 100); await page.getByRole('button', { name: '자막 및 음성', exact: true }).click(); };
  const close = () => page.getByRole('button', { name: '닫기', exact: true }).click();
  const selected = label => page.waitForFunction(label => [...document.querySelectorAll('.panel-subs .opt.is-active')].some(element => element.textContent.includes(label)), label);
  const shown = part => page.waitForFunction(part => document.querySelector('track')?.src.includes(part), part);
  const toSource = async otherEpisode => {
    await page.mouse.move(100, 100);
    await page.getByRole('button', { name: '재생 설정', exact: true }).click();
    await page.getByRole('button', { name: '다른 소스 선택', exact: true }).click();
    await page.getByRole('button', { name: '소스 B', exact: true }).click();
    if (otherEpisode) {
      await page.getByRole('combobox', { name: '다른 소스의 회차', exact: true }).click();
      await page.getByRole('option', { name: '시즌 1 · 2화 · 다른 회차', exact: true }).click();
    }
    await page.getByRole('button', { name: '이 회차로 재생', exact: true }).click(); await ready();
  };
  await page.goto(`${base}watch/e1`); await ready(); await open();
  await page.getByRole('button', { name: 'English', exact: true }).click(); await shown('english');
  const previousUrl = await page.locator('track').getAttribute('src');
  reordered = true;
  await page.reload(); await ready(); await open(); await selected('English'); await shown('english');
  assert.notEqual(await page.locator('track').getAttribute('src'), previousUrl);
  await page.getByRole('button', { name: '끄기', exact: true }).click();
  await page.reload(); await ready(); await open(); await selected('끄기');
  await close(); await toSource(false); await open(); await selected('끄기');
  await page.goto(`${base}watch/e1`); await ready(); await open();
  await page.getByRole('button', { name: '선택한 파일.srt', exact: true }).click(); await close();
  await toSource(false); await shown('upload');
  assert.equal(new URL(page.url()).pathname, '/watch/e2');
  await page.goto(`${base}watch/e2`); await ready(); await shown('upload');
  assert.ok(lookups.includes('/api/episodes/e1/subtitles/uploads'));
  await page.goto(`${base}watch/e1`); await ready(); await open();
  await page.getByRole('button', { name: '한국어 AI 번역', exact: true }).click(); await close();
  await toSource(false); await shown('translation');
  await page.goto(`${base}watch/e2`); await ready(); await shown('translation');
  assert.ok(lookups.includes('/api/episodes/e1/subtitles/translations'));
  await page.goto(`${base}watch/e1`); await ready();
  await toSource(true); await shown('japanese');
  assert.equal(await page.evaluate(() => localStorage.getItem('moa.subtitleChoice:["first","e3"]')), null);
  await page.evaluate(() => localStorage.setItem('moa.profile', 'second'));
  await page.goto(`${base}watch/e2`); await ready(); await shown('japanese');
  assert.equal(await page.evaluate(() => localStorage.getItem('moa.subtitleChoice:["second","e2"]')), null);
  await page.evaluate(async () => {
    localStorage.setItem('moa.profile', 'first');
    const { rememberSubtitle } = await import('/src/player/subtitles/subtitle-preference.ts');
    await rememberSubtitle('e2', { id: 'upload-stable', source: 'upload', label: '선택한 파일.srt', format: 'vtt', url: '/expired' }, 'e1');
  });
  let release;
  resolveGate = new Promise(resolve => { release = resolve; });
  const before = lookups.filter(item => item.endsWith('/uploads')).length;
  await page.goto(`${base}watch/e2`); await ready(); await open();
  await page.getByRole('button', { name: 'English', exact: true }).click(); await shown('english');
  release(); resolveGate = undefined;
  await page.waitForTimeout(100);
  assert.ok(lookups.filter(item => item.endsWith('/uploads')).length > before);
  await selected('English');
  const other = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  other.on('pageerror', error => errors.push(String(error)));
  await other.addInitScript(() => { localStorage.setItem('moa.profile', 'first'); localStorage.setItem('moa.fullscreenOnPlay', '0'); });
  await fixtures(other);
  await other.goto(`${base}watch/e2`);
  await other.waitForFunction(() => document.querySelector('track')?.src.includes('english'));
  assert.equal(await other.locator('.seek-marker').count(), 2);
  assert.equal(await other.locator('.seek-intro').getAttribute('title'), '오프닝 0:15–1:25');
  await other.mouse.move(100, 100);
  await other.getByRole('button', { name: '자막 및 음성', exact: true }).click();
  await other.getByRole('button', { name: /자막 설정/, exact: false }).click();
  await other.locator('.sub-style-details > summary').click();
  await other.getByRole('spinbutton', { name: '자막 그림자', exact: true }).fill('2.5');
  await other.getByRole('spinbutton', { name: '자막 그림자', exact: true }).press('Tab');
  await other.getByRole('spinbutton', { name: '자막 윤곽선', exact: true }).fill('1.2');
  await other.getByRole('spinbutton', { name: '자막 윤곽선', exact: true }).press('Tab');
  await other.getByRole('spinbutton', { name: '자막 크기', exact: true }).fill('');
  await other.getByRole('spinbutton', { name: '자막 크기', exact: true }).pressSequentially('125');
  await other.getByRole('spinbutton', { name: '자막 크기', exact: true }).press('Tab');
  await other.getByRole('spinbutton', { name: '자막 높이', exact: true }).fill('12');
  await other.getByRole('spinbutton', { name: '자막 높이', exact: true }).press('Tab');
  await other.getByRole('radio', { name: '옅게', exact: true }).click();
  await other.getByRole('spinbutton', { name: '자막 배경 여백', exact: true }).fill('8');
  await other.getByRole('spinbutton', { name: '자막 배경 여백', exact: true }).press('Tab');
  await other.waitForFunction(() => document.querySelector('.subtitle-overlay')?.getAttribute('data-shadow') === '2.5' && document.querySelector('.subtitle-overlay')?.getAttribute('data-outline') === '1.2');
  await other.getByRole('button', { name: '+0.5', exact: true }).click();
  await other.evaluate(async () => { const { setDevicePref } = await import('/src/lib/device-prefs.ts'); setDevicePref('seekStep', 30); });
  await other.waitForFunction(async () => {
    const { deviceId } = await import('/src/lib/device-prefs.ts');
    const response = await fetch('/api/settings/device', { headers: { 'x-moa-profile': 'first', 'x-moa-device': deviceId() } });
    return (await response.json()).settings?.seekStep === 30;
  });
  await other.evaluate(() => localStorage.removeItem('moa.deviceSettings:first'));
  await other.reload();
  await other.waitForFunction(() => document.querySelector('track')?.src.includes('english'));
  await other.mouse.move(100, 100);
  await other.getByRole('button', { name: '자막 및 음성', exact: true }).click();
  await other.getByRole('button', { name: /자막 설정/, exact: false }).click();
  await other.locator('.sub-style-details > summary').click();
  assert.match(await other.locator('.sync-value').innerText(), /0.5/);
  assert.equal(await other.getByRole('spinbutton', { name: '자막 크기', exact: true }).inputValue(), '125');
  assert.equal(await other.getByRole('spinbutton', { name: '자막 그림자', exact: true }).inputValue(), '2.5');
  assert.equal(await other.evaluate(async () => (await import('/src/lib/device-prefs.ts')).devicePrefs().seekStep), 30);
  await page.reload(); await ready(); await open();
  await page.getByRole('button', { name: /자막 설정/, exact: false }).click();
  await page.locator('.sub-style-details > summary').click();
  assert.equal(await page.getByRole('spinbutton', { name: '자막 크기', exact: true }).inputValue(), '100');
  assert.equal(await page.getByRole('spinbutton', { name: '자막 그림자', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('spinbutton', { name: '자막 윤곽선', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('spinbutton', { name: '자막 높이', exact: true }).inputValue(), '0');
  assert.equal(await page.getByRole('spinbutton', { name: '자막 배경 여백', exact: true }).inputValue(), '6');
  assert.match(await page.locator('.sync-value').innerText(), /0.0/);
  assert.equal(await page.evaluate(async () => (await import('/src/lib/device-prefs.ts')).devicePrefs().seekStep), 10);
  await other.goto(`${base}watch/e3`);
  await other.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await other.mouse.move(100, 100);
  await other.getByRole('button', { name: '자막 및 음성', exact: true }).click();
  await other.getByRole('button', { name: /자막 설정/, exact: false }).click();
  await other.locator('.sub-style-details > summary').click();
  assert.match(await other.locator('.sync-value').innerText(), /0.0/);
  assert.equal(await other.getByRole('spinbutton', { name: '자막 그림자', exact: true }).inputValue(), '2.5');
  await other.goto(`${base}watch/e2`);
  await other.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await other.mouse.move(100, 100);
  await other.getByRole('button', { name: '자막 및 음성', exact: true }).click();
  await other.getByRole('button', { name: /자막 설정/, exact: false }).click();
  await other.locator('.sub-style-details > summary').click();
  await other.getByRole('button', { name: '자막 설정', exact: true }).click();
  const offSaved = other.waitForResponse(response => response.url().endsWith('/subtitles/preference') && response.request().method() === 'PUT');
  await other.getByRole('button', { name: '끄기', exact: true }).click();
  await offSaved;
  await page.reload(); await ready(); await open(); await selected('끄기');
  assert.equal(profileSettings.size, 0);
  assert.notEqual(await page.evaluate(() => localStorage.getItem('moa.deviceId')), await other.evaluate(() => localStorage.getItem('moa.deviceId')));
  await other.close();
  let releasePreference;
  preferenceGate = new Promise(resolve => { releasePreference = resolve; });
  const preferenceStarted = page.waitForRequest(request => request.url().endsWith('/subtitles/preference') && request.method() === 'GET');
  await page.reload(); await preferenceStarted; await ready(); await open();
  const choiceSaved = page.waitForResponse(response => response.url().endsWith('/subtitles/preference') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'English', exact: true }).click(); await choiceSaved;
  const preferenceFinished = page.waitForResponse(response => response.url().endsWith('/subtitles/preference') && response.request().method() === 'GET');
  releasePreference(); preferenceGate = undefined; await preferenceFinished;
  await selected('English');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moa.subtitleChoice:["first","e2"]')).label), 'English');
  await page.goto(`${base}settings#subtitle-library`);
  await page.getByRole('heading', { name: '자막 선택 기억' }).waitFor();
  await page.getByRole('combobox', { name: '자막 선택 보관 단위' }).click();
  await page.getByRole('option', { name: '개월 (30일)' }).click();
  await page.getByRole('spinbutton', { name: '자막 선택 보관 기간' }).fill('2');
  const savedRetention = page.waitForResponse(response => response.url().endsWith('/admin/subtitle-memory') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: '저장', exact: true }).click(); await savedRetention;
  assert.equal(retentionDays, 60);
  await page.getByRole('button', { name: '모두 삭제', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '모두 삭제', exact: true }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  assert.equal(preferences.size, 0);
  await page.goto(`${base}watch/e2`); await ready(); await shown('japanese');
  assert.equal(await page.evaluate(() => localStorage.getItem('moa.subtitleChoice:["first","e2"]')), null);
  recommendation = { id: 'extension-1', source: 'extension', label: 'English', lang: 'en', format: 'vtt', episodeId: 'e2' };
  await page.reload(); await ready(); await shown('english');
  assert.equal(preferences.size, 0);
  await open(); await page.getByRole('button', { name: '끄기', exact: true }).click();
  await page.reload(); await ready(); await open(); await selected('끄기');
  const deviceId = await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    await Promise.all([device.saveDevicePrefs({ subtitleScale: 120 }), device.saveDevicePrefs({ subtitleScale: 140 }), device.saveDevicePrefs({ subtitleShadow: 3 })]);
    return device.deviceId();
  });
  assert.equal(deviceSettings.get(`first:${deviceId}`).subtitleScale, 140);
  assert.equal(deviceSettings.get(`first:${deviceId}`).subtitleShadow, 3);
  failDeviceSave = true;
  assert.equal(await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    await device.saveDevicePrefs({ subtitleOutline: 4 }).catch(() => {});
    return device.devicePrefs().subtitleOutline;
  }), 4);
  assert.notEqual(deviceSettings.get(`first:${deviceId}`).subtitleOutline, 4);
  failDeviceSave = false;
  await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    await device.loadDevicePrefs({}, new AbortController().signal);
  });
  assert.equal(deviceSettings.get(`first:${deviceId}`).subtitleOutline, 4);
  failDeviceSave = true;
  await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    await device.saveDevicePrefs({ subtitleScale: 120 }).catch(() => {});
  });
  failDeviceSave = false;
  let releaseDeviceReplay;
  deviceReplayGate = new Promise(resolve => { releaseDeviceReplay = resolve; });
  const replayStarted = page.waitForRequest(request => request.url().endsWith('/settings/device') && request.method() === 'PATCH');
  await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    window.deviceReplay = device.loadDevicePrefs({}, new AbortController().signal);
  });
  await replayStarted;
  await page.evaluate(async () => {
    const device = await import('/src/lib/device-prefs.ts');
    window.deviceEdit = device.saveDevicePrefs({ subtitleScale: 160 });
  });
  await page.waitForTimeout(100);
  releaseDeviceReplay();
  await page.evaluate(async () => { await Promise.all([window.deviceReplay, window.deviceEdit]); delete window.deviceReplay; delete window.deviceEdit; });
  assert.equal(deviceSettings.get(`first:${deviceId}`).subtitleScale, 160);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moa.deviceSettings:first')).dirty), null);
  const values = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('moa.subtitleChoice:')).map(([, value]) => JSON.parse(value)));
  assert.ok(values.every(value => !value || !('url' in value) && !('content' in value)));
  assert.deepEqual(errors, []);
  console.log('Subtitle selection replay, fresh URL resolution, reordered tracks, off, profile/episode isolation, carried upload/translation and late-response, cross-device selection/off, isolated server-backed device appearance and controls, delayed device replay with newer edits, admin retention/deletion, expired cache removal, recommended subtitle precedence, skip ranges and subtitle shadow/outline checks passed.');
} finally { await browser.close(); await server.close(); }
