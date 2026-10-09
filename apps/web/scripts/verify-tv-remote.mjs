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
const output = process.env.MOA_VERIFY_OUTPUT || verificationPath('verification-tv');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
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
  await context.addInitScript(mode => { localStorage.setItem('moa.profile', 'ui-test'); if (!localStorage.getItem('moa.remoteMode')) localStorage.setItem('moa.remoteMode',mode); }, options.mode || 'on');
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const calls = { searches: [], applies: [], sessions: [] };
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
    if (path === '/api/profiles') return json([{id:'ui-test',name:'테스트',color:'violet'}]);
    if (path === '/api/sources') return json([]);
    if (path === '/api/home') {
      const provider={id:'local',kind:'local',name:'로컬'};
      return json({hero:[{id:'m1',title:'테스트 작품',type:'anime',provider}], rows:[1,2,3].map(n=>({id:'row'+n,title:'작품 줄 '+n,layout:'poster',items:Array.from({length:18},(_,i)=>({id:'m'+(i+1),title:`작품 ${n}-${i+1}`,type:'anime',provider}))}))});
    }
    if (path.endsWith('/group')) return json({members:[]});
    if (path === '/api/settings') { await options.settingsGate?.promise; return json({ ...settings, navigation:[{id:'home',name:'홈',sourceIds:[],includeLocal:true}], ...options.settings }); }
    if (path === '/api/playback' && req.method() === 'POST') {
      const { episodeId } = req.postDataJSON(); calls.sessions.push(episodeId);
      if (episodeId === 'e2') await options.nextGate?.promise;
      return json({ sessionId: `s-${episodeId}`, episodeId, mediaId: 'm1', mediaTitle: '플레이어 검증', mediaType: 'anime', episodeLabel: episodeId === 'e1' ? 'S1:E1' : 'S1:E2', episodeTitle: episodeId === 'e1' ? '첫 번째 회차' : '두 번째 회차', mode: 'direct', url: '/fixture/video.mp4', mime: 'video/mp4', duration: 600, startPosition: 0, audioTracks: [{ id: 'a1', label: '일본어', default: true }], subtitles: [track], next: episodeId === 'e1' ? { episodeId: 'e2', title: '두 번째 회차', label: 'S1:E2' } : null, markers: { introStart: 20, introEnd: 80, creditsStart: 480, creditsEnd: 540 } });
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
    if (/^\/api\/media\/m[0-9]+$/.test(path)) return json({ id: 'm1', title: '플레이어 검증', type: 'anime', provider: { id: 'local', name: '로컬', kind: 'local' }, seasons: [{ number: 1, episodes: [{ id: 'e1', number: 1, title: '첫 번째 회차' }, { id: 'e2', number: 2, title: '두 번째 회차' }] }] });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${base}${options.path || '/watch/e1'}`);
  if (!options.path) {
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2).catch(async error => {
    console.error(await page.evaluate(() => ({ url: location.href, text: document.body.innerText, video: document.querySelector('video')?.currentSrc })), calls, errors);
    throw error;
  });
  }
  const panel = page.getByRole('dialog', { name: '자막 및 음성' });
  const open = async () => { await page.mouse.move(200, 200); await page.getByRole('button', { name: '자막 및 음성', exact: true }).click(); await panel.waitFor(); };
  const off = () => panel.getByRole('button', { name: '끄기', exact: true });
  const close = async () => { for (const value of Object.values(options)) value?.release?.(); await context.close(); console.log(`PASS: ${results.at(-1)}`); };
  return { page, context, calls, panel, open, off, close };
}

try {
  {
    const f=await fixture({path:'/'}),p=f.page;
    await p.waitForSelector('.row-track a');
    await p.waitForFunction(()=>document.documentElement.hasAttribute('data-tv'));
    await p.locator('.row-track').first().locator('a').first().focus();
    for(let i=0;i<12;i++) await p.keyboard.press('ArrowRight');
    assert.ok(await p.locator('.row-track').first().evaluate(e=>e.scrollLeft)>100,'Offscreen row cards become reachable');
    const selected=await p.evaluate(()=>document.activeElement.getAttribute('aria-label'));
    await p.keyboard.press('Enter');await p.waitForURL('**/title/*');
    await p.waitForTimeout(200);await p.keyboard.press('Escape');await p.waitForURL(base+'/');
    await p.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,selected);
    await p.keyboard.press('ArrowDown');
    assert.notEqual(await p.evaluate(()=>document.activeElement.closest('.row')?.getAttribute('aria-labelledby')),'row-row1');
    await p.getByRole('button',{name:'프로필 메뉴'}).focus();await p.keyboard.press('Enter');
    await p.waitForFunction(()=>document.activeElement?.closest('[role="menu"]')).catch(async e=>{console.log(await p.evaluate(()=>({focus:document.activeElement.outerHTML,menu:document.querySelector('[role="menu"]')?.outerHTML,body:document.body.innerText.slice(0,350)})));throw e;});
    await p.keyboard.press('ArrowDown');assert.ok(await p.evaluate(()=>!!document.activeElement.closest('[role="menu"]')));
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('[role="menu"]'));
    await p.waitForFunction(()=>document.activeElement.getAttribute('aria-label')==='프로필 메뉴');
    await p.screenshot({path:output+'/home-focus.png'});
    results.push('Rows scroll with D-pad; detail Back restores the card; menus contain and restore focus');await f.close();
  }
  {
    const f=await fixture({settings:{autoFetchSubtitles:false}}),p=f.page;
    await p.locator('video').evaluate(v=>v.pause());
    await p.locator('.center-play').focus();
    const start=await p.locator('video').evaluate(v=>v.currentTime);
    await p.keyboard.press('ArrowRight');assert.equal(await p.evaluate(()=>document.activeElement.getAttribute('aria-label')),'10초 앞으로');
    await p.keyboard.press('Enter');assert.ok(await p.locator('video').evaluate(v=>v.currentTime)>=start+9);
    await p.locator('.seek').focus();await p.keyboard.press('ArrowRight');
    // Remote seeks preview on the bar and land once the presses stop.
    assert.ok(await p.locator('video').evaluate(v=>v.currentTime)<start+19,'Seek waits for the presses to stop');
    await p.waitForFunction(s=>document.querySelector('video').currentTime>=s+19,start);
    await p.keyboard.press('Escape');await p.waitForFunction(()=>document.querySelector('.player.is-idle'));
    const idleStart=await p.locator('video').evaluate(v=>v.currentTime);
    await p.keyboard.press('ArrowRight');await p.waitForFunction(()=>document.activeElement?.classList.contains('seek'));
    await p.waitForFunction(s=>document.querySelector('video').currentTime>=s+9,idleStart);
    await p.getByRole('button',{name:'자막 및 음성',exact:true}).focus();await p.keyboard.press('Enter');
    await p.waitForFunction(()=>document.activeElement?.closest('.player-panel'));
    const before=await p.locator('video').evaluate(v=>v.currentTime);
    await p.keyboard.press('ArrowDown');await p.keyboard.press('ArrowRight');
    assert.equal(await p.locator('video').evaluate(v=>v.currentTime),before,'Panel arrows must not seek');
    await f.panel.getByRole('button',{name:/자막 설정/}).focus();await p.keyboard.press('Enter');
    await f.panel.getByRole('button',{name:'더 크게',exact:true}).focus();await p.keyboard.press('Enter');
    await p.getByRole('slider',{name:'자막 높이'}).focus();
    const old=await p.getByRole('slider',{name:'자막 높이'}).inputValue();await p.keyboard.press('ArrowRight');
    assert.equal(Number(await p.getByRole('slider',{name:'자막 높이'}).inputValue()),Number(old)+1);
    await p.keyboard.press('Escape');await f.panel.locator('.panel-link').waitFor();
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('.player-panel'));
    await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='자막 및 음성');
    await p.keyboard.press('Escape');await p.waitForFunction(()=>document.querySelector('.player.is-idle'));
    await p.keyboard.press('Enter');await p.waitForFunction(()=>document.activeElement?.classList.contains('center-play'));
    await p.keyboard.press('Enter');await p.waitForFunction(()=>!document.querySelector('video').paused).catch(async e=>{console.log(await p.evaluate(()=>({focus:document.activeElement.outerHTML,chrome:document.querySelector('.player').className,center:document.querySelector('.player-center').outerHTML})));throw e;});
    await p.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'MediaPause',bubbles:true})));
    assert.equal(await p.locator('video').evaluate(v=>v.paused),true);
    await p.waitForFunction(()=>!document.querySelector('.player').classList.contains('is-playing'));
    await p.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:10009,bubbles:true})));
    await p.waitForFunction(()=>document.querySelector('.player.is-idle'));
    await p.keyboard.press('Enter');await p.waitForFunction(()=>document.activeElement?.classList.contains('center-play'));
    await p.getByRole('button',{name:'전체 화면 (F)',exact:true}).focus();await p.keyboard.press('Enter');
    await p.waitForFunction(()=>!!document.fullscreenElement);
    await p.getByRole('button',{name:'다음 화 (N)',exact:true}).focus();await p.keyboard.press('Enter');
    await p.waitForURL('**/watch/e2');await p.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
    assert.equal(await p.evaluate(()=>!!document.fullscreenElement),true,'Remote next keeps fullscreen');
    await p.screenshot({path:output+'/player.png'});
    results.push('Player D-pad, seek, nested subtitle Back, native sliders, media keys and Samsung Back');await f.close();
  }
  {
    const f=await fixture({mode:'off',settings:{autoFetchSubtitles:false}}),p=f.page;
    await p.locator('video').evaluate(v=>{v.pause();v.currentTime=100});await p.keyboard.press('ArrowRight');
    assert.ok(await p.locator('video').evaluate(v=>v.currentTime)>=105,'Desktop shortcut preserved');
    assert.equal(await p.evaluate(()=>document.documentElement.hasAttribute('data-tv')),false);
    results.push('Desktop mode preserves arrow seeking');await f.close();
  }
  {
    const f=await fixture({path:'/profiles',mode:'auto'}),p=f.page;
    await p.getByRole('button',{name:'테스트',exact:true}).waitFor();
    await p.keyboard.press('ArrowRight');await p.keyboard.press('Enter');await p.waitForURL(base+'/');
    assert.equal(await p.evaluate(()=>document.documentElement.hasAttribute('data-tv')),true);
    await p.goto(base+'/settings#device');await p.getByRole('combobox',{name:'TV 리모컨 모드'}).waitFor();
    await p.getByRole('combobox',{name:'TV 리모컨 모드'}).click();await p.getByRole('option',{name:'항상 켜기',exact:true}).click();
    await p.goto(base+'/settings/tabs');await p.getByRole('button',{name:'홈 편집',exact:true}).focus();await p.keyboard.press('Enter');
    const dialog=p.getByRole('dialog',{name:'홈 탭 편집'});await dialog.waitFor();
    await p.waitForFunction(()=>document.activeElement?.closest('[role="dialog"]'));
    for(const key of ['ArrowDown','ArrowDown','ArrowRight','ArrowLeft']) {
      await p.keyboard.press(key); assert.ok(await p.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')));
    }
    await p.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:461,bubbles:true})));
    await p.waitForFunction(()=>!document.querySelector('[role="dialog"]'));
    await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='홈 편집');
    await p.goto(base+'/settings#device');await p.getByRole('combobox',{name:'TV 리모컨 모드'}).click();await p.getByRole('option',{name:'끄기',exact:true}).click();await p.reload();
    await p.getByRole('combobox',{name:'TV 리모컨 모드'}).waitFor();
    assert.equal(await p.getByRole('combobox',{name:'TV 리모컨 모드'}).textContent(),'끄기');
    assert.equal(await p.evaluate(()=>document.documentElement.hasAttribute('data-tv')),false);
    results.push('Profile entry, automatic mode, settings dialog trapping, LG Back and device preference persistence');await f.close();
  }
  for (const mobile of [false,true]) {
    const f=await fixture({path:'/',mobile}),p=f.page;
    await p.locator('.row-track a').first().focus();await p.keyboard.press('Enter');await p.waitForURL('**/title/m1');
    await p.locator('.title-page:not(.title-skeleton)').waitFor();
    const back=p.getByRole('button',{name:'이전 화면',exact:true});await back.waitFor();
    const box=await back.boundingBox();assert.ok(box.y>=0&&box.x>=0);
    await p.waitForTimeout(600);await p.screenshot({path:output+`/detail-${mobile?'mobile':'desktop'}.png`});
    await back.focus();await p.keyboard.press('Enter');await p.waitForURL(base+'/');
    results.push(`Visible detail Back button: ${mobile?'mobile':'desktop'}`);await f.close();
  }
  assert.deepEqual(errors,[]);
  await writeFile(output+'/results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));
} finally {await browser.close();}
