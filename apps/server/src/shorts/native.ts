import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { publicStream } from '../sources/extensions/index.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiFailure } from '../util.js';
import { subtitleDocument } from '../translation/subtitle.js';
import { rewritePlaylist } from '../playback/remote.js';

type Caption={url:string;lang:string;label:string;auto:boolean};
export type NativeTrailer = { videoId?:string; title?:string; subtitles?:Caption[]; url:string; mime:'video/mp4'|'application/vnd.apple.mpegurl'; headers:Record<string,string>; master?:boolean };
export type TrailerExtractor = (id:string,signal:AbortSignal,proxy?:string)=>Promise<NativeTrailer>;
const fail = (status=502,code='shorts-native-unavailable')=>new ApiFailure(status,code);
const token=()=>randomBytes(24).toString('base64url');
const TTL=10*60_000, BYTE_LIMIT=128*1024*1024;

/** Only media endpoints returned by the fixed YouTube extractor. publicStream also pins public DNS on every hop. */
export function trailerMediaUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>16384)throw fail();
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)googlevideo\.com$/.test(u.hostname))throw fail();
  return u.href;
}
export function trailerCaptionUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>16384)throw fail();
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.youtube.com','youtube.com'].includes(u.hostname)||u.pathname!=='/api/timedtext')throw fail();
  return u.href;
}
function captions(value:any):Caption[]{
  const found:Caption[]=[];
  for(const [auto,source] of [[false,value.subtitles],[true,value.automatic_captions]] as const){
    if(!source||typeof source!=='object')continue;
    for(const [lang,entries] of Object.entries(source)){
      if(!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8}){0,3}$/.test(lang)||!Array.isArray(entries))continue;
      for(const row of entries){
        try{
          if(row.ext!=='vtt')continue;
          const url=trailerCaptionUrl(row.url);
          // Original ASR only: translated variants use MOA's explicit translation setting.
          if(new URL(url).searchParams.has('tlang'))continue;
          const normalized=lang.replace(/-orig$/i,'');
          if(!found.some(c=>c.lang===normalized&&c.auto===auto))found.push({url,lang:normalized,label:typeof row.name==='string'?row.name.slice(0,80):normalized,auto});break;
        }catch{/* Ignore unsupported caption endpoints. */}
      }
    }
  }
  return found.sort((a,b)=>Number(b.lang.startsWith('ko'))-Number(a.lang.startsWith('ko'))||Number(a.auto)-Number(b.auto)).slice(0,24);
}
export function selectNativeTrailer(value:any,id:string):NativeTrailer {
  if(!value||value.id!==id||value.is_live||value.has_drm||!Number.isFinite(value.duration)||value.duration<=0||value.duration>600)throw fail(422,'shorts-native-unsupported');
  const formats=(Array.isArray(value.formats)?value.formats:[]).filter((f:any)=>
    f&&!f.has_drm&&/^avc1/.test(f.vcodec)&&/^mp4a/.test(f.acodec)&&f.ext==='mp4'&&f.height>0&&f.height<=720&&
    ['https','m3u8_native','m3u8'].includes(f.protocol));
  formats.sort((a:any,b:any)=>b.height-a.height);
  for(const f of formats){
    try{
      const url=trailerMediaUrl(f.url),headers:Record<string,string>={};
      for(const [key,v] of Object.entries({...value.http_headers,...f.http_headers}))
        if(/^(user-agent|referer|origin|accept-language)$/i.test(key)&&typeof v==='string'&&v.length<=2048&&!/[\r\n]/.test(v))headers[key]=v;
      return {videoId:id,title:typeof value.title==='string'?value.title.slice(0,300):'Trailer',subtitles:captions(value),url,headers,mime:f.protocol==='https'?'video/mp4':'application/vnd.apple.mpegurl'};
    }catch{/* another playable format may exist */}
  }
  // YouTube commonly exposes HLS with separate audio renditions. Preserve the master audio
  // group instead of treating a video-only media playlist as a complete playable movie.
  for(const f of (Array.isArray(value.formats)?value.formats:[])){
    if(f&&!f.has_drm&&/^avc1/.test(f.vcodec)&&f.height>0&&f.height<=720&&['m3u8_native','m3u8'].includes(f.protocol)){
      try{
        const url=trailerMediaUrl(f.manifest_url),headers:Record<string,string>={};
        for(const [key,v] of Object.entries({...value.http_headers,...f.http_headers}))
          if(/^(user-agent|referer|origin|accept-language)$/i.test(key)&&typeof v==='string'&&v.length<=2048&&!/[\r\n]/.test(v))headers[key]=v;
        return {videoId:id,title:typeof value.title==='string'?value.title.slice(0,300):'Trailer',subtitles:captions(value),url,headers,mime:'application/vnd.apple.mpegurl',master:true};
      }catch{/* no usable master */}
    }
  }
  throw fail(422,'shorts-native-unsupported');
}

