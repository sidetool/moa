import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Actual API + browser; Gemini, online search and Jimaku responses are fixtures. No paid requests.
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,copyFile,stat,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildApp} from '../src/app.js';
import {createServer} from '../../web/node_modules/vite/dist/node/index.js';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
assert.ok(process.env.MOA_TEST_VIDEO, 'MOA_TEST_VIDEO must point to a small playable MP4');
const dir=await mkdtemp(join(process.env.MOA_VERIFY_TMPDIR || tmpdir(),'verification-advanced-')),media=dir+'/media';await mkdir(media);
await copyFile(process.env.MOA_TEST_VIDEO!,media+'/test.mp4');
const content='WEBVTT\n\n00:00:00.000 --> 00:00:25.000\nHello world\n';await writeFile(media+'/test.en.vtt',content);
const env=await buildApp({dataDir:dir,mediaRoot:media,webDir:dir+'/web'},false,{tmdb:{token:'',key:''},aniSkip:{async lookup(){return {match:null,intervals:[],markers:null};}},translationFetch:async(_url,init)=>{const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({lines:data.lines.map((l:any)=>({id:l.id,text:'번역된 대사'}))})}]}}]});}});
const address=await env.app.listen({host:'127.0.0.1',port:0});env.translations.configure({apiKey:'fake-advanced-test-key',enabled:true,requestIntervalMs:0,retryCount:0});
const info=await stat(media+'/test.mp4');
env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','m','Test','anime','{}','2026');
env.db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','e','m',1,1,'Episode',30,null);
env.db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)','e',media+'/test.mp4',info.size,info.mtimeMs,'',JSON.stringify({duration:30,container:'mp4',streams:[{index:0,codec_type:'video',codec_name:'h264',width:320,height:180}]}),JSON.stringify([media+'/test.en.vtt']));
delete process.env.VITE_MOCK;
const root=fileURLToPath(new URL('../../web', import.meta.url));
const vite=await createServer({root,configFile:root+'/vite.config.ts',cacheDir:dir+'/vite-cache',logLevel:'error',server:{host:'127.0.0.1',port:0,proxy:{'/api':address}}});await vite.listen();
const browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']}),results:any[]=[],errors:string[]=[];
const cases:any[]=[
 {name:'unknown-protected',label:'사이트 자막',skip:true,priority:'site',expect:'none',online:0},
 {name:'unknown-jimaku-protected',label:'사이트 자막',skip:true,priority:'jimaku',expect:'none',online:0},
 {name:'english-label',label:'English CC',skip:true,priority:'site',expect:'site',online:1},
 {name:'japanese-label',label:'日本語',skip:true,priority:'site',expect:'site',online:1},
 {name:'jimaku-priority',label:'English',skip:true,priority:'jimaku',expect:'jimaku',online:1},
 {name:'jimaku-empty-fallback',label:'English',skip:true,priority:'jimaku',empty:true,expect:'site',online:1},
 {name:'jimaku-error-fallback',label:'English',skip:true,priority:'jimaku',error:true,expect:'site',online:1},
 {name:'unknown-opt-out',label:'사이트 자막',skip:false,priority:'site',expect:'site',online:1},
 {name:'korean',label:'Korean',skip:false,priority:'jimaku',expect:'none',online:0},
 {name:'no-tracks-auto',noTracks:true,skip:false,priority:'site',expect:'none',online:1},
 {name:'no-tracks-ask',noTracks:true,mode:'ask',skip:false,priority:'jimaku',expect:'none',online:1},
 {name:'no-tracks-opt-out',noTracks:true,protect:false,skip:true,priority:'site',expect:'jimaku',online:1},
 {name:'no-tracks-manual',noTracks:true,manual:true,skip:false,priority:'jimaku',expect:'none',online:1},
];
try{
for(const c of cases.filter(c=>!process.env.MOA_CASES||process.env.MOA_CASES.split(',').includes(c.name))){
 console.log('CASE',c.name);
 // Do not allow completed translations from an earlier fixture to bypass selection.
 env.db.run('DELETE FROM translated_subtitles');
 const p=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:c.name}})).json();
 const headers={'x-moa-profile':p.id};await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{translationMode:c.mode??'auto',...(c.protect===undefined?{}:{skipTranslationWithoutSubtitles:c.protect}),autoFetchSubtitles:true,translationSourcePriority:c.priority,skipSubtitleSearchWithSiteTrack:c.skip}});
 const page=await browser.newPage();page.on('pageerror',(e:any)=>errors.push(e.message));await page.addInitScript((id:string)=>{localStorage.setItem('moa.profile',id);localStorage.setItem('moa.fullscreenOnPlay','0');},p.id);
 let online=0,jimaku=0,site=0,translated=0;
 await page.route('**/api/playback',async(route:any)=>{const res=await route.fetch();const data=await res.json();data.subtitles=c.noTracks?[]:data.subtitles.slice(0,1).map((t:any)=>({...t,label:c.label,lang:undefined,source:'extension'}));await route.fulfill({response:res,json:data});});
 await page.route('**/api/episodes/e/subtitles/translations', (route:any)=>route.fulfill({json:[]}));
 await page.route('**/api/episodes/e/subtitles/online*', (route:any)=>{online++;return route.fulfill({json:{searchId:'online',resolvedTitle:'Test',candidates:[],partial:false,expiresAt:Date.now()+60000}});});
 await page.route('**/api/episodes/e/subtitles/jimaku**',async(route:any)=>{
  if(route.request().method()==='POST'){
   translated++;const job=await env.app.inject({method:'POST',url:'/api/episodes/e/subtitles/translate',headers,payload:{content,format:'vtt',sourceLabel:'Jimaku source',sourceLanguage:'ja'}});return route.fulfill({status:job.statusCode,contentType:'application/json',body:job.body});
  }
  jimaku++;return route.fulfill(c.error?{status:502,json:{error:'jimaku-unavailable'}}:{json:{searchId:'jimaku',query:{title:'Test',season:1,episode:1},candidates:c.empty?[]:[{id:'candidate',filename:'Test 01.srt',format:'srt',match:'episode',sourceUrl:'https://example.org/subtitles/9001',size:100}],expiresAt:Date.now()+60000}});
 });
 page.on('request',(r:any)=>{if(new URL(r.url()).pathname==='/api/episodes/e/subtitles/translate')site++;});
 await page.goto(vite.resolvedUrls!.local[0]+'watch/e');await page.locator('video').waitFor();
 if(c.expect==='none'){await page.waitForTimeout(2500);assert.equal(site+translated+jimaku,0);assert.equal(online,c.online);assert.equal(await page.locator('.translate-offer').count(),0);}
 else {await page.waitForFunction(()=>[...document.querySelector('video')!.textTracks].some(t=>t.mode==='showing'&&[...t.cues||[]].some(q=>(q as VTTCue).text==='번역된 대사')),null,{timeout:15000});assert.equal(site,c.expect==='site'?1:0);assert.equal(translated,c.expect==='jimaku'?1:0);assert.equal(jimaku,c.priority==='jimaku'||c.noTracks?1:0);assert.equal(online,c.online);assert.equal(await page.locator('.translate-offer').count(),0);}
 if(c.manual){
  await page.mouse.move(300,250);await page.getByRole('button',{name:'자막 및 음성',exact:true}).click();
  await page.getByRole('button',{name:/한국어로 번역/}).click();
  await page.getByRole('radio',{name:/Test 01.srt/}).waitFor();
  // Dev StrictMode can replay and abort the mount search; no search happened before opening the panel.
  assert.ok(jimaku>=1);assert.equal(translated,0);
  await page.getByRole('button',{name:'번역 시작',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelector('video')!.textTracks].some(t=>t.mode==='showing'&&[...t.cues||[]].some(q=>(q as VTTCue).text==='번역된 대사')),null,{timeout:15000});
  assert.equal(translated,1);
 }
 results.push({name:c.name,online,jimaku,site,translated});await page.close();await env.app.inject({method:'DELETE',url:'/api/profiles/'+p.id});
}
const profile=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'Settings'}})).json();
const settingsPage=await browser.newPage({viewport:{width:390,height:844}});
settingsPage.on('pageerror',(error:any)=>errors.push(error.message));
await settingsPage.addInitScript((id:string)=>localStorage.setItem('moa.profile',id),profile.id);
await settingsPage.goto(vite.resolvedUrls!.local[0]+'settings#subtitles');
const advanced=settingsPage.getByRole('button',{name:/자막 고급설정/});await advanced.waitFor();
assert.equal(await advanced.getAttribute('aria-expanded'),'false');
assert.equal(await settingsPage.getByLabel('번역 요청 간격(초)',{exact:true}).count(),0);
await advanced.click();
const interval=settingsPage.getByLabel('번역 요청 간격(초)',{exact:true});await interval.fill('1.5');
const spacingSaved=settingsPage.waitForResponse((r:any)=>r.request().method()==='PATCH'&&r.url().endsWith('/admin/translation/config'));
await interval.press('Tab');assert.equal((await spacingSaved).status(),200);
await settingsPage.getByRole('status').filter({hasText:'요청 간격을 1.5초로 저장했어요.'}).waitFor();
assert.equal(env.translations.config().requestIntervalMs,1500);
const retriesSaved=settingsPage.waitForResponse((r:any)=>r.request().method()==='PATCH'&&r.url().endsWith('/admin/translation/config'));
await settingsPage.getByRole('combobox',{name:'실패 시 다시 시도',exact:true}).click();await settingsPage.getByRole('option',{name:'4회',exact:true}).click();assert.equal((await retriesSaved).status(),200);
assert.equal(env.translations.config().retryCount,4);
const prioritySaved=settingsPage.waitForResponse((r:any)=>r.request().method()==='PATCH'&&r.url().endsWith('/api/settings'));
await settingsPage.getByRole('radio',{name:'Jimaku 먼저',exact:true}).click();assert.equal((await prioritySaved).status(),200);
assert.equal(env.db.settings(profile.id).translationSourcePriority,'jimaku');
assert.equal(await settingsPage.getByRole('switch',{name:'사이트 자막이 있으면 자동 검색 안 함',exact:true}).getAttribute('aria-checked'),'true');
const skipSaved=settingsPage.waitForResponse((r:any)=>r.request().method()==='PATCH'&&r.url().endsWith('/api/settings'));
await settingsPage.getByRole('switch',{name:'사이트 자막이 있으면 자동 검색 안 함',exact:true}).click();assert.equal((await skipSaved).status(),200);
assert.equal(env.db.settings(profile.id).skipSubtitleSearchWithSiteTrack,false);
const noSubsSwitch=settingsPage.getByRole('switch',{name:'자막이 없는 영상은 자동 번역 안 함',exact:true});
assert.equal(await noSubsSwitch.getAttribute('aria-checked'),'true');
const noSubsSaved=settingsPage.waitForResponse((r:any)=>r.request().method()==='PATCH'&&r.url().endsWith('/api/settings'));
await noSubsSwitch.click();assert.equal((await noSubsSaved).status(),200);
assert.equal(env.db.settings(profile.id).skipTranslationWithoutSubtitles,false);
await settingsPage.reload();await settingsPage.getByRole('button',{name:/자막 고급설정/}).click();
assert.equal(await noSubsSwitch.getAttribute('aria-checked'),'false');
assert.equal(env.db.settings(profile.id).skipSubtitleSearchWithSiteTrack,false);

assert.equal(await settingsPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
await settingsPage.screenshot({path:process.env.MOA_VERIFY_SCREENSHOT || join(dir,'settings.png')});
await settingsPage.close();
assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,results,settingsSaved:true,collapsedDefault:true,mobileOverflow:false,errors}));
}finally{await browser.close();await vite.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
