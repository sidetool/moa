import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const video = await readFile(process.env.MOA_TEST_VIDEO);
process.env.VITE_MOCK = '0';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const card = id => ({ id, title: id, type: 'movie', provider: { id: 'local', name: '로컬', kind: 'local' } });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); localStorage.setItem('moa.fullscreenOnPlay', '0'); Math.random = () => 0; });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    let subtitles = ['a', 'b', 'c'].map(id => ({ id, name: `${id}.srt`, title: id, source: 'upload', format: 'srt', bytes: 50, profile: '테스트', episodes: [] }));
    let folders = ['a', 'b', 'c'].map(id => ({ id, path: `/media/${id}`, label: `폴더 ${id}`, type: 'movie', itemCount: 1 }));
    let sources = ['a', 'b', 'c'].map(id => ({ id, name: `소스 ${id}`, installed: true, enabled: true, type: 'anime', lang: 'ko' }));
    const deletes = [], sourceDeletes = [], requests = [];
    let failSubtitle = true, failFolder = true, randomMode = 'pages', catalogGate, releaseCatalog, next = false;
    await context.route('**/fixture/video.mp4', route => {
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(range?.[1] || 0), end = Math.min(video.length - 1, range?.[2] ? Number(range[2]) : video.length - 1);
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: video.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
    });
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      const json = body => route.fulfill({ json: body });
      if (path === '/api/me') return json({ id: 'admin', username: '테스트', role: 'admin' });
      if (path === '/api/profiles') return json([{ id: 'test', name: '테스트', color: 'blue' }]);
      if (path === '/api/settings') return json({ defaultSubtitleLang: 'off', subtitleSize: 'medium', autoFetchSubtitles: false, autoplayNext: false, translationMode: 'manual', navigation: [{ id: 'home', name: '홈', sourceIds: [], includeLocal: true }] });
      if (path === '/api/admin/subtitles') return json(subtitles);
      if (path.startsWith('/api/admin/subtitles/upload/') && method === 'DELETE') {
        const id = path.split('/').at(-1); deletes.push(`subtitle:${id}`);
        if (id === 'b' && failSubtitle) { failSubtitle = false; return route.fulfill({ status: 409, json: { error: 'translation-running' } }); }
        subtitles = subtitles.filter(row => row.id !== id); return route.fulfill({ status: 204 });
      }
      if (path === '/api/library/folders') return json(folders);
      if (path.startsWith('/api/library/folders/') && method === 'DELETE') {
        const id = path.split('/').at(-1); deletes.push(`folder:${id}`);
        if (id === 'b' && failFolder) { failFolder = false; return route.fulfill({ status: 503, json: { error: 'unavailable' } }); }
        folders = folders.filter(row => row.id !== id); return route.fulfill({ status: 204 });
      }
      if (path === '/api/library/scan') return json({ running: false, total: 0, done: 0 });
      if (path === '/api/sources') return json(sources);
      if (path.endsWith('/removal-impact')) return json({ mediaCount: 1, episodeCount: 1, progressCount: 1, watchlistCount: 0, profilesAffected: 1 });
      if (path === '/api/sources/remove') { const ids = request.postDataJSON().ids; sourceDeletes.push(ids); sources = sources.filter(row => !ids.includes(row.id)); return json({ removed: ids }); }
      if (path === '/api/home') return json({ hero: [], rows: [] });
      if (path === '/api/media') {
        const number = Number(url.searchParams.get('page')); requests.push(number); await catalogGate;
        if (randomMode === 'error') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        if (randomMode === 'empty') return json({ items: [card('m1')], total: 1, page: 1, hasNextPage: false });
        return json({ items: number === 1 ? [card('m1'), card('same')] : [card('m2')], total: 3, page: number, hasNextPage: number === 1 });
      }
      if (path === '/api/playback' && method === 'POST') {
        const { episodeId } = request.postDataJSON();
        return json({ sessionId: `session-${episodeId}`, episodeId, mediaId: episodeId === 'e1' ? 'm1' : 'm2', mediaTitle: '종료 화면 검증', mediaType: 'movie', mode: 'direct', mime: 'video/mp4', url: '/fixture/video.mp4', duration: 600, startPosition: 0, subtitles: [], audioTracks: [], ...(next ? { next: { episodeId: 'e2', title: '다음 회차' } } : {}) });
      }
      if (path.startsWith('/api/media/')) return json({ ...card(path.split('/').at(-1)), seasons: [], alternatives: [card('same')], playTarget: { episodeId: 'e2', position: 0, label: '재생' } });
      if (path.endsWith('/subtitles/preference')) return json({});
      if (path === '/api/admin/updates') return json({ configured: false, connected: false, current: 'unknown', state: 'idle' });
      if (path.endsWith('/translation/config')) return json({ configured: false, enabled: false, keys: [] });
      if (method === 'DELETE' || method === 'POST') return route.fulfill({ status: 204 });
      return json([]);
    });
    const base = server.resolvedUrls.local[0];
    await page.goto(`${base}subtitles`);
    const library = page.locator('#saved-subtitles');
    await library.getByRole('checkbox', { name: 'a.srt 선택', exact: true }).check();
    await library.getByRole('checkbox', { name: 'b.srt 선택', exact: true }).check();
    assert.equal(await library.getByRole('checkbox', { name: '표시된 자막 모두 선택' }).evaluate(element => element.indeterminate), true);
    await library.getByRole('button', { name: '선택 삭제', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '취소', exact: true }).click();
    assert.deepEqual(deletes, []);
    await library.getByRole('button', { name: '선택 삭제', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('alert').waitFor();
    assert.deepEqual(deletes, ['subtitle:a', 'subtitle:b']);
    await page.getByRole('alertdialog').getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.deepEqual(deletes, ['subtitle:a', 'subtitle:b', 'subtitle:b']);
    await library.getByRole('checkbox', { name: 'c.srt 선택', exact: true }).waitFor();
    assert.equal(await library.getByRole('checkbox', { name: 'c.srt 선택', exact: true }).isChecked(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${base}library`);
    await page.getByRole('checkbox', { name: '라이브러리 폴더 모두 선택' }).check();
    await page.getByRole('checkbox', { name: '폴더 c 선택', exact: true }).uncheck();
    await page.getByRole('button', { name: '선택 제거', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '제거', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('alert').waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: '제거', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.deepEqual(deletes.filter(id => id.startsWith('folder:')), ['folder:a', 'folder:b', 'folder:b']);
    await page.goto(`${base}sources`);
    await page.getByRole('checkbox', { name: '표시된 설치 소스 모두 선택' }).check();
    await page.getByRole('checkbox', { name: '소스 c 선택', exact: true }).uncheck();
    await page.getByRole('button', { name: '선택 삭제', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '2개 삭제', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.deepEqual(sourceDeletes, [['a', 'b']]);
    await page.getByRole('checkbox', { name: '소스 c 선택', exact: true }).waitFor();
    const finish = async () => {
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await page.locator('video').evaluate(element => { element.pause(); element.currentTime = 100; element.dispatchEvent(new Event('ended')); });
      await page.locator('.player-end').waitFor();
    };
    await page.goto(`${base}watch/e1`); await finish();
    await page.getByRole('link', { name: 'm2 재생', exact: true }).waitFor();
    assert.deepEqual(requests, [1, 2]);
    assert.ok(page.url().endsWith('/watch/e1'));
    await page.screenshot({ path: verificationPath(`player-end-${width}.png`), animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: '다른 추천', exact: true }).click();
    await page.locator('.player-end').getByRole('status').filter({ hasText: '다른 추천 작품이 아직 없습니다' }).waitFor();
    assert.ok(page.url().endsWith('/watch/e1'));
    await page.getByRole('button', { name: '다시 보기', exact: true }).click();
    await page.locator('.player-end').waitFor({ state: 'detached' });
    assert.ok(await page.locator('video').evaluate(element => element.currentTime < 3 && !element.paused));
    randomMode = 'empty';
    await finish();
    await page.locator('.player-end').getByRole('status').filter({ hasText: '다른 작품이 아직 없습니다' }).waitFor();
    randomMode = 'error';
    await page.getByRole('button', { name: '추천 다시 찾기', exact: true }).click();
    await page.locator('.player-end').getByRole('status').filter({ hasText: '다시 시도' }).waitFor();
    randomMode = 'pages'; requests.length = 0;
    await page.getByRole('button', { name: '추천 다시 찾기', exact: true }).click();
    await page.getByRole('link', { name: 'm2 재생', exact: true }).click();
    await page.waitForURL('**/watch/e2*');
    assert.deepEqual(requests, [1, 2]);
    next = true;
    catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    await page.goto(`${base}watch/e1`); await finish();
    await page.getByRole('button', { name: '다음 화 재생', exact: true }).waitFor();
    await page.getByRole('button', { name: '다시 보기', exact: true }).waitFor();
    await page.getByRole('button', { name: '추천 찾는 중…', exact: true }).waitFor();
    await page.getByRole('button', { name: '홈으로', exact: true }).click();
    await page.waitForURL(base);
    releaseCatalog(); await page.waitForTimeout(250);
    assert.equal(page.url(), base);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Bulk subtitle/folder/source selection, confirmation, partial failure retry, end replay/home/random other pages and cancellation passed at 1280px and 390px.');
} finally {
  await browser.close();
  await server.close();
}
