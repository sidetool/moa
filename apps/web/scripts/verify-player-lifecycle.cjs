const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'), assert=require('assert/strict');
(async()=>{
 assert.ok(process.env.MOA_PLAYER_FIXTURE, 'Set MOA_PLAYER_FIXTURE to a generated MP4');
 const {verificationPath}=await import('./verification-path.mjs');
 const browser=await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();const errors=[],events=[];let count=0,heartbeat=0,fail=false,transient=false,runtime=true;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:5188/fixture.mp4',r=>{const bytes=fs.readFileSync(process.env.MOA_PLAYER_FIXTURE);const range=/bytes=(\d+)-(\d*)/.exec(r.request().headers().range||'');if(!range)return r.fulfill({contentType:'video/mp4',body:bytes,headers:{'Accept-Ranges':'bytes'}});const from=+range[1],to=range[2]?+range[2]:bytes.length-1;return r.fulfill({status:206,contentType:'video/mp4',body:bytes.subarray(from,to+1),headers:{'Content-Range':`bytes ${from}-${to}/${bytes.length}`,'Accept-Ranges':'bytes'}});});
 await page.route('http://127.0.0.1:5188/api/**',async r=>{
  const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON(),method=req.method();
  const json=x=>r.fulfill({json:x});
  if(path==='/api/plugins'||path==='/api/plugin-runtime'||path.endsWith('/subtitles/translations'))return json([]);
  if(path==='/api/me')return json({role:'admin'});
  if(path.endsWith('/markers'))return json({markers:null,status:'unavailable'});
  if(path==='/api/playback'&&method==='POST'){
   events.push({type:'create',episode:body.episodeId,at:body.startPosition||0,clock:Date.now()});
   if(body.episodeId==='e4')await new Promise(r=>setTimeout(r,600));
   return json({sessionId:'s'+(++count),episodeId:body.episodeId,mediaId:'m',mediaTitle:'회복 검증',mediaType:'movie',mode:'direct',url:'/fixture.mp4',mime:'video/mp4',duration:120,startPosition:body.startPosition||0,subtitles:[],audioTracks:[],runtimeDependent:runtime,next:{episodeId:'e2',title:'다음 화',label:'2화'}});
  }
  if(path.endsWith('/heartbeat')){heartbeat++;return fail||transient?r.fulfill({status:transient?503:409,json:{error:transient?'temporary':'playback-restart-required'}}):r.fulfill({status:204});}
  if(method==='DELETE'){events.push({type:'release-start',clock:Date.now()});await new Promise(r=>setTimeout(r,250));events.push({type:'release-end',clock:Date.now()});return r.fulfill({status:204});}
  if(path==='/api/settings')return json({autoplayNext:false,autoFetchSubtitles:false,defaultSubtitleLang:'off',subtitleSize:'medium'});
  if(path==='/api/media/m')return json({id:'m',title:'검증',type:'movie',seasons:[],provider:{id:'test',name:'test'}});
  if(method==='POST')return r.fulfill({status:204});
  if(path.endsWith('/group'))return json({members:[]});
  return r.fulfill({status:204});
 });
 const ready=()=>page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=3},null,{timeout:15000});
 try{
 await page.goto('http://127.0.0.1:5188/tests/fixtures/player.html');await ready();
 await page.waitForFunction(()=>document.querySelector('video').currentTime>1);
 transient=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(200);assert.equal(count,1);transient=false;
 await page.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=24;});await page.waitForTimeout(200);
 fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));

 await page.waitForTimeout(900);fail=false;await ready();
 assert.equal(count,2);const recover=events.filter(e=>e.type==='create')[1];assert.ok(Math.abs(recover.at-24)<1);
 const state=await page.evaluate(()=>({paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime}));assert.equal(state.paused,true);assert.ok(Math.abs(state.time-24)<1);
 const end=events.findIndex(e=>e.type==='release-end'),created=events.findIndex((e,i)=>i>0&&e.type==='create');assert.ok(end<created);
 fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(500);assert.equal(count,2);assert.ok(await page.getByRole('button',{name:'다시 시도',exact:true}).isVisible());
 fail=false;await page.evaluate(()=>{window.originalHost=document.querySelector('.watch-fullscreen-host');window.testNavigate('/watch/e2');});await page.waitForTimeout(900);await ready();assert.equal(count,3);
 assert.equal(await page.evaluate(()=>window.originalHost===document.querySelector('.watch-fullscreen-host')),true);
 runtime=false;await page.evaluate(()=>window.testNavigate('/watch/e3'));await page.waitForTimeout(900);await ready();const before=heartbeat;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(200);assert.equal(heartbeat,before);
 runtime=true;await page.evaluate(()=>window.testNavigate('/watch/e4'));await page.waitForTimeout(150);assert.equal(events.at(-1).episode,'e4');
 await page.evaluate(()=>window.testNavigate('/watch/e5'));await page.waitForTimeout(1200);await ready();
 const e5=events.findIndex(e=>e.type==='create'&&e.episode==='e5');assert.equal(events[e5-1].type,'release-end');
 assert.deepEqual(errors,[]);
 const result={passed:true,pausedRecovery:state,recoveryStartPosition:recover.at,automaticRetryLimit:1,releaseBeforeCreate:true,fullscreenHostPreserved:true,ordinaryPlaybackHeartbeat:false,cancelledCreationReleasedBeforeNext:true,events,errors};
 fs.writeFileSync(process.env.MOA_PLAYER_REPORT||verificationPath('verification-lifecycle-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
