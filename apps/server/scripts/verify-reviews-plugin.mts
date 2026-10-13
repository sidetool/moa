// Synthetic isolated MOA + real plugin SDK/API; image bytes only are fixtures.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {unpackPlugin} from '../src/website-plugins.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH||'playwright');
const out=process.env.MOA_VERIFY_DIR||path.join(tmpdir(),'moa-reviews-verify');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(tmpdir(),'moa-reviews-app-'));
process.env.MOA_VERSION='0.1.2-beta.3';process.env.VITE_MOCK='0';
const upstream:string[]=[];
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{
reviews:{fetch:async(input,init)=>{
 upstream.push(String(input));const body=JSON.parse(String(init?.body));
 return Response.json({data:body.variables.search?{Page:{media:[{id:1,isAdult:false,title:{native:'검증용 시리즈',english:'Example Season One'},startDate:{year:2023},format:'TV'},{id:2,isAdult:false,title:{native:'검증용 시리즈 2기',english:'Example Season Two'},startDate:{year:2025},format:'TV'}]}}:{Media:{id:1,isAdult:false,reviews:{nodes:[{mediaId:1,summary:'A story worth revisiting',body:'Synthetic anime review, not a real user review.',siteUrl:'https://anilist.co/review/123',user:{name:'Example viewer'}}]}}}});}},
tmdb:{token:'synthetic-provider-token',fetch:async input=>{
 const u=new URL(String(input));upstream.push(u.pathname);
 if(u.pathname==='/3/tv/1/videos')return Response.json({results:[]}); // Title page trailer lookup is independent of reviews.
 if(u.pathname==='/3/tv/1/reviews')return Response.json({results:[{author:'Example writer',url:'https://www.themoviedb.org/review/abcdef',content:'Synthetic review. Not a real user review.',created_at:'2026-10-11'}]});
 throw Error(`Unexpected upstream endpoint ${u.pathname}`);
}}});
let vite:any,browser:any;
try {
  env.db.run("INSERT INTO media VALUES('demo',NULL,'검증용 시리즈','series','{}','2026')");
  env.db.run("INSERT INTO tmdb_links VALUES('demo','tv',1,NULL,'manual',100,?)",Date.now());
  env.db.run("INSERT INTO tmdb_titles VALUES('tv',1,?,?,?)",JSON.stringify({title:'검증용 시리즈',adult:false,certification:'ALL',genreIds:[10751],genres:['가족'],originCountries:['KR']}),JSON.stringify({people:[{name:'예제 배우 1',role:'캐릭터 1',photo:'https://image.tmdb.org/t/p/w185/person1.jpg',identity:{provider:'tmdb',id:'1'}},{name:'이전 캐시 배우',role:'배역'}],similar:[]}),Date.now());
  env.db.run("INSERT INTO tmdb_seasons VALUES(1,1,'[]',?)",Date.now());
  const pkg=await unpackPlugin({files:[{name:'manifest.json',content:await readFile(path.join(root,'plugins/title-reviews/manifest.json'),'utf8')},{name:'plugin.js',content:await readFile(path.join(root,'plugins/title-reviews/plugin.js'),'utf8')}]});
  const installed=await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg});assert.equal(installed.statusCode,200,installed.body);
  const p=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'검증 프로필'}})).json();
  await env.app.listen({host:'127.0.0.1',port:0});process.env.MOA_API=`http://127.0.0.1:${(env.app.server.address() as any).port}`;
  vite=await createServer({root:path.join(root,'apps/web'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
  const base=vite.resolvedUrls.local[0],origin=new URL(base).origin;
  browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1280,height:1000}});
  await context.addInitScript((id:string)=>{if(window!==window.top)return;localStorage.setItem('moa.profile',id);localStorage.setItem('moa.remoteMode','off');},p.id);
  const errors:string[]=[],unexpected:string[]=[];let images=0;
  const sharp=createRequire(import.meta.url)('sharp');
  const portrait=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="185" height="278"><rect width="185" height="278" fill="#263841"/><circle cx="92" cy="90" r="40" fill="#75a5b1"/><path d="M27 230a65 65 0 0 1 130 0" fill="#75a5b1"/></svg>')).png().toBuffer();
  await context.route('**/*',async(route:any)=>{
    const u=new URL(route.request().url());
    if(u.origin==='https://image.tmdb.org'){
      assert.match(u.pathname,/^\/t\/p\/(w185|w342)\/(person\d+|work\d+)\.jpg$/);images++;return route.fulfill({contentType:'image/png',body:portrait});
    }
    if(u.origin!==origin){unexpected.push(u.origin);return route.abort();}
    if(u.pathname==='/api/admin/updates')return route.fulfill({json:{state:'idle',available:false,supported:false,helperConnected:false}});
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.goto(`${base}title/demo`);
  const section=page.getByRole('region',{name:'리뷰 모아보기'});
  await section.getByRole('button',{name:/리뷰 모아보기/}).waitFor();assert.deepEqual(upstream.filter(x=>x!=='/3/tv/1/videos'),[],'no review requests until the user opens reviews');
  await section.getByRole('button',{name:/리뷰 모아보기/}).click();
  await section.getByText('Example writer',{exact:false}).waitFor();
  assert.equal(await section.locator('details[open]').count(),0);
  await section.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.').waitFor();
  await section.screenshot({path:path.join(out,'reviews-desktop.png')});
  await page.setViewportSize({width:390,height:844});await section.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await section.getByRole('button',{name:'AniList · 애니',exact:true}).click();
  await section.getByRole('button',{name:/Example Season One/}).waitFor();
  assert.equal(await section.locator('.review-entry').count(),0);
  await section.screenshot({path:path.join(out,'reviews-selection-mobile.png')});
  await section.getByRole('button',{name:/Example Season One/}).click();
  await section.getByText('Example viewer',{exact:false}).waitFor();
  await section.locator('summary').click();
  assert.match((await section.getByRole('link',{name:'Google 번역으로 원문 열기 ↗'}).getAttribute('href'))!,/^https:\/\/translate.google.com\/translate/);
  await section.screenshot({path:path.join(out,'reviews-anilist-mobile.png')});
  await section.getByRole('button',{name:'작품 다시 선택'}).click();
  await section.getByRole('button',{name:/Example Season One/}).waitFor();assert.equal(await section.locator('.review-entry').count(),0);
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);
  await section.getByRole('button',{name:'다시 확인'}).click();
  await section.getByText('이 프로필에서는 외부 리뷰를 표시하지 않아요.').waitFor();assert.equal(await section.locator('.review-entry').count(),0);assert.equal(await section.locator('.review-search-links a').count(),0);
  env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='title-reviews'");await page.reload();await page.waitForTimeout(500);assert.equal(await section.count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({ok:true,upstream,screenshots:out}));
} finally {await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
