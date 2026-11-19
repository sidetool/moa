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
      if (/^(?:WEBVTT\b|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
      const match=block.match(/((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})[^\n]*\n([\s\S]*)/);
      if(match)add(seconds(match[1]),seconds(match[2]),match[3]);
    }
  }
  result.sort((a,b)=>a.start-b.start);return result.filter((x,i)=>!i||x.start-result[i-1].start>.12).slice(0,5000);
}
function lower(times:CueTime[],value:number){let l=0,r=times.length;while(l<r){const m=(l+r)>>>1;if(times[m].start<value)l=m+1;else r=m;}return l;}
const median=(xs:number[])=>{const a=xs.slice().sort((a,b)=>a-b);return a[Math.floor(a.length/2)]??0;};
function candidateOffsets(sample: CueTime[], reference: CueTime[]) {
  const bins=new Map<number,number>();
  for(const cue of sample){for(let i=lower(reference,cue.start-120);i<reference.length&&reference[i].start<=cue.start+120;i++){
    const bin=Math.round((reference[i].start-cue.start)*4);bins.set(bin,(bins.get(bin)||0)+1);
  }}
  const peaks=[...bins].map(([bin,count])=>({bin,count:count+(bins.get(bin-1)||0)+(bins.get(bin+1)||0)})).sort((a,b)=>b.count-a.count);
  const offsets:number[]=[0];for(const peak of peaks){const value=peak.bin/4;if(offsets.every(x=>Math.abs(x-value)>1.5))offsets.push(value);if(offsets.length>=16)break;}
  return offsets;
}
/** A single constant offset, supported throughout the episode. Cuts/FPS drift remain unmodified. */
export function alignCueTimes(candidate:CueTime[],reference:CueTime[]):Alignment{
  const valid=(xs:CueTime[])=>xs.filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.start>=0&&x.end>x.start&&x.end<=21600).sort((a,b)=>a.start-b.start).slice(0,5000);
  candidate=valid(candidate);reference=valid(reference);
  if(candidate.length<50||reference.length<50)return uncertain();
  const span=candidate.at(-1)!.start-candidate[0].start, refSpan=reference.at(-1)!.start-reference[0].start;
  if(span<300||refSpan<300||Math.min(span,refSpan)/Math.max(span,refSpan)<.65)return uncertain();
  const step=Math.max(1,Math.ceil(candidate.length/400)), sample=candidate.filter((_,i)=>i%step===0);
  const offsets = candidateOffsets(sample, reference);
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

export interface SubtitleTimingStep {
  /** Start of the first supported dialogue after the edit, on the original subtitle clock. */
  boundary: number;
  before: number;
  after: number;
  beforeMatch: number;
  afterMatch: number;
}

function nearestReference(reference: CueTime[], time: number) {
  const next = lower(reference, time);
  if (next === 0) return 0;
  if (next === reference.length) return next - 1;
  return time - reference[next - 1].start <= reference[next].start - time ? next - 1 : next;
}

function timingHits(cues: CueTime[], reference: CueTime[], offset: number) {
  let previous = -1;
  return cues.map(cue => {
    const index = nearestReference(reference, cue.start + offset);
    const delta = reference[index].start - cue.start;
    if (Math.abs(delta - offset) > .4 || previous === index) return null;
    previous = index;
    return delta;
  });
}

function anchorOffset(cues: CueTime[], reference: CueTime[]) {
  if (cues.at(-1)!.start - cues[0].start < 30) return null;
  const scores = candidateOffsets(cues, reference).map(offset => {
    const initial = timingHits(cues, reference, offset).filter(x => x !== null);
    const refined = initial.length ? median(initial) : offset;
    const hits = timingHits(cues, reference, refined).filter(x => x !== null);
    return { offset: refined, hits: hits.length, error: median(hits.map(x => Math.abs(x - refined))) };
  }).sort((a, b) => b.hits - a.hits || a.error - b.error);
  const best = scores[0], runner = scores.find(x => Math.abs(x.offset - best.offset) > 1.5);
  const short = cues.length < 24;
  if (best.hits < cues.length * (short ? .94 : .85) || best.error > (short ? .1 : .15) ||
    (runner && best.hits - runner.hits < cues.length * (short ? .35 : .2))) return null;
  return Math.abs(best.offset) < .2 ? 0 : Math.round(best.offset * 100) / 100;
}

function supportedSegment(deltas: (number | null)[], offset: number) {
  const hits = deltas.filter(delta => delta !== null);
  const match = hits.length / deltas.length;
  if (match < .85 || median(hits.map(x => Math.abs(x - offset))) > .15) return null;
  // A third cut or a continuous drift can have good overall coverage but a run of poor local matches.
  for (let start = 0; start + 12 <= deltas.length; start += 4) {
    if (deltas.slice(start, start + 12).filter(delta => delta !== null).length < 8) return null;
  }
  return match;
}

/** cueTimes supplies sorted, deduplicated dialogue starts on both clocks. No opening marker is needed. */
export function findSubtitleTimingStep(candidate: CueTime[], reference: CueTime[]): SubtitleTimingStep | null {
  // At the parser cap the unseen tail cannot support a claim about a single cut.
  if (candidate.length < 50 || reference.length < 50 || candidate.length >= 5000 || reference.length >= 5000) return null;
  const span = (cues: CueTime[]) => cues.at(-1)!.start - cues[0].start;
  if (Math.min(span(candidate), span(reference)) < 300) return null;
  // A cold open may only contain a dozen lines. Accept a short anchor only if it covers
  // a minute and has a near-exact, substantially more distinctive match than alternatives.
  const opening = candidate.slice(0, 24);
  const lastAnchor = opening.findIndex((cue, i) => i >= 11 && cue.start - opening[0].start >= 60);
  const prefixCount = lastAnchor < 0 ? 24 : lastAnchor + 1;
  const suffixCount = 24;
  const before = anchorOffset(opening.slice(0, prefixCount), reference);
  if (before === null) return null;
  const after = anchorOffset(candidate.slice(-suffixCount), reference);
  if (after === null || Math.abs(after - before) < 1.5) return null;
  const early = timingHits(candidate, reference, before);
  const late = timingHits(candidate, reference, after);
  // Moving the boundary right gains a prefix vote and loses a suffix vote. A tie leaves the
  // transition ambiguous, so retain the existing single-offset result for the whole track.
  let best = -Infinity, split = 0, tied = false, score = 0;
  for (let i = 1; i <= candidate.length - suffixCount; i++) {
    score += Number(early[i - 1] !== null) - Number(late[i - 1] !== null);
    if (i < prefixCount) continue;
    if (score > best) { best = score; split = i; tied = false; }
    else if (score === best) tied = true;
  }
  if (tied || early[split - 1] === null || late[split - 1] !== null || late[split] === null || early[split] !== null) return null;
  const boundary = candidate[split].start;
  if (candidate[split - 1].end + before > boundary + after) return null;
  const beforeMatch = supportedSegment(early.slice(0, split), before);
  const afterMatch = supportedSegment(late.slice(split), after);
  return beforeMatch && afterMatch ? { boundary, before, after, beforeMatch, afterMatch } : null;
}