/** Keep browser-compatible, bounded video variants and their matching audio renditions together. */
export function selectTrailerMaster(body:string):string {
  const lines=body.split(/\r?\n/).map(line=>line.trim());
  if(lines[0]!=='#EXTM3U')throw fail();
  const attr=(line:string)=>Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m=>[m[1],m[2].replace(/^"|"$/g,'')]));
  const media=lines.filter(line=>line.startsWith('#EXT-X-MEDIA:'));
  const variants:string[]=[],groups=new Set<string>();
  for(let i=0;i<lines.length;i++){
    if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;
    const a=attr(lines[i]),codecs=(a.CODECS||'').split(',').map(c=>c.trim());
    const height=Number((a.RESOLUTION||'').split('x')[1]),url=lines[i+1];
    if(!(height>0&&height<=720)||!url||url.startsWith('#')||!codecs.some(c=>/^avc1\./.test(c))||!codecs.some(c=>/^mp4a\./.test(c))||codecs.some(c=>! /^(avc1|mp4a)\./.test(c)))continue;
    if(a.AUDIO&&!media.some(line=>{const m=attr(line);return m.TYPE==='AUDIO'&&m['GROUP-ID']===a.AUDIO&&m.URI;}))continue;
    if(a.AUDIO)groups.add(a.AUDIO);
    variants.push(lines[i],url);
  }
  if(!variants.length)throw fail(422,'shorts-native-unsupported');
  return ['#EXTM3U',...lines.filter(line=>/^#EXT-X-(VERSION:|INDEPENDENT-SEGMENTS$)/.test(line)),
    ...media.filter(line=>{const a=attr(line);return a.TYPE==='AUDIO'&&groups.has(a['GROUP-ID']);}),...variants,''].join('\n');
}

/** Classify only; raw stderr can contain credentials or signed URLs and must never leave the process. */
export function extractorFailure(stderr:string):ApiFailure {
  if(/sign in to confirm|confirm your age|age.restricted|login required|cookies are no longer valid/i.test(stderr))return fail(502,'shorts-native-auth-required');
  if(/timed? out|timeout/i.test(stderr))return fail(504,'shorts-native-timeout');
  if(/video unavailable|video is unavailable|private video|has been removed|not available in your country|requested format is not available/i.test(stderr))return fail(422,'shorts-native-unsupported');
  return fail();
}

/** Fixed executable + fixed URL, no shell/config/plugins/account cookies. Child trees die on timeout, abort or exit. */
export function ytDlpExtractor(binary:string):TrailerExtractor {
  return async(id,signal,proxy)=>{
    if(!/^[A-Za-z0-9_-]{11}$/.test(id))throw fail(400,'invalid-trailer');
    signal.throwIfAborted();
    const args=['--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--no-warnings','--no-progress',
      '--use-extractors','^youtube$','--no-remote-components','--no-js-runtimes','--js-runtimes',`node:${process.execPath}`,
      '--extractor-args','youtube:skip=translated_subs','--socket-timeout','12','--retries','0','--extractor-retries','0','--print','%(.{id,title,duration,is_live,has_drm,formats,http_headers,subtitles,automatic_captions})j','--skip-download',
      '--proxy',proxy||'','--',`https://www.youtube.com/watch?v=${id}`];
    const raw=await new Promise<string>((resolve,reject)=>{
      const child=spawn(binary,args,{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
      let text='',stderr='',size=0,done=false;
      const kill=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);kill();error?reject(error):resolve(text);};
      const abort=()=>finish(fail(499,'shorts-native-cancelled'));
      const timer=setTimeout(()=>finish(fail(504,'shorts-native-timeout')),40_000);timer.unref();
      signal.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024)finish(fail());else text+=chunk.toString('utf8');});
      child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString('utf8')).slice(-16_384);});
      child.once('error',()=>finish(fail(503,'shorts-native-unconfigured')));
      child.once('close',code=>finish(code===0?undefined:extractorFailure(stderr)));
      if(signal.aborted)abort();
    });
    try{return selectNativeTrailer(JSON.parse(raw),id);}catch(e){if(e instanceof ApiFailure)throw e;throw fail();}
  };
}

