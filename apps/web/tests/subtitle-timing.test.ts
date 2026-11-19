import test from 'node:test';
import assert from 'node:assert/strict';
import {alignCueTimes,cueTimes,findSubtitleTimingStep,type CueTime,type SubtitleTimingStep} from '../src/player/subtitles/subtitle-timing.ts';
import { retimeSubtitle } from '../src/player/subtitles/segmented-subtitle.ts';
function dialogue(seed=12,count=240){let time=10,random=seed;return Array.from({length:count},()=>{random=(random*1664525+1013904223)>>>0;time+=1.7+random/2**32*7;return {start:time,end:time+1.4};});}
const shift=(xs:CueTime[],offset:number)=>xs.map(c=>({start:c.start+offset,end:c.end+offset}));
test('offset direction and zero alignment preserve original cue timing',()=>{
 const reference=dialogue();const frozen=structuredClone(reference);
 assert.equal(alignCueTimes(shift(reference,-3.25),reference).offsetSeconds,3.25);
 assert.equal(alignCueTimes(shift(reference,12),reference).offsetSeconds,-12);
 assert.equal(alignCueTimes(reference,reference).offsetSeconds,0);
 assert.equal(alignCueTimes(reference,reference).status,'aligned');
 assert.deepEqual(reference,frozen);
});
test('translation split/merge noise still has independently supported dialogue throughout the episode',()=>{
 const reference=dialogue(),candidate=shift(reference.filter((_,i)=>i%7!==0),-4.5);
 candidate.splice(35,0,{start:210,end:212});candidate.splice(100,0,{start:690,end:692});
 const found=alignCueTimes(candidate,reference);assert.equal(found.status,'aligned');assert.equal(found.offsetSeconds,4.5);
});
test('FPS drift, mid-episode cuts and ambiguous regular timings are never automatically shifted',()=>{
 const reference=dialogue();
 const drift=reference.map(x=>({start:x.start*1.04,end:x.end*1.04}));
 const cut=reference.map((x,i)=>({start:x.start+(i<120?0:20),end:x.end+(i<120?0:20)}));
 for(const candidate of [drift,cut])assert.notEqual(alignCueTimes(candidate,reference).status,'aligned');
 const regular=Array.from({length:240},(_,i)=>({start:i*5+10,end:i*5+12}));
 assert.notEqual(alignCueTimes(shift(regular,5),regular).status,'aligned');
});
test('different episodes and shared opening alone cannot authorize correction',()=>{
 const reference=dialogue(42),unrelated=dialogue(900);
 assert.notEqual(alignCueTimes(unrelated,reference).status,'aligned');
 const commonIntro=[...reference.slice(0,25),...unrelated.slice(25)];
 assert.notEqual(alignCueTimes(commonIntro,reference).status,'aligned');
 assert.equal(alignCueTimes(reference.slice(0,15),reference).status,'uncertain');
});
test('ASS drawings, positioned signs, karaoke and non-dialogue styles do not vote',()=>{
 const document='[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:10.00,0:00:12.00,Default,대사\nDialogue: 0,0:00:20.00,0:00:22.00,Default,{\\pos(40,40)}간판\nDialogue: 0,0:00:30.00,0:00:32.00,Signs,간판\nDialogue: 0,0:00:40.00,0:00:42.00,Default,{\\p1}m 0 0\n';
 assert.deepEqual(cueTimes(document),[{start:10,end:12}]);
 assert.deepEqual(cueTimes('WEBVTT\n\n00:10.000 --> 00:12.000\nhello\n\n'),[{start:10,end:12}]);
 assert.deepEqual(cueTimes('1\n00:00:10,000 --> 00:00:12,000\nhello\n'),[{start:10,end:12}]);
});
test('random unrelated dense subtitles do not produce a confident offset across seeds',()=>{
 let aligned=0;for(let seed=1;seed<=30;seed++)if(alignCueTimes(dialogue(seed),dialogue(seed+90)).status==='aligned')aligned++;
 assert.equal(aligned,0);
});

function editedEdition(before: number, after: number, boundary = 32) {
  const reference = dialogue(1729, 110).map((cue, i) => {
    // A gap between scenes accommodates both insertions and removals without reordering cues.
    const start = Math.round((cue.start + (i >= boundary ? 60 : 0)) * 100) / 100;
    return { start, end: start + 1.4 };
  });
  const candidate = reference.map((cue, i) => shift([cue], i < boundary ? -before : -after)[0]);
  return { candidate, reference };
}

