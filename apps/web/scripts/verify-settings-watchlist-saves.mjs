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
  const devices = { one: {}, two: {} }, saved = new Set(), writes = [], watchWrites = [], watchTargets = [];
  const groupSaved = new Set(), groupWrites = [];
  let groupConflict = false, failWatchlistTimes = 0, groupReads = 0, failGroupReadTimes = 0, failGroupRead = false;
  let failGroupWrite = false, separateOnConflict = false;
  const unsavedEditions = new Set(), separatedEditions = new Set(), groupReadEditions = [];
  const gates = new Map();
  // A gate pauses exactly one write until the browser has made the next selection.
  function hold(key) {
    const gate = Promise.withResolvers();
    gates.set(key, gate);
    return gate;
  }
  let deviceWrites = 0;
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
        deviceWrites++;
        const gate = gates.get('device');
        gates.delete('device');
        if (gate && !(await gate.promise)) return reject();
        if (failDevice) return reject();
        Object.assign(devices[profile], route.request().postDataJSON().settings);
      }
      return json({ settings: devices[profile] });
    }
    if (/^\/api\/media\/[mn]\/group$/.test(path)) return json({ members: [] });
    if (path === '/api/media/m' || path === '/api/media/n') {
      if (failRead) return reject();
      const id = path.slice(-1);
      return json({ id, title: id === 'm' ? '영화' : '다른 영화', type: 'movie', provider: { id: 'local', name: 'Local', kind: 'local' }, seasons: [], inWatchlist: saved.has(id === 'm' ? profile : `${profile}:n`) });
    }
    if (path === '/api/watchlist/m/group') {
      const method = route.request().method();
      const edition = new URL(route.request().url()).searchParams.get('savedEdition');
      if (method === 'GET') {
        groupReads++;
        if (failGroupRead || (failGroupReadTimes > 0 && failGroupReadTimes--)) return reject();
        groupReadEditions.push(edition);
        if (separatedEditions.has(edition)) return json({ grouped: false, inWatchlist: false });
        return json({ grouped: true, inWatchlist: !unsavedEditions.has(edition) && groupSaved.has(profile) });
      }
      groupWrites.push(method);
      // The edition left its group after the page loaded. The client must not retry or fall back to another target.
      if (groupConflict) {
        if (separateOnConflict) separatedEditions.add(edition);
        return route.fulfill({ status: 409, json: { error: 'watchlist-group-changed' } });
      }
      if (failGroupWrite) return reject();
      if (method === 'PUT') groupSaved.add(profile); else groupSaved.delete(profile);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/watchlist/m' || path === '/api/watchlist/n') {
      const id = path.slice(-1);
      watchWrites.push(route.request().method());
      watchTargets.push(`${profile}:${id}`);
      const gate = gates.get('watchlist');
      gates.delete('watchlist');
      if (gate && !(await gate.promise)) return reject();
      if (failWatchlist || (failWatchlistTimes > 0 && failWatchlistTimes--)) return reject();
      const key = id === 'm' ? profile : `${profile}:n`;
      if (route.request().method() === 'PUT') saved.add(key); else saved.delete(key);
      return json({});
    }
    if (path === '/api/watchlist') return json([...saved.has(profile) ? [{ id: 'm' }] : [], ...saved.has(`${profile}:n`) ? [{ id: 'n' }] : []]);
    if (path === '/api/shorts') return json({ status: 'ready', items: [
      { key: 'movie:1', title: '영화', category: 'movie', mediaId: 'm', href: '/title/m' },
      { key: 'movie:2', title: '다른 영화', category: 'movie', mediaId: 'n', href: '/title/n' },
      { key: 'movie:3', title: '영화 다른 예고편', category: 'movie', mediaId: 'm', href: '/title/m' }
    ], nextCursor: null });
    // Shorts trailer lists fail here so an unplayable slide waits instead of advancing on its own.
    if (path.startsWith('/api/shorts/') && path.endsWith('/trailers')) return reject();
    if (path.endsWith('/trailers')) return json({ trailers: [], checked: true });
    if (path === '/api/home') return json({ hero: [], rows: [] });
    return json([]);
  });
  const base = server.resolvedUrls.local[0];
  await page.goto(base + 'settings#playback', { waitUntil: 'domcontentloaded' });
  const toggle = (name, checked) => page.getByRole('switch', { name, exact: true, checked });
  const retry = page.getByRole('alert').getByRole('button', { name: '다시 시도' });
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  async function retryWithKeyboard(key, success, moveTo) {
    const gate = hold(key);
    assert.ok(await focused(retry));
    await page.keyboard.press('Enter');
    const pending = page.getByRole('alert').getByRole('button', { name: '다시 시도', disabled: true });
    await pending.waitFor();
    assert.ok(await pending.evaluate(el => el === document.activeElement && !el.disabled));
    await page.keyboard.press('Enter');
    if (moveTo) await moveTo.focus();
    gate.resolve(success);
    if (success) await retry.waitFor({ state: 'hidden' });
    else {
      await page.getByRole('alert').getByRole('button', { name: '다시 시도', disabled: false }).waitFor();
      assert.ok(await focused(retry));
    }
  }
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
  await retry.focus();
  await retryWithKeyboard('autoplayNext', false);
  await retryWithKeyboard('autoplayNext', true);
  assert.ok(await focused(toggle('다음 화 자동 재생', false)));
  assert.equal(writes.filter(write => 'autoplayNext' in write.patch).length, 3);
  const deviceGate = page.waitForResponse(response => response.url().endsWith('/settings/device') && response.status() === 503);
  failDevice = true;
  await toggle('화면 채우기', false).click();
  await deviceGate;
  await page.getByText('이 기기에 적용했지만 서버에 저장하지 못했어요.', { exact: false }).waitFor();
  assert.equal(await toggle('화면 채우기', true).count(), 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moa.deviceSettings:one')).dirty.videoFill), true);
  await retry.focus();
  await retryWithKeyboard('device', false);
  failDevice = false;
  const other = toggle('하드웨어 변환', true);
  await retryWithKeyboard('device', true, other);
  assert.ok(await focused(other));
  assert.equal(deviceWrites, 3);
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
  await retry.click();
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
  const note = page.locator('.title-action-note');
  const label = add => add ? '내 목록에 있음' : '내 목록';
  await watchlist(false).waitFor();
  const attemptWithKeyboard = async button => {
    const gate = hold('watchlist');
    await button.focus();
    await page.keyboard.press('Enter');
    const pending = page.locator('button[aria-disabled="true"][aria-pressed]');
    await pending.waitFor();
    assert.ok(await pending.evaluate(el => el === document.activeElement && !el.disabled));
    // A second press while the request is open must not queue another change.
    await page.keyboard.press('Enter');
    gate.resolve(true);
  };
  const settled = () => page.waitForFunction(() => document.querySelector('.hero-actions button[aria-pressed]').getAttribute('aria-disabled') !== 'true');
  for (const add of [true, false]) {
    // Persistent failure: the app retries quietly, then shows the confirmed state and one short note.
    failWatchlist = true;
    failRead = true;
    const before = watchWrites.length;
    await attemptWithKeyboard(watchlist(!add));
    await page.getByRole('alert').filter({ hasText: add ? '추가하지 못했어요' : '빼지 못했어요' }).waitFor();
    assert.equal(watchWrites.length - before, 3, 'one request and two automatic retries');
    assert.equal(await watchlist(!add).textContent(), label(!add));
    assert.equal(await page.getByRole('button', { name: /다시 시도/ }).count(), 0);
    assert.equal(await watchlist(!add).getAttribute('aria-describedby'), await note.getAttribute('id'));
    assert.ok(await watchlist(!add).evaluate(el => el === document.activeElement));
    // Pressing the unchanged button again repeats the same intent.
    failWatchlist = false;
    failRead = false;
    await page.keyboard.press('Enter');
    await watchlist(add).waitFor();
    await settled();
    assert.equal(await note.count(), 0);
    assert.ok(await watchlist(add).evaluate(el => el === document.activeElement));
    assert.equal(saved.has('two'), add);
  }
  assert.deepEqual(watchWrites, ['PUT', 'PUT', 'PUT', 'PUT', 'DELETE', 'DELETE', 'DELETE', 'DELETE']);

  // A transient failure recovers without any visible error or label change.
  for (const add of [true, false]) {
    failWatchlistTimes = 1;
    const firstFailure = page.waitForResponse(r => r.url().endsWith('/api/watchlist/m') && r.status() === 503);
    await watchlist(!add).click();
    await firstFailure;
    assert.equal(await page.locator(`.hero-actions button[aria-pressed="${add}"][aria-disabled="true"]`).count(), 1);
    await watchlist(add).waitFor();
    await settled();
    assert.equal(await note.count(), 0);
    assert.equal(saved.has('two'), add);
  }
  assert.deepEqual(watchWrites.slice(8), ['PUT', 'PUT', 'DELETE', 'DELETE']);

  // A changed group is final: no retry and no write to the ungrouped title.
  await navigate('/title/m?savedEdition=e1');
  await watchlist(false).waitFor();
  groupConflict = true;
  const ungroupedWrites = watchWrites.length;
  await watchlist(false).click();
  await page.getByRole('alert').filter({ hasText: '작품 묶음이 바뀌어' }).waitFor();
  await page.waitForTimeout(2500);
  assert.deepEqual(groupWrites, ['PUT']);
  assert.equal(watchWrites.length, ungroupedWrites);
  assert.equal(await watchlist(false).textContent(), '내 목록');
  groupConflict = false;
  await watchlist(false).click();
  await watchlist(true).waitFor();
  await settled();
  assert.equal(await note.count(), 0);
  assert.deepEqual(groupWrites, ['PUT', 'PUT']);
  assert.ok(groupSaved.has('two') && !saved.has('two'));

  // Reading the saved group: a transient failure recovers on its own; a lasting one keeps the same
  // "내 목록" button, re-checks on press and never writes to another edition.
  const mainButton = page.locator('.hero-actions').getByRole('button', { name: /^내 목록/ });
  const writesBefore = () => [groupWrites.length, watchWrites.length];
  const untouched = writesBefore();
  const readsUntil = async count => { for (const started = Date.now(); groupReads < count; await page.waitForTimeout(50)) assert.ok(Date.now() - started < 8000); };
  failGroupReadTimes = 1;
  groupReads = 0;
  await navigate('/title/m?savedEdition=e2');
  await readsUntil(2);
  await watchlist(true).waitFor();
  assert.equal(groupReads, 2);
  assert.equal(await note.count(), 0);
  failGroupRead = true;
  groupReads = 0;
  await navigate('/title/m?savedEdition=e3');
  await page.getByRole('alert').filter({ hasText: '내 목록 상태를 확인하지 못했어요' }).waitFor();
  assert.equal(groupReads, 3, 'one read and two automatic retries');
  assert.equal(await mainButton.textContent(), '내 목록');
  assert.equal(await mainButton.getAttribute('aria-pressed'), null);
  assert.equal(await mainButton.getAttribute('aria-describedby'), await note.getAttribute('id'));
  assert.equal(await page.locator('.hero-actions').getByRole('button', { name: /다시 확인|다시 시도/ }).count(), 0);
  await mainButton.focus();
  await page.keyboard.press('Enter');
  await page.locator('.hero-actions button[aria-disabled="true"]').waitFor();
  // A second press while checking is ignored.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.hero-actions button[aria-disabled="true"]'));
  await page.getByRole('alert').filter({ hasText: '내 목록 상태를 확인하지 못했어요' }).waitFor();
  assert.equal(groupReads, 6, 'a press re-checks once, with its own quiet retries');
  assert.ok(await mainButton.evaluate(el => el === document.activeElement));
  failGroupRead = false;
  await page.keyboard.press('Enter');
  await watchlist(true).waitFor();
  assert.equal(await note.count(), 0);
  assert.ok(await watchlist(true).evaluate(el => el === document.activeElement));
  assert.deepEqual(writesBefore(), untouched, 'no write while the group state was unknown');

  // A final failure belongs to the page's saved edition: moving to another edition of the same title
  // in place does not carry the old note over.
  const readEdition = async edition => {
    for (const started = Date.now(); !groupReadEditions.includes(edition); await page.waitForTimeout(50)) assert.ok(Date.now() - started < 8000);
    await page.waitForFunction(() => document.querySelector('.hero-actions button[aria-pressed]') && !document.querySelector('.hero-actions button[aria-disabled="true"]'));
  };
  unsavedEditions.add('e5').add('e6').add('e7');
  failGroupWrite = true;
  await navigate('/title/m?savedEdition=e5');
  await readEdition('e5');
  const groupWritesBefore = groupWrites.length;
  await watchlist(false).click();
  await page.getByRole('alert').filter({ hasText: '추가하지 못했어요' }).waitFor();
  assert.equal(groupWrites.length - groupWritesBefore, 3);
  failGroupWrite = false;
  await navigate('/title/m?savedEdition=e6');
  await readEdition('e6');
  assert.equal(await watchlist(false).count(), 1);
  assert.equal(await note.count(), 0, 'the e5 note does not follow to e6');

  // A 409 that splits the group keeps its note on the same page; the toggle falls back to the ungrouped
  // title for later presses, but nothing is written for the refused one.
  groupConflict = true;
  separateOnConflict = true;
  await navigate('/title/m?savedEdition=e7');
  await readEdition('e7');
  const ungroupedBefore = watchWrites.length, groupBefore = groupWrites.length;
  await watchlist(false).click();
  await page.getByRole('alert').filter({ hasText: '작품 묶음이 바뀌어' }).waitFor();
  for (const started = Date.now(); groupReadEditions.filter(edition => edition === 'e7').length < 2; await page.waitForTimeout(50)) assert.ok(Date.now() - started < 8000);
  await page.waitForTimeout(500);
  assert.equal(await note.filter({ hasText: '작품 묶음이 바뀌어' }).count(), 1, 'the 409 note stays after the group splits');
  assert.equal(watchWrites.length, ungroupedBefore);
  assert.equal(groupWrites.length - groupBefore, 1);
  groupConflict = false;
  separateOnConflict = false;
  await navigate('/title/m');
  await watchlist(false).waitFor();

  // A rejected enable is recoverable on the Shorts landing page.
  const enable = hold('shortsEnabled');
  await navigate('/shorts');
  await page.getByRole('button', { name: '켜기' }).click();
  enable.resolve(false);
  await retry.focus();
  await retryWithKeyboard('shortsEnabled', false);
  await retryWithKeyboard('shortsEnabled', true);
  await page.getByRole('feed', { name: '쇼츠' }).waitFor();
  assert.ok(await focused(page.getByRole('main')));
  assert.equal(writes.filter(write => 'shortsEnabled' in write.patch).length, 3);
  // Shorts uses the same quiet retries. The rail button keeps its add/remove label and caption.
  const slide = title => page.locator(`.shorts-slide[aria-label="${title}"]`);
  const rail = (title, name) => slide(title).locator('.shorts-rail').getByRole('button', { name, exact: true });
  const caption = title => slide(title).locator('.shorts-rail button[aria-pressed] small');
  const showShort = async title => {
    await page.locator('.shorts-nav').getByRole('button', { name: title === '영화' ? '이전 작품' : '다음 작품' }).click();
    await page.locator(`.shorts-slide.is-active[aria-label="${title}"]`).waitFor();
  };
  const writesUntil = async count => { for (const started = Date.now(); watchWrites.length < count; await page.waitForTimeout(50)) assert.ok(Date.now() - started < 8000); };
  failWatchlist = true;
  await attemptWithKeyboard(rail('영화', '내 목록에 추가'));
  await slide('영화').getByRole('alert').filter({ hasText: '추가하지 못했어요' }).waitFor();
  assert.deepEqual(watchWrites.slice(12), ['PUT', 'PUT', 'PUT']);
  assert.equal(await caption('영화').textContent(), '내 목록');
  assert.equal(await page.locator('.shorts-rail').getByRole('button', { name: /다시 시도/ }).count(), 0);
  assert.equal(await rail('영화', '내 목록에 추가').getAttribute('aria-describedby'), await slide('영화').locator('.shorts-note').getAttribute('id'));
  failWatchlist = false;
  await page.keyboard.press('Enter');
  const savedButton = slide('영화').getByRole('button', { name: '내 목록에서 빼기', pressed: true, disabled: false });
  await savedButton.waitFor();
  assert.ok(await savedButton.evaluate(el => el === document.activeElement));
  assert.equal(await slide('영화').locator('.shorts-note').count(), 0);
  assert.deepEqual(watchWrites.slice(12), ['PUT', 'PUT', 'PUT', 'PUT']);

  // A failure that finishes after swiping stays on the slide that asked for it.
  let shortsGate = hold('watchlist');
  const removeWrites = watchWrites.length;
  await rail('영화', '내 목록에서 빼기').click();
  await writesUntil(removeWrites + 1);
  await showShort('다른 영화');
  failWatchlist = true;
  shortsGate.resolve(false);
  await writesUntil(removeWrites + 3);
  await page.waitForFunction(() => !document.querySelector('.shorts-rail button[aria-disabled="true"]'));
  assert.deepEqual(watchTargets.slice(removeWrites), ['two:m', 'two:m', 'two:m']);
  assert.equal(await rail('다른 영화', '내 목록에 추가').getAttribute('aria-pressed'), 'false');
  assert.equal(await slide('다른 영화').locator('.shorts-note').count(), 0);
  assert.equal(await page.getByRole('alert').filter({ hasText: '내 목록' }).count(), 0);
  // The earlier slide reports quietly and is still in the list.
  assert.equal(await slide('영화').locator('.shorts-note').getAttribute('role'), null);
  await showShort('영화');
  await slide('영화').locator('.shorts-note').filter({ hasText: '빼지 못했어요' }).waitFor();
  assert.equal(await rail('영화', '내 목록에서 빼기').getAttribute('aria-pressed'), 'true');
  failWatchlist = false;

  // A success that finishes after swiping back changes only the slide that was pressed.
  await showShort('다른 영화');
  shortsGate = hold('watchlist');
  const addWrites = watchWrites.length;
  await rail('다른 영화', '내 목록에 추가').click();
  await writesUntil(addWrites + 1);
  await showShort('영화');
  shortsGate.resolve(true);
  await page.waitForFunction(() => !document.querySelector('.shorts-rail button[aria-disabled="true"]'));
  assert.deepEqual(watchTargets.slice(addWrites), ['two:n']);
  assert.ok(saved.has('two:n') && saved.has('two'));
  assert.equal(await rail('다른 영화', '내 목록에서 빼기').getAttribute('aria-pressed'), 'true');
  assert.equal(await rail('영화', '내 목록에서 빼기').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.shorts-note').count(), 1, 'only the earlier failed removal remains reported');

  // Another slide of the same title settles that report; changing it back later must not revive the old note.
  for (const label of ['다른 영화', '영화 다른 예고편']) {
    await page.locator('.shorts-nav').getByRole('button', { name: '다음 작품' }).click();
    await page.locator(`.shorts-slide.is-active[aria-label="${label}"]`).waitFor();
  }
  await rail('영화 다른 예고편', '내 목록에서 빼기').click();
  await rail('영화 다른 예고편', '내 목록에 추가').waitFor();
  await page.waitForFunction(() => !document.querySelector('.shorts-rail button[aria-disabled="true"]'));
  assert.equal(await slide('영화').locator('.shorts-note').count(), 0, 'settled once the removal is confirmed elsewhere');
  await rail('영화 다른 예고편', '내 목록에 추가').click();
  await rail('영화 다른 예고편', '내 목록에서 빼기').waitFor();
  await page.waitForFunction(() => !document.querySelector('.shorts-rail button[aria-disabled="true"]'));
  assert.equal(await rail('영화', '내 목록에서 빼기').getAttribute('aria-pressed'), 'true');
  assert.equal(await slide('영화').locator('.shorts-note').count(), 0, 'the old removal failure does not come back');
  assert.ok(saved.has('two'));

  // Leaving the title during a retry keeps the change on the title that was pressed.
  await navigate('/title/m');
  await watchlist(true).waitFor();
  failWatchlistTimes = 1;
  let gate = hold('watchlist');
  const removing = watchWrites.length;
  await watchlist(true).click();
  gate.resolve(false);
  await page.waitForResponse(r => r.url().endsWith('/api/watchlist/m') && r.status() === 503);
  gate = hold('watchlist');
  await page.waitForRequest(r => r.url().endsWith('/api/watchlist/m') && r.method() === 'DELETE');
  await navigate('/title/n');
  await page.getByRole('heading', { name: '다른 영화' }).waitFor();
  failWatchlistTimes = 0;
  gate.resolve(true);
  await page.waitForFunction(() => !document.querySelector('.hero-actions button[aria-disabled="true"]'));
  await page.waitForTimeout(500);
  // m was removed as pressed; n keeps the state saved from Shorts.
  assert.ok(!saved.has('two') && saved.has('two:n'));
  assert.equal(await watchlist(true).count(), 1);
  assert.equal(await note.count(), 0);
  assert.deepEqual(watchTargets.slice(removing), ['two:m', 'two:m']);

  // Changing profile during a retry stops the remaining attempts for the earlier profile.
  await navigate('/title/m');
  await watchlist(false).waitFor();
  failWatchlist = true;
  gate = hold('watchlist');
  const adding = watchWrites.length;
  await watchlist(false).click();
  gate.resolve(false);
  await page.waitForResponse(r => r.url().endsWith('/api/watchlist/m') && r.status() === 503);
  gate = hold('watchlist');
  // The retry is now held at the server stub, after it left with the earlier profile.
  for (const started = Date.now(); watchWrites.length < adding + 2; await page.waitForTimeout(50)) assert.ok(Date.now() - started < 5000);
  await navigate('/profiles');
  await page.getByRole('button', { name: 'one', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('moa.profile') === 'one');
  gate.resolve(false);
  await page.waitForTimeout(2500);
  assert.deepEqual(watchTargets.slice(adding), ['two:m', 'two:m']);
  assert.ok(!saved.has('two') && !saved.has('one'));
  assert.deepEqual(errors, []);
  console.log('PASS profile save overlap, same-field retry, dirty device recovery, profile switch, detail add/remove with transient and persistent failures, group conflict, title and profile moves during retry, and Shorts retries across swipes');
} finally {
  await browser?.close();
  await server.close();
}
