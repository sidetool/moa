import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const base = process.env.MOA_TEST_BASE || 'http://127.0.0.1:5137';
assert.match(base, /^http:\/\/127\.0\.0\.1:51\d\d$/);
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE,headless:true});
const page = await browser.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const sources = ['fast','middle','slow'].map(id=>({id,name:id,lang:'ko',type:'anime',enabled:true,installed:true}));
const card = (id,source='fast')=>({id,title:'작품 2기',type:'anime',provider:{id:source,name:source,lang:'ko',kind:'mangayomi-js'},seasonInfo:{kind:'season',season:2,label:'시즌 2'}});
let failResolve = false, slowFinished = false, resolves = 0;
let device = { titleGrouping: true };
const baseline = process.env.MOA_TEST_BASELINE === '1';
await page.addInitScript(()=>{localStorage.setItem('moa.profile','test');window.framesSeen=[]; const sample=()=>{const cards=[...document.querySelectorAll('a.poster-card')].map(e=>e.textContent);window.framesSeen.push({cards,sk:document.querySelectorAll('.grid > div.poster-card > .sk').length});requestAnimationFrame(sample)};requestAnimationFrame(sample)});
await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
 const url=new URL(route.request().url());let body={};let status=200;
 if(url.pathname==='/api/sources') body=sources;
 else if(url.pathname==='/api/profiles') body=[{id:'test',name:'테스트',color:'blue'}];
 else if(url.pathname==='/api/settings') body={navigation:[]};
 else if(url.pathname==='/api/settings/device') { if(route.request().method()==='PATCH') device={...device,...route.request().postDataJSON().settings}; body={settings:device}; }
 else if(url.pathname==='/api/me') body={role:'admin'};
 else if(url.pathname==='/api/search') {await new Promise(r=>setTimeout(r,700));body={query:'작품',groups:[]};}
 else if(url.pathname.endsWith('/browse')) {const id=url.pathname.split('/')[3];await new Promise(r=>setTimeout(r,{fast:100,middle:900,slow:1800}[id]));if(id==='slow') slowFinished=true;body={items:[card(id,id),card(id+'-duplicate',id)],page:1,hasNextPage:false};}
 else if(url.pathname==='/api/media/groups/resolve') {resolves++;await new Promise(r=>setTimeout(r,350));body=[card('grouped')];if(route.request().postDataJSON().query==='오디오') body=[{...card('dub'),title:'(더빙) 작품 2기',baseTitle:'더빙 작품',audio:'dub'},{...card('next'),title:'작품 3기',baseTitle:'작품',seasonInfo:{kind:'season',season:3,label:'시즌 3'}},{...card('sub'),title:'작품 2기 (자막)',baseTitle:'작품 자막',audio:'sub'}];if(failResolve){status=500;body={error:'test-failure'}}}
 else body=[];
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
});
try {
 await page.goto(base+'/search?q=작품');
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===1);
 assert.equal(slowFinished,false,'fast grouped result appears before the slow source finishes');
 if(!baseline) await page.waitForFunction(()=>window.framesSeen.some(f=>f.cards.length===1&&f.sk===6));
 await page.waitForFunction(()=>document.querySelector('.search-sources')?.textContent.includes('slow2'));
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===1 && document.querySelectorAll('.grid > div.poster-card > .sk').length===0);
 const frames=await page.evaluate(()=>window.framesSeen);
 const duplicateFrames=frames.filter(f=>f.cards.length>1).length;
 if(!baseline) {
   assert.ok(frames.some(f=>f.sk===12),'initial skeletons');
   assert.ok(frames.every(f=>f.sk<=12),'one initial skeleton grid even while local search is pending');
   assert.equal(duplicateFrames,0,'no frame renders raw duplicate cards');
   const first=frames.findIndex(f=>f.cards.length===1);
   assert.ok(frames.slice(first).every(f=>f.cards.length===1),'previous grouped results persist');
 }
 if(baseline) {console.log(JSON.stringify({frames:frames.length,duplicateFrames,maxCards:Math.max(...frames.map(f=>f.cards.length))}));process.exitCode=0;}
 else {
 failResolve=true;
 await page.goto(base+'/search?q=실패');
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===6);
 failResolve=false;
 await page.goto(base+'/search?q=오디오');
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===3);
 assert.deepEqual(await page.locator('a.poster-card .card-season').allTextContents(),['시즌 2','시즌 2 · 더빙','시즌 3']);
 await page.goto(base+'/profiles');
 await page.evaluate(async sources=>{
   const dependency = name => import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+name)).name);
   const react=await dependency('react.js'); const React=react.default || react;
   const dom=await dependency('react-dom_client.js'); const {createRoot}=dom.default || dom;
   const {QueryClient,QueryClientProvider}=await dependency('@tanstack_react-query.js');
   const {useTabFeed}=await import('/src/features/catalog/GroupedFeed.tsx');
   const root=document.createElement('div');document.body.append(root);window.tabFrames=[];
   const sample=()=>{window.tabFrames.push(root.querySelectorAll('.tab-test-card').length);requestAnimationFrame(sample)};requestAnimationFrame(sample);
   function Feed(){const feed=useTabFeed(sources);return React.createElement('div',{'data-pending':feed.pending},feed.cards.map(c=>React.createElement('span',{key:c.id,className:'tab-test-card'},c.title)));}
   createRoot(root).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(Feed)));
 },sources);
 await page.waitForFunction(()=>window.tabFrames.includes(1));
 await page.waitForTimeout(2200);
 const tabFrames=await page.evaluate(()=>window.tabFrames);
 assert.equal(Math.max(...tabFrames),1,'tab feed never exposes raw cards');
 assert.ok(tabFrames.slice(tabFrames.indexOf(1)).every(n=>n===1),'tab feed retains grouped cards during arrivals');
 const setGrouping = enabled => page.evaluate(async enabled=>{const {saveDevicePrefs}=await import('/src/lib/device-prefs.ts');await saveDevicePrefs({titleGrouping:enabled});},enabled);
 const beforeOff=resolves;
 await setGrouping(false);
 await page.waitForFunction(()=>document.querySelectorAll('.tab-test-card').length===6);
 assert.equal(resolves,beforeOff,'disabling grouping exposes all feed cards without resolve');
 await setGrouping(true);
 await page.waitForFunction(()=>document.querySelectorAll('.tab-test-card').length===1);
 await setGrouping(false);
 const beforeSearchOff=resolves;
 await page.goto(base+'/search?q=묶기끔');
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===6);
 assert.equal(resolves,beforeSearchOff,'disabled search never resolves');
 await setGrouping(true);
 await page.waitForFunction(()=>document.querySelectorAll('a.poster-card').length===1);
 assert.ok(resolves>beforeSearchOff,'enabling grouping resolves immediately without reload');
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log(JSON.stringify({frames:frames.length,duplicateFrames,initialSkeletons:12,pendingSkeletons:6,errorFallbackCards:6,incremental:true,audioOrder:true,tabFeed:true,groupingToggle:true}));
 }
} catch(error) { console.error(await page.locator('body').innerText()); console.error(await page.evaluate(()=>({search:window.framesSeen.slice(-3),tab:window.tabFrames?.slice(-5)}))); throw error; } finally { await browser.close(); }
