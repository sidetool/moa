import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { invokeMangayomi, parseRepository, compatibilityHttp, runExtension } from '../../src/sources/extensions/index.js';

const row = { id: 123, name: 'Fixture', lang: 'ko', version: '1.0', itemType: 1, sourceCodeLanguage: 1, baseUrl: 'https://example.com', sourceCodeUrl: 'https://example.com/source.js' };
const entry = parseRepository([row])[0];
const source = `class DefaultExtension extends MProvider {
 getSourcePreferences(){return [{key:'label',editTextPreference:{title:'Label',value:'Default'}}];}
 async getPopular(){const r=await new Client().get('https://example.com');const doc=new Document(r.body);return {list:[{name:doc.selectFirst('h1').text,link:'/one'}],hasNextPage:false};}
 async getDetail(url){return {name:'Series',link:url,chapters:[{name:'1화',url:'/ep1'}]};}
 async getVideoList(url){return [{url:'https://example.com/video.m3u8',headers:{Referer:'https://example.com'},subtitles:[{file:'https://example.com/ko.vtt',label:'한국어'}]}];}
}`;

test('repository accepts video JS entries, isolates duplicate IDs and rejects unsafe metadata', () => {
  assert.equal(entry.itemType, 1); assert.equal(entry.id, '123');
  assert.equal(parseRepository([{ ...row, itemType: 0 }, { ...row, sourceCodeLanguage: 0 }]).length, 0);
  assert.throws(() => parseRepository([row, row]), /repository-entry-invalid/);
  const variants=parseRepository([{...row,lang:'en'},{...row,lang:'ja'}]);
  assert.deepEqual(variants.map(e=>[e.id,e.lang]),[['123','en'],['123','ja']]);
  assert.equal(parseRepository([{...row,iconUrl:'file:///invalid'}])[0].iconUrl,undefined);
  assert.equal(parseRepository([{...row,iconUrl:'https://example.com/icon.png'}])[0].iconUrl,'https://example.com/icon.png');
  assert.throws(() => parseRepository([{ ...row, sourceCodeUrl: 'file:///etc/passwd' }]), /repository-url-invalid/);
});
test('original-shaped source runs list, DOM, preferences, details and videos with subtitles', async () => {
  const transport = async () => ({ bytes: Buffer.from('<h1>영상 작품</h1>'), headers: {}, statusCode: 200, contentType: 'text/html' });
  const input = { source, entry, signal: AbortSignal.timeout(15_000) };
  const list = await invokeMangayomi({ ...input, action: 'list' }, transport as typeof compatibilityHttp);
  assert.equal((list.result as any).list[0].name, '영상 작품');
  const detail = await invokeMangayomi({ ...input, action: 'detail', params: { workUrl: '/one' } });
  assert.equal((detail.result as any).chapters[0].url, '/ep1');
  const videos = await invokeMangayomi({ ...input, action: 'videos', params: { episodeUrl: '/ep1' } });
  assert.equal((videos.result as any)[0].subtitles[0].label, '한국어');
  assert.equal((videos.result as any)[0].headers.Referer, 'https://example.com');
});
test('Client accepts wrapped request headers without changing direct headers, bodies or HTTP limits', async () => {
  const requests: any[] = [];
  const code = `class DefaultExtension extends MProvider {
    async getPopular(){
      const client=new Client({timeout:8,followRedirects:false});
      const headers={Referer:'https://example.com','Content-Type':'application/json'};
      await client.get('https://example.com/list',{headers});
      await client.get('https://example.com/direct',headers);
      await client.post('https://example.com/json',{headers},{name:'한글'});
      await client.post('https://example.com/form',{'X-Test':'form'},{name:'한글'});
      return {list:[],hasNextPage:false};
    }
  }`;
  await invokeMangayomi({entry,source:code,action:'list',signal:AbortSignal.timeout(5000)},async request=>{
    requests.push(request);
    return {bytes:Buffer.from('{}'),headers:{},statusCode:200,contentType:'application/json'};
  });
  assert.deepEqual(requests[0].headers,requests[1].headers);
  assert.equal(requests[0].headers.Referer,'https://example.com');
  assert.equal(requests[2].body,JSON.stringify({name:'한글'}));
  assert.equal(requests[3].headers['Content-Type'],'application/x-www-form-urlencoded');
  assert.equal(requests[3].body,'name='+encodeURIComponent('한글'));
  for(const request of requests)assert.deepEqual(request.options,{timeout:8,followRedirects:false});
});
test('extension cannot reach private network or silently obtain a WebView', async () => {
  await assert.rejects(compatibilityHttp({ url: 'https://127.0.0.1/test' }, AbortSignal.timeout(5000)), /source_address_denied/);
  await assert.rejects(invokeMangayomi({ entry, source: `class DefaultExtension extends MProvider { async getVideoList(){return evaluateJavascriptViaWebview('https://example.com',{},['1']);} }`, action: 'videos', signal: AbortSignal.timeout(5000) }), /source_browser_unavailable/);
});
test('guest has no Node globals; CPU loops and cancellation terminate', async () => {
  const isolated = await runExtension({ source: "globalThis.moaExtension=()=>({process:typeof process,require:typeof require});", method: 'check' });
  assert.deepEqual(isolated, { process: 'undefined', require: 'undefined' });
  await assert.rejects(runExtension({ source: 'globalThis.moaExtension=()=>{while(true){}};', method: 'check', timeoutMs: 100 }), /execution_timeout/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runExtension({ source: 'globalThis.moaExtension=()=>1;', method: 'check', signal: controller.signal }), /cancelled/);
});

