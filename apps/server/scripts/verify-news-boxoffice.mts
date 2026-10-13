// Synthetic loopback app + real plugin runtime API/SDK for watchlist-news and korean-boxoffice; provider fetches are stubbed, no external requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { unpackPlugin } from '../src/website-plugins.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH||'playwright');
const out=process.env.MOA_VERIFY_DIR||path.join(tmpdir(),'moa-news-boxoffice-verify');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(tmpdir(),'moa-news-boxoffice-app-'));
process.env.MOA_VERSION='0.1.2-beta.3';process.env.VITE_MOCK='0';
const dayMs=86400_000,now=Date.now(),seoul=(t:number)=>new Date(t+9*3600_000).toISOString().slice(0,10);
const today=seoul(now),plus=(n:number)=>seoul(now+n*dayMs),compact=(d:string)=>d.replaceAll('-','');
let tmdbCalls=0,kobisCalls=0;
// TMDB fixtures keyed by kind:id. Out-of-window dates must be filtered by the host.
const movies:Record<number,string[]>={101:[plus(3)],102:[plus(12),plus(45)],103:[plus(40)]};
const shows:Record<number,{air_date:string;season_number:number;episode_number:number}|null>={201:{air_date:today,season_number:2,episode_number:7},202:{air_date:plus(1),season_number:1,episode_number:12},203:null};
const titles=['한낮의 정원','파도 너머','겨울 정거장','달빛 수선소','도시의 여름','마지막 상영관','작은 영웅들','은하 우체국','바람의 노래','새벽 열차'];
const weekTitles=['파도 너머','한낮의 정원','은하 우체국','겨울 정거장','도시의 여름','달빛 수선소','바람의 노래','작은 영웅들','새벽 열차','마지막 상영관'];
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{
 schedule:{now:()=>now},
 boxoffice:{key:'fixture',now:()=>now,fetch:async input=>{
  kobisCalls++;const u=new URL(String(input)),weekly=u.pathname.endsWith('searchWeeklyBoxOfficeList.json'),target=u.searchParams.get('targetDt')!;
  assert.equal(u.origin,'https://www.kobis.or.kr');assert.equal(u.searchParams.get('key'),'fixture');
  const from=weekly?compact(new Date(Date.parse(`${target.slice(0,4)}-${target.slice(4,6)}-${target.slice(6)}`)-6*dayMs).toISOString().slice(0,10)):target;
  const names=weekly?weekTitles:titles;
  const list=names.map((movieNm,i)=>({rank:String(i+1),movieCd:String(20260000+titles.indexOf(movieNm)),movieNm,audiCnt:String((weekly?7:1)*Math.round(184_320/(i+1))),audiAcc:String(Math.round(2_431_870/(i+1))+i*5_000),rankInten:String([0,2,-1,0,3,-2,0,1,-4,0][i]),rankOldAndNew:i===6||(weekly&&i===2)?'NEW':'OLD'}));
  return Response.json({boxOfficeResult:{boxofficeType:weekly?'주간 박스오피스':'일별 박스오피스',showRange:`${from}~${target}`,[weekly?'weeklyBoxOfficeList':'dailyBoxOfficeList']:list}});
 }},
 tmdb:{token:'synthetic-provider-token',fetch:async input=>{
  tmdbCalls++;const u=new URL(String(input)),m=u.pathname.match(/^\/3\/(movie|tv)\/(\d+)(\/release_dates)?$/);
  if(m?.[1]==='movie'&&m[3]&&movies[+m[2]])return Response.json({id:+m[2],results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:plus(2)+'T00:00:00Z'}]},{iso_3166_1:'KR',release_dates:movies[+m[2]].map(d=>({type:3,release_date:d+'T00:00:00.000Z'}))}]});
  if(m?.[1]==='tv'&&!m[3]&&+m[2] in shows)return Response.json({id:+m[2],name:'fixture',next_episode_to_air:shows[+m[2]]});
  return Response.json({status_message:'not in fixture'},{status:404});
 }}
});
let vite:any,browser:any;
try{
  const install=async(id:string)=>{
   const pkg=await unpackPlugin({files:await Promise.all(['manifest.json','plugin.js'].map(async name=>({name,content:await readFile(path.join(root,'plugins',id,name),'utf8')})))});
   const installed=await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg});assert.equal(installed.statusCode,200,installed.body);return pkg;
  };
  const news=await install('watchlist-news'),box=await install('korean-boxoffice');
  const p=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'검증 프로필'}})).json();
  // Newest first: [mediaId, title, tmdb link]. Unlinked titles are counted but never guessed.
  const seed:Array<[string,string,['movie'|'tv',number]|null]>=[
   ['fixture-movie-a','한낮의 정원',['movie',101]],['fixture-show-a','유리 숲의 아이들',['tv',201]],['fixture-unlinked-a','이름 없는 기록',null],
   ['fixture-movie-b','파도 너머',['movie',102]],['fixture-show-b','밤의 편의점',['tv',202]],['fixture-show-c','끝난 이야기',['tv',203]],
   ['fixture-movie-c','먼 훗날의 극장',['movie',103]],['fixture-unlinked-b','보관함 영상',null]];
  seed.forEach(([id,title,link],i)=>{
   env.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,title,link?.[0]==='movie'?'movie':'drama','{}','2026-01-01T00:00:00.000Z');
   env.db.run('INSERT INTO watchlist VALUES(?,?,?)',p.id,id,new Date(now-i*60_000).toISOString());
   if(link)env.db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,?,?,'manual',1)",id,link[0],link[1]);
  });
  await env.app.listen({host:'127.0.0.1',port:0});
  process.env.MOA_API=`http://127.0.0.1:${(env.app.server.address() as any).port}`;
  vite=await createServer({root:path.join(root,'apps/web'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
  const base=vite.resolvedUrls.local[0],origin=new URL(base).origin;
  browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript((id:string)=>{if(window!==window.top)return;localStorage.setItem('moa.profile',id);localStorage.setItem('moa.remoteMode','off');},p.id);
  const unexpected:string[]=[],errors:string[]=[];
  // Fault injection sits in front of the real runtime endpoints; untouched requests reach the host API unchanged.
  const fault:{box?:'fail'|'unconfigured'|'slow-week';news?:'fail'|'unconfigured'|'unavailable'|'slow'}={};
  const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  await context.route('**/*',async(route:any)=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin){unexpected.push(u.origin);return route.abort();}
    if(u.pathname===`/api/plugin-runtime/${box.id}/discovery/boxoffice`){
      const period=route.request().postDataJSON().query.period;
      if(fault.box==='fail')return route.fulfill({status:503,json:{error:'plugin-discovery-unavailable'}});
      if(fault.box==='unconfigured')return route.fulfill({json:{provider:'kobis',period,from:plus(-1),through:plus(-1),status:'unconfigured',items:[]}});
      if(fault.box==='slow-week'&&period==='week')await delay(1500);
    }
    if(u.pathname===`/api/plugin-runtime/${news.id}/watchlist/news`){
      if(fault.news==='fail')return route.fulfill({status:503,json:{error:'plugin-discovery-unavailable'}});
      if(fault.news==='slow')await delay(1500);
      if(fault.news==='unavailable')return route.fulfill({json:{provider:'tmdb',status:'unavailable',from:today,through:plus(30),items:[],unlinked:0,checked:0,truncated:false}});
      if(fault.news==='unconfigured')return route.fulfill({json:{provider:'tmdb',status:'unconfigured',from:today,through:plus(30),items:[],unlinked:0,checked:0,truncated:false}});
    }
    if(u.pathname==='/api/admin/updates')return route.fulfill({json:{state:'idle',available:false,supported:false,helperConnected:false}});
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
  const frame=(pkg:{name:string})=>page.frameLocator(`iframe[title="${pkg.name}"]`),shot=(pkg:{name:string},name:string)=>page.locator(`iframe[title="${pkg.name}"]`).screenshot({path:path.join(out,name)});
  const N=frame(news),B=frame(box),boxItems=()=>B.locator('#list li'),newsItems=()=>N.locator('#list li');
  await page.goto(base);
  // Watchlist news: only in-window events of linked titles, sorted by date, unlinked count disclosed.
  await N.getByRole('button',{name:/^유리 숲의 아이들, .* 새 회차, 작품 정보 열기$/}).waitFor();
  assert.deepEqual(await N.locator('#list .body > strong').allTextContents(),['유리 숲의 아이들','밤의 편의점','한낮의 정원','파도 너머']);
  assert.match(await N.locator('#status').textContent(),/다가오는 소식 4건/);
  assert.match(await N.locator('#note').textContent(),/^확인 대상 6편 · 최근 찜 중 TMDB 미연결 2편 제외$/);
  assert.equal(await N.locator('.when small').first().textContent(),'오늘');
  // Box office: daily top 10 in rank order with up/down/new markers and KOBIS credit.
  await B.getByRole('button',{name:'1위 한낮의 정원 MOA에서 검색'}).waitFor();
  assert.equal(await boxItems().count(),10);
  assert.deepEqual(await B.locator('.change').allTextContents(),['–','▲2','▼1','–','▲3','▼2','NEW','▲1','▼4','–']);
  await B.getByText(/영화진흥위원회/).first().waitFor();
  await page.locator(`iframe[title="${news.name}"]`).scrollIntoViewIfNeeded();
  await shot(news,'news-desktop.png');await shot(box,'boxoffice-day-desktop.png');
  // Period switch clears the old ranking at once, and a slow earlier answer cannot overwrite a newer one.
  fault.box='slow-week';
  await B.getByRole('button',{name:'주간',exact:true}).click();
  assert.equal(await boxItems().count(),0,'daily ranking must disappear while weekly loads');
  await B.getByRole('button',{name:'일간',exact:true}).click();
  await B.getByRole('button',{name:'1위 한낮의 정원 MOA에서 검색'}).waitFor();
  await delay(1800);
  assert.equal(await B.getByRole('button',{name:'1위 파도 너머 MOA에서 검색'}).count(),0,'late weekly answer must be ignored');
  assert.equal(await B.locator('[data-period="day"]').getAttribute('aria-pressed'),'true');
  fault.box=undefined;
  await B.getByRole('button',{name:'주간',exact:true}).click();
  await B.getByRole('button',{name:'1위 파도 너머 MOA에서 검색'}).waitFor();
  assert.match(await B.locator('#range').textContent(),/주간/);assert.equal(await B.locator('.change.new').count(),2);
  await shot(box,'boxoffice-week-desktop.png');
  // Failure and unconfigured responses remove every previous card.
  fault.box='fail';await B.getByRole('button',{name:'다시 확인'}).click();
  await B.getByText('박스오피스를 불러오지 못했어요.').waitFor();assert.equal(await boxItems().count(),0);
  fault.box='unconfigured';await B.getByRole('button',{name:'다시 시도'}).click();
  await B.getByText('박스오피스는 관리자 설정 후 이용할 수 있어요.').waitFor();assert.equal(await boxItems().count(),0);
  assert.equal(await B.locator('body').evaluate((e:HTMLElement)=>/MOA_KOBIS_API_KEY|kobisopenapi/.test(e.innerText)),false,'setup details stay in README');
  await shot(box,'boxoffice-unconfigured.png');
  fault.box=undefined;await B.getByRole('button',{name:'다시 확인'}).click();await B.getByRole('button',{name:'1위 파도 너머 MOA에서 검색'}).waitFor();
  fault.news='fail';await N.getByRole('button',{name:'다시 확인'}).click();
  await N.getByText('작품 소식을 불러오지 못했어요.').waitFor();assert.equal(await newsItems().count(),0);
  fault.news='unconfigured';await N.getByRole('button',{name:'다시 시도'}).click();
  await N.getByText('작품 소식을 보려면 TMDB 연결이 필요해요.').waitFor();assert.equal(await newsItems().count(),0);assert.equal(await N.locator('#note').textContent(),'');
  fault.news='unavailable';await N.getByRole('button',{name:'다시 확인'}).click();
  await N.getByText('지금은 작품 소식을 가져올 수 없어요.').waitFor();assert.equal(await newsItems().count(),0);
  // A slow personal answer that arrives after a newer request must not reappear.
  fault.news='slow';await N.getByRole('button',{name:'다시 시도'}).click();
  fault.news='unconfigured';await N.getByRole('button',{name:'다시 확인'}).click();
  await N.getByText('작품 소식을 보려면 TMDB 연결이 필요해요.').waitFor();await delay(1800);
  assert.equal(await newsItems().count(),0,'late news answer must be ignored');
  fault.news=undefined;await N.getByRole('button',{name:'다시 확인'}).click();
  // Selecting a news item opens the current MOA title page.
  await N.getByRole('button',{name:/^파도 너머, /}).click();await page.waitForURL('**/title/**');
  assert.equal(new URL(page.url()).pathname,'/title/fixture-movie-b');
  // Mobile layout: no horizontal overflow, then search navigation without autoplay.
  await page.setViewportSize({width:390,height:844});await page.goto(base);
  await N.getByRole('button',{name:/^유리 숲의 아이들, /}).waitFor();await B.getByRole('button',{name:'1위 한낮의 정원 MOA에서 검색'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  for(const f of [N,B])assert.equal(await f.locator('body').evaluate((e:HTMLElement)=>e.scrollWidth>innerWidth),false);
  await page.locator(`iframe[title="${news.name}"]`).scrollIntoViewIfNeeded();await shot(news,'news-mobile.png');
  await page.locator(`iframe[title="${box.name}"]`).scrollIntoViewIfNeeded();await shot(box,'boxoffice-mobile.png');
  await B.getByRole('button',{name:'3위 겨울 정거장 MOA에서 검색'}).click();await page.waitForURL('**/search?**');
  assert.equal(new URL(page.url()).searchParams.get('q'),'겨울 정거장');assert.equal(await page.locator('video').count(),0);
  // Kids profiles: both hosts answer restricted and nothing personal or provider-derived remains.
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);await page.goto(base);
  await N.getByText('이 프로필에서는 작품 소식을 표시하지 않아요.').waitFor();await B.getByText('이 프로필에서는 박스오피스를 표시하지 않아요.').waitFor();
  assert.equal(await newsItems().count(),0);assert.equal(await boxItems().count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(JSON.stringify({ok:true,tmdbCalls,kobisCalls,screenshots:out}));
}finally{await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
