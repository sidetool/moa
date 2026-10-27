/** Timing-only comparison: no dialogue text leaves the device and no language model is used. */
export interface CueTime {start:number;end:number}
export interface Alignment {status:'aligned'|'uncertain'|'mismatch';offsetSeconds:number;match:number}
const uncertain=():Alignment=>({status:'uncertain',offsetSeconds:0,match:0});
function seconds(raw:string){return raw.trim().replace(',','.').split(':').reduce((n,x)=>n*60+Number(x),0);}
export function cueTimes(content:string):CueTime[]{
  if(content.length>1_200_000)return [];
  const result:CueTime[]=[];
  const add=(start:number,end:number,text:string)=>{
    if(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end<=21600&&end-start>=.3&&end-start<=15&&text.replace(/<[^>]*>|\{[^}]*\}|\\[Nnh]/g,'').trim())result.push({start,end});
  };
  if(/\[Events\]/i.test(content)){
    let fields:string[]=[],events=false;
    for(const row of content.split(/\r?\n/)){
      if(/^\[/.test(row)){events=/^\[Events\]/i.test(row);continue;}if(!events)continue;
      if(/^Format\s*:/i.test(row)){fields=row.slice(row.indexOf(':')+1).split(',').map(x=>x.trim().toLowerCase());continue;}
      if(!/^Dialogue\s*:/i.test(row)||fields.at(-1)!=='text')continue;
      const parts=row.slice(row.indexOf(':')+1).split(','), text=parts.slice(fields.length-1).join(',');
      const style=parts[fields.indexOf('style')]||'';
      if(/\{[^}]*\\(?:p[1-9]|pos\(|move\(|k\d)/i.test(text)||/(?:^|[ _-])(?:signs?|title|op|ed|karaoke)(?:$|[ _-])/i.test(style))continue;
      add(seconds(parts[fields.indexOf('start')]||''),seconds(parts[fields.indexOf('end')]||''),text);
    }
  }else{
    for(const block of content.replace(/\r/g,'').split(/\n\s*\n/)){
      const match=block.match(/((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})[^\n]*\n([\s\S]*)/);
      if(match)add(seconds(match[1]),seconds(match[2]),match[3]);
    }
  }
  result.sort((a,b)=>a.start-b.start);return result.filter((x,i)=>!i||x.start-result[i-1].start>.12).slice(0,5000);
}
function lower(times:CueTime[],value:number){let l=0,r=times.length;while(l<r){const m=(l+r)>>>1;if(times[m].start<value)l=m+1;else r=m;}return l;}
const median=(xs:number[])=>{const a=xs.slice().sort((a,b)=>a-b);return a[Math.floor(a.length/2)]??0;};
/** A single constant offset, supported throughout the episode. Cuts/FPS drift remain unmodified. */
export function alignCueTimes(candidate:CueTime[],reference:CueTime[]):Alignment{
  const valid=(xs:CueTime[])=>xs.filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.start>=0&&x.end>x.start&&x.end<=21600).sort((a,b)=>a.start-b.start).slice(0,5000);
  candidate=valid(candidate);reference=valid(reference);
  if(candidate.length<50||reference.length<50)return uncertain();
  const span=candidate.at(-1)!.start-candidate[0].start, refSpan=reference.at(-1)!.start-reference[0].start;
  if(span<300||refSpan<300||Math.min(span,refSpan)/Math.max(span,refSpan)<.65)return uncertain();
  const step=Math.max(1,Math.ceil(candidate.length/400)), sample=candidate.filter((_,i)=>i%step===0);
  const bins=new Map<number,number>();
  for(const cue of sample){for(let i=lower(reference,cue.start-120);i<reference.length&&reference[i].start<=cue.start+120;i++){
    const bin=Math.round((reference[i].start-cue.start)*4);bins.set(bin,(bins.get(bin)||0)+1);
  }}
  const peaks=[...bins].map(([bin,count])=>({bin,count:count+(bins.get(bin-1)||0)+(bins.get(bin+1)||0)})).sort((a,b)=>b.count-a.count);
  const offsets:number[]=[0];for(const peak of peaks){const value=peak.bin/4;if(offsets.every(x=>Math.abs(x-value)>1.5))offsets.push(value);if(offsets.length>=16)break;}
  function score(offset:number){
    const deltas:number[]=[],errors:number[]=[],blocks=[{n:0,hit:0},{n:0,hit:0},{n:0,hit:0}];
    let hits=0,last=-1;
    for(const cue of sample){const block=blocks[Math.min(2,Math.floor((cue.start-candidate[0].start)/span*3))];block.n++;
      const time=cue.start+offset,i=lower(reference,time);const index=i===0?0:i===reference.length?i-1:Math.abs(reference[i].start-time)<Math.abs(reference[i-1].start-time)?i:i-1;
      const distance=Math.abs(reference[index].start-time);
      if(distance<=.45&&index!==last){hits++;block.hit++;deltas.push(reference[index].start-cue.start);errors.push(distance);last=index;}
    }
    return {offset,ratio:hits/sample.length,hits,blocks,deltas,error:median(errors)};
  }
  const scored=offsets.map(x=>{const first=score(x);return score(first.deltas.length?median(first.deltas):x);}).sort((a,b)=>b.ratio-a.ratio||a.error-b.error);
  const best=scored[0],runner=scored.find(x=>Math.abs(x.offset-best.offset)>1.5);
  const stable=best.blocks.every(b=>b.n>=10&&b.hit/b.n>=.67);
  if(best.ratio>=.78&&best.hits>=45&&best.error<=.18&&stable&&(!runner||best.ratio-runner.ratio>=.14)){
    const offsetSeconds=Math.abs(best.offset)<.2?0:Math.round(best.offset*100)/100;
    return {status:'aligned',offsetSeconds,match:best.ratio};
  }
  // This only vetoes automatic selection. It is not proof of a wrong title/episode.
  return {status:sample.length>=100&&best.ratio<.28?'mismatch':'uncertain',offsetSeconds:0,match:best.ratio};
}
