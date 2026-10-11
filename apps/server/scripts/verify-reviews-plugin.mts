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
process.env.MOA_VERSION='0.1.2-beta.2';process.env.VITE_MOCK='0';
const upstream:string[]=[];
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{
reviews:{naverId:'synthetic-id',naverSecret:'synthetic-secret',fetch:async input=>{
 const url=new URL(String(input));upstream.push(url.origin);
 return Response.json({items:[{title:'조용한 장면들이 오래 남는 이유',link:'https://example.com/review1',description:'인물들의 선택을 돌아보는 예시 리뷰입니다. 실제 이용자의 글이 아닙니다.',bloggername:'검증용 블로그',postdate:'20261011'}, {title:'<b>검증용 시리즈</b> — 보고 난 뒤의 생각',link:'https://example.com/review2',description:'두 번째 합성 리뷰입니다.',bloggername:'예시 글쓴이',postdate:'20261010'},{title:'Unsafe',link:'javascript:alert(1)'}]});}},
tmdb:{token:'synthetic-provider-token',fetch:async input=>{
 const u=new URL(String(input));upstream.push(u.pathname);
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
  await section.getByRole('button',{name:/리뷰 모아보기/}).waitFor();assert.equal(upstream.length,0,'no requests until the user opens reviews');
  await section.getByRole('button',{name:/리뷰 모아보기/}).click();
  await section.getByRole('link',{name:/조용한 장면/}).waitFor();
  assert.equal(await section.locator('details[open]').count(),0);
  assert.equal(await section.locator('script').count(),0);
  await section.screenshot({path:path.join(out,'reviews-desktop.png')});
  await page.setViewportSize({width:390,height:844});await section.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await section.screenshot({path:path.join(out,'reviews-mobile.png')});
  await section.getByRole('button',{name:'다음 블로그',exact:true}).click();
  await section.getByText('블로그 검색이 아직 연결되지 않았어요.',{exact:false}).waitFor();
  assert.equal(await section.locator('.review-entry').count(),0);
  const link=await section.getByRole('link',{name:'네이버에서 한국어 리뷰 검색 ↗'}).getAttribute('href');assert.match(link!,/^https:\/\/search.naver.com/);
  await section.screenshot({path:path.join(out,'reviews-keyless-mobile.png')});
  await section.getByRole('button',{name:'해외 사용자 리뷰',exact:true}).click();
  await section.getByText('Example writer',{exact:false}).waitFor();
  await section.locator('summary').click();
  assert.match((await section.getByRole('link',{name:'Google 번역으로 원문 열기 ↗'}).getAttribute('href'))!,/^https:\/\/translate.google.com\/translate/);
  await section.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.').waitFor();
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);
  await section.getByRole('button',{name:'다시 확인'}).click();
  await section.getByText('이 프로필에서는 외부 리뷰를 표시하지 않아요.').waitFor();assert.equal(await section.locator('.review-entry').count(),0);assert.equal(await section.locator('.review-search-links a').count(),0);
  env.db.run("UPDATE website_plugins SET enabled=0 WHERE id='title-reviews'");await page.reload();await page.waitForTimeout(500);assert.equal(await section.count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({ok:true,upstream,screenshots:out}));
} finally {await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
