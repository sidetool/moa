// Loopback player regression: simulate metadata/reconnection without external media.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH||'playwright-core');
process.env.VITE_MOCK='0';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'error',plugins:process.env.MOA_REPRO_OLD ? [{name:'original-player',enforce:'pre',load(id){if(id.endsWith('/pages/WatchPage.tsx'))return execFileSync('git',['show','HEAD:apps/web/src/pages/WatchPage.tsx'],{encoding:'utf8'});}}] : [],server:{host:'127.0.0.1',port:0,proxy:{}}});
await server.listen();const base=server.resolvedUrls.local[0],origin=new URL(base).origin;
const browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE});
const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});const page=await context.newPage(),errors=[],queries=[];
let sessions=0;
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
await context.addInitScript(()=>{
 localStorage.setItem('moa.profile','viewer');localStorage.setItem('moa.fullscreenOnPlay','0');
 // Keep the actual React player/engine, replace only the media decoder clock.
 const p=HTMLMediaElement.prototype;
 Object.defineProperty(p,'src',{configurable:true,get(){return this.dataset.src||'';},set(v){this.dataset.src=v;}});
 Object.defineProperty(p,'duration',{configurable:true,get(){return Number(this.dataset.duration||0);}});
 Object.defineProperty(p,'currentTime',{configurable:true,get(){return Number(this.dataset.time||0);},set(v){this.dataset.time=String(v);}});
 Object.defineProperty(p,'paused',{configurable:true,get(){return this.dataset.playing !== '1';}});
 p.play=async function(){this.dataset.playing='1';this.dispatchEvent(new Event('play'));};p.pause=function(){this.dataset.playing='0';this.dispatchEvent(new Event('pause'));};p.load=function(){};
});
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url()),path=u.pathname,json=v=>route.fulfill({json:v});
 if(u.origin!==origin)return route.abort();
 if(!path.startsWith('/api/'))return route.continue();
 if(path==='/api/me')return json({id:'viewer',role:'admin'});
 if(path==='/api/profiles')return json([{id:'viewer',name:'Viewer',color:'blue',kids:false}]);
 if(path==='/api/settings')return json({defaultSubtitleLang:'off',autoFetchSubtitles:false,autoplayNext:false,navigation:[]});
 if(path==='/api/plugin-runtime')return json([]);
 if(path==='/api/translation/config')return json({enabled:false,configured:false});
 if(path==='/api/playback'&&req.method()==='POST')return json({sessionId:'s'+(++sessions),episodeId:'ep',mediaId:'m',mediaTitle:'Fixture',mediaType:'anime',streams:[{id:'0',label:'Fixture'}],streamId:'0',mode:'direct',mime:'video/mp4',url:'/fixture.mp4',duration:0,startPosition:25,subtitles:[],audioTracks:[],next:null});
 if(path==='/api/media/m')return json({id:'m',title:'Fixture',type:'anime',seasons:[]});
 if(path==='/api/episodes/ep/markers'){
  queries.push({duration:Number(u.searchParams.get('duration')),session:sessions});
  const count=queries.filter(q=>q.session===sessions).length;
  return json(count>2?{status:'error',markers:null}:{status:'matched',markers:count===2?{creditsStart:480,creditsEnd:550}:{introStart:10,introEnd:90,creditsStart:480,creditsEnd:550}});
 }
 if(path.endsWith('/subtitles/preference'))return json({});
 if(path.endsWith('/subtitles/uploads')||path.includes('/translations'))return json([]);
 return route.fulfill({status:204});
});
const metadata=async length=>page.locator('video').evaluate((v,length)=>{v.dataset.duration=String(length);v.currentTime=25;v.dispatchEvent(new Event('loadedmetadata'));v.dispatchEvent(new Event('timeupdate'));v.dispatchEvent(new Event('canplay'));},length);
try{
 await page.goto(base+'watch/ep',{waitUntil:'commit'});await page.waitForFunction(()=>document.querySelector('video')?.dataset.src);
 await page.waitForTimeout(200);
 assert.equal(queries.length,0,'wait for decoded duration');
 await metadata(600);await page.locator('.seek-intro').waitFor();
 assert.equal(await page.locator('.seek-marker').count(),2);
 await metadata(580);await page.waitForFunction(()=>document.querySelector('.seek-credits')?.style.left.startsWith('82.'));
 await page.waitForTimeout(150);
 if(process.env.MOA_REPRO_OLD){
  assert.equal(await page.locator('.seek-intro').count(),0);
  assert.equal(await page.locator('.seek-credits').count(),1);
  assert.deepEqual(queries.map(q=>q.duration),[600,580]);
  console.log('REPRODUCED: partial AniSkip refresh removes a previously matched opening');
 }else{
  assert.equal(await page.locator('.seek-marker').count(),2,'partial response preserves the known opening');
  await metadata(581);await page.waitForTimeout(150);
  assert.equal(await page.locator('.seek-marker').count(),2,'failed refresh preserves known ranges');
  await metadata(581);await page.waitForTimeout(100);assert.equal(queries.length,3);
  await page.waitForTimeout(5200);
  assert.equal(await page.locator('.seek-marker').count(),2);
  if(await page.locator('.player.is-idle').count())await page.locator('.player-surface').tap();
  await page.getByRole('button',{name:'오프닝 건너뛰기',exact:true}).click();
  assert.equal(await page.locator('video').evaluate(v=>v.currentTime),90);
  assert.equal(await page.locator('.seek-marker').count(),2,'markers survive button auto-hide');
  await page.locator('video').evaluate(v=>v.dispatchEvent(new Event('error')));
  await page.locator('.player-error').getByRole('button',{name:'다시 시도',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video')?.dataset.src);
  await page.waitForTimeout(100);
  assert.equal(sessions,2);assert.equal(queries.length,3,'reconnect must not reuse previous metadata');
  assert.equal(await page.locator('.seek-marker').count(),0,'old session markers do not leak');
  await metadata(600);await page.locator('.seek-marker').first().waitFor();
  assert.deepEqual(queries,[{duration:600,session:1},{duration:580,session:1},{duration:581,session:1},{duration:600,session:2}]);
  assert.deepEqual(errors,[]);
  console.log('PASS: decoded duration, stable markers/skip control, reconnect isolation');
 }
}finally{await browser.close();await server.close();}