type CachedAsset={body:Buffer;type:string;url:string;start:number;total:number};
type Asset={url:string;headers:Record<string,string>;playlist:boolean;master?:boolean;cached?:CachedAsset;loading?:Promise<void>};
type CaptionAsset=Caption & {content?:string;loading?:Promise<string>};
type Session={captions:Map<string,CaptionAsset>;title:string;videoId:string;cleanups:Map<string,()=>void>;profile:string;expires:number;proxy?:string;abort:AbortController;assets:Map<string,Asset>;bytes:number;active:number;cacheKey:string;warming?:Promise<{ready:boolean}>};
/** Bounded, memory-only media leases. Neither URLs nor extraction metadata go to clients or persistent caches. */
export class NativeShorts {
  private sessions=new Map<string,Session>();
  private pending=new Set<AbortController>();
  private resolved=new Map<string,{value:NativeTrailer;expires:number}>();
  private sweep:ReturnType<typeof setInterval>;
  private closed=false;
  private warming=0;
  private captionLoads=0;
  constructor(private extractor:TrailerExtractor|undefined,private transport=publicStream,private now=Date.now){
    this.sweep=setInterval(()=>{for(const [id,s] of this.sessions)if(s.expires<=this.now())this.release(id);},30_000);this.sweep.unref();
  }
  get available(){return Boolean(this.extractor)&&!this.closed;}
  get busy(){return this.pending.size>0||[...this.sessions.values()].some(s=>s.expires>this.now());}
  owner(id:string){return this.sessions.get(id)?.profile;}
  release(id:string,profile?:string){const s=this.sessions.get(id);if(s&&(!profile||s.profile===profile)){s.abort.abort();this.sessions.delete(id);for(const cleanup of s.cleanups.values()){try{cleanup();}catch{}}s.cleanups.clear();}}
  private asset(id:string,s:Session,asset:Asset){
    trailerMediaUrl(asset.url);
    for(const [key,prior] of s.assets)if(prior.url===asset.url)return `/api/playback/${id}/shorts/${key}`;
    if(s.assets.size>=1024)throw fail();
    const key=token();s.assets.set(key,asset);return `/api/playback/${id}/shorts/${key}`;
  }
  async prepare(profile:string,ids:string[],signal:AbortSignal,proxy?:string){
    if(!this.available)throw fail(503,'shorts-native-unconfigured');
    if(this.pending.size>=2)throw fail(503,'shorts-native-busy');
    const abort=new AbortController();this.pending.add(abort);
    const combined=AbortSignal.any([signal,abort.signal]);
    try{
      const cacheKey=createHash('sha256').update(JSON.stringify([profile,proxy||'',ids.slice(0,2)])).digest('hex');
      for(const [key,row] of this.resolved)if(row.expires<=this.now())this.resolved.delete(key);
      let selected=this.resolved.get(cacheKey)?.value,lastError:ApiFailure|undefined;
      for(const candidate of selected?[]:ids.slice(0,2)){
        combined.throwIfAborted();
        try{selected=await this.extractor!(candidate,combined,proxy);break;}catch(error){combined.throwIfAborted();if(error instanceof ApiFailure){if(error.error==='shorts-native-unconfigured')throw error;if(error.statusCode!==422)lastError=error;}else lastError=fail();}
      }
      combined.throwIfAborted();
      if(!selected)throw lastError||fail(422,'shorts-native-unavailable');
      if(!this.resolved.has(cacheKey)){
        const signedExpiry=Number(new URL(selected.url).searchParams.get('expire'))*1000;
        const expires=Math.min(this.now()+120_000,signedExpiry>0?signedExpiry-30_000:Infinity);
        if(expires>this.now()){
          if(this.resolved.size>=64)this.resolved.delete(this.resolved.keys().next().value!);
          this.resolved.set(cacheKey,{value:selected,expires});
        }
      }
      for(const [id,s] of this.sessions)if(s.expires<=this.now())this.release(id);
      if(this.sessions.size>=32)throw fail(503,'shorts-native-busy');
      const own=[...this.sessions.entries()].filter(([,s])=>s.profile===profile);
      // Current playback plus two prepared next works; old leases are retired in order.
      while(own.length>=3)this.release(own.shift()![0]);
      const id=token(),s:Session={profile,expires:this.now()+TTL,proxy,abort:new AbortController(),assets:new Map(),bytes:0,active:0,cacheKey,title:selected.title||'Trailer',videoId:selected.videoId||ids[0],captions:new Map(),cleanups:new Map()};
      const url=this.asset(id,s,{...selected,playlist:selected.mime!=='video/mp4'});
      this.sessions.set(id,s);
      const subtitles=(selected.subtitles||[]).map(caption=>{
        const key=token();s.captions.set(key,{...caption});
        return {id:key,label:caption.label,lang:caption.lang,auto:caption.auto,url:`/api/playback/${id}/shorts-captions/${key}`};
      });
      return {sessionId:id,url,mime:selected.mime,subtitles};
    }finally{this.pending.delete(abort);}
  }
  private current(id:string,profile?:string){
    const s=this.sessions.get(id);
    if(!s||s.expires<=this.now()){this.release(id);throw fail(410,'shorts-native-expired');}
    if(profile&&s.profile!==profile)throw fail(403,'session-profile-mismatch');
    return s;
  }
  onRelease(id:string,profile:string,key:string,cleanup:()=>void){this.current(id,profile).cleanups.set(key,cleanup);}
  async caption(id:string,track:string,profile:string,signal:AbortSignal){
    const s=this.current(id,profile),caption=s.captions.get(track);
    if(!caption)throw fail(404,'subtitle-not-found');
    if(!caption.content){
      if(!caption.loading){
        if(this.captionLoads>=4)throw fail(429,'shorts-native-busy');
        this.captionLoads++;
        const combined=AbortSignal.any([s.abort.signal,AbortSignal.timeout(15_000)]);
        const root=s.assets.values().next().value!;
        caption.loading=(async()=>{
          const result=await this.transport(trailerCaptionUrl(caption.url),root.headers,combined,s.proxy);
          try{
            trailerCaptionUrl(result.url);
            if(result.response.statusCode!==200)throw fail(502,'shorts-subtitles-unavailable');
            const chunks:Buffer[]=[];let bytes=0;
            for await(const chunk of result.response){bytes+=chunk.length;if(bytes>1024*1024)throw fail(413,'shorts-subtitles-too-large');chunks.push(Buffer.from(chunk));}
            combined.throwIfAborted();
            const document=subtitleDocument(Buffer.concat(chunks).toString('utf8'),'vtt');
            const content=document.render(Object.fromEntries(document.lines.map(line=>[String(line.id),line.text])));
            const own=[...s.captions.values()].reduce((n,c)=>n+Buffer.byteLength(c.content||''),0);
            const total=[...this.sessions.values()].reduce((n,row)=>n+[...row.captions.values()].reduce((m,c)=>m+Buffer.byteLength(c.content||''),0),0);
            if(own+Buffer.byteLength(content)>4*1024*1024||total+Buffer.byteLength(content)>16*1024*1024)throw fail(429,'shorts-native-busy');
            caption.content=content;
            return caption.content;
          }finally{result.response.destroy();}
        })().catch(error=>{if(error instanceof ApiFailure)throw error;throw fail(502,'shorts-subtitles-unavailable');}).finally(()=>{this.captionLoads--;});
      }
      const loading=caption.loading;
      try{await loading;}finally{if(caption.loading===loading)caption.loading=undefined;}
    }
    signal.throwIfAborted();this.current(id,profile);
    return {content:caption.content!,format:'vtt',sourceLabel:caption.label,sourceLanguage:caption.lang,title:s.title,videoId:s.videoId};
  }
  /** Initial bytes only, no playback. A cancelled warmer never cancels foreground media. */
  async warm(id:string,profile:string,signal:AbortSignal,quality:'auto'|'360p'|'480p'|'720p'='auto'):Promise<{ready:boolean}>{
    const s=this.current(id,profile);
    if(s.warming)return s.warming;
    if(this.warming>=2)return {ready:false};
    this.warming++;
    const combined=AbortSignal.any([signal,s.abort.signal,AbortSignal.timeout(12_000)]);
    let received=0;
    const load=async(asset:Asset,range?:string)=>{
      if(asset.cached)return;
      if(asset.loading)return asset.loading;
      const pending=(async()=>{
        const out=await this.transport(asset.url,{...asset.headers,...(range?{Range:range}:{})},combined,s.proxy);
        const response=out.response,type=String(response.headers['content-type']||'');
        try{
          if(![200,206].includes(response.statusCode||0)||!/^(video\/|audio\/|application\/(?:octet-stream|[^;]*mpegurl))/i.test(type))throw fail();
          const chunks:Buffer[]=[];let bytes=0;
          for await(const chunk of response){bytes+=chunk.length;received+=chunk.length;s.bytes+=chunk.length;
            if(bytes>(asset.playlist?512*1024:2*1024*1024)||received>8*1024*1024||s.bytes>BYTE_LIMIT)throw fail();
            chunks.push(Buffer.from(chunk));
          }
          combined.throwIfAborted();
          const contentRange=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range']||''));
          if(response.statusCode===206&&!contentRange)throw fail();
          const used=[...this.sessions.values()].reduce((n,row)=>n+[...row.assets.values()].reduce((m,a)=>m+(a.cached?.body.length||0),0),0);
          if(used+bytes>32*1024*1024)throw fail();
          asset.cached={body:Buffer.concat(chunks),type,url:out.url,start:contentRange?Number(contentRange[1]):0,total:contentRange?Number(contentRange[3]):bytes};
        }finally{response.destroy();}
      })();
      asset.loading=pending;
      try{await pending;}finally{if(asset.loading===pending)asset.loading=undefined;}
    };
    const child=(parent:Asset,url:string,playlist:boolean)=>{
      const target=trailerMediaUrl(new URL(url,parent.cached?.url||parent.url).href);
      const key=this.asset(id,s,{url:target,headers:parent.headers,playlist}).split('/').at(-1)!;
      return s.assets.get(key)!;
    };
    const segment=async(asset:Asset)=>{
      await load(asset);
      const body=asset.cached!.body.toString('utf8');
      if(!body.startsWith('#EXTM3U')||/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE)/.test(body))throw fail();
      // Up to six seconds/three fragments, with the matching initialization segment only.
      const urls:string[]=[];let map:string|undefined,duration=0,nextDuration=0;
      for(const line of body.split(/\r?\n/).map(x=>x.trim())){
        if(line.startsWith('#EXT-X-BYTERANGE:'))throw fail();
        if(line.startsWith('#EXT-X-MAP:')){if(urls.length)break;map=/URI="([^"]+)"/.exec(line)?.[1];if(!map||/BYTERANGE=/.test(line))throw fail();}
        if(line==='#EXT-X-DISCONTINUITY'&&urls.length)break;
        if(line.startsWith('#EXTINF:'))nextDuration=parseFloat(line.slice(8));
        if(line&&!line.startsWith('#')){
          urls.push(line);duration+=Number.isFinite(nextDuration)?nextDuration:0;nextDuration=0;
          if(urls.length>=3||duration>=6)break;
        }
      }
      if(map)await load(child(asset,map,false));
      for(const url of urls)await load(child(asset,url,false));
    };
    s.warming=(async()=>{
      try{
        const root=s.assets.values().next().value!;
        if(!root.playlist){await load(root,'bytes=0-524287');return {ready:true};}
        await load(root);
        if(!root.master){await segment(root);return {ready:true};}
        const body=selectTrailerMaster(root.cached!.body.toString('utf8')),lines=body.split('\n');
        const variants=lines.flatMap((line,i)=>{const h=Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1]);return line.startsWith('#EXT-X-STREAM-INF:')&&h?[{height:h,url:lines[i+1],audio:/AUDIO="([^"]+)"/.exec(line)?.[1]}]:[];}).sort((a,b)=>a.height-b.height);
        const height=(variants.filter(v=>v.height<=(quality==='auto'?360:parseInt(quality,10))).at(-1)||variants[0])?.height;
        const picked=variants.find(v=>v.height===height);if(!picked)throw fail();
        // Match the player's initial quality; auto begins at 360p.
        const audio=lines.find(line=>line.startsWith('#EXT-X-MEDIA:')&&line.includes('TYPE=AUDIO')&&line.includes(`GROUP-ID="${picked.audio}"`));
        const audioUrl=audio&&/URI="([^"]+)"/.exec(audio)?.[1];
        // At most two tracks per warmer, two warmers globally; wait for both before freeing capacity.
        const tracks=await Promise.allSettled([segment(child(root,picked.url,true)),...(audioUrl?[segment(child(root,audioUrl,true))]:[])]);
        if(tracks.some(r=>r.status==='rejected'))return {ready:false};
        return {ready:true};
      }catch{return {ready:false};}finally{this.warming--;}
    })();
    return s.warming;
  }
  private cachedResponse(asset:Asset,range?:string){
    const cache=asset.cached;if(!cache)return;
    let start=0,end=cache.total-1,status=200;
    if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2])return;
      start=m[1]?Number(m[1]):Math.max(0,cache.total-Number(m[2]));
      end=m[1]&&m[2]?Math.min(Number(m[2]),cache.total-1):cache.total-1;status=206;
      if(!m[2])end=Math.min(end,cache.start+cache.body.length-1);
    }
    if(start<cache.start||end<start||end>=cache.start+cache.body.length)return;
    const body=cache.body.subarray(start-cache.start,end-cache.start+1);
    const response=Object.assign(Readable.from([body]),{statusCode:status,headers:{'content-type':cache.type,'content-length':String(body.length),'accept-ranges':'bytes',...(status===206?{'content-range':`bytes ${start}-${end}/${cache.total}`}:{})}});
    return {url:cache.url,response};
  }
  async stream(req:FastifyRequest,reply:FastifyReply,id:string,assetId:string){
    const s=this.sessions.get(id);
    if(!s||s.expires<=this.now()){this.release(id);throw fail(410,'shorts-native-expired');}
    if(req.moaProfile&&req.moaProfile!==s.profile)throw fail(403,'session-profile-mismatch');
    const asset=s.assets.get(assetId);if(!asset)throw fail(404,'asset-not-found');
    if(s.active>=8||[...this.sessions.values()].reduce((n,row)=>n+row.active,0)>=32)throw fail(429,'shorts-native-busy');
    if(req.headers.range&&!/^bytes=\d{0,15}-\d{0,15}$/.test(req.headers.range))return reply.code(416).send();
    const abort=new AbortController(),signal=AbortSignal.any([s.abort.signal,abort.signal,AbortSignal.timeout(60_000)]);
    const close=()=>abort.abort();reply.raw.once('close',close);s.active++;
    let cleaned=false;
    const clean=()=>{if(cleaned)return;cleaned=true;s.active--;reply.raw.off('close',close);};
    try{
      // A slow speculative request must not hold foreground playback for its full timeout.
      if(asset.loading)await new Promise<void>(resolve=>{
        const timer=setTimeout(resolve,250);timer.unref();
        const done=()=>{clearTimeout(timer);resolve();};asset.loading!.then(done,done);
      });
      signal.throwIfAborted();
      const upstream=this.cachedResponse(asset,req.headers.range)||await this.transport(asset.url,{...asset.headers,...(req.headers.range?{Range:req.headers.range}:{})},signal,s.proxy);
      const response=upstream.response,status=response.statusCode??502;
      if(![200,206].includes(status)){this.resolved.delete(s.cacheKey);response.destroy();throw fail(status===416?416:502);}
      const type=String(response.headers['content-type']||'');
      reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
      response.on('data',(chunk:Buffer)=>{s.bytes+=chunk.length;if(s.bytes>BYTE_LIMIT)this.release(id);});
      if(asset.playlist||/mpegurl/i.test(type)){
        try{
          let size=0;const chunks:Buffer[]=[];
          for await(const chunk of response){size+=chunk.length;if(size>512*1024)throw fail();chunks.push(Buffer.from(chunk));}
          let body=Buffer.concat(chunks).toString('utf8');
          if(/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE)/.test(body))throw fail(422,'shorts-native-unsupported');
          if(asset.master)body=selectTrailerMaster(body);
          const playlist=rewritePlaylist(body,upstream.url,url=>this.asset(id,s,{url,headers:asset.headers,playlist:/\.m3u8$/i.test(new URL(url).pathname)}));
          return reply.type('application/vnd.apple.mpegurl').send(playlist);
        }finally{response.destroy();clean();}
      }
      if(!/^(video\/|audio\/|application\/octet-stream)/i.test(type)){response.destroy();throw fail();}
      for(const key of ['content-length','content-range','accept-ranges'] as const)if(response.headers[key])reply.header(key,response.headers[key]);
      response.once('close',clean);
      return reply.code(status).type(asset.playlist?'application/vnd.apple.mpegurl':/^(video|audio)\//.test(type)?type:'application/octet-stream').send(response);
    }catch(error){clean();abort.abort();if(error instanceof ApiFailure)throw error;throw fail();}
  }
  close(){this.closed=true;this.resolved.clear();clearInterval(this.sweep);for(const c of this.pending)c.abort();for(const id of this.sessions.keys())this.release(id);}
}