test('two independent offsets preserve early dialogue and identify one step on the source clock', () => {
  for (const [before, after] of [[0, 18], [0, -10], [-3, 7], [4, -9]]) {
    const { candidate, reference } = editedEdition(before, after);
    const step = findSubtitleTimingStep(candidate, reference);
    assert.ok(step, `expected step ${before} → ${after}`);
    assert.deepEqual(step, { before, after, beforeMatch: 1, afterMatch: 1, boundary: candidate[32].start });
  }
});

test('a short cold open provides independent evidence when a dozen distinctive cues span a minute', () => {
  const { candidate, reference } = editedEdition(0, 18, 16);
  const step = findSubtitleTimingStep(candidate, reference);
  assert.equal(step?.before, 0);
  assert.equal(step?.after, 18);
  assert.equal(step?.boundary, candidate[16].start);
});

test('one edit tolerates occasional translation splits and missing cues within both spans', () => {
  const { candidate, reference } = editedEdition(0, 18);
  const sparse = candidate.filter((_, i) => i % 9 !== 2);
  sparse.push({ start: candidate[78].start + .8, end: candidate[78].end + .8 });
  sparse.sort((a, b) => a.start - b.start);
  const step = findSubtitleTimingStep(sparse, reference);
  assert.equal(step?.before, 0);
  assert.equal(step?.after, 18);
  assert.ok(step.afterMatch >= .85 && step.afterMatch < 1);
});

test('a single cut needs unambiguous evidence on both sides and at the boundary', () => {
  const { candidate, reference } = editedEdition(0, 18);
  const periodic = Array.from({ length: 110 }, (_, i) => ({ start: i * 6 + 30, end: i * 6 + 31 }));
  const ambiguous = [...reference, ...shift([candidate[32]], 0)].sort((a, b) => a.start - b.start);
  for (const [left, right] of [
    [candidate, ambiguous],
    [reference, reference],
    [shift(reference, 5), reference],
    [reference.map(x => ({ start: x.start * 1.02, end: x.end * 1.02 })), reference],
    [candidate.map((x, i) => i > 55 && i < 75 ? shift([x], 12)[0] : x), reference],
    [candidate.slice(23), reference],
    [candidate, [...reference.slice(0, 32), ...shift(dialogue(99, 78), 350)]],
    [periodic.map((x, i) => shift([x], i < 32 ? 0 : 18)[0]), periodic]
  ]) assert.equal(findSubtitleTimingStep(left, right), null);
  for (let seed = 1; seed < 25; seed++) assert.equal(findSubtitleTimingStep(dialogue(seed), dialogue(seed + 100)), null);
});

const timingStep: SubtitleTimingStep = { boundary: 112, before: 0, after: -10, beforeMatch: 1, afterMatch: 1 };
test('VTT timing copy preserves metadata, cue identifiers, positioning, inline timestamps and crossing cue duration', () => {
  const header = 'WEBVTT\r\n\r\nNOTE chapter\r\n01:50.000 --> 01:58.000\r\n\r\n';
  const earlier = 'opening\r\n00:01:48.000 --> 00:01:53.000 line:20%\r\nbefore\r\n\r\n';
  const later = 'event-2\r\n01:52.000 --> 01:55.500 align:end\r\na<01:53.000>b';
  const expected = 'event-2\r\n00:01:42.000 --> 00:01:45.500 align:end\r\na<00:01:43.000>b';
  assert.equal(retimeSubtitle(header + earlier + later, 'vtt', timingStep), header + earlier + expected);
  assert.deepEqual(cueTimes(header + earlier + later), [{ start: 108, end: 113 }, { start: 112, end: 115.5 }]);
  assert.equal(retimeSubtitle('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:123\n\n' + later, 'vtt', timingStep), null);
});
test('ASS changes event times using Format order, preserving layers, overrides, karaoke and relative motion', () => {
  const header = '[Events]\nFormat: Layer, End, Start, Style, Text\n';
  const early = 'Dialogue: 2,0:01:50.00,0:01:48.00,Default,early\n';
  const body = ',Default,{\\move(10,10,90,90,100,500)\\k50}Hello, there\n';
  const original = header + early + 'Dialogue: 3,0:01:55.50,0:01:52.00' + body;
  assert.equal(retimeSubtitle(original, 'ass', timingStep), header + early + 'Dialogue: 3,0:01:45.50,0:01:42.00' + body);
  assert.equal(retimeSubtitle(original, 'ass', { ...timingStep, after: -150 }), null);
});
