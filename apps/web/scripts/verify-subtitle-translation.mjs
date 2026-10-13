import { mockWatchUrl } from './mock-watch.mjs';
// AI subtitle translation UI against the development mock API (VITE_MOCK=1).
// No backend, Gemini key or Jimaku request is used: this checks the UI flow, not real translation results.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.MOA_TRANSLATION_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'moa-translation-'));
process.env.VITE_MOCK = '1';
const server = await createServer({ root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), cacheDir: path.join(evidence, 'vite-cache'), logLevel: 'warn', server: { port: 0, open: false, hmr: false } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const errors = [];
const srt = name => ({ name, mimeType: 'application/x-subrip', buffer: Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\n${name} line\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n`) });
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `${name}.png`) });

async function open(viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => { localStorage.setItem('moa.profile', 'p1'); localStorage.setItem('moa.fullscreenOnPlay', '0'); localStorage.setItem('moa.mockTranslationBatchMs', '4000'); });
  // Stay offline: answer the mock's public HLS stream with a playlist whose segment never arrives,
  // so the player keeps buffering with usable controls instead of showing a connection error.
  await context.route(url => url.hostname === 'test-streams.mux.dev', route => route.request().url().endsWith('.m3u8')
    ? route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:600\n#EXTINF:596,\nsegment.ts\n#EXT-X-ENDLIST\n' })
    : new Promise(() => {}));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => { errors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss(); });
  return page;
}
const patch = (page, body) => page.evaluate(body => fetch('/api/admin/translation/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()), body);
const readConfig = page => page.evaluate(() => fetch('/api/translation/config').then(r => r.json()));
// Replace the whole key chain (test helper; the UI adds and removes keys itself).
const setKeys = (page, secrets) => page.evaluate(async secrets => {
  const config = await fetch('/api/translation/config').then(r => r.json());
  const send = body => fetch('/api/admin/translation/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await send({ removeKeyIds: config.keys.map(key => key.id) });
  await send({ addKeys: secrets, enabled: true });
}, secrets);
const subsPanel = async page => {
  if (await page.locator('.player-panel').count()) return;
  await page.getByRole('button', { name: '자막 및 음성' }).click({ force: true });
  await page.locator('.player-panel').waitFor();
};
const back = page => page.locator('.panel-back').click();
const entry = page => page.locator('.translate-entry');

let step = 'start', current;
const at = (name, page) => { step = name; current = page; };
try {
  /* ---------- admin settings: key chain, model, batch size ---------- */
  const page = await open({ width: 1280, height: 860 });
  at('settings', page);
  await page.goto(`${base}/settings#translation`);
  const section = page.locator('#translation');
  await section.getByText('API 키', { exact: true }).waitFor();
  assert.equal(await section.locator('.status-pill').textContent(), '없음');
  assert.equal(await section.getByRole('switch', { name: 'AI 자막 번역' }).isDisabled(), true, 'toggle needs a key first');
  const keyInput = section.getByLabel('추가할 API 키');
  assert.equal(await section.getByLabel('번역 API 주소').count(), 0);
  assert.equal(await section.getByLabel('번역 모델 ID', { exact: true }).count(), 0);
  await section.getByRole('combobox', { name: '번역 서비스' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'OpenAI', exact: true }).click();
  await section.getByText('API 설정을 저장했어요. 사용할 API 키를 등록해 주세요.').waitFor();
  await page.waitForFunction(() => document.querySelector('#translation [aria-label="번역 서비스"]').textContent === 'OpenAI');
  assert.equal(await section.getByLabel('번역 API 주소').count(), 0);
  await keyInput.fill('sk-test-preserved-key');
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 2개').waitFor();
  const savedPreset = await readConfig(page);
  await section.getByRole('combobox', { name: '번역 서비스' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: '직접 입력', exact: true }).click();
  assert.equal(await section.getByLabel('번역 API 주소').inputValue(), 'https://api.openai.com/v1');
  await section.getByRole('combobox', { name: '직접 입력 API 방식' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'Gemini 호환', exact: true }).click();
  assert.deepEqual(await readConfig(page), savedPreset, 'opening direct input and editing its protocol preserves saved keys, model and service');
  await section.getByRole('combobox', { name: '번역 서비스' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'OpenAI', exact: true }).click();
  assert.equal(await section.getByLabel('번역 API 주소').count(), 0);
  assert.deepEqual(await readConfig(page), savedPreset, 'returning to the unchanged preset does not clear keys');
  await section.getByRole('combobox', { name: '번역 서비스' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: '직접 입력', exact: true }).click();
  await section.getByLabel('번역 API 주소').fill('http://127.0.0.1:1234/v1');
  await section.getByRole('button', { name: '주소 저장' }).click();
  await section.getByText('API 설정을 저장했어요. 사용할 API 키를 등록해 주세요.').waitFor();
  assert.equal(await section.getByRole('combobox', { name: '번역 서비스' }).textContent(), '직접 입력');
  assert.equal(await section.locator('.status-pill').textContent(), '없음', 'saving a different endpoint clears its old keys');
  await keyInput.fill('sk-test-provider-key');
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 2개').waitFor();
  await section.getByRole('button', { name: '전체 테스트', exact: true }).click();
  await section.locator('.translation-key-result').getByText('정상 · 현재 모델로 번역할 수 있어요.').waitFor();

  await section.getByRole('combobox', { name: '번역 모델', exact: true }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: '직접 입력', exact: true }).click();
  const beforeModel = await readConfig(page);
  await section.getByLabel('번역 모델 ID', { exact: true }).fill('org/custom-model:free');
  assert.deepEqual(await readConfig(page), beforeModel, 'typing a model does not save it');
  await section.getByRole('button', { name: '모델 저장' }).click();
  await page.waitForFunction(() => document.querySelector('#translation [role=combobox][aria-label="번역 모델"]').textContent === 'org/custom-model:free');
  const provider = await patch(page, {});
  assert.equal(provider.provider, 'openai');
  assert.equal(provider.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(provider.model, 'org/custom-model:free');
  assert.equal(provider.keys[0].test, undefined, 'model changes clear the previous test result');
  assert.equal(await section.getByLabel('번역 모델 ID', { exact: true }).count(), 0);
  await section.getByRole('combobox', { name: '직접 입력 API 방식' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'Gemini 호환', exact: true }).click();
  await section.getByRole('button', { name: '주소 저장' }).click();
  await section.getByText('API 설정을 저장했어요. 사용할 API 키를 등록해 주세요.').waitFor();
  assert.equal((await readConfig(page)).provider, 'gemini');
  assert.equal((await readConfig(page)).baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(await section.getByRole('combobox', { name: '번역 서비스' }).textContent(), '직접 입력');
  await section.getByRole('combobox', { name: '번역 서비스' }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'Gemini', exact: true }).click();
  await section.getByText('API 설정을 저장했어요. 사용할 API 키를 등록해 주세요.').waitFor();
  await page.waitForFunction(() => document.querySelector('#translation [aria-label="번역 서비스"]').textContent === 'Gemini');
  assert.equal(await section.locator('.status-pill').textContent(), '없음');
  assert.equal(await section.getByRole('switch', { name: 'AI 자막 번역' }).isDisabled(), true);
  // The first key is rejected; listing models must fail over to the second one.
  await keyInput.fill('AIza-bad-first-key-0001\nAIza-secret-second-key-0002\n');
  await section.getByText('2개 입력됨').waitFor();
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 3개').waitFor();
  assert.equal(await section.locator('.status-pill').textContent(), '2개');
  assert.equal(await section.locator('.translation-key-list li').count(), 2);
  assert.equal(await keyInput.inputValue(), '', 'key input is cleared after saving');
  const html = await page.content();
  assert.equal(html.includes('bad-first-key') || html.includes('secret-second-key'), false, 'saved keys never appear in the page');
  assert.equal(await section.getByText('검사하지 않음', { exact: true }).count(), 2, 'adding keys never starts paid tests');
  await page.evaluate(() => {
    window.__keyTests = [];
    window.__activeKeyTests = 0;
    window.__maxKeyTests = 0;
    const request = window.fetch;
    window.fetch = async (...args) => {
      const test = /\/admin\/translation\/keys\/[^/]+\/test$/.test(String(args[0]));
      if (test) {
        window.__keyTests.push(String(args[0]));
        window.__maxKeyTests = Math.max(window.__maxKeyTests, ++window.__activeKeyTests);
      }
      try { return await request(...args); }
      finally { if (test) window.__activeKeyTests--; }
    };
  });
  assert.equal(await section.getByRole('button', { name: /번 키 다시 검사/ }).count(), 0);
  await section.getByRole('button', { name: '전체 테스트', exact: true }).click();
  await section.getByText('검사 중…', { exact: true }).first().waitFor();
  assert.equal(await section.getByRole('button', { name: '1번 키 지우기' }).isDisabled(), true);
  assert.equal(await section.getByRole('combobox', { name: '번역 서비스' }).isDisabled(), true);
  await section.locator('.translation-key-list li.is-invalid').getByText('API 키가 유효하지 않거나 만료됐어요. 키를 확인해 주세요.').waitFor();
  await section.getByText('2개 검사 · 정상 1개 · 문제 1개', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__keyTests.length), 2);
  assert.equal(await section.getByRole('button', { name: /번 키 다시 검사/ }).count(), 1);
  await section.getByRole('button', { name: '1번 키 다시 검사' }).click();
  await section.getByText('검사 중…', { exact: true }).waitFor();
  await section.getByText('2개 검사 · 정상 1개 · 문제 1개', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__keyTests.length), 3);
  assert.equal(await page.evaluate(() => window.__keyTests[2] === window.__keyTests[0]), true);
  await keyInput.fill('AIza-quota-key-0003');
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 3개').waitFor();
  await section.getByText('2개 검사 · 정상 1개 · 문제 1개 · 미검사 1개', { exact: true }).waitFor();
  await section.getByRole('button', { name: '전체 테스트', exact: true }).click();
  await section.getByText('3개 검사 · 정상 1개 · 문제 2개', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__keyTests.length), 6);
  assert.equal(await section.getByRole('button', { name: /번 키 다시 검사/ }).count(), 2);
  await section.getByText('번역 API 사용 한도를 넘었어요. 관리자에게 알려 주세요.').waitFor();
  assert.equal(await section.locator('.translation-key-list li.is-invalid').count(), 2);
  assert.equal(await section.getByText('정상 · 현재 모델로 번역할 수 있어요.').count(), 1, 'adding another key preserves existing results');
  assert.equal(await section.locator('.translation-key-list li.is-invalid code').first().evaluate(element => getComputedStyle(element).color), 'rgb(255, 90, 106)');
  await section.screenshot({ path: path.join(evidence, 'keys-tested-desktop.png') });
  await section.getByRole('button', { name: '3번 키 지우기' }).click();
  await page.getByRole('alertdialog', { name: 'API 키를 지울까요?' }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.translation-key-list li').length === 2);

  await section.getByRole('button', { name: '1번 키 지우기' }).click();
  await page.getByRole('alertdialog', { name: 'API 키를 지울까요?' }).getByRole('button', { name: '삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.translation-key-list li').length === 1);
  await keyInput.fill(Array.from({ length: 20 }, (_, i) => `AIza-extra-${i}`).join('\n'));
  await section.getByText('최대 20개까지 · 19개 더 추가할 수 있어요').waitFor();
  assert.equal(await section.getByRole('button', { name: '키 저장' }).isDisabled(), true, 'more than 20 keys is blocked before sending');
  await keyInput.fill('');
  const batchInput = section.getByLabel('묶음당 자막 수');
  assert.equal(await batchInput.inputValue(), '120');
  await batchInput.fill('999');
  await batchInput.press('Enter');
  await section.getByText('묶음당 300줄로 저장했어요.').waitFor();
  await batchInput.fill('80');
  await batchInput.blur();
  await section.getByText('묶음당 80줄로 저장했어요.').waitFor();
  await section.getByRole('combobox', { name: '번역 모델', exact: true }).click();
  await page.locator('.dropdown-menu:popover-open').getByRole('option', { name: 'gemini-flash-lite-latest', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#translation [role=combobox][aria-label="번역 모델"]').textContent === 'gemini-flash-lite-latest');
  await section.getByRole('switch', { name: 'AI 자막 번역' }).click();
  await page.waitForFunction(() => document.querySelector('#translation [role=switch]').getAttribute('aria-checked') === 'true');
  await section.screenshot({ path: path.join(evidence, 'settings-desktop.png') });

  await keyInput.fill('AIza-extra-key-0003\nAIza-extra-key-0004\nAIza-extra-key-0005');
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 3개').waitFor();
  await section.getByRole('button', { name: '전체 테스트', exact: true }).click();
  await section.getByText('4개 검사 · 정상 4개 · 문제 0개', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__maxKeyTests), 3, 'key tests run concurrently with a limit of three');
  await section.getByRole('button', { name: '전체 삭제', exact: true }).click();
  const clearDialog = page.getByRole('alertdialog', { name: 'API 키를 모두 지울까요?' });
  await clearDialog.getByText('저장된 API 키 4개를 모두 삭제하고 자막 번역을 꺼요.').waitFor();
  await clearDialog.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(await section.locator('.translation-key-list li').count(), 4);
  await section.getByRole('button', { name: '전체 삭제', exact: true }).click();
  await shot(page, 'keys-delete-modal');
  await clearDialog.getByRole('button', { name: '삭제', exact: true }).click();
  await section.getByText('키를 모두 지웠어요. 번역을 사용할 수 없어요.').waitFor();
  assert.equal(await section.locator('.translation-key-list li').count(), 0);
  assert.equal(await section.getByRole('switch', { name: 'AI 자막 번역' }).isDisabled(), true);
  at('twenty keys', page);
  const capacityKeys = Array.from({ length: 20 }, (_, i) => `AIza-test-capacity-${String(i).padStart(2, '0')}`);
  const testsBeforeSave = await page.evaluate(() => window.__keyTests.length);
  await keyInput.fill(capacityKeys.join('\n'));
  assert.equal(await section.getByRole('button', { name: '키 저장' }).isEnabled(), true);
  await section.getByRole('button', { name: '키 저장' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.translation-key-list li').length === 20, undefined, { timeout: 10000 });
  await section.getByText('모델 목록을 불러왔어요 · 3개').waitFor();
  assert.equal((await readConfig(page)).keys.length, 20);
  assert.equal(await section.getByText('검사하지 않음', { exact: true }).count(), 20);
  assert.equal(await page.evaluate(() => window.__keyTests.length), testsBeforeSave, 'saving twenty keys never starts paid tests');
  for (const key of capacityKeys) assert.equal((await page.content()).includes(key), false);
  await section.screenshot({ path: path.join(evidence, 'keys-twenty-desktop.png') });
  await section.getByRole('button', { name: '전체 테스트', exact: true }).click();
  await section.getByText('20개 검사 · 정상 20개 · 문제 0개', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__maxKeyTests), 3, 'twenty keys preserve three concurrent user-requested tests');
  await section.getByRole('button', { name: '전체 삭제', exact: true }).click();
  await clearDialog.getByText('저장된 API 키 20개를 모두 삭제하고 자막 번역을 꺼요.').waitFor();
  await clearDialog.getByRole('button', { name: '삭제', exact: true }).click();
  await section.getByText('키를 모두 지웠어요. 번역을 사용할 수 없어요.').waitFor();
  await keyInput.fill('AIza-secret-second-key-0002');
  await section.getByRole('button', { name: '키 저장' }).click();
  await section.getByText('모델 목록을 불러왔어요 · 3개').waitFor();
  await section.getByRole('switch', { name: 'AI 자막 번역' }).click();
  await page.waitForFunction(() => document.querySelector('#translation [role=switch]').getAttribute('aria-checked') === 'true');

  /* ---------- player: cancel, then translate the English track ---------- */
  at('translate track', page);
  await page.goto(await mockWatchUrl(page, base, 'movie'));
  await subsPanel(page);
  await entry(page).click();
  await page.getByRole('radio', { name: /영어/ }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /^한국어/ }).count(), 0, 'Korean tracks are not offered as a source');
  assert.equal(await page.getByText('Jimaku에서 찾는 중…').count(), 0, 'Jimaku is not searched while a foreign track exists');
  await shot(page, 'player-translate-pick');
  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.getByRole('progressbar', { name: '번역 진행률' }).waitFor();
  await page.getByRole('button', { name: '번역 취소' }).click();
  await page.getByRole('button', { name: '번역 시작' }).waitFor();

  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.waitForFunction(() => /\d+ \/ \d+줄/.test(document.querySelector('.translate-progress small')?.textContent ?? ''));
  await shot(page, 'player-translate-progress');
  await page.locator('.translate-done').waitFor({ timeout: 20000 });
  await page.locator('.player-notice', { hasText: /AI 번역 자막을 적용했어요|AI 번역을 마쳤어요/ }).waitFor();
  await back(page);
  await page.locator('.panel-cols .opt.is-active .tag-ai').waitFor();
  await shot(page, 'player-translated');

  /* ---------- cached: the same source finishes immediately ---------- */
  at('cached', page);
  await entry(page).click();
  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.locator('.translate-done', { hasText: '저장된 번역' }).waitFor();

  /* ---------- a manual change while translating is respected ---------- */
  at('manual change', page);
  await page.locator('.translate-view input[type=file]').setInputFiles(srt('upload-a.srt'));
  await page.getByRole('radio', { name: /upload-a\.srt/ }).waitFor();
  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.getByRole('progressbar').waitFor();
  await back(page);
  await page.locator('.translate-entry.is-busy').waitFor();
  await page.getByRole('button', { name: '끄기', exact: true }).click();
  const doneNotice = page.locator('.player-notice', { hasText: '한국어 AI 번역이 끝났어요' });
  await doneNotice.waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.panel-cols .opt.is-active span').first().textContent(), '끄기', 'subtitles stay off');
  await page.locator('.panel-head').getByRole('button', { name: '닫기', exact: true }).click();
  await doneNotice.getByRole('button', { name: '적용' }).click();
  await subsPanel(page);
  await page.waitForFunction(() => document.querySelector('.panel-cols .opt.is-active .tag-ai'));

  /* ---------- failure and retry ---------- */
  at('failure', page);
  await setKeys(page, ['AIza-fail-key-0003']);
  await entry(page).click();
  await page.locator('.translate-view input[type=file]').setInputFiles(srt('upload-b.srt'));
  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.getByRole('alert').filter({ hasText: '번역 서비스가 응답하지 않았어요' }).waitFor({ timeout: 20000 });
  await shot(page, 'player-translate-failed');
  await back(page);
  await page.getByRole('button', { name: '번역하지 못했어요 · 다시 시도' }).click();
  await setKeys(page, ['AIza-good-key-0004']);
  await page.getByRole('button', { name: '다시 시도' }).click();
  await page.locator('.translate-done').waitFor({ timeout: 20000 });

  at('saved', page);
  await page.reload();
  await subsPanel(page);
  await page.locator('.panel-cols .tag-ai').first().waitFor();
  await page.locator('.panel-cols .opt.is-active .tag-ai').waitFor();
  assert.equal(await page.locator('.panel-cols .opt.is-active .tag-ai').count(), 1, 'the chosen saved translation is restored');

  /* ---------- Jimaku: offered beside a Japanese track, searched only on request ---------- */
  at('jimaku manual', page);
  await page.goto(await mockWatchUrl(page, base, 'anime', 3));
  await subsPanel(page);
  await page.getByText('한국어 자막이 없어요 · 이 영상의 자막을 번역할 수 있어요').waitFor();
  await page.locator('.panel-cols .opt.is-active').filter({ hasText: '일본어 (파일)' }).waitFor();
  assert.equal(await page.locator('.panel-cols > section').filter({has: page.getByRole('button', {name: '끄기', exact: true})}).locator('.opt.is-active span').textContent(), '일본어 (파일)', 'own Japanese track stays selected');
  await entry(page).click();
  await page.getByRole('button', { name: 'Jimaku에서 일본어 자막 찾기' }).click();
  await page.getByRole('radio', { name: /03 \(WEB\)\.srt/ }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /全話/ }).count(), 0, 'unverified files are hidden at first');
  await page.getByRole('button', { name: '회차 확인 안 된 파일 1개 더 보기' }).click();
  await page.getByRole('radio', { name: /全話/ }).getByText('회차 확인 안 됨').waitFor();
  assert.equal(await page.getByRole('radio', { name: /^일본어/ }).getAttribute('aria-checked'), 'true', 'the viewer’s own track stays the default pick');
  await page.getByRole('radio', { name: /03 \(WEB\)\.srt/ }).click();
  await shot(page, 'player-jimaku');
  // Manual correction of the query.
  await page.getByRole('button', { name: 'Jimaku 검색 조건 바꾸기' }).click();
  await page.getByLabel('화수', { exact: true }).fill('4');
  await page.getByRole('button', { name: '이 조건으로 찾기' }).click();
  await page.getByRole('radio', { name: /04 \(WEB\)\.srt/ }).click();
  await page.getByRole('button', { name: '번역 시작' }).click();
  await page.locator('.translate-progress', { hasText: '04 (WEB).srt' }).waitFor();
  await page.locator('.translate-done').waitFor({ timeout: 20000 });
  await page.locator('.player-notice', { hasText: /AI 번역 자막을 적용했어요|AI 번역을 마쳤어요/ }).waitFor();
  await back(page);
  await page.locator('.panel-cols .opt.is-active', { hasText: 'Jimaku 원문' }).waitFor();

  /* ---------- Jimaku: searched right away when there is nothing to translate ---------- */
  at('jimaku auto', page);
  await page.goto(`${base}/watch/demo-7-e1`);
  await subsPanel(page);
  assert.equal(await page.locator('.translate-entry em').count(), 0, 'no hint when a Korean subtitle exists');
  await entry(page).click();
  await page.getByRole('radio', { name: /S\d - 01\.ass/ }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /S\d - 01\.ass/ }).getAttribute('aria-checked'), 'true', 'best match is preselected');
  assert.equal(await page.locator('.translate-progress').count(), 0, 'nothing is translated without a press');
  await page.getByRole('button', { name: 'Jimaku 검색 조건 바꾸기' }).click();
  await page.getByLabel('작품 제목').fill('없는 작품');
  await page.getByRole('button', { name: '이 조건으로 찾기' }).click();
  await page.getByText('‘없는 작품’ 자막을 찾지 못했어요').waitFor();

  /* ---------- disabled: admins get a settings shortcut ---------- */
  at('disabled', page);
  await patch(page, { enabled: false });
  await page.reload();
  await subsPanel(page);
  await page.getByRole('link', { name: /한국어로 번역.*설정 필요/ }).waitFor();
  await patch(page, { enabled: true });

  /* ---------- phone layout (new tab: mock state starts fresh) ---------- */
  const mobile = await open({ width: 390, height: 844 });
  at('mobile', mobile);
  await mobile.goto(`${base}/settings#translation`);
  await mobile.locator('#translation').getByLabel('추가할 API 키').fill('AIza-mobile-key-0005');
  await mobile.locator('#translation').getByRole('button', { name: '키 저장' }).click();
  await mobile.locator('#translation').getByText(/모델 목록을 불러왔어요/).waitFor();
  await mobile.locator('#translation').getByLabel('추가할 API 키').fill('AIza-bad-mobile-key-0006');
  await mobile.locator('#translation').getByRole('button', { name: '키 저장' }).click();
  await mobile.locator('#translation').getByRole('button', { name: '전체 테스트', exact: true }).click();
  await mobile.getByText('2개 검사 · 정상 1개 · 문제 1개', { exact: true }).waitFor();
  await mobile.locator('.translation-key-list li.is-invalid').waitFor();

  await mobile.locator('#translation').getByRole('switch', { name: 'AI 자막 번역' }).click();
  await mobile.waitForFunction(() => document.querySelector('#translation [role=switch]').getAttribute('aria-checked') === 'true');
  const mobileConfig = await readConfig(mobile);
  await mobile.getByRole('combobox', { name: '번역 서비스' }).click();
  await mobile.locator('.dropdown-menu:popover-open').getByRole('option', { name: '직접 입력', exact: true }).click();
  await mobile.getByRole('combobox', { name: '번역 모델', exact: true }).click();
  await mobile.locator('.dropdown-menu:popover-open').getByRole('option', { name: '직접 입력', exact: true }).click();
  assert.deepEqual(await readConfig(mobile), mobileConfig, 'direct input keeps the enabled service and keys intact on mobile');
  assert.equal(await mobile.getByLabel('번역 모델 ID', { exact: true }).inputValue(), mobileConfig.model);
  await mobile.locator('#translation').screenshot({ path: path.join(evidence, 'settings-mobile.png') });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'settings fit the phone width');
  await mobile.setViewportSize({ width: 320, height: 844 });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'custom fields fit a narrow phone');
  await mobile.locator('#translation').screenshot({ path: path.join(evidence, 'settings-custom-320.png') });
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(await mockWatchUrl(mobile, base, 'anime', 5));
  await subsPanel(mobile);
  await entry(mobile).click();
  await mobile.getByRole('button', { name: 'Jimaku에서 일본어 자막 찾기' }).click();
  await mobile.getByRole('radio', { name: /S2 - 05\.ass/ }).waitFor();
  await shot(mobile, 'player-translate-mobile');
  const overflow = await mobile.evaluate(() => { const panel = document.querySelector('.player-panel').getBoundingClientRect(); return panel.right > innerWidth + 1 || panel.left < -1; });
  assert.equal(overflow, false, 'panel fits the phone width');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence, errors }, null, 2));
} catch (error) {
  if (current) await current.screenshot({ path: path.join(evidence, `failed-${step.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  console.error(`failed at: ${step}`);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
