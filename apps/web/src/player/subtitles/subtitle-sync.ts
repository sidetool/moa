import type {SubtitleTrack} from '@moa/shared';
import {readTrack} from '../translation/subtitle-translation';
import type {Alignment} from './subtitle-timing';
const empty=():Alignment=>({status:'uncertain',offsetSeconds:0,match:0});
const cache=new Map<string,Alignment>();
/** Online Korean subtitles only; translated tracks already inherit their original timings. */
export async function checkSubtitleAlignment(target:SubtitleTrack,tracks:SubtitleTrack[],signal:AbortSignal):Promise<Alignment>{
  if(target.source!=='online'||signal.aborted)return empty();
  const originals=tracks.filter(t=>!/(?:forced|signs?|songs?|karaoke|가사|간판)/i.test(t.label));
  const reference=originals.find(t=>t.id!==target.id && ['embedded','local','extension'].includes(t.source||'') && /^(?:en|eng|ja|jpn|jp)(?:-|$)/i.test(t.lang||''))
    ??originals.find(t=>t.id!==target.id && !t.provenance && t.source!=='online' && t.source!=='translation' && /english|japanese|日本語|영어|일본어/i.test(t.label));
  if(!reference)return empty();
  // Only read authenticated app assets; remote extensions use the existing subtitle proxy.
  if([target,reference].some(t=>new URL(t.url,location.href).origin!==location.origin))return empty();
  const key=JSON.stringify([target.url,reference.url]);if(cache.has(key))return cache.get(key)!;
  const stop=new AbortController(), abort=()=>stop.abort();signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,5000);
  let worker:Worker|undefined;
  try{
    const [a,b]=await Promise.all([readTrack(target,stop.signal),readTrack(reference,stop.signal)]);stop.signal.throwIfAborted();
    worker=new Worker(new URL('./subtitle-sync-worker.ts',import.meta.url),{type:'module'});
    const result=await new Promise<Alignment>((resolve,reject)=>{
      const fail=()=>reject(new Error('sync-cancelled'));
      stop.signal.addEventListener('abort',fail,{once:true});
      worker!.onmessage=e=>{stop.signal.removeEventListener('abort',fail);resolve(e.data);};
      worker!.onerror=()=>{stop.signal.removeEventListener('abort',fail);reject(new Error('sync-worker'));};
      worker!.postMessage({candidate:a.content,reference:b.content});
    });
    cache.set(key,result);while(cache.size>32)cache.delete(cache.keys().next().value!);return result;
  }catch{return empty();}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);stop.abort();worker?.terminate();}
}
