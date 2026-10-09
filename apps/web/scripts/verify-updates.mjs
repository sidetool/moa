import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
process.env.VITE_MOCK = '0';
const web = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 0, open: false } });
await web.listen();
const base = web.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const settings = { autoplayNext: false, preferredQuality: 'auto', defaultSubtitleLang: 'ko', subtitleSize: 'medium', translationMode: 'manual' };
const translation = { enabled: false, configured: false, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keys: [], batchSize: 50 };

/** A browser context with a mocked API; `server` holds the mutable state each test steers. */
async function open(width, server) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'test'); localStorage.setItem('moa.remoteMode', 'off'); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(dialog.type()); await dialog.dismiss(); });
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: server.me });
    if (path === '/api/profiles') return route.fulfill({ json: [{ id: 'test', name: '테스트', color: 'blue' }] });
    if (path === '/api/settings') return route.fulfill({ json: settings });
    if (path === '/api/admin/system') { server.systemGets = (server.systemGets || 0) + 1; return route.fulfill({ json: { os: 'Fixture Linux', kernel: '6.1.0', architecture: 'arm64', nodeVersion: '22.23.3', version: 'v1.0.0', revision: 'a'.repeat(40), deployment: 'docker', cpuCount: 4, memoryTotal: 8 * 1024 ** 3, memoryUsed: 2 * 1024 ** 3, uptimeSeconds: 7200 } }); }
    if (path === '/api/admin/updates') { server.gets++; return route.fulfill({ json: server.status }); }
    if (path.endsWith('/updates/check')) { server.status = { ...server.status, ...server.onCheck }; return route.fulfill({ status: 202, json: { ...server.status, state: 'checking' } }); }
    if (path.endsWith('/updates/apply')) { server.applies++; server.status = { ...server.status, state: server.status.mode === 'release' ? 'downloading' : 'updating' }; return route.fulfill({ status: 202, json: server.status }); }
    if (path.endsWith('/updates/settings') && request.method() === 'PATCH') { server.patches.push(request.postDataJSON()); return route.fulfill({ status: 202, json: server.status }); }
    if (path.endsWith('/translation/config')) return route.fulfill({ json: translation });
    if (path === '/api/network') return route.fulfill({ json: { defaultProxy: '', revision: 0 } });
    if (path === '/api/admin/default-navigation') return route.fulfill({ json: { navigation: null } });
    return route.fulfill({ json: [] });
  });
  return { context, page };
}
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
const admin = (id = 'admin-a') => ({ id, username: id, role: 'admin' });

