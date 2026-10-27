import test from 'node:test';
import assert from 'node:assert/strict';
import {alignCueTimes,cueTimes,type CueTime} from '../src/player/subtitles/subtitle-timing.ts';
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
