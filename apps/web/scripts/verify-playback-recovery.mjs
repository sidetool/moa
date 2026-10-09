import { verificationPath } from './verification-path.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH||'playwright-core');
const base=process.env.MOA_VERIFY_URL||'http://127.0.0.1:18795',bytes=await readFile(process.env.MOA_TEST_VIDEO);
const browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});const context=await browser.newContext({hasTouch:true,viewport:{width:390,height:844}});await context.addInitScript(()=>localStorage.setItem('moa.profile','test'));
const settings={defaultSubtitleLang:'ko',subtitleSize:'medium',autoFetchSubtitles:false,autoplayNext:true};
const p=await context.newPage(),calls=[],errors=[];p.on('pageerror',e=>errors.push(String(e)));p.setDefaultTimeout(20000);
await context.route('**/fixture/fail.mp4',r=>r.fulfill({status:404}));
await context.route('**/fixture/ko.vtt',r=>r.fulfill({contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:09:59.000\n자막 위치 확인\n'}));
await context.route('**/fixture/pass.mp4',r=>{const match=r.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/),start=Number(match?.[1]||0),end=Math.min(bytes.length-1,match?.[2]?Number(match[2]):bytes.length-1);return r.fulfill({status:match?206:200,contentType:'video/mp4',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});});
await context.route(u=>u.pathname.startsWith('/api/'),r=>{
 const path=new URL(r.request().url()).pathname,method=r.request().method();
 if(path==='/api/playback'&&method==='POST'){const body=r.request().postDataJSON();calls.push(body);const id=body.streamId||'0';return r.fulfill({json:{sessionId:'s'+calls.length,episodeId:body.episodeId,mediaId:'m',mediaTitle:'시험 영상',mediaType:'anime',streams:[{id:'0',label:'서버 1'},{id:'1',label:'서버 2'}],streamId:id,mode:'direct',mime:'video/mp4',url:id==='0'?'/fixture/fail.mp4':'/fixture/pass.mp4',duration:600,startPosition:body.startPosition||0,subtitles:[{id:'ko',label:'한국어',lang:'ko',format:'vtt',url:'/fixture/ko.vtt'}],audioTracks:[],next:null}});}
 if(path.endsWith('/markers'))return r.fulfill({json:{status:'matched',markers:{introStart:20,introEnd:80,creditsStart:480,creditsEnd:540}}});
 if(path==='/api/settings'){if(method==='PATCH')Object.assign(settings,r.request().postDataJSON());return r.fulfill({json:settings});}
 if(path==='/api/me')return r.fulfill({json:{role:'admin'}});
 if(path==='/api/plugin-runtime')return r.fulfill({json:[]});
 if(path==='/api/episodes/ep/context')return r.fulfill({json:{mediaId:'m',season:1,number:2}});
 if(path==='/api/media/m/group')return r.fulfill({json:{id:'g',members:[{id:'m',provider:{name:'원래 소스'}},{id:'other',provider:{name:'다른 소스'}}]}});
 if(path==='/api/media/other')return r.fulfill({json:{id:'other',seasons:[{number:1,episodes:[{id:'other-1',season:1,number:1,title:'1화'},{id:'other-2',season:1,number:2,title:'2화'}]}]}});
 if(path==='/api/media/m')return r.fulfill({json:{id:'m',title:'시험 영상',type:'anime',provider:{id:'remote',name:'소스',kind:'mangayomi-js'},seasons:[],playTarget:null}});
 return r.fulfill({status:204});
});
try{
 await p.goto(base+'/watch/ep');await p.waitForFunction(()=>document.querySelector('video')?.currentTime>1);assert.deepEqual(calls.map(c=>c.streamId||'0'),['0','1'],'native media error falls back once');
 if(await p.locator('.player.is-idle').count())await p.locator('.player-surface').tap();await p.getByRole('button',{name:'자막 및 음성',exact:true}).click();await p.getByRole('button',{name:/자막 설정/}).click();await p.getByRole('spinbutton',{name:'자막 높이',exact:true}).fill('25');await p.getByRole('spinbutton',{name:'자막 높이',exact:true}).press('Tab');await p.waitForFunction(()=>document.querySelector('video').textTracks[0]?.cues?.[0].line < -1);
 await p.getByRole('spinbutton',{name:'자막 크기',exact:true}).fill('130');await p.getByRole('spinbutton',{name:'자막 크기',exact:true}).press('Tab');
 await p.getByRole('radiogroup',{name:'자막 배경',exact:true}).getByRole('radio',{name:'진하게',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('.player.cue-bg-solid'));
 assert.equal(settings.subtitleScale,130);assert.equal(settings.subtitleHeight,25);
 await p.waitForTimeout(350);await p.screenshot({path:verificationPath('verification-recovery-subtitle-panel.png')});
 await p.locator('.panel-back').click();await p.getByRole('button',{name:'끄기',exact:true}).click();await p.keyboard.press('Escape');await p.locator('video').evaluate(v=>{v.currentTime=123;v.dispatchEvent(new Event('timeupdate'));});await p.waitForTimeout(300);await p.locator('video').evaluate(v=>v.dispatchEvent(new Event('error')));
 await p.locator('.player-error').getByRole('button',{name:'다시 시도',exact:true}).click();await p.waitForFunction(()=>document.querySelector('video')?.currentTime>120);assert.ok(calls.at(-1).startPosition>=123);assert.equal(await p.locator('track').count(),0,'manual subtitle off survives retry');
 if(await p.locator('.player.is-idle').count())await p.locator('.player-surface').tap();await p.getByRole('button',{name:'재생 설정',exact:true}).click();await p.getByRole('button',{name:'다른 소스 선택',exact:true}).click();await p.getByRole('button',{name:'다른 소스',exact:true}).click();await p.getByRole('option',{name:'시즌 1 · 2화 · 2화',exact:true,selected:true,includeHidden:true}).waitFor({state:'attached'});assert.equal(await p.locator('video').evaluate(v=>v.paused),true);
 await p.screenshot({path:verificationPath('verification-recovery-source-dialog.png')});
 const previousVideo=await p.locator('video').elementHandle();
 await p.getByRole('button',{name:'이 회차로 재생',exact:true}).click();await p.waitForURL(/watch\/other-2\?t=12/);await p.waitForFunction(video=>!video.isConnected,previousVideo);await previousVideo.dispose();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.waitForFunction(()=>document.querySelector('.player.cue-bg-solid'));
 await p.waitForFunction(()=>document.querySelectorAll('.seek-marker').length===2);
 await p.waitForFunction(()=>{const v=document.querySelector('video');return v?.readyState>=3 && v.currentTime>=123 && !v.seeking;});
 await p.locator('video').evaluate(v=>{v.pause();v.currentTime=25;});
 await p.waitForFunction(()=>{const v=document.querySelector('video');return v && !v.seeking && Math.abs(v.currentTime-25)<1;});
 await p.locator('video').evaluate(v=>v.dispatchEvent(new Event('timeupdate')));
 await p.getByRole('button',{name:'오프닝 건너뛰기',exact:true}).click();
 assert.ok(await p.locator('video').evaluate(v=>v.currentTime>=80));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,calls,errors},null,2));
}finally{await browser.close();}
