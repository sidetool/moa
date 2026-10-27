import { mangayomiFilters } from './filters.mjs';
/** Independently implemented compatibility surface; extension code stays inside QuickJS. */
export const mangayomiBootstrap = String.raw`
let bridge, preferenceValues, preferenceChanges;
let activeRequests=0;const requestQueue=[];
function queuedRequest(method,input){return new Promise((resolve,reject)=>{if(requestQueue.length>=512){reject(new Error('compatibility_feature_unsupported'));return;}requestQueue.push({method,input,resolve,reject});drainRequests();});}
function drainRequests(){while(activeRequests<4&&requestQueue.length){const task=requestQueue.shift();activeRequests++;bridge.request(task.method,task.input).then(task.resolve,task.reject).finally(()=>{activeRequests--;drainRequests();});}}
const unsupported=()=>{const e=new Error('compatibility_feature_unsupported');e.code='compatibility_feature_unsupported';throw e;};
// Match the string-instance helpers exposed by Mangayomi, including missing delimiters.
Object.defineProperties(String.prototype,{
 substringAfter:{value:function(p){const n=this.indexOf(p);return n<0?String(this):this.substring(n+p.length);},configurable:true,writable:true},
 substringAfterLast:{value:function(p){return this.split(p).pop();},configurable:true,writable:true},
 substringBefore:{value:function(p){const n=this.indexOf(p);return n<0?String(this):this.substring(0,n);},configurable:true,writable:true},
 substringBeforeLast:{value:function(p){const n=this.lastIndexOf(p);return n<0?String(this):this.substring(0,n);},configurable:true,writable:true},
 substringBetween:{value:function(a,b){const n=this.indexOf(a);if(n<0)return '';const start=n+a.length,end=this.indexOf(b,start);return end<0?'':this.substring(start,end);},configurable:true,writable:true}
});
function optionalMethod(extension,name,args,fallback){try{return extension[name](...args);}catch(error){if(new RegExp('^'+name+' not implemented[.!]?$').test(error?.message))return fallback;throw error;}}
function cryptoHandler(text,iv,secretKeyString,encrypt){return __moaCryptoHandler(String(text),String(iv),String(secretKeyString),encrypt===true);}
class MProvider {
  get source(){return sourceMetadata;}
  get supportsLatest(){return typeof this.getLatestUpdates==='function';}
  getHeaders(){return {};}
  getFilterList(){return [];}
  getSourcePreferences(){return [];}
  substringAfter(s,p){const n=s.indexOf(p);return n<0?s:s.slice(n+p.length);}
  substringAfterLast(s,p){const n=s.lastIndexOf(p);return n<0?s:s.slice(n+p.length);}
  substringBefore(s,p){const n=s.indexOf(p);return n<0?s:s.slice(0,n);}
  substringBeforeLast(s,p){const n=s.lastIndexOf(p);return n<0?s:s.slice(0,n);}
  substringBetween(s,a,b){return this.substringBefore(this.substringAfter(s,a),b);}
}
class SharedPreferences {
  get(key){return preferenceValues[key] ?? null;}
  getString(key,defaultValue){const v=this.get(key);if(v!=null)return String(v);if(defaultValue===undefined)return null;this.setString(key,defaultValue);return String(defaultValue);}
  getBool(key){return this.get(key);}
  getBoolean(key){return this.get(key);}
  getInt(key){return this.get(key);}
  getDouble(key){return this.get(key);}
  containsKey(key){return Object.prototype.hasOwnProperty.call(preferenceValues,key);}
  set(key,value){if(typeof key!=='string'||key.length>256||!['string','boolean','number'].includes(typeof value))unsupported();preferenceValues[key]=value;preferenceChanges[key]=value;return true;}
  setString(k,v){return this.set(k,String(v));} setBool(k,v){return this.set(k,!!v);} setBoolean(k,v){return this.set(k,!!v);}
  setInt(k,v){return this.set(k,Number(v));} setDouble(k,v){return this.set(k,Number(v));}
  remove(k){delete preferenceValues[k];preferenceChanges[k]=null;return true;}
}
class Client {
  constructor(options){this.options=options||{};}
  request(method,url,headers,body){
    // Some original sources pass Client.get(url, {headers: {...}}).
    // Keep accepting the direct header map used by the other sources.
    if(headers&&headers.headers&&typeof headers.headers==='object'&&!Array.isArray(headers.headers))headers=headers.headers;
    if(body!==undefined&&typeof body!=='string'){const json=Object.entries(headers||{}).some(([k,v])=>k.toLowerCase()==='content-type'&&String(v).includes('json'));body=json?JSON.stringify(body):body===null?undefined:Object.entries(body).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');headers={...(json||body===undefined?{}:{'Content-Type':'application/x-www-form-urlencoded'}),...headers};}return queuedRequest('compatibility.http',{method,url,headers,body,options:this.options});
  }
  get(u,h){return this.request('GET',u,h);} post(u,h,b){return this.request('POST',u,h,b);} put(u,h,b){return this.request('PUT',u,h,b);} delete(u,h,b){return this.request('DELETE',u,h,b);} head(u,h){return this.request('HEAD',u,h);} patch(u,h,b){return this.request('PATCH',u,h,b);}
}
class DomNode {
  constructor(node){this.node=node;}
  select(selector){return Array.from(this.node?.querySelectorAll(selector)||[],n=>new DomNode(n));}
  selectFirst(selector){return new DomNode(this.node?.querySelector(selector));}
  getElementById(id){return this.selectFirst('[id="'+String(id).replace(/["\\]/g,'\\$&')+'"]');}
  getElementsByTagName(tag){return this.select(tag);}
  getElementsByClassName(name){const names=String(name).trim().split(/\s+/).filter(Boolean);return names.length?this.select('*').filter(n=>names.every(c=>n.node.classList.contains(c))):[];}
  attr(name){return this.node?.getAttribute?.(name)||'';}
  hasAttr(name){return this.node?.hasAttribute?.(name)||false;}
  get text(){return this.node?.textContent||'';}
  get ownText(){return Array.from(this.node?.childNodes||[]).filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim();}
  get html(){return this.innerHtml;} get innerHtml(){return this.node?.innerHTML||'';} get outerHtml(){return this.node?.outerHTML||'';}
  get className(){return this.node?.className||'';} get localName(){return this.node?.localName||'';} get namespaceUri(){return this.node?.namespaceURI||'';}
  get getSrc(){return /src="([^"]+)"/.exec(this.outerHtml)?.[1]||'';}
  get getImg(){return /img="([^"]+)"/.exec(this.outerHtml)?.[1]||'';}
  get getHref(){return /href="([^"]+)"/.exec(this.outerHtml)?.[1]||'';}
  get getDataSrc(){return /data-src="([^"]+)"/.exec(this.outerHtml)?.[1]||'';}
  get children(){return Array.from(this.node?.children||[],n=>new DomNode(n));}
  get parent(){return this.node?.parentElement?new DomNode(this.node.parentElement):null;}
  get nextElementSibling(){return new DomNode(this.node?.nextElementSibling);}
  get previousElementSibling(){return new DomNode(this.node?.previousElementSibling);}
  remove(){this.node?.remove();} toString(){return this.outerHtml;}
}
class Document extends DomNode {
 constructor(html){super(__moaParseHTML(String(html)).document);}
 get body(){return this.node.body?new DomNode(this.node.body):null;}
 get head(){return this.node.head?new DomNode(this.node.head):null;}
 get documentElement(){return this.node.documentElement?new DomNode(this.node.documentElement):null;}
}
const console={log(){},warn(){},error(){},debug(){}};
let timerId=0;const timers=new Map();
function setTimeout(fn,delay,...args){if(typeof fn!=='function'||timers.size>=128)unsupported();const id=++timerId;let ms=Number(delay);if(!Number.isFinite(ms)||ms<0)ms=0;timers.set(id,{fn,args,at:Date.now()+Math.min(ms,2147483647)});return id;}
function clearTimeout(id){timers.delete(id);}
// The compatibility helper pumps these inside the same CPU/memory/deadline limits as all guest code.
// Timers never occupy HTTP RPC slots, and cancellation immediately drops the callback.
globalThis.__moaRunTimers=()=>{const now=Date.now();const due=[...timers].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]).slice(0,32);for(const [id,t] of due){if(timers.delete(id))t.fn(...t.args);}};
const evaluate=unsupported,fetch=unsupported;
async function evaluateJavascriptViaWebview(url,headers,scripts,timeout){
  return queuedRequest('compatibility.webview',{url,headers:headers||{},scripts,timeout});
}
async function sendMessage(method,payload){
  if(method!=='evaluateJavascriptViaWebview')unsupported();
  const args=typeof payload==='string'?JSON.parse(payload):payload;
  if(!Array.isArray(args)||args.length<3||args.length>4)throw new Error('invalid_source_invocation');
  return evaluateJavascriptViaWebview(...args);
}
`;
export const mangayomiDispatch =
  `const compatibilityFilters=${mangayomiFilters.toString()};\n` +
  String.raw`
globalThis.moaExtension=async function(method,input,host){
 bridge=host;preferenceValues=Object.assign(Object.create(null),input.preferences||{});preferenceChanges=Object.create(null);
 if(input.action==='metadata')return {result:typeof mangayomiSources==='undefined'?[]:mangayomiSources,changes:{}};
 const extension=new DefaultExtension();const specs=optionalMethod(extension,'getSourcePreferences',[],[])||[];
 if(!Array.isArray(specs))throw new Error('compatibility_preferences_invalid');
 for(const spec of specs){if(Object.prototype.hasOwnProperty.call(preferenceValues,spec.key))continue;
 const field=spec.editTextPreference||spec.switchPreferenceCompat||spec.listPreference||spec.multiSelectListPreference;
 if(!field)continue;
 preferenceValues[spec.key]=spec.multiSelectListPreference?(field.values||[]):spec.listPreference?(field.valueIndex===undefined?(field.value??field.entryValues?.[0]):field.entryValues?.[field.valueIndex]):field.value;
 }
 let result;const p=input.params||{};
 if(input.action==='metadata')result=typeof mangayomiSources==='undefined'?[]:mangayomiSources;
 else if(input.action==='preferences')result=specs;
 else if(input.action==='list'||input.action==='filters'){
 let filters;try{filters=await extension.getFilterList()||[];}catch(error){if(!/^getFilterList not implemented[.!]?$/.test(error.message))throw error;filters=[];}
 const definitions=compatibilityFilters(filters,p.filters||[]);
 const mode=p.query?'search':p.mode||(p.filters?.length?'search':'popular');
 let latest=false;try{latest=extension.supportsLatest===true;}catch(error){if(!/^supportsLatest not implemented[.!]?$/.test(error.message))throw error;}
 result=input.action==='filters'?{}:mode==='search'?await extension.search(p.query||'',p.page||1,filters):mode==='latest'?await extension.getLatestUpdates(p.page||1):await extension.getPopular(p.page||1);
 result.browse={activeMode:mode,availableModes:latest?['popular','latest','search']:['popular','search'],filters:definitions};
 }
 else if(input.action==='detail'||input.action==='chapters')result=await extension.getDetail(p.workUrl);
 else if(input.action==='videos'){if(typeof extension.getVideoList!=='function')unsupported();result=await extension.getVideoList(p.episodeUrl);}
 else if(input.action==='pages'){result=await extension.getPageList(p.chapterUrl);if(Array.isArray(result))result=await Promise.all(result.map(async page=>{const url=typeof page==='string'?page:page.url;return {url,headers:(typeof page==='object'&&page.headers)||await optionalMethod(extension,'getHeaders',[url],{})||{}};}));}
 // Original novel sources own cleaning; invoking it again destroys already-extracted fragments.
 else if(input.action==='html'){if(sourceMetadata.itemType!==2||typeof extension.getHtmlContent!=='function')unsupported();result=await extension.getHtmlContent(p.title,p.chapterUrl);}
 else if(input.action==='headers')result=await optionalMethod(extension,'getHeaders',[p.url],{})||{};
 else unsupported();
 if(input.action==='list'||input.action==='detail'||input.action==='chapters'){
  // Covers belong to their work page. Image-host Referer fails on hotlink-protected CDNs.
  const covers=async(value,depth)=>{
   if(!value||typeof value!=='object'||depth>4)return;
   if(Array.isArray(value)){for(const item of value)await covers(item,depth+1);return;}
   if(typeof value.imageUrl==='string'&&/^https:\/\//i.test(value.imageUrl)){
    let context=value.link||value.url||p.workUrl||sourceMetadata.baseUrl||value.imageUrl;
    if(typeof context==='string'&&context.startsWith('/')){
     const origin=/^https?:\/\/[^/]+/.exec(extension.baseUrl||sourceMetadata.baseUrl||'');
     if(context.startsWith('//'))context='https:'+context;
     else if(origin)context=origin[0]+context;
    }
    value.imageHeaders=value.imageHeaders||await optionalMethod(extension,'getHeaders',[context],{})||{};
   }
   for(const key of Object.keys(value))if(key!=='imageHeaders')await covers(value[key],depth+1);
  };
  await covers(result,0);
 }
 return {result,changes:preferenceChanges};
};
`;
