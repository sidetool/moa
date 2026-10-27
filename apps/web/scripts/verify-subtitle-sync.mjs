import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const video=await readFile(process.env.MOA_TEST_VIDEO);
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({root,server:{port:0},define:{'import.meta.env.VITE_MOCK':'"0"'}});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});
const errors=[];
function cues(seed,offset){let t=10,r=seed;return 'WEBVTT\n\n'+Array.from({length:240},()=>{r=(r*1664525+1013904223)>>>0;t+=1.7+r/2**32*7;const fmt=s=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};return `${fmt(t+offset)} --> ${fmt(t+offset+1.4)}\n대사\n\n`;}).join('');}
async function scenario({enabled=true,wrong=false,manual=false,offDuringCheck=false}={}){
 const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('moa.profile','test'));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const reference={id:'ja',label:'일본어',lang:'ja',format:'vtt',source:'extension',url:'/fixture/reference.vtt',default:true};
 const track={id:'ko',label:'테스트 한국어',lang:'ko',format:'vtt',source:'online',url:'/fixture/online.vtt',provenance:{creatorName:'테스트 제작자',sourceUrl:'https://example.com'}};
 const calls={reference:0,online:0,apply:0};
 await context.route('**/fixture/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('video.mp4')){
   const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/),start=Number(range?.[1]||0),end=Math.min(video.length-1,range?.[2]?Number(range[2]):video.length-1);
   return route.fulfill({status:range?206:200,contentType:'video/mp4',body:video.subarray(start,end+1),headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${video.length}`}:{})}});
  }
  if(path.endsWith('reference.vtt')){calls.reference++;if(offDuringCheck&&calls.reference>1)await new Promise(r=>setTimeout(r,1800));return route.fulfill({contentType:'text/vtt',body:cues(12,0)});}
  calls.online++;return route.fulfill({contentType:'text/vtt',body:cues(wrong?900:12,-3.25)});
 });
 await context.route(url=>url.pathname.startsWith('/api/'),route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const json=body=>route.fulfill({json:body});
  if(path==='/api/plugins'||path==='/api/plugin-runtime')return json([]);
  if(path.endsWith('/markers'))return json({markers:null,status:'unavailable'});
  if(path==='/api/me')return json({id:'test',role:'member',username:'test',permissions:['video.watch','subtitles.add']});
  if(path==='/api/translation/config')return json({configured:false,enabled:false,keys:[],batchSize:120,requestIntervalMs:1000,retryCount:2});
  if(path==='/api/settings')return json({autoplayNext:false,autoplayDelay:5,defaultSubtitleLang:'ko',subtitleSize:'medium',preferredQuality:'auto',hardwareTranscoding:true,autoFetchSubtitles:true,experimentalSubtitleSync:enabled,translationMode:'manual',skipSubtitleSearchWithSiteTrack:true});
  if(path==='/api/playback')return json({sessionId:'s',episodeId:'e',mediaId:'m',mediaTitle:'검증',mediaType:'anime',mode:'direct',url:'/fixture/video.mp4',mime:'video/mp4',duration:1800,startPosition:0,subtitles:[reference],audioTracks:[]});
  if(path.endsWith('/subtitles/online')){
   if(request.method()==='GET')return json({searchId:'search',resolvedTitle:'검증',autoApply:!manual,candidates:[{id:'candidate',creatorName:'테스트 제작자',sourceUrl:'https://example.com',filename:'01.vtt',format:'vtt',matchedEpisode:1,confidence:.9}],partial:false,expiresAt:Date.now()+60000});
   calls.apply++;return json(track);
  }
  if(path==='/api/media/m')return json({id:'m',title:'검증',type:'anime',provider:{id:'local',name:'로컬',kind:'local'},seasons:[]});
  return route.fulfill({status:204});
 });
 await page.goto(`${base}/watch/e`);await page.waitForSelector('video');
 await page.evaluate(()=>document.querySelector('video').pause());
 await page.mouse.move(200,200);await page.getByRole('button',{name:'자막 및 음성',exact:true}).click();
 const panel=page.getByRole('dialog',{name:'자막 및 음성'});await panel.waitFor();
 if(offDuringCheck){await panel.getByRole('button',{name:'끄기',exact:true}).click();await page.waitForTimeout(2200);assert.match(await panel.getByRole('button',{name:'끄기',exact:true}).getAttribute('class'),/is-active/);}
 if(manual)await panel.getByRole('button',{name:/테스트 제작자/}).click();
 if(wrong&&!manual){await page.waitForTimeout(1500);const active=await panel.locator('.is-active').allTextContents();assert.ok(!active.some(x=>x.includes('테스트 한국어')));assert.ok(active.some(x=>x.includes('일본어')));assert.equal(calls.online,1);}
 if(process.env.MOA_SYNC_SCREENSHOTS&&enabled&&!wrong&&!manual&&!offDuringCheck){await mkdir(process.env.MOA_SYNC_SCREENSHOTS,{recursive:true});await page.setViewportSize({width:844,height:390});await page.waitForTimeout(200);await page.screenshot({path:process.env.MOA_SYNC_SCREENSHOTS+'/player-subtitles.png'});}
 await panel.getByRole('button',{name:/자막 설정/}).click();
 if(enabled&&!wrong&&!offDuringCheck){
  await page.waitForFunction(()=>document.querySelector('.sync-value')?.textContent?.includes('+3.3'));
  if(process.env.MOA_SYNC_SCREENSHOTS){await page.waitForTimeout(150);await page.screenshot({path:process.env.MOA_SYNC_SCREENSHOTS+'/player-sync.png'});}
  await panel.locator('.sync-value').click();assert.match(await panel.locator('.sync-value').textContent(),/^0.0/);
  await page.waitForTimeout(250);assert.match(await panel.locator('.sync-value').textContent(),/^0.0/);
 }else{
  await page.waitForTimeout(1500);
  assert.match(await panel.locator('.sync-value').textContent(),/^0.0/);

 }
 if(!enabled)assert.equal(calls.reference,1,'off does not fetch the reference for analysis');
 assert.ok(calls.apply>0);
 await context.close();console.log(JSON.stringify({enabled,wrong,manual,offDuringCheck,ok:true,calls}));
}
try{await scenario();await scenario({enabled:false});await scenario({wrong:true});await scenario({wrong:true,manual:true});await scenario({offDuringCheck:true});assert.deepEqual(errors,[]);}finally{await browser.close();await server.close();}
