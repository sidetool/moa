import { verificationPath } from './verification-path.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const {chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH||'playwright-core');
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({root,configFile:root+'/vite.config.ts',server:{port:0},plugins:[{name:'rank-fixture',configureServer(s){s.middlewares.use(async (req,res,next)=>{
 if(!req.url.startsWith('/__rank_verify'))return next();
 res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml('/__rank_verify', `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import{BrowserRouter}from'react-router-dom';import{Row}from'/src/components/Row.tsx';import '/src/styles/base.scss';import '/src/styles/components.scss';
 const items=Array.from({length:10},(_,i)=>({id:String(i),title:['구름 정원의 여행자','이름이 긴 작품의 제목도 깔끔하게 표시됩니다','나침반을 잘 찾는 탐험가'][i%3],type:'anime',provider:{id:'test',name:'test'}}));
 createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement('div',null,React.createElement('div',{style:{height:100}}),React.createElement(Row,{rank:true,row:{id:'top',title:'오늘의 TOP 10',layout:'poster',items}}),React.createElement('div',{style:{height:1600,padding:20}},'다음 콘텐츠'))));
 </script></html>`));
 });}}]});
let browser;
try{
 await server.listen();browser=await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });const page=await browser.newPage({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});page.on('pageerror',e=>console.log('pageerror',String(e)));await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__rank_verify');await page.waitForSelector('.rank-card');
 const row=page.locator('.row-track'),cdp=await page.context().newCDPSession(page);
 console.log('dimensions',await row.evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight,overflowY:getComputedStyle(el).overflowY})));
 const drag=async(x,y,dx,dy)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y}]});for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x+dx*i/12,y:y+dy*i/12}]});await page.waitForTimeout(20);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(300);};
 const b=await row.boundingBox();await drag(300,b.y+65,-210,2);assert.ok(await row.evaluate(el=>el.scrollLeft)>100,'horizontal browsing');
 await drag(195,b.y+110,8,-170);assert.ok(await page.evaluate(()=>scrollY)>60,'vertical swipe leaves ranked row');
 assert.equal(await row.evaluate(el=>el.scrollTop),0,'no inner vertical scroll');
 await page.evaluate(()=>scrollTo(0,0));await row.evaluate(el=>el.scrollLeft=0);await page.waitForTimeout(250);
 assert.equal(await page.locator('.rank-card .card-title').count(),10);
 const title=await page.locator('.rank-card').first().evaluate(el=>{const frame=el.querySelector('.card-frame').getBoundingClientRect(),title=el.querySelector('.card-title').getBoundingClientRect();return {below:title.top>=frame.bottom,left:Math.abs(title.left-frame.left)<1};});assert.ok(title.below&&title.left);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:verificationPath('verification-rank-mobile.png')});console.log('PASS: horizontal browsing, vertical escape and poster-aligned titles');
}finally{await browser?.close();await server.close();}
