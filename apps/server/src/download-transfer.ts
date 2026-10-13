import { open, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadQuality } from '@moa/shared';
import { preferredQuality } from './download-quality.js';
import type { SourceVideo } from '@moa/extensions';
import { runCommand } from '@moa/skip-markers';
import type { Config } from './config.js';
import type { Probe } from './probe.js';
import { ApiFailure } from './util.js';

export type DownloadTransport=(url:string,range?:string)=>Promise<{response:import('node:http').IncomingMessage;url:string}>;
const fail=(code:string):never=>{throw new ApiFailure(422,code);};
const attributes=(s:string)=>Object.fromEntries([...s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m=>[m[1],m[2].replace(/^"|"$/g,'')]));

/** Materialize a finite playlist first. ffmpeg/ffprobe never receive an upstream URL. */
export async function transferVideo(cfg:Config,dir:string,item:SourceVideo,fetcher:DownloadTransport,signal:AbortSignal,account:(bytes:number,total?:number)=>Promise<void>,finalizing:()=>void,quality:DownloadQuality='best'){
  let sequence=0,requests=0,expectedDuration=0,omittedSubtitles=false; const files:string[]=[];
  const request=async(url:string,range?:string)=>{
    signal.throwIfAborted();if(++requests>12000)fail('download-request-limit');
    const r=await fetcher(url,range),status=r.response.statusCode;
    if(status!==(range?206:200)){r.response.destroy();fail(status===401||status===403?'download-auth-expired':'download-fetch-failed');}
    if(range){const expected=/^bytes=(\d+)-(\d+)$/.exec(range)!,received=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(r.response.headers['content-range']));
      if(!received||received[1]!==expected[1]||received[2]!==expected[2]){r.response.destroy();fail('download-range-invalid');}}
    return r;
  };
  const consume=async(r:Awaited<ReturnType<typeof request>>,limit:number,file?:string,reportTotal=false)=>{
    const chunks:Buffer[]=[];let bytes=0;const declared=Number(r.response.headers['content-length']);
    let target:Awaited<ReturnType<typeof open>>|undefined;
    try { target=file?await open(path.join(dir,file),'wx',0o600):undefined;if(reportTotal&&Number.isSafeInteger(declared)&&declared>0)await account(0,declared);for await(const chunk of r.response){signal.throwIfAborted();const b=Buffer.from(chunk);bytes+=b.length;if(bytes>limit)fail('download-response-limit');await account(b.length);if(target)await target.writeFile(b);else chunks.push(b);}
      if(Number.isFinite(declared)&&declared>0&&bytes!==declared)fail('download-truncated');
    }finally{r.response.destroy();await target?.close();}
    if(!bytes)fail('download-empty');return file?Buffer.alloc(0):Buffer.concat(chunks);
  };
  const blob=async(url:string,range?:string,limit=512*1024*1024)=>{const name=`part-${++sequence}.bin`;await consume(await request(url,range),limit,name);files.push(name);return name;};
  const playlist=async(url:string,depth=0,provided?:string):Promise<string>=>{
    if(depth>3)fail('download-playlist-depth');
    let base=url,body=provided;
    if(body===undefined){const r=await request(url);base=r.url;body=(await consume(r,2*1024*1024)).toString('utf8');}
    if(!body.startsWith('#EXTM3U')||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body)||/#EXT-X-(DEFINE|PART|PRELOAD-HINT|SESSION-KEY)|\{\$/.test(body))fail('download-hls-unsupported');
    const lines=body.split(/\r?\n/).map(x=>x.trim());
    if(lines.some(s=>s.startsWith('#EXT-X-MEDIA:')&&attributes(s).TYPE==='SUBTITLES'))omittedSubtitles=true;
    const variants=lines.map((s,i)=>({s,i})).filter(x=>x.s.startsWith('#EXT-X-STREAM-INF:'));
    if(variants.length){
      const v=preferredQuality(variants.sort((a,b)=>Number(attributes(b.s).BANDWIDTH||0)-Number(attributes(a.s).BANDWIDTH||0)),quality,x=>{const resolution=/^\d+x(\d+)$/i.exec(attributes(x.s).RESOLUTION||'');return resolution?Number(resolution[1]):undefined;})!;
      const uri=lines[v.i+1];if(!uri||uri.startsWith('#'))fail('download-playlist-invalid');
      const video=await playlist(new URL(uri,base).href,depth+1),attrs=attributes(v.s),videoDuration=expectedDuration;
      const audio=lines.filter(s=>s.startsWith('#EXT-X-MEDIA:')).map(attributes).filter(a=>a.TYPE==='AUDIO'&&a['GROUP-ID']===attrs.AUDIO&&a.URI).sort((a,b)=>Number(b.DEFAULT==='YES')-Number(a.DEFAULT==='YES'))[0];
      if(!audio)return video;
      const sound=await playlist(new URL(audio.URI,base).href,depth+1);expectedDuration=videoDuration;const name=`master-${++sequence}.m3u8`;
      await writeFile(path.join(dir,name),`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${sound}"\n#EXT-X-STREAM-INF:BANDWIDTH=10000000,AUDIO="audio"\n${video}\n`,{mode:0o600});files.push(name);return name;
    }
    if(!lines.includes('#EXT-X-ENDLIST')||!lines.some(s=>s.startsWith('#EXTINF:')))fail('download-live-unsupported');
    let range:string|undefined,lastUrl='',end=0,totalDuration=0;
    const output:string[]=[];
    // Three bounded transfers; placeholders preserve playlist order despite out-of-order completion.
    const pending:Promise<{error:unknown}|null>[]=[];
    const drain=async()=>{const results=await Promise.all(pending.splice(0));const failed=results.find(r=>r!==null);if(failed)throw failed.error;};
    try { for(const line of lines){
      if(!line)continue;
      if(line.startsWith('#EXTINF:')){const segmentDuration=parseFloat(line.slice(8));if(!(segmentDuration>0))fail('download-playlist-invalid');totalDuration+=segmentDuration;if(!Number.isFinite(totalDuration)||totalDuration>21600)fail('download-duration-limit');}
      if(line.startsWith('#EXT-X-BYTERANGE:')){range=line.slice(17);continue;}
      if(!line.startsWith('#')){
        const target=new URL(line,base).href;let header:string|undefined;
        if(range){const m=/^(\d+)(?:@(\d+))?$/.exec(range);if(!m)fail('download-range-invalid');const length=Number(m![1]),offset=m![2]!==undefined?Number(m![2]):target===lastUrl?end:NaN;
          if(!Number.isSafeInteger(length)||length<1||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(offset+length))fail('download-range-invalid');header=`bytes=${offset}-${offset+length-1}`;end=offset+length;range=undefined;}
        lastUrl=target;
        const slot=output.length;output.push('');
        pending.push(blob(target,header).then(name=>{output[slot]=name;return null;},error=>({error})));
        if(pending.length===3)await drain();
        continue;
      }
      if(line.startsWith('#EXT-X-KEY:')){
        await drain();
        const a=attributes(line);if(a.METHOD==='NONE'){output.push('#EXT-X-KEY:METHOD=NONE');continue;}
        if(a.METHOD!=='AES-128'||a.KEYFORMAT&&a.KEYFORMAT!=='identity'||!a.URI||a.IV&&!/^0x[0-9a-fA-F]{32}$/.test(a.IV))fail('download-drm-unsupported');
        const key=await blob(new URL(a.URI,base).href,undefined,16);if((await stat(path.join(dir,key))).size!==16)fail('download-key-invalid');
        output.push(`#EXT-X-KEY:METHOD=AES-128,URI="${key}"${a.IV?`,IV=${a.IV}`:''}`);continue;
      }
      if(line.startsWith('#EXT-X-MAP:')){
        await drain();
        const a=attributes(line);if(!a.URI||a.BYTERANGE)fail('download-map-unsupported');output.push(`#EXT-X-MAP:URI="${await blob(new URL(a.URI,base).href)}"`);continue;
      }
      // Reject all remaining URL-bearing directives; no upstream address reaches ffmpeg.
      if(/URI=/.test(line))fail('download-hls-unsupported');
      if(/^#(?:EXTM3U|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|DISCONTINUITY(?:-SEQUENCE:|$)|ENDLIST$|PLAYLIST-TYPE:|INDEPENDENT-SEGMENTS$))/.test(line))output.push(line);
    }
    } finally { // Cancellation/parse errors must settle all writers before the job removes its directory.
      await Promise.all(pending);
    }
    await drain();
    expectedDuration=totalDuration;
    const name=`list-${++sequence}.m3u8`;await writeFile(path.join(dir,name),output.join('\n')+'\n',{mode:0o600});files.push(name);return name;
  };
  if(!item.url.startsWith('https:')||item.audios?.length)fail('download-stream-unsupported');
  const first=await request(item.url),mime=String(first.response.headers['content-type']||'');
  let input:string;
  if(/mpegurl/i.test(mime)||/\.m3u8(?:\?|$)/i.test(first.url))input=await playlist(first.url,0,(await consume(first,2*1024*1024)).toString('utf8'));
  else {input='input.mp4';await consume(first,20*1024**3,input,true);files.push(input);}
  signal.throwIfAborted();finalizing();
  const target=path.join(dir,'video.mp4.part');
  if(input.endsWith('.m3u8')){
    // quota accounts for temporary input plus at most one equally-sized remuxed output.
    const inputBytes=(await Promise.all(files.map(f=>stat(path.join(dir,f))))).reduce((n,s)=>n+s.size,0);
    const outputLimit=Math.ceil(inputBytes*1.1)+1024*1024;await account(outputLimit);
    await runCommand(cfg.ffmpeg,['-nostdin','-v','error','-protocol_whitelist','file,crypto','-allowed_extensions','ALL','-allowed_segment_extensions','ALL','-extension_picky','0','-i',path.join(dir,input),'-map','0:v:0','-map','0:a:0?','-c','copy','-sn','-dn','-map_metadata','-1','-movflags','+faststart','-fs',String(outputLimit),'-f','mp4','-y',target],{signal,timeoutMs:15*60_000,maxBytes:1024*1024});
  }else await rename(path.join(dir,input),target);
  const raw=JSON.parse((await runCommand(cfg.ffprobe,['-v','error','-protocol_whitelist','file','-show_format','-show_streams','-of','json',target],{signal,timeoutMs:60_000,maxBytes:1024*1024})).toString());
  const duration=Number(raw.format?.duration);if(!Number.isFinite(duration)||duration<1||duration>21600||!Array.isArray(raw.streams)||!raw.streams.some((s:any)=>s.codec_type==='video'))fail('download-media-invalid');
  if(expectedDuration&&Math.abs(duration-expectedDuration)>Math.max(2,expectedDuration*.005))fail('download-duration-mismatch');
  const probe:Probe={duration,startTime:Number(raw.format.start_time)||0,container:raw.format.format_name,streams:raw.streams};
  const subtitles:string[]=[];let subtitleWarning=omittedSubtitles||(item.subtitles?.length??0)>8;
  for(const [i,sub]of(item.subtitles||[]).slice(0,8).entries()){
    if(!/^https:/.test(sub.file)||!/\.(vtt|srt|ass|ssa)(?:\?|$)/i.test(sub.file)){subtitleWarning=true;continue;}
    const ext=/\.(vtt|srt|ass|ssa)(?:\?|$)/i.exec(sub.file)![1].toLowerCase(),name=`subtitle-${i}.${ext}`;
    try{
      const content=await consume(await request(sub.file),10*1024*1024),text=content.toString('utf8').replace(/^\uFEFF/,'').trimStart();
      if(ext==='vtt'?!/^WEBVTT(?:\s|$)/.test(text):ext==='srt'?!/\d{2}:\d{2}:\d{2}[,.]\d+\s*-->/.test(text):!/^\[Script Info\]/i.test(text))fail('download-subtitle-invalid');
      await writeFile(path.join(dir,name),content,{mode:0o600,flag:'wx'});subtitles.push(name);
    }catch{signal.throwIfAborted();subtitleWarning=true;await rm(path.join(dir,name),{force:true});}
  }
  signal.throwIfAborted();await rename(target,path.join(dir,'video.mp4'));
  for(const f of files)await rm(path.join(dir,f),{force:true});
  return {probe,subtitles,subtitleWarning,size:(await stat(path.join(dir,'video.mp4'))).size};
}
