import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { publicStream } from '@moa/extensions';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiFailure } from './util.js';
import { rewritePlaylist } from './remote-playback.js';

export type NativeTrailer = { url:string; mime:'video/mp4'|'application/vnd.apple.mpegurl'; headers:Record<string,string> };
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
      return {url,headers,mime:f.protocol==='https'?'video/mp4':'application/vnd.apple.mpegurl'};
    }catch{/* another playable format may exist */}
  }
  throw fail(422,'shorts-native-unsupported');
}

/** Fixed executable + fixed URL, no shell/config/plugins/account cookies. Child trees die on timeout, abort or exit. */
export function ytDlpExtractor(binary:string):TrailerExtractor {
  return async(id,signal,proxy)=>{
    if(!/^[A-Za-z0-9_-]{11}$/.test(id))throw fail(400,'invalid-trailer');
    signal.throwIfAborted();
    const args=['--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--no-warnings','--no-progress',
      '--use-extractors','^youtube$','--no-remote-components','--no-js-runtimes','--js-runtimes',`node:${process.execPath}`,
      '--socket-timeout','12','--retries','0','--extractor-retries','0','--dump-single-json','--skip-download',
      '--proxy',proxy||'','--',`https://www.youtube.com/watch?v=${id}`];
    const raw=await new Promise<string>((resolve,reject)=>{
      const child=spawn(binary,args,{detached:process.platform!=='win32',stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
      let text='',size=0,done=false;
      const kill=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);kill();error?reject(error):resolve(text);};
      const abort=()=>finish(fail(499,'shorts-native-cancelled'));
      const timer=setTimeout(()=>finish(fail(504,'shorts-native-timeout')),40_000);timer.unref();
      signal.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024)finish(fail());else text+=chunk.toString('utf8');});
      child.once('error',()=>finish(fail(503,'shorts-native-unconfigured')));
      child.once('close',code=>finish(code===0?undefined:fail()));
      if(signal.aborted)abort();
    });
    try{return selectNativeTrailer(JSON.parse(raw),id);}catch(e){if(e instanceof ApiFailure)throw e;throw fail();}
  };
}

type Asset={url:string;headers:Record<string,string>;playlist:boolean};
type Session={profile:string;expires:number;proxy?:string;abort:AbortController;assets:Map<string,Asset>;bytes:number;active:number};
/** Bounded, memory-only media leases. Neither URLs nor extraction metadata go to clients or persistent caches. */
export class NativeShorts {
  private sessions=new Map<string,Session>();
  private pending=new Set<AbortController>();
  private sweep:ReturnType<typeof setInterval>;
  private closed=false;
  constructor(private extractor:TrailerExtractor|undefined,private transport=publicStream,private now=Date.now){
    this.sweep=setInterval(()=>{for(const [id,s] of this.sessions)if(s.expires<=this.now())this.release(id);},30_000);this.sweep.unref();
  }
  get available(){return Boolean(this.extractor)&&!this.closed;}
  owner(id:string){return this.sessions.get(id)?.profile;}
  release(id:string,profile?:string){const s=this.sessions.get(id);if(s&&(!profile||s.profile===profile)){s.abort.abort();this.sessions.delete(id);}}
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
      let selected:NativeTrailer|undefined;
      for(const candidate of ids.slice(0,2)){
        combined.throwIfAborted();
        try{selected=await this.extractor!(candidate,combined,proxy);break;}catch(error){combined.throwIfAborted();if(error instanceof ApiFailure&&error.error==='shorts-native-unconfigured')throw error;}
      }
      combined.throwIfAborted();
      if(!selected)throw fail(422,'shorts-native-unavailable');
      for(const [id,s] of this.sessions)if(s.expires<=this.now())this.release(id);
      if(this.sessions.size>=32)throw fail(503,'shorts-native-busy');
      const own=[...this.sessions.entries()].filter(([,s])=>s.profile===profile);
      // At most two leases allow a handover without a previous response racing the next one.
      while(own.length>=2)this.release(own.shift()![0]);
      const id=token(),s:Session={profile,expires:this.now()+TTL,proxy,abort:new AbortController(),assets:new Map(),bytes:0,active:0};
      const url=this.asset(id,s,{...selected,playlist:selected.mime!=='video/mp4'});
      this.sessions.set(id,s);
      return {sessionId:id,url,mime:selected.mime};
    }finally{this.pending.delete(abort);}
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
      const upstream=await this.transport(asset.url,{...asset.headers,...(req.headers.range?{Range:req.headers.range}:{})},signal,s.proxy);
      const response=upstream.response,status=response.statusCode??502;
      if(![200,206].includes(status)){response.destroy();throw fail(status===416?416:502);}
      const type=String(response.headers['content-type']||'');
      reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
      response.on('data',(chunk:Buffer)=>{s.bytes+=chunk.length;if(s.bytes>BYTE_LIMIT)this.release(id);});
      if(asset.playlist||/mpegurl/i.test(type)){
        try{
          let size=0;const chunks:Buffer[]=[];
          for await(const chunk of response){size+=chunk.length;if(size>512*1024)throw fail();chunks.push(Buffer.from(chunk));}
          const body=Buffer.concat(chunks).toString('utf8');
          if(/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE)/.test(body))throw fail(422,'shorts-native-unsupported');
          const playlist=rewritePlaylist(body,upstream.url,url=>this.asset(id,s,{url,headers:asset.headers,playlist:/\.m3u8(?:\?|$)|\/playlist\//i.test(url)}));
          return reply.type('application/vnd.apple.mpegurl').send(playlist);
        }finally{response.destroy();clean();}
      }
      if(!/^(video\/|audio\/|application\/octet-stream)/i.test(type)){response.destroy();throw fail();}
      for(const key of ['content-length','content-range','accept-ranges'])if(response.headers[key])reply.header(key,response.headers[key]);
      response.once('close',clean);
      return reply.code(status).type(asset.playlist?'application/vnd.apple.mpegurl':/^(video|audio)\//.test(type)?type:'application/octet-stream').send(response);
    }catch(error){clean();abort.abort();if(error instanceof ApiFailure)throw error;throw fail();}
  }
  close(){this.closed=true;clearInterval(this.sweep);for(const c of this.pending)c.abort();for(const id of this.sessions.keys())this.release(id);}
}
