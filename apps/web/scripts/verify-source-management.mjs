import { verificationPath } from './verification-path.mjs';
import assert from 'node:assert/strict';import{createRequire}from'node:module';
const{chromium}=createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH||'playwright-core');const base=process.env.MOA_VERIFY_URL||'http://127.0.0.1:18795';
const b=await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE }),c=await b.newContext({viewport:{width:390,height:844}});await c.addInitScript(()=>localStorage.setItem('moa.profile','test'));const p=await c.newPage(),errors=[],actions=[];p.on('pageerror',e=>errors.push(String(e)));
let repos=[],source={id:'s',name:'시험 소스',version:'2',installedVersion:'1',installed:true,enabled:true,type:'anime',live:false,repository:'https://one.example/index.json'};
await c.route(u=>u.pathname.startsWith('/api/'),r=>{const path=new URL(r.request().url()).pathname,method=r.request().method(),body=method==='GET'?{}:r.request().postDataJSON();
 if(path==='/api/me')return r.fulfill({json:{role:'admin'}});
 if(path==='/api/admin/sources/s/preload')return r.fulfill({json:{state:'idle',cachedItems:0,pages:0}});
 if(path==='/api/source-repositories'){if(method==='DELETE')repos=repos.filter(repo=>repo.url!==body.url);return r.fulfill({json:repos});}
 if(path==='/api/sources/refresh'){if(!repos.some(repo=>repo.url===body.url))repos.push({url:body.url,checkedAt:new Date().toISOString()});actions.push('refresh:'+body.url);return r.fulfill({json:[source]});}
 if(path==='/api/sources/s/install'){source={...source,installedVersion:'2',rollbackVersion:'1'};actions.push('install');return r.fulfill({json:source});}
 if(path==='/api/sources/s/rollback'){source={...source,installedVersion:'1',rollbackVersion:undefined};actions.push('rollback');return r.fulfill({json:source});}
 if(path==='/api/sources/s/check'){source={...source,health:{ok:false,checkedAt:new Date().toISOString(),code:'connection-failed'}};return r.fulfill({json:source});}
 if(path==='/api/sources')return r.fulfill({json:[source]});if(path==='/api/settings')return r.fulfill({json:{}});if(path==='/api/profiles')return r.fulfill({json:[{id:'test',name:'테스트',color:'blue'}]});return r.fulfill({json:[]});});
try{
 await p.goto(base+'/sources');await p.getByLabel('확장 저장소 주소').fill('https://one.example/index.json');await p.getByRole('button',{name:'저장소 추가',exact:true}).click();await p.locator('.source-repositories-toggle[aria-expanded="false"]').waitFor();await p.locator('.source-repositories-toggle').click();await p.locator('.repository-entry').first().waitFor();await p.getByLabel('확장 저장소 주소').fill('https://two.example/index.json');await p.getByRole('button',{name:'저장소 추가',exact:true}).click();await p.waitForFunction(()=>document.querySelectorAll('.repository-entry').length===2);
 await p.getByRole('button',{name:'업데이트',exact:true}).click();await p.getByRole('button',{name:'시험 소스 설정',exact:true}).click();await p.getByRole('button',{name:'이전 버전 1 복원',exact:true}).click();await p.getByRole('button',{name:'업데이트',exact:true}).waitFor();assert.deepEqual(actions.slice(-2),['install','rollback']);
 await p.getByRole('button',{name:'연결 확인',exact:true}).click();await p.getByRole('status').filter({hasText:'네트워크·프록시 연결 실패'}).waitFor();
 await p.locator('.repository-entry').first().getByRole('button',{name:'등록 해제'}).click();await p.waitForFunction(()=>document.querySelectorAll('.repository-entry').length===1);assert.equal(await p.locator('.source-entry').count(),1);
 await p.screenshot({path:verificationPath('verification-recovery-repositories.png'),fullPage:true});
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,actions,errors},null,2));
}finally{await b.close();}
