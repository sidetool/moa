// Synthetic loopback app + real discovery API/SDK; poster request bytes stubbed, no external requests.
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
const out=process.env.MOA_VERIFY_DIR||path.join(tmpdir(),'moa-schedule-verify');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(tmpdir(),'moa-schedule-app-'));
process.env.MOA_VERSION='0.1.2-beta.3';process.env.VITE_MOCK='0';
let providerCalls=0;
const day=new Date(Date.now()+9*3600_000).toISOString().slice(0,10);
const env=await buildApp({dataDir:dir,mediaRoot:dir,webDir:path.join(dir,'web'),requireAccount:false},false,{
 schedule:{fetch:async input=>{providerCalls++;const d=new URL(String(input)).searchParams.get('date');return Response.json(Array.from({length:4},(_,i)=>({id:i+1,airdate:d,airtime:`${19+i}:00`,airstamp:`${d}T${10+i}:00:00Z`,season:1,number:i+1,show:{name:['봄날의 편지','우리들의 시간','다시 만난 계절','밤을 걷는 사람들'][i],type:'Scripted',network:{name:'예시 채널',country:{code:'KR'}}}})));}},
 tmdb:{token:'synthetic-provider-token',fetch:async input=>{const u=new URL(String(input));providerCalls++;if(u.pathname==='/3/discover/movie')return Response.json({results:[{id:1,title:'오래된 정원',adult:false},{id:2,title:'별빛 산책',adult:false}],total_pages:1});if(u.pathname.endsWith('/release_dates'))return Response.json({results:[{iso_3166_1:'KR',release_dates:[{type:3,release_date:day+'T00:00:00Z'}]}]});throw Error('unexpected endpoint');}}
});
let vite:any,browser:any;
try{
  const manifest=await readFile(path.join(root,'plugins/release-calendar/manifest.json'),'utf8');
  const script=await readFile(path.join(root,'plugins/release-calendar/plugin.js'),'utf8');
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
  await panel().getByRole('button',{name:'오래된 정원 MOA에서 검색'}).waitFor();
  await page.locator(`iframe[title="${pkg.name}"]`).screenshot({path:path.join(out,'calendar-desktop.png')});
  await panel().getByRole('button',{name:'드라마 방영',exact:true}).click();
  await panel().getByRole('button',{name:'봄날의 편지 MOA에서 검색'}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await panel().locator('body').evaluate((e:HTMLElement)=>e.scrollWidth>innerWidth),false);
  await page.locator(`iframe[title="${pkg.name}"]`).screenshot({path:path.join(out,'calendar-mobile.png')});
  await panel().getByRole('button',{name:'봄날의 편지 MOA에서 검색'}).click();await page.waitForURL('**/search?**');assert.equal(new URL(page.url()).searchParams.get('q'),'봄날의 편지');
  env.db.run('UPDATE profiles SET kids=1 WHERE id=?',p.id);await page.goto(base);
  await panel().getByText('이 프로필에서는 외부 일정을 표시하지 않아요.').waitFor();assert.equal(await panel().locator('#list li').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(JSON.stringify({ok:true,providerCalls,screenshots:out}));
}finally{await browser?.close();await vite?.close();await env.app.close();await rm(dir,{recursive:true,force:true});}
