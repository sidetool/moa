import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';
import { buildApp } from '../../server/dist/app.js';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const bytes = await readFile(process.env.MOA_TEST_VIDEO);
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n번역한 자막\n';
const translated = { id: 'translation-test', label: '한국어 · AI 번역', lang: 'ko', format: 'vtt', source: 'translation', url: '/fixture/translated.vtt' };
const original = { id: 'original', label: 'English', lang: 'en', format: 'vtt', url: '/fixture/original.vtt' };
const directory = await mkdtemp(path.join(tmpdir(), 'moa-upload-browser-'));
const backend = await buildApp({ dataDir: directory, mediaRoot: directory }, false);
backend.db.run("INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES('test','테스트','blue',0,'2026','local')");
for (const id of ['1', '2']) {
  backend.db.run('INSERT INTO media VALUES(?,NULL,?,\'movie\',\'{}\',\'2026\')', `m${id}`, '자막 검증');
  backend.db.run('INSERT INTO episodes VALUES(?,?,1,1,\'회차\',600,NULL)', `e${id}`, `m${id}`);
}
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], cancelled = [], jobs = [];
let session = 0, completed = false, importGate, role = 'admin';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.fullscreenOnPlay', '0'); });
  await page.route('**/fixture/video.mp4', route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] || 0), end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  await page.route('**/fixture/*.vtt*', route => route.fulfill({ contentType: 'text/vtt', body: vtt }));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = body => route.fulfill({ json: body });
    if (pathname.startsWith('/api/admin/subtitles')) {
      const response = await backend.app.inject({ method: request.method(), url: pathname });
      return route.fulfill({ status: response.statusCode, contentType: response.headers['content-type'], body: response.body });
    }
    if (pathname === '/api/subtitles/import') {
      await importGate;
      const response = await backend.app.inject({ method: 'POST', url: pathname, headers: { 'x-moa-profile': 'test' }, payload: request.postDataJSON() });
      return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    }
    if (pathname.startsWith('/api/playback/upload-')) {
      const response = await backend.app.inject({ url: pathname, headers: { 'x-moa-profile': 'test' } });
      return route.fulfill({ status: response.statusCode, contentType: response.headers['content-type'], body: response.body });
    }
    if (pathname === '/api/playback' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const uploads = (await backend.app.inject({ url: `/api/episodes/${body.episodeId}/subtitles/uploads`, headers: { 'x-moa-profile': 'test' } })).json();
      return json({ sessionId: `s${++session}`, episodeId: body.episodeId, mediaId: body.episodeId === 'e2' ? 'm2' : 'm1', mediaTitle: '자막 검증', mediaType: 'movie', mode: 'direct', mime: 'video/mp4', url: '/fixture/video.mp4', duration: 600, startPosition: body.startPosition || 0, subtitles: [original, ...uploads], audioTracks: [], streamId: body.streamId || 'a', streams: [{ id: 'a', label: '서버 A' }, { id: 'b', label: '서버 B' }] });
    }
    if (pathname === '/api/settings') return json({ defaultSubtitleLang: 'en', subtitleSize: 'medium', autoFetchSubtitles: false, autoplayNext: false, translationMode: 'manual' });
    if (pathname === '/api/me') return json({ role });
    if (pathname === '/api/profiles') return json([{ id: 'test', name: '테스트', color: 'blue' }]);
    if (pathname === '/api/sources') return json([]);
    if (pathname === '/api/admin/updates') return json({ state: 'unsupported', available: false, current: 'fixture' });
    if (pathname === '/api/admin/subtitle-memory') return json({ retentionDays: 90, count: 0 });
    if (pathname === '/api/plugins' || pathname === '/api/plugin-runtime') return json([]);
    if (pathname.endsWith('/markers')) return json({ markers: null, status: 'unavailable' });
    if (pathname === '/api/translation/config') return json({ provider: 'gemini', configured: true, enabled: true, model: 'test', keys: [] });
    if (pathname.endsWith('/subtitles/translations')) return json([translated]);
    if (pathname === '/api/translations/job') {
      jobs.push({ completed, method: request.method() });
      if (request.method() === 'DELETE') { cancelled.push(pathname); return route.fulfill({ status: 204 }); }
      return json({ id: 'job', episodeId: 'e1', state: completed ? 'completed' : 'running', revision: completed ? 2 : 1, partial: !completed, done: completed ? 2 : 1, total: 2, model: 'test', cached: false, translatedRanges: [{ start: 0, end: 600 }], track: { ...translated, url: `${translated.url}?r=${completed ? 2 : 1}` } });
    }
    if (pathname.endsWith('/context')) return json({ mediaId: 'm1', season: 1, number: 1 });
    if (pathname.endsWith('/group')) return json({ members: [{ id: 'm1', provider: { name: '소스 A' } }, { id: 'm2', provider: { name: '소스 B' } }] });
    if (pathname.startsWith('/api/media/')) return json({ id: pathname.split('/').at(-1), title: '자막 검증', type: 'movie', provider: { id: 'local', name: '로컬', kind: 'local' }, seasons: [{ number: 1, episodes: [{ id: 'e2', season: 1, number: 1, title: '같은 회차' }] }] });
    return route.fulfill({ status: 204 });
  });
  const base = server.resolvedUrls.local[0];
  await page.goto(`${base}tests/fixtures/player.html`);
  const ready = async () => { await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2).catch(async error => { console.error(errors, await page.locator('body').innerText(), await page.locator('video').evaluate(video => ({ src: video.currentSrc, error: video.error?.message }))); throw error; }); await page.locator('video').evaluate(video => video.pause()); };
  await ready();
  const profileChanged = await page.evaluate(async () => {
    const { importSubtitleFile } = await import('/src/player/subtitles/subtitle-files.ts');
    const file = new File(['WEBVTT\n'], 'race.vtt');
    file.arrayBuffer = async () => { localStorage.setItem('moa.profile', 'other'); return new TextEncoder().encode('WEBVTT\n').buffer; };
    try { await importSubtitleFile(file, 'e1', new AbortController().signal); return false; }
    catch (error) { return error.name === 'AbortError'; }
    finally { localStorage.setItem('moa.profile', 'test'); }
  });
  assert.equal(profileChanged, true);
  assert.equal(backend.db.get('SELECT count(*) AS n FROM uploaded_subtitles').n, 0);
  await page.waitForFunction(() => document.querySelector('track')?.track.cues?.length);
  assert.deepEqual(await page.locator('track').evaluate(element => ({ line: element.track.cues[0].line, snapToLines: element.track.cues[0].snapToLines })), { line: 'auto', snapToLines: true });
  const openSubs = async () => { await page.mouse.move(100, 100); await page.getByRole('button', { name: '자막 및 음성', exact: true }).click(); };
  await openSubs();
  await page.getByRole('button', { name: '한국어 AI 번역', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'AI 번역 자막 내보내기' }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /\.ko\.vtt$/);
  assert.equal(await readFile(await download.path(), 'utf8'), vtt);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '재생 설정', exact: true }).click();
  await page.getByRole('button', { name: '서버 B', exact: true }).click();
  await ready();
  await openSubs();
  assert.match(await page.getByRole('button', { name: '한국어 AI 번역', exact: true }).getAttribute('class'), /is-active/);
  await page.getByLabel('자막 파일 선택', { exact: true }).setInputFiles({ name: '직접.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n직접 추가\n') });
  await page.waitForFunction(() => document.querySelector('track')?.track.cues?.[0]?.text === '직접 추가');
  assert.match(await page.getByRole('button', { name: '직접.srt', exact: true }).getAttribute('class'), /is-active/);
  const drop = async (selector, name, data) => {
    const transfer = await page.evaluateHandle(({ name, data }) => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name)); return transfer; }, { name, data });
    await page.locator(selector).dispatchEvent('dragover', { dataTransfer: transfer });
    await page.getByText('자막 파일을 놓아 주세요', { exact: true }).waitFor();
    await page.locator(selector).dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
  };
  await drop('.panel-subs', '직접.smi', Buffer.from('<SAMI><SYNC Start=1000><P>드롭 자막<SYNC Start=3000><P>&nbsp;</SAMI>').toString('base64'));
  await page.waitForFunction(() => document.querySelector('track')?.track.cues?.[0]?.text === '드롭 자막');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await drop('.player-surface', 'test.rar', 'UmFyIRoHAQDFGjMyAwEAAFEpQdsRAgImACYAAAAIdGVzdC5zcnQxCjAwOjAwOjAxLDAwMCAtLT4gMDA6MDA6MDMsMDAwCkhlbGxvChmyOjUDBQAA');
  await page.waitForFunction(() => document.querySelector('track')?.track.cues?.[0]?.text === 'Hello');
  let releaseImport;
  importGate = new Promise(resolve => { releaseImport = resolve; });
  await page.getByLabel('자막 파일 선택', { exact: true }).setInputFiles({ name: '늦은.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n늦은 자막\n') });
  await page.getByRole('button', { name: '끄기', exact: true }).click();
  releaseImport();
  await page.getByRole('button', { name: '늦은.srt', exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: '끄기', exact: true }).getAttribute('class'), /is-active/);
  importGate = undefined;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.panel-body').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: verificationPath(`subtitle-files-${width}.png`), animations: 'disabled' });
    const box = await page.locator('.panel-subs').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'test.srt', exact: true }).click();
  await page.locator('video').evaluate(video => { video.currentTime = 2; video.pause(); });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '재생 설정', exact: true }).click();
  await page.getByRole('button', { name: '다른 소스 선택', exact: true }).click();
  const resume = page.getByRole('checkbox', { name: /현재 위치/ });
  assert.deepEqual(await resume.evaluate(input => ({ appearance: getComputedStyle(input).appearance, width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height })), { appearance: 'none', width: 18, height: 18 });
  await resume.uncheck(); assert.equal(await resume.isChecked(), false);
  await resume.check(); assert.equal(await resume.isChecked(), true);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: verificationPath(`subtitle-source-${width}.png`), animations: 'disabled' });
    const box = await page.locator('.playback-source-dialog > div').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: '소스 B', exact: true }).click();
  await page.getByRole('button', { name: '이 회차로 재생', exact: true }).click();
  await ready();
  await openSubs();
  assert.match(await page.getByRole('button', { name: 'test.srt', exact: true }).getAttribute('class'), /is-active/);
  await page.reload();
  await ready();
  await openSubs();
  await page.getByRole('button', { name: '직접.srt', exact: true }).waitFor();
  assert.equal(backend.db.get('SELECT count(*) AS n FROM uploaded_subtitles').n, 4);
  await page.getByRole('button', { name: '한국어 AI 번역', exact: true }).click();
  await page.evaluate(() => sessionStorage.setItem('moa.translationJob:["test","e1"]', JSON.stringify({ id: 'job', label: 'English', origin: 'auto' })));
  await page.reload();
  await ready();
  await page.waitForFunction(() => document.querySelector('track')?.src.includes('translated'));
  await page.getByRole('button', { name: '재생 설정', exact: true }).click();
  await page.getByRole('button', { name: '다른 소스 선택', exact: true }).click();
  await page.getByRole('button', { name: '소스 B', exact: true }).click();
  await page.getByRole('button', { name: '이 회차로 재생', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.player-title')?.textContent.includes('자막 검증') && document.querySelector('track')?.src.includes('translated'));
  await ready();
  await openSubs();
  assert.match(await page.getByRole('button', { name: /한국어 AI 번역 번역 중/ }).getAttribute('class'), /is-active/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('moa.translationJob:["test","e1"]')), null);
  await page.locator('video').evaluate(video => video.pause());
  completed = true;
  await page.waitForFunction(() => document.querySelector('track')?.src.includes('r=2')).catch(async error => { console.error({ jobs, cancelled, errors }, await page.evaluate(() => ({ text: document.body.innerText, tracks: [...document.querySelectorAll('track')].map(track => ({ src: track.src, ready: track.readyState, mode: track.track.mode })), store: {...sessionStorage} }))); throw error; });
  assert.deepEqual(cancelled, []);
  backend.db.run("INSERT INTO translation_cache(key,format,chunks,content,touched,complete) VALUES('test','vtt','[]',?,?,1)", vtt, Date.now());
  backend.db.run("INSERT INTO online_subtitles VALUES('online','e1','제작자','https://example.com/sub','vtt',?,'hash','token',?)", vtt, Date.now());
  await page.goto(`${base}subtitles`);
  await page.getByRole('heading', { name: '자막 관리', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#subtitle-library');
  await page.getByText('6개 ·', { exact: false }).waitFor();
  const savedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '직접.srt 다운로드', exact: true }).click();
  assert.match(await readFile(await (await savedDownload).path(), 'utf8'), /직접 추가/);
  await page.getByRole('button', { name: '직접.srt 삭제', exact: true }).click();
  await page.getByRole('alertdialog', { name: '자막 삭제', exact: true }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '직접.srt 삭제', exact: true }).waitFor({ state: 'detached' });
  assert.equal(backend.db.get('SELECT count(*) AS n FROM uploaded_subtitles').n, 3);
  const onlineDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '제작자 · 한국어 다운로드', exact: true }).click();
  assert.equal(await readFile(await (await onlineDownload).path(), 'utf8'), vtt);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: verificationPath(`subtitle-library-${width}.png`), animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.getByRole('button', { name: '제작자 · 한국어 삭제', exact: true }).click();
  await page.getByRole('alertdialog', { name: '자막 삭제', exact: true }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '제작자 · 한국어 삭제', exact: true }).waitFor({ state: 'detached' });
  assert.equal(backend.db.get('SELECT count(*) AS n FROM online_subtitles').n, 0);
  await page.goto(`${base}me`);
  await page.getByRole('link', { name: '설정', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('link', { name: '자막 관리', exact: true }).click();
  await page.getByRole('heading', { name: '자막 관리', exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: '프로필 메뉴', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '플러그인', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '설정', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('link', { name: '플러그인', exact: true }).click();
  await page.getByRole('heading', { name: '플러그인', exact: true }).waitFor();
  role = 'member';
  await page.goto(`${base}subtitles`);
  await page.getByRole('heading', { name: '관리자만 볼 수 있어요', exact: true }).waitFor();
  assert.equal(await page.locator('#saved-subtitles').count(), 0);
  await page.goto(`${base}me`);
  assert.equal(await page.getByRole('link', { name: '저장한 자막', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '플러그인', exact: true }).count(), 0);
  await page.getByRole('link', { name: '설정', exact: true }).click();
  const settingsMenu = page.getByRole('navigation', { name: '설정 메뉴', exact: true });
  await settingsMenu.getByRole('link', { name: '재생', exact: true }).waitFor();
  assert.equal(await settingsMenu.getByRole('link', { name: '자막 관리', exact: true }).count(), 0);
  assert.equal(await settingsMenu.getByRole('link', { name: '플러그인', exact: true }).count(), 0);
  await page.goto(`${base}plugins`);
  await page.getByRole('heading', { name: '관리자만 볼 수 있어요', exact: true }).waitFor();
  assert.equal(await page.locator('#plugins').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['original position', 'translated export', 'stream subtitle retention', 'file selection', 'panel drop', 'video archive drop', 'profile change abort', 'source switch with uploaded subtitle', 'source dialog checkbox', 'saved uploads after reload', 'source switch with active translation', 'admin upload/AI/online subtitle list/download/delete', 'settings navigation and member restrictions'] }));
} finally { await browser.close(); await server.close(); await backend.app.close(); await rm(directory, { recursive: true, force: true }); }
