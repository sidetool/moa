import {readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createRequire} from 'node:module';


if(!process.env.MOA_CANDIDATES)throw new Error('Set MOA_CANDIDATES to a user-supplied candidate JSON file');

// Test harness only: a temporary loopback server uses the unchanged MOA playback proxy.
const appRoot=process.env.MOA_APP_ROOT || fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(join(appRoot,'apps/server/package.json'));
const Fastify=require('fastify');
const {RemotePlayback}=await import(pathToFileURL(join(appRoot,'apps/server/src/playback/remote.ts')).href);
const {publicStream}=await import(pathToFileURL(join(appRoot,'apps/server/dist/sources/extensions/index.js')).href);
const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH || 'playwright');
const candidates=JSON.parse(await readFile(process.env.MOA_CANDIDATES,'utf8'));
const app=Fastify({logger:false});
const routes=new Map();
app.get('/hls.js',async(req,reply)=>reply.type('application/javascript').send(await readFile(join(appRoot,'apps/web/node_modules/hls.js/dist/hls.min.js'))));
app.get('/',async(req,reply)=>reply.type('text/html').send('<video muted autoplay playsinline width="960" height="540"></video><script src="/hls.js"></script>'));
app.get('/api/playback/:id/remote/:asset',async(req:any,reply)=>routes.get(req.params.id).proxy(req,reply,req.params.id,req.params.asset));
await app.listen({host:'127.0.0.1',port:18796});
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const report=[];
try{
 for(const candidate of candidates.filter(c=>c.items[0]?.url.startsWith('https:'))){
  const episode={id:'probe-ep',title:'probe',number:1,season:1};
  const source={remoteEpisode:()=>({media_id:'probe',source_id:'probe'}),videos:async()=>candidate.items.map(v=>({...v,subtitles:[]})),row:()=>({live:1}),proxy:()=>undefined};
  const remote=new RemotePlayback({} as any,{detail:()=>({id:'probe',title:candidate.source,type:'movie',seasons:[{episodes:[episode]}]})} as any,source as any,async (url,headers,signal,proxy)=>{
    if(new URL(url).hostname!=='apk-proof.invalid')return publicStream(url,headers,signal,proxy);
    if(process.env.MOA_ALLOW_LOCAL_PROOF!=='1')throw Error('local proof relay not enabled');
    const target=new URL(url);target.protocol='http:';target.host='127.0.0.1:18797';
    return new Promise((resolve,reject)=>{const req=http.get(target,{headers,signal},response=>resolve({response,url}));req.on('error',reject);});
  });
  const session=await remote.create('probe','probe-ep');routes.set(session.sessionId,remote);
  const page=await browser.newPage();let errors=[];
  await page.goto('http://127.0.0.1:18796/');
  await page.evaluate(url=>{const video=document.querySelector('video');const hls=new window.Hls();window.hls=hls;window.fatal=[];hls.on(window.Hls.Events.ERROR,(_,e)=>{if(e.fatal)window.fatal.push(e.details)});hls.loadSource(url);hls.attachMedia(video);video.play().catch(()=>{});},session.url);
  const started=Date.now();let playing=false;
  try{await page.waitForFunction(()=>document.querySelector('video').readyState>=3 && document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames>5,{},{timeout:20000});playing=true;}catch{}
  const firstFrameMs=Date.now()-started;
  const before=await page.evaluate(()=>({time:document.querySelector('video').currentTime,frames:document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames}));
  if(playing)await new Promise(r=>setTimeout(r,Number(process.env.MOA_PLAYBACK_SECONDS || 10)*1000));
  const seeks=[];
  if(playing && process.env.MOA_SEEK==='1') {
   for(const position of [120,600,1200]){
    const started=Date.now();
    await page.evaluate(p=>{document.querySelector('video').currentTime=p;},position);
    let resumed=true;try{await page.waitForFunction(p=>{const v=document.querySelector('video');return !v.seeking && v.readyState>=3 && v.currentTime>p+.2;},position,{timeout:15000});}catch{resumed=false;}
    seeks.push({position,resumed,ms:Date.now()-started});
   }
  }
  const result=await page.evaluate(()=>{const v=document.querySelector('video');return{time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight,fatal:window.fatal};});
  report.push({source:candidate.source,playing,firstFrameMs,before,seeks,...result});console.log(JSON.stringify(report.at(-1)));await page.close();remote.close();
 }
}finally{await browser.close();await app.close();await writeFile(process.env.MOA_REPORT || join(appRoot,'data/apk-proof/verification/browser.json'),JSON.stringify(report,null,2));}
