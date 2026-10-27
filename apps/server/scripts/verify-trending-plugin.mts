// Synthetic loopback app + real discovery API/SDK; poster request bytes stubbed, no external requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { unpackPlugin } from '../src/plugins/service.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=require(process.env.MOA_PLAYWRIGHT_PATH||'playwright');
const out=process.env.MOA_VERIFY_DIR||path.join(tmpdir(),'moa-trending-verify');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(tmpdir(),'moa-trending-app-'));
process.env.MOA_VERSION='0.1.2-beta.1';process.env.VITE_MOCK='0';
let providerCalls=0;
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{tmdb:{token:'synthetic-provider-token',fetch:async(input)=>{
  const u=new URL(String(input));assert.match(u.pathname,/^\/3\/trending\/(movie|tv)\/(day|week)$/);providerCalls++;
  const kind=u.pathname.split('/')[3],period=u.pathname.split('/')[4];
  return Response.json({results:Array.from({length:20},(_,i)=>({id:i+1,adult:false,media_type:kind,title:`예제 영화 ${i+1}`,name:`예제 TV ${i+1}`,original_title:'Synthetic movie',original_name:'Synthetic TV',release_date:'2026-01-01',first_air_date:'2026-01-01',overview:`합성 검증 데이터 ${period}`,poster_path:`/fixture${i}.jpg`}))});
}}});
let vite:any,browser:any;
try{
  const manifest=await readFile(path.join(root,'plugins/trending-titles/manifest.json'),'utf8');
  const script=await readFile(path.join(root,'plugins/trending-titles/plugin.js'),'utf8');
  const pkg=await unpackPlugin({files:[{name:'manifest.json',content:manifest},{name:'plugin.js',content:script}]});
  const installed=await env.app.inject({method:'POST',url:'/api/admin/plugins',payload:pkg});assert.equal(installed.statusCode,200,installed.body);
  const p=(await env.app.inject({method:'POST',url:'/api/profiles',payload:{name:'검증 프로필'}})).json();
  await env.app.listen({host:'127.0.0.1',port:0});
  process.env.MOA_API=`http://127.0.0.1:${(env.app.server.address() as any).port}`;
  vite=await createServer({root:path.join(root,'apps/web'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
  const base=vite.resolvedUrls.local[0],origin=new URL(base).origin;
  browser=await chromium.launch({executablePath:process.env.MOA_BROWSER_EXECUTABLE,args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript((id:string)=>{if(window!==window.top)return;localStorage.setItem('moa.profile',id);localStorage.setItem('moa.remoteMode','off');},p.id);
  const unexpected:string[]=[],errors:string[]=[];
  const sharp=createRequire(import.meta.url)('sharp');
  const fixturePoster=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="#254452"/><circle cx="170" cy="175" r="72" fill="#6da6af"/><text x="170" y="330" text-anchor="middle" font-size="25" fill="white">SAMPLE</text></svg>')).png().toBuffer();
  let posterRequests=0;
  await context.route('**/*',async(route:any)=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin){unexpected.push(u.origin);return route.abort();}
    if(u.pathname===`/api/plugin-runtime/${pkg.id}/request`){
      const body=route.request().postDataJSON();
      assert.match(body.url,/^https:\/\/image\.tmdb\.org\/t\/p\/w342\/fixture\d+\.jpg$/);
      assert.equal(body.revision,installed.json().revision);posterRequests++;
      return route.fulfill({json:{base64:fixturePoster.toString('base64')}});
    }
    if(u.pathname==='/api/admin/updates')return route.fulfill({json:{state:'idle',available:false,supported:false,helperConnected:false}});
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
  const panel=()=>page.frameLocator(`iframe[title="${pkg.name}"]`);
  await page.goto(base);
  await panel().getByRole('button',{name:/1위 예제 영화 1 /}).waitFor();
  assert.equal(await panel().locator('.card').count(),20);
  await panel().locator('.poster img[src^="blob:"]').first().waitFor();
  await panel().locator('.poster img[src^="blob:"]').first().evaluate(async(img:HTMLImageElement)=>{await img.decode();if(!img.naturalWidth)throw Error('poster missing');});
  await page.screenshot({path:path.join(out,'trending-desktop.png'),fullPage:true});
  await panel().getByRole('button',{name:'TV',exact:true}).click();
  await panel().getByRole('button',{name:/1위 예제 TV 1 /}).waitFor();
  await panel().getByRole('button',{name:'주간',exact:true}).click();
  await panel().getByRole('button',{name:/1위 예제 TV 1 /}).waitFor();
  await panel().getByRole('button',{name:'새로고침',exact:true}).click();
  await panel().getByRole('button',{name:/1위 예제 TV 1 /}).waitFor();assert.equal(providerCalls,3,'refresh should reuse server cache');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(out,'trending-mobile.png'),fullPage:true});
  await panel().getByRole('button',{name:/1위 예제 TV 1 /}).click();
  await page.waitForURL('**/search?**');assert.equal(new URL(page.url()).searchParams.get('q'),'예제 TV 1');
  // Switch policy and reload: real host must not serve its cached adult feed to kids.
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);await page.goto(base);
  await panel().getByText('이 프로필에서는 인기 작품 목록을 볼 수 없음').waitFor();assert.equal(await panel().locator('.card').count(),0);
  env.db.run('UPDATE profiles SET kids=0 WHERE id=?',p.id);
  // Disable the package; it must disappear without needing a server restart.
  const disabled=await env.app.inject({method:'PATCH',url:`/api/admin/plugins/${pkg.id}`,payload:{enabled:false}});assert.equal(disabled.statusCode,200);
  await page.reload();await page.getByRole('heading',{name:pkg.name,exact:true}).count();
  await page.waitForTimeout(300);assert.equal(await page.locator(`iframe[title="${pkg.name}"]`).count(),0);
  assert.ok(posterRequests>0,'Posters must pass through SDK fetch and render');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({result:'passed',providerCalls,posterRequests,screenshots:out,checks:['real plugin SDK/API','movie/TV/day/week','cached refresh','MOA search','mobile overflow','kids restriction','disable'],data:'synthetic'}));
}finally{await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
