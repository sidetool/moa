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
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
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
  let device = { fullscreenOnPlay: true, ...options.device };
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
    if (path === '/api/me') return json({ id: 'admin', role: 'admin' });
    if (path === '/api/plugin-runtime') return json([]);
    if (path === '/api/settings/device') { if (req.method() === 'PATCH') device = { ...device, ...req.postDataJSON().settings }; return json({ settings: device }); }
    if (path.endsWith('/markers')) return json({ status: 'unavailable' });
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
    if (/^\/api\/media\/m[0-9]+$/.test(path)) return json({ id: 'm1', title: '플레이어 검증', type: 'anime', provider: { id: 'local', name: '로컬', kind: 'local' }, playTarget:{episodeId:'e1',position:0}, seasons: [{ number: 1, episodes: [{ id: 'e1', number: 1, title: '첫 번째 회차' }, { id: 'e2', number: 2, title: '두 번째 회차' }] }] });
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
 for (const mobile of [false,true]) {
  const f=await fixture({path:'/title/m1',mode:'off',mobile}),p=f.page;
  await p.locator('.title-hero-copy .hero-actions button').first().click();
  await p.waitForURL('**/watch/e1');
  await p.waitForFunction(()=>!!document.fullscreenElement);
  await p.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
  await p.evaluate(()=>document.exitFullscreen());
  await p.locator('video').evaluate(v=>v.pause());
  const button=p.getByRole('button',{name:'전체 화면 (F)',exact:true});
  await button.waitFor();
  const box=await button.boundingBox(),viewport=p.viewportSize();
  assert.ok(box.x>=0 && box.x+box.width<=viewport.width && box.y+box.height<=viewport.height,'Fullscreen within portrait viewport');
  assert.ok(await button.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),'Fullscreen unobstructed');
  await button.click();await p.waitForFunction(()=>!!document.fullscreenElement);
  await p.getByRole('button',{name:'다음 화 (N)',exact:true}).click();await p.waitForURL('**/watch/e2');
  await p.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
  assert.equal(await p.evaluate(()=>!!document.fullscreenElement),true);
  await p.goBack();await p.waitForFunction(()=>!document.fullscreenElement);
  results.push((mobile?'Mobile':'Desktop')+': play enters fullscreen; button visible; next preserves fullscreen; Back exits');await f.close();
 }
 const home=await fixture({path:'/',mode:'off'});
 await home.page.locator('.hero-actions button').first().click();
 await home.page.waitForURL('**/watch/e1');await home.page.waitForFunction(()=>!!document.fullscreenElement && document.querySelector('video')?.currentTime>0);
 await home.page.goBack();await home.page.waitForFunction(()=>!document.fullscreenElement);
 results.push('Home play redirect preserves initial fullscreen through asynchronous resolution');await home.close();
 const f=await fixture({path:'/title/m1',mode:'off'}),p=f.page;
 await p.evaluate(()=>{document.documentElement.requestFullscreen=()=>Promise.reject(new DOMException('Denied','NotAllowedError'));});
 await p.locator('.title-hero-copy .hero-actions button').first().click();
 await p.waitForURL('**/watch/e1');await p.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
 assert.equal(await p.evaluate(()=>!!document.fullscreenElement),false);
 results.push('Denied fullscreen still plays inline');await f.close();
 const off=await fixture({path:'/title/m1',mode:'off',device:{fullscreenOnPlay:false}});
 await off.page.locator('.title-hero-copy .hero-actions button').first().click();
 await off.page.waitForURL('**/watch/e1');await off.page.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
 assert.equal(await off.page.evaluate(()=>!!document.fullscreenElement),false,'setting off keeps inline playback');
 results.push('Fullscreen-on-play setting off plays inline');await off.close();
 assert.deepEqual(errors,[]);
} finally {await browser.close();}
