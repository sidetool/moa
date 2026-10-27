// Real Chromium multi-touch input against local video/API fixtures.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH||'playwright-core');
const base=process.env.MOA_VERIFY_URL||'http://127.0.0.1:18795',bytes=await readFile(process.env.MOA_TEST_VIDEO);
const browser=await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});const context=await browser.newContext({hasTouch:true,viewport:process.env.MOA_LANDSCAPE?{width:844,height:390}:{width:390,height:844}});await context.addInitScript(()=>localStorage.setItem('moa.profile','test'));
const p=await context.newPage(),calls=[],errors=[];p.on('pageerror',e=>errors.push(String(e)));p.setDefaultTimeout(20000);
await context.route('**/fixture/fail.mp4',r=>r.fulfill({status:404}));
await context.route('**/fixture/ko.vtt',r=>r.fulfill({contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:09:59.000\n자막 위치 확인\n'}));
await context.route('**/fixture/pass.mp4',r=>{const match=r.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/),start=Number(match?.[1]||0),end=Math.min(bytes.length-1,match?.[2]?Number(match[2]):bytes.length-1);return r.fulfill({status:match?206:200,contentType:'video/mp4',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});});
await context.route(u=>u.pathname.startsWith('/api/'),r=>{
 const path=new URL(r.request().url()).pathname,method=r.request().method();
 if(path==='/api/playback'&&method==='POST'){const body=r.request().postDataJSON();calls.push(body);const id=body.streamId||'1';return r.fulfill({json:{sessionId:'s'+calls.length,episodeId:body.episodeId,mediaId:'m',mediaTitle:'시험 영상',mediaType:'anime',streams:[{id:'0',label:'서버 1'},{id:'1',label:'서버 2'}],streamId:id,mode:'direct',mime:'video/mp4',url:id==='0'?'/fixture/fail.mp4':'/fixture/pass.mp4',duration:600,startPosition:body.startPosition||0,subtitles:[{id:'ko',label:'한국어',lang:'ko',format:'vtt',url:'/fixture/ko.vtt'}],audioTracks:[],next:null}});}
 if(path.endsWith('/markers'))return r.fulfill({json:{status:'matched',markers:{introStart:20,introEnd:80,creditsStart:480,creditsEnd:540}}});
 if(path==='/api/settings')return r.fulfill({json:{defaultSubtitleLang:'ko',autoFetchSubtitles:false,autoplayNext:true}});
 if(path==='/api/episodes/ep/context')return r.fulfill({json:{mediaId:'m',season:1,number:2}});
 if(path==='/api/media/m/group')return r.fulfill({json:{id:'g',members:[{id:'m',provider:{name:'원래 소스'}},{id:'other',provider:{name:'다른 소스'}}]}});
 if(path==='/api/media/other')return r.fulfill({json:{id:'other',seasons:[{number:1,episodes:[{id:'other-1',season:1,number:1,title:'1화'},{id:'other-2',season:1,number:2,title:'2화'}]}]}});
 if(path==='/api/media/m')return r.fulfill({json:{id:'m',title:'시험 영상',type:'anime',provider:{id:'remote',name:'소스',kind:'mangayomi-js'},seasons:[],playTarget:null}});
 return r.fulfill({status:204});
});


await context.addInitScript(()=>{
 window.fullscreenRequests=0;
 Element.prototype.requestFullscreen=function(){window.fullscreenRequests++;return Promise.resolve();};
});
try {
 await p.goto(base+'/watch/ep');await p.waitForFunction(()=>document.querySelector('video')?.currentTime>1);
 await p.locator('video').evaluate(v=>{v.pause();v.currentTime=200;});
 await p.waitForFunction(()=>!document.querySelector('video').seeking);
 const cdp=await context.newCDPSession(p), results=[];
 const viewport=p.viewportSize(), cx=viewport.width/2, cy=viewport.height/2, surfaceY=cy-85;
 const leftBox=await p.locator('.player-center [aria-label="10초 뒤로"]').boundingBox();
 const rightBox=await p.locator('.player-center [aria-label="10초 앞으로"]').boundingBox();
 const lx=leftBox.x+leftBox.width/2, rx=rightBox.x+rightBox.width/2;
 await p.evaluate(()=>{window.cancels=0;document.addEventListener('pointercancel',()=>window.cancels++,true);});
 const touch=(id,x,y)=>({id,x,y,radiusX:5,radiusY:5,force:1});
 const send=(type,touchPoints)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints});
 const gesture=async(name,points,out)=>{
  const before=await p.locator('video').evaluate(v=>v.currentTime);
  await send('touchStart',points.map((a,i)=>touch(i+1,...a)));
  for(let n=1;n<=8;n++)await send('touchMove',points.map(([x,y],i)=>touch(i+1,x+(i?1:-1)*n*(out?7:-7),y)));
  await send('touchEnd',[]);await p.waitForTimeout(350);
  assert.equal(await p.locator('.player.is-fill').count(),Number(out),name);
  assert.equal(await p.locator('video').evaluate(v=>v.paused),true,name+' must not click play');
  assert.ok(Math.abs(await p.locator('video').evaluate(v=>v.currentTime)-before)<.1,name+' must not click seek');
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('moa.deviceSettings:test')).value.videoFill),out);
  results.push(name);
 };
 await gesture('pinch over both seek buttons',[[lx,cy],[rx,cy]],true);
 await gesture('pinch inward over seek buttons',[[lx,cy],[rx,cy]],false);
 await gesture('pinch from play button and surface',[[cx,cy],[cx+100,surfaceY]],true);
 await gesture('pinch inward on video surface',[[lx,surfaceY],[rx,surfaceY]],false);
 assert.equal(await p.evaluate(()=>window.cancels),0,'browser must not take over zoom');
 // Single buttons still receive their normal click after a pinch.
 const at=await p.locator('video').evaluate(v=>v.currentTime);
 await p.locator('.player-center [aria-label="10초 앞으로"]').tap();
 assert.ok(Math.abs(await p.locator('video').evaluate(v=>v.currentTime)-at-10)<.1);
 await p.locator('.center-play').tap();await p.waitForFunction(()=>!document.querySelector('video').paused);
 await p.locator('.center-play').tap();await p.waitForFunction(()=>document.querySelector('video').paused);
 results.push('single seek and play/pause after pinch');
 const prior=await p.locator('video').evaluate(v=>v.currentTime);
 await send('touchStart',[touch(1,viewport.width*.85,surfaceY)]);await send('touchEnd',[]);
 await send('touchStart',[touch(1,viewport.width*.85,surfaceY)]);await send('touchEnd',[]);
 await p.waitForTimeout(100);
 assert.ok(Math.abs(await p.locator('video').evaluate(v=>v.currentTime)-prior-10)<.1);
 await p.locator('.player-surface').dispatchEvent('dblclick',{bubbles:true});
 assert.equal(await p.evaluate(()=>window.fullscreenRequests),0,'touch dblclick must not enter fullscreen');
 results.push('surface double tap seeks without fullscreen');
 await p.waitForTimeout(300);
 await send('touchStart',[touch(1,cx,surfaceY)]);await send('touchEnd',[]);
 await send('touchStart',[touch(1,cx,surfaceY)]);await send('touchEnd',[]);
 await p.locator('.player-surface').dispatchEvent('dblclick',{bubbles:true});
 assert.equal(await p.evaluate(()=>window.fullscreenRequests),1,'center double tap requests fullscreen exactly once');
 results.push('center double tap keeps fullscreen gesture');
 // Switching from hold to two fingers must release boost immediately.
 await p.locator('video').evaluate(v=>v.play());
 await send('touchStart',[touch(1,lx,surfaceY)]);await p.waitForTimeout(550);
 assert.equal(await p.locator('video').evaluate(v=>v.playbackRate),2);
 await send('touchStart',[touch(1,lx,surfaceY),touch(2,rx,surfaceY)]);
 assert.equal(await p.locator('video').evaluate(v=>v.playbackRate),1);
 await send('touchCancel',[]);await p.locator('video').evaluate(v=>v.pause());
 await gesture('new gesture after cancellation',[[lx,surfaceY],[rx,surfaceY]],true);
 results.push('hold to pinch restores speed');
 // Cancelling a gesture must not leave a stuck pointer or suppress the next tap.
 await p.locator('.center-play').tap();await p.waitForFunction(()=>!document.querySelector('video').paused);
 await p.mouse.dblclick(cx,surfaceY);
 assert.equal(await p.evaluate(()=>window.fullscreenRequests),2,'mouse double click still requests fullscreen');
 await p.getByRole('button',{name:'전체 화면 (F)',exact:true}).click();
 assert.equal(await p.evaluate(()=>window.fullscreenRequests),3,'explicit fullscreen button remains available');
 results.push('desktop double click and fullscreen button');
 // Empty space inside the control bands belongs to the video: a tap there toggles the UI.
 await p.locator('video').evaluate(v=>v.pause());await p.waitForTimeout(350);
 const idle=()=>p.locator('.player.is-idle').count();
 const tapAt=async(x,y)=>{await send('touchStart',[touch(1,x,y)]);await send('touchEnd',[]);await p.waitForTimeout(450);};
 if(await idle())await tapAt(cx,surfaceY);
 assert.equal(await idle(),0,'controls visible before band taps');
 const bottom=await p.locator('.player-bottom').boundingBox();
 const time=await p.locator('.player-time').boundingBox();
 for(const [name,x,y] of [['bottom gradient',cx,bottom.y+12],['control row gap',viewport.width>viewport.height?time.x+time.width+40:time.x-24,time.y+time.height/2],['between center buttons',(lx+cx)/2-10,cy]]){
  await tapAt(x,y);assert.equal(await idle(),1,name+' hides controls');
  await tapAt(x,y);assert.equal(await idle(),0,name+' shows controls again');
 }
 assert.equal(await p.locator('video').evaluate(v=>v.paused),true,'band taps must not toggle playback');
 results.push('taps in empty control areas toggle the UI');
 // Auto skip (device setting) jumps over a known opening once.
 await p.evaluate(async()=>{const {saveDevicePrefs}=await import('/src/lib/device-prefs.ts');await saveDevicePrefs({autoSkip:true,seekStep:5});});
 await p.reload();await p.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
 assert.equal(await p.locator('.player-center [aria-label="5초 앞으로"]').count(),1,'seek step setting labels the buttons');
 await p.locator('video').evaluate(v=>{v.currentTime=21;return v.play();});
 await p.waitForFunction(()=>document.querySelector('video').currentTime>=79,null,{timeout:8000});
 results.push('auto skip and seek step settings');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,results,errors},null,2));
}finally{await browser.close();}