test('Korean Referer paths are encoded like browser requests', async () => {
  let referer: string | undefined;
  const server = createServer((req, res) => { referer = req.headers.referer; res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    await compatibilityHttp({ url: origin, headers: { Referer: 'https://example.com/영상/1화' } }, AbortSignal.timeout(5000), [origin]);
    assert.equal(referer, new URL('https://example.com/영상/1화').href);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('detail revision fragments are omitted on the wire, including after redirects', async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === '/detail') { res.writeHead(302, { location: '/next?lang=ko#revision' }); res.end(); }
    else res.end('detail');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const result = await compatibilityHttp({ url: origin + '/detail#fixture_detail_v2' }, AbortSignal.timeout(5000), [origin]);
    assert.equal(result.bytes.toString(), 'detail');
    assert.deepEqual(paths, ['/detail', '/next?lang=ko']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('filter discovery does not fetch a listing; heterogeneous filter states reach search',async()=>{
 const code=`class DefaultExtension extends MProvider {
 get supportsLatest(){return false;}
 async getFilterList(){return [{type_name:'GroupFilter',name:'구역',state:[{type_name:'SelectFilter',name:'정렬',values:['원본순','인기'],state:0},{type_name:'TriStateFilter',name:'장르',state:0}]},{type_name:'SortFilter',name:'순서',values:['제목','날짜'],state:{index:0,ascending:false}},{type_name:'TextFilter',name:'문자',state:''},{type_name:'CheckBoxFilter',name:'완결',state:false}];}
 async getPopular(){throw new Error('should-not-fetch');}
 async search(q,page,filters){return {list:[{name:JSON.stringify(filters.map(f=>f.state)),link:'https://example.com/one'}],hasNextPage:false};}
 }`;
 const result=await invokeMangayomi({entry,source:code,action:'filters'});
 const schema=(result.result as any).browse;
 assert.deepEqual(schema.availableModes,['popular','search']);assert.equal(schema.filters[1].groupPosition,0);
 const page=await invokeMangayomi({entry,source:code,action:'list',params:{mode:'search',filters:[{position:0,groupPosition:0,value:1},{position:0,groupPosition:1,value:'EXCLUDE'},{position:1,value:{index:1,ascending:true}},{position:2,value:'123'},{position:3,value:true}]}});
 const states=JSON.parse((page.result as any).list[0].name);
 assert.equal(states[0][0].state,1);assert.equal(states[0][1].state,2);assert.deepEqual(states[1],{index:1,ascending:true});assert.equal(states[2],'123');assert.equal(states[3],true);
});

test('all Client methods preserve direct and wrapped headers, raw bodies and null bodies', async () => {
  const requests: any[]=[];
  const code=`class DefaultExtension extends MProvider {async getPopular(){
    const c=new Client();
    for(const method of ['get','head','post','put','patch','delete']){
      await c[method]('https://example.com',{headers:{'X-Test':method}},null);
      await c[method]('https://example.com',{'X-Test':method},'raw=a%20b');
    }
    await c.post('https://example.com',{'Content-Type':'application/json'},null);
    return {list:[],hasNextPage:false};
  }}`;
  await invokeMangayomi({entry,source:code,action:'list',signal:AbortSignal.timeout(5000)},async request=>{
    requests.push(request);return {bytes:Buffer.from('{}'),headers:{},statusCode:200,contentType:'application/json'};
  });
  for(let i=0;i<12;i+=2){assert.equal(requests[i].body,undefined);assert.deepEqual(requests[i].headers,requests[i+1].headers);assert.equal(requests[i].method,requests[i].headers['X-Test'].toUpperCase());if(i>=4)assert.equal(requests[i+1].body,'raw=a%20b');}
  assert.equal(requests[12].body,'null');
});

test('swallowed transport/HTTP errors cannot become cacheable empty lists or videos; successful fallbacks remain usable', async () => {
  const base={entry,signal:AbortSignal.timeout(15000)};
  const fixture=(body:string)=>`class DefaultExtension extends MProvider {async getPopular(){${body};return {list:[],hasNextPage:false};} async getVideoList(){try{await new Client().get('https://example.com')}catch{};return [];}}`;
  const failure=async()=>{throw new Error('source_http_failed');};
  for(const action of ['list','videos'])await assert.rejects(invokeMangayomi({...base,source:fixture("try{await new Client().get('https://example.com')}catch{}"),action},failure),/source_http_failed/);
  const response=(statusCode=200)=>({bytes:Buffer.from('{}'),headers:{},statusCode,contentType:'application/json'});
  await assert.rejects(invokeMangayomi({...base,source:fixture("await new Client().get('https://example.com')"),action:'list'},async()=>response(503)),/source_http_failed/);
  const empty=await invokeMangayomi({...base,source:fixture("await new Client().get('https://example.com')"),action:'list'},async()=>response());
  assert.deepEqual((empty.result as any).list,[]);
  let calls=0;
  const recovered=await invokeMangayomi({...base,source:fixture("try{await new Client().get('https://example.com')}catch{};await new Client().get('https://example.com/fallback')"),action:'list'},async()=>{if(calls++===0)throw new Error('source_request_timeout');return response();});
  assert.deepEqual((recovered.result as any).list,[]);
});

test('detail has reserved admission while two lists occupy their own isolated guest processes',async()=>{
  let release!:()=>void, ready!:()=>void, calls=0;
  const blocked=new Promise<void>(r=>{release=r;}),bothStarted=new Promise<void>(r=>{ready=r;});
  const code=`globalThis.counter=(globalThis.counter||0)+1;
    class DefaultExtension extends MProvider {
      async getPopular(){await new Client().get('https://example.com');return {list:[{name:String(globalThis.counter),link:'/one'}],hasNextPage:false};}
      async getDetail(url){return {name:String(globalThis.counter),link:url,chapters:[]};}
    }`;
  const input={entry,source:code,signal:AbortSignal.timeout(10000)};
  const transport=async()=>{if(++calls===2)ready();await blocked;return {bytes:Buffer.from('ok'),headers:{},statusCode:200,contentType:'text/plain'};};
  const lists=[invokeMangayomi({...input,action:'list'},transport),invokeMangayomi({...input,action:'list'},transport)];
  try {
    await bothStarted;
    const detail=await invokeMangayomi({...input,action:'detail',params:{workUrl:'/one'},signal:AbortSignal.timeout(3000)});
    assert.equal((detail.result as any).name,'1','detail has a fresh realm and runs before either list is released');
  } finally {release();}
  for(const list of await Promise.all(lists))assert.equal((list.result as any).list[0].name,'1');
});
