// Synthetic isolated MOA + real plugin SDK/API; image bytes only are fixtures.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {unpackPlugin} from '../src/plugins/service.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH||'playwright');
const out=process.env.MOA_VERIFY_DIR||path.join(tmpdir(),'moa-people-verify');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(tmpdir(),'moa-people-app-'));
process.env.MOA_VERSION='0.1.2-beta.1';process.env.VITE_MOCK='0';
const upstream:string[]=[];
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{tmdb:{token:'synthetic-provider-token',fetch:async input=>{
  const u=new URL(String(input));upstream.push(u.pathname);
  if(u.pathname==='/3/tv/1/aggregate_credits')return Response.json({
    cast:Array.from({length:18},(_,i)=>({id:i+1,name:`예제 배우 ${i+1}`,adult:false,profile_path:`/person${i+1}.jpg`,roles:[{character:`캐릭터 ${i+1}${i===0?' (voice)':''}`},{character:'특별 출연'}]})),
    crew:[{id:100,name:'예제 감독',jobs:[{job:'Director'},{job:'Writer'}],profile_path:'/person100.jpg'}]
  });
  if(u.pathname==='/3/person/1/combined_credits')return Response.json({cast:Array.from({length:12},(_,i)=>({id:i+20,adult:false,media_type:i%2?'tv':'movie',title:`참여 영화 ${i+1}`,name:`참여 시리즈 ${i+1}`,release_date:'2025-01-01',first_air_date:'2024-01-01',poster_path:`/work${i}.jpg`})),crew:[]});
  throw Error(`Unexpected upstream endpoint ${u.pathname}`);
}}});
let vite:any,browser:any;
try {
  env.db.run("INSERT INTO media VALUES('demo',NULL,'검증용 시리즈','series','{}','2026')");
  env.db.run("INSERT INTO tmdb_links VALUES('demo','tv',1,NULL,'manual',100,?)",Date.now());
  env.db.run("INSERT INTO tmdb_titles VALUES('tv',1,?,?,?)",JSON.stringify({title:'검증용 시리즈',adult:false,certification:'ALL',genreIds:[10751],genres:['가족'],originCountries:['KR']}),JSON.stringify({people:[{name:'예제 배우 1',role:'캐릭터 1',photo:'https://image.tmdb.org/t/p/w185/person1.jpg',identity:{provider:'tmdb',id:'1'}},{name:'이전 캐시 배우',role:'배역'}],similar:[]}),Date.now());
  env.db.run("INSERT INTO tmdb_seasons VALUES(1,1,'[]',?)",Date.now());
  const pkg=await unpackPlugin({files:[{name:'manifest.json',content:await readFile(path.join(root,'plugins/title-people/manifest.json'),'utf8')},{name:'plugin.js',content:await readFile(path.join(root,'plugins/title-people/plugin.js'),'utf8')}]});
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
  const dialog=()=>page.getByRole('dialog',{name:'출연·제작진',exact:true});
  await page.goto(`${base}title/demo`);
  await page.getByRole('button',{name:'출연·제작진 전체'}).waitFor();
  assert.equal(await page.locator('.home-plugin').count(),0,'no duplicate plugin cast panel');
  assert.equal(await page.getByRole('button',{name:/이전 캐시 배우.*참여 작품/}).count(),0,'no name-based identity guess');
  await page.screenshot({path:path.join(out,'people-desktop.png'),fullPage:true});
  await page.locator('section[aria-labelledby=people-title]').screenshot({path:path.join(out,'native-cast-row.png')});
  await page.getByRole('button',{name:'출연·제작진 전체'}).click();
  await dialog().getByRole('button',{name:/예제 배우 1,.*참여 작품/}).waitFor();
  await dialog().getByText('시리즈 전체 기준',{exact:true}).waitFor();
  await dialog().getByRole('button',{name:/제작/}).click();
  await dialog().getByRole('button',{name:/예제 감독/}).waitFor();
  await dialog().getByRole('button',{name:/출연/}).click();
  await page.screenshot({path:path.join(out,'credits-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const el=document.querySelector('.people-sheet');return el && el.getBoundingClientRect().bottom<=innerHeight+2;});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await dialog().evaluate((el:HTMLElement)=>el.getBoundingClientRect().bottom<=innerHeight+2),true);
  await page.screenshot({path:path.join(out,'credits-mobile.png'),fullPage:true});
  await dialog().getByRole('button',{name:/예제 배우 1,.*참여 작품/}).click();
  const personDialog=page.getByRole('dialog',{name:'예제 배우 1',exact:true});
  await personDialog.getByRole('link',{name:/참여 영화 1 /}).waitFor();
  await personDialog.locator('.person-profile img').waitFor();
  await page.screenshot({path:path.join(out,'person-works-mobile.png'),fullPage:true});
  await personDialog.getByRole('link',{name:/참여 영화 1 /}).click();
  await page.waitForURL('**/search?**');assert.equal(new URL(page.url()).searchParams.get('q'),'참여 영화 1');
  await page.goto(`${base}title/demo`);
  await page.getByRole('button',{name:/예제 배우 1, 캐릭터 1\. 참여 작품 보기/}).click();
  await page.getByRole('dialog',{name:'예제 배우 1',exact:true}).getByRole('link',{name:/참여 영화 1 /}).waitFor();
  await page.keyboard.press('Escape');
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);await page.reload();
  await page.getByRole('button',{name:'출연·제작진 전체'}).click();
  await dialog().getByText(/이 프로필/).waitFor();assert.equal(await dialog().locator('.credit-person').count(),0);
  env.db.run('UPDATE profiles SET kids=0 WHERE id=?',p.id);await page.reload();
  await page.getByRole('button',{name:'출연·제작진 전체'}).waitFor();
  env.db.run("UPDATE tmdb_links SET status='off' WHERE media_id='demo'");
  await page.getByRole('button',{name:'출연·제작진 전체'}).click();await dialog().getByText(/연결되지/).waitFor();
  await env.app.inject({method:'PATCH',url:`/api/admin/plugins/${pkg.id}`,payload:{enabled:false}});await page.reload();
  await page.waitForTimeout(250);assert.equal(await page.getByRole('button',{name:'출연·제작진 전체'}).count(),0);
  assert.equal(await page.getByRole('heading',{name:'출연',exact:true}).count(),0,'off metadata is not replaced by plugin');
  env.db.run("UPDATE tmdb_links SET status='manual' WHERE media_id='demo'");await page.reload();
  await page.getByRole('heading',{name:'출연',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'출연·제작진 전체'}).count(),0);
  assert.equal(await page.getByRole('button',{name:/예제 배우 1.*참여 작품/}).count(),0,'disabled plugin restores ordinary native cast');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.ok(images>0);assert.deepEqual(upstream,['/3/tv/1/aggregate_credits','/3/person/1/combined_credits']);
  console.log(JSON.stringify({result:'passed',upstream,images,screenshots:out,checks:['real detail SDK/API','series scope/voice role','person works','MOA search','mobile','kids','unlinked','disable'],data:'synthetic'}));
}finally{await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
