import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base=process.env.MOA_VERIFY_URL || 'http://127.0.0.1:18795';
const bytes=await readFile(process.env.MOA_TEST_VIDEO);
const browser=await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});
const errors=[],results=[];
try { for(const live of [false,true]) {
  const context=await browser.newContext(); await context.addInitScript(()=>localStorage.setItem('moa.profile','test'));
  const page=await context.newPage(),streams=[],progress=[]; page.on('pageerror',e=>errors.push(String(e)));
  await context.route('**/fixture/fail.m3u8',r=>r.fulfill({status:404,body:'unavailable'}));
  await context.route('**/fixture/pass.mp4',r=>{ const match=r.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);const start=Number(match?.[1]||0),end=Math.min(bytes.length-1,match?.[2]?Number(match[2]):bytes.length-1);return r.fulfill({status:match?206:200,contentType:'video/mp4',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}}); });
  await context.route(u=>u.pathname.startsWith('/api/'),r=>{
    const path=new URL(r.request().url()).pathname,method=r.request().method();
    if(path.endsWith('/markers'))return r.fulfill({json:{markers:null,status:'unavailable'}});
    if(path==='/api/plugin-runtime')return r.fulfill({json:[]});
    if(path==='/api/playback' && method==='POST') { const body=r.request().postDataJSON(),id=body.streamId||'0'; streams.push(id); return r.fulfill({json:{sessionId:'session-'+id,episodeId:'ep',mediaId:'m',mediaTitle:'외부 영상',mediaType:'series',live,streams:[{id:'0',label:'서버 1'},{id:'1',label:'서버 2'}],streamId:id,mode:'direct',mime:id==='0'?'application/vnd.apple.mpegurl':'video/mp4',url:id==='0'?'/fixture/fail.m3u8':'/fixture/pass.mp4',duration:live?0:600,startPosition:0,subtitles:[],audioTracks:[],next:null}}); }
    if(path==='/api/settings')return r.fulfill({json:{defaultSubtitleLang:'off',autoFetchSubtitles:false,autoplayNext:true}});
    if(path==='/api/media/m')return r.fulfill({json:{id:'m',title:'외부 영상',type:'series',provider:{id:'remote',name:'소스',kind:'mangayomi-js'},seasons:[],playTarget:null}});
    if(path==='/api/progress'){progress.push(r.request().postDataJSON());}
    return r.fulfill({status:204});
  });
  await page.goto(base+'/watch/ep');
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v?.readyState>=3&&v.currentTime>0;},undefined,{timeout:30000}).catch(async error=>{console.error({streams,errors,body:await page.locator("body").textContent(),video:await page.evaluate(()=>{const v=document.querySelector("video");return v?{src:v.currentSrc,paused:v.paused,ready:v.readyState,error:v.error?.message}:null;})});throw error;});
  assert.deepEqual(streams,['0','1'],'fall back exactly once');
  await page.mouse.move(600,500);
  assert.equal(await page.getByRole('slider',{name:'재생 위치'}).count(),live?0:1);
  if(live){await page.keyboard.press('9');await page.keyboard.press('ArrowRight');assert.ok(await page.locator('video').evaluate(v=>v.currentTime)<10,'live keyboard must not seek'); await page.locator('video').evaluate(v=>{v.currentTime=30;v.dispatchEvent(new Event('timeupdate'));v.pause();});await page.waitForTimeout(300);assert.equal(progress.length,0);assert.equal(await page.locator('.next-card').count(),0);}
  results.push({live,streams,progressWrites:progress.length});await context.close();
} assert.deepEqual(errors,[]);console.log(JSON.stringify({results,errors},null,2)); }finally{await browser.close();}