try {
  // Git/Docker installs: check, confirm, cancel, progress, failure, disconnect and member visibility.
  for (const width of [1280, 320]) {
    const server = { me: admin(), gets: 0, applies: 0, patches: [], onCheck: { state: 'available', latest: 'b'.repeat(40), behind: 1 },
      status: { configured: true, connected: true, state: 'current', mode: 'docker', current: 'a'.repeat(40), latest: 'a'.repeat(40), branch: 'main', behind: 0, ahead: 0, checkedAt: Date.now(), error: null } };
    const { context, page } = await open(width, server);
    await page.goto(`${base}settings#updates`);
    const section = page.locator('#updates');
    await section.getByText('최신 상태', { exact: true }).waitFor();
    assert.equal(await section.getByRole('combobox', { name: '업데이트 채널' }).count(), 0);
    await section.getByRole('button', { name: '업데이트 확인', exact: true }).click();
    const apply = section.getByRole('button', { name: '지금 업데이트', exact: true });
    await apply.click();
    const dialog = page.getByRole('alertdialog', { name: '서버를 업데이트할까요?' });
    await dialog.getByRole('button', { name: '취소' }).click();
    assert.equal(server.applies, 0);
    await apply.click();
    await dialog.getByRole('button', { name: '업데이트', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(server.applies, 1);
    assert.equal(await section.getByRole('button', { name: '업데이트 확인' }).isDisabled(), true);
    server.status = { ...server.status, state: 'blocked', error: 'update-dirty' };
    await section.getByRole('alert').filter({ hasText: '수정한 파일' }).waitFor();
    server.status = { ...server.status, connected: false, error: null };
    await section.getByText('도구 연결 끊김', { exact: true }).waitFor();
    await noOverflow(page);
    server.me = { ...server.me, role: 'member' };
    server.status = { ...server.status, connected: true, state: 'available' };
    await page.reload();
    await page.getByRole('heading', { name: '설정', exact: true }).waitFor();
    assert.equal(await section.count(), 0);
    assert.equal(await page.getByRole('heading', { name: '시스템 정보', exact: true }).count(), 0);
    server.gets = 0;
    await page.goto(`${base}my-list`);
    await page.waitForTimeout(1000);
    assert.equal(server.gets, 0, 'members never fetch update status');
    assert.equal(await page.locator('.update-notice').count(), 0);
    await context.close();
  }

  // Release settings: channel only, saved straight from the menu and held until the host acknowledges it.
  for (const width of [1280, 390]) {
    const server = { me: admin(), gets: 0, applies: 0, patches: [], onCheck: {},
      status: { configured: true, connected: true, state: 'current', mode: 'release', current: '1.2.0', latest: '1.2.0', branch: null, behind: 0, ahead: 0, checkedAt: Date.now(), error: null, policy: { channel: 'stable' }, notesUrl: null, updaterVersion: '1.0.0', history: [{ version: '1.2.0', previous: '1.1.0', at: Date.now() - 864e5, outcome: 'complete' }] } };
    const { context, page } = await open(width, server);
    await page.goto(`${base}settings#updates`);
    const section = page.locator('#updates');
    await section.getByText('MOA v1.2.0', { exact: true }).waitFor();
    for (const gone of ['자동 업데이트', '자동 확인', '시간대', '시작 시간', '확인 간격(시간)']) assert.equal(await section.getByLabel(gone).count(), 0, gone);
    assert.equal(await section.getByRole('button', { name: '설정 저장' }).count(), 0);
    assert.equal(await section.getByText('설정 안내').count(), 0);
    await section.getByRole('combobox', { name: '업데이트 채널' }).click();
    await page.getByRole('option', { name: '베타' }).click();
    await section.getByText('업데이트 도구에 반영하는 중…').waitFor();
    assert.deepEqual(server.patches, [{ channel: 'beta' }]);
    await page.waitForTimeout(3500);
    assert.match(await section.getByRole('combobox', { name: '업데이트 채널' }).innerText(), /베타/, 'chosen channel stays while the host catches up');
    server.status = { ...server.status, policy: { channel: 'beta' } };
    await section.getByText('업데이트 도구에 반영하는 중…').waitFor({ state: 'detached' });
    await section.getByText('베타 채널', { exact: true }).waitFor();

    server.status = { ...server.status, state: 'available', latest: '1.3.0-beta.1', notesUrl: 'https://github.com/sidetool/moa/releases/tag/v1.3.0-beta.1' };
    await section.getByText('새 버전 v1.3.0-beta.1', { exact: true }).waitFor();
    assert.equal(await section.getByRole('link', { name: '변경 사항 보기' }).getAttribute('href'), server.status.notesUrl);
    assert.equal(await page.locator('.update-notice').count(), 0, 'no notice on the settings page itself');
    server.status = { ...server.status, state: 'applying', notesUrl: 'https://example.com/notes' };
    await section.getByText('4/5', { exact: true }).waitFor();
    assert.equal(await section.getByRole('button', { name: '업데이트 확인' }).isDisabled(), true);
    server.status = { ...server.status, state: 'available' };
    await section.getByRole('button', { name: '지금 업데이트' }).waitFor();
    assert.equal(await section.getByRole('link', { name: '변경 사항 보기' }).count(), 0);
    await section.getByText('자세히').click();
    await section.getByRole('list', { name: '업데이트 기록' }).getByText('v1.1.0 → v1.2.0').waitFor();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: verificationPath(`updates-release-${width}.png`), fullPage: true });
    await noOverflow(page);
    await context.close();
  }

  // Admin notice: install from anywhere, close for a day, turn off, per-account, reload and polling rate.
  for (const width of [1280, 390]) {
    const available = { configured: true, connected: true, state: 'available', mode: 'release', current: '1.2.0', latest: '2.0.0', branch: null, behind: 0, ahead: 0, checkedAt: Date.now(), error: null, policy: { channel: 'stable' }, notesUrl: null };
    const server = { me: admin(), gets: 0, applies: 0, patches: [], onCheck: {}, status: available };
    const { context, page } = await open(width, server);
    await page.goto(`${base}my-list`);
    const notice = page.locator('.update-notice');
    await notice.getByText('업데이트가 있어요').waitFor();
    assert.match(await notice.innerText(), /MOA v2\.0\.0 업데이트가 있어요/);
    const box = await notice.boundingBox();
    assert.ok(box && box.y + box.height <= 900 && box.x >= 0 && box.x + box.width <= width, 'notice fits the viewport');
    if (width < 760) {
      const bar = await page.locator('.tabbar').boundingBox();
      assert.ok(box.y + box.height <= bar.y, 'notice sits above the tab bar');
    }
    await noOverflow(page);
    await page.screenshot({ path: verificationPath(`update-notice-${width}.png`) });

    server.gets = 0;
    await page.waitForTimeout(4000);
    assert.equal(server.gets, 0, 'notice does not poll every few seconds');

    // Install asks first and only then calls apply.
    await notice.getByRole('button', { name: '설치' }).click();
    const dialog = page.getByRole('alertdialog', { name: '서버를 업데이트할까요?' });
    await dialog.getByText('MOA v2.0.0을 설치합니다.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: '취소' }).click();
    assert.equal(server.applies, 0);
    await notice.getByRole('button', { name: '설치' }).click();
    await dialog.getByRole('button', { name: '설치' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(server.applies, 1);
    await notice.getByText('업데이트 중…').waitFor();
    server.status = { ...available, state: 'current', current: '2.0.0' };
    await notice.getByText('업데이트를 마쳤어요.').waitFor({ timeout: 10_000 });
    await notice.getByRole('button', { name: '닫기' }).click();
    await notice.waitFor({ state: 'detached' });

    // Closing rests for a day, across reloads; once the day is over it returns.
    server.status = { ...available, current: '2.0.0', latest: '2.1.0' };
    await page.reload();
    await notice.getByText('MOA v2.1.0').waitFor();
    await notice.getByRole('button', { name: '닫기' }).click();
    await notice.waitFor({ state: 'detached' });
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await notice.count(), 0, 'closed notice stays quiet after reload');
    server.status = { ...server.status, latest: '2.2.0' };
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await notice.count(), 0, 'a newer version does not break the daily rest');
    await page.evaluate(() => localStorage.setItem('moa.updateNotice.snooze.admin-a', String(Date.now() - 1)));
    await page.reload();
    await notice.getByText('MOA v2.2.0').waitFor();

    // "다시 보지 않음" turns the notice off for this account; settings turns it back on.
    await notice.getByRole('button', { name: '다시 보지 않음' }).click();
    await notice.waitFor({ state: 'detached' });
    server.status = { ...server.status, latest: '3.0.0' };
    server.gets = 0;
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await notice.count(), 0);
    assert.equal(server.gets, 0, 'turned-off notice stops checking');

    // Another admin in the same browser still sees it.
    server.me = admin('admin-b');
    await page.reload();
    await notice.getByText('MOA v3.0.0').waitFor();
    server.me = admin('admin-a');
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await notice.count(), 0);

    await page.goto(`${base}settings#updates`);
    const toggle = page.locator('#updates').getByRole('switch', { name: '업데이트 알림' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.goto(`${base}my-list`);
    await notice.getByText('MOA v3.0.0').waitFor();

    // Git/Docker builds only have commits: the notice stays generic.
    server.status = { ...server.status, mode: 'docker', current: 'a'.repeat(40), latest: 'b'.repeat(40) };
    await page.reload();
    await notice.getByText('새 업데이트가 있어요').waitFor();
    await context.close();
  }
  for (const width of [1280, 390]) {
    const discovery = { repository: 'fixture/moa', currentVersion: 'v1.0.0', updateAvailable: true, checkedAt: Date.now(), error: null, releases: [{ version: 'v2.0.0', url: 'https://github.com/fixture/moa/releases/tag/v2.0.0', publishedAt: '2026-01-01T00:00:00Z' }] };
    const server = { me: admin(), gets: 0, applies: 0, patches: [], onCheck: {}, status: { configured: false, connected: false, state: 'idle', mode: 'docker', current: 'a'.repeat(40), latest: null, branch: null, behind: 0, ahead: 0, checkedAt: null, error: null, discovery } };
    const { context, page } = await open(width, server);
    await page.goto(`${base}my-list`);
    const notice = page.locator('.update-notice');
    await notice.getByText('MOA v2.0.0').waitFor();
    assert.equal(await notice.getByRole('button', { name: '설치', exact: true }).count(), 0);
    await notice.getByRole('link', { name: '릴리스 보기' }).click();
    const section = page.locator('#updates');
    await section.getByText('새 릴리스 있음', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '시스템 정보', exact: true }).waitFor();
    await page.getByText('Fixture Linux', { exact: true }).waitFor();
    assert.equal(await section.getByRole('button', { name: '업데이트 확인', exact: true }).isEnabled(), true);
    assert.equal(await section.getByRole('button', { name: '지금 업데이트', exact: true }).count(), 0);
    assert.equal(await section.getByRole('link', { name: '릴리스 보기' }).getAttribute('href'), discovery.releases[0].url);
    await section.getByRole('button', { name: '업데이트 확인', exact: true }).click();
    await noOverflow(page);
    await page.screenshot({ path: verificationPath(`updates-discovery-${width}.png`), fullPage: true });
    server.status = { ...server.status, discovery: { ...discovery, currentVersion: null, updateAvailable: null } };
    await page.reload();
    await section.getByText('버전 비교 불가', { exact: true }).waitFor();
    assert.equal(server.applies, 0);
    server.me = { ...server.me, role: 'member' };
    server.gets = 0; server.systemGets = 0;
    await page.reload();
    await page.getByRole('heading', { name: '설정', exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(server.gets, 0);
    assert.equal(server.systemGets, 0);
    assert.equal(await page.getByRole('heading', { name: '시스템 정보', exact: true }).count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Update settings, channel sync, admin notice, install confirmation, rest/off preferences, account isolation, polling and responsive layout passed.');
} catch (error) { console.error(errors); throw error; }
finally { await browser.close(); await web.close(); }
