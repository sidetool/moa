import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlaybackMarkers } from '../src/player/skip-markers.js';

test('file intervals keep their boundaries while remote intervals supplement missing sections', () => {
  const result = mergePlaybackMarkers({source:'manual',introStart:12,introEnd:71},{source:'theintrodb',introStart:8,introEnd:80,creditsStart:1100,creditsEnd:1150});
  assert.deepEqual(result,{source:'manual',introStart:12,introEnd:71,creditsStart:1100,creditsEnd:1150,provenance:{intro:'manual',credits:'theintrodb'}});
});
test('a partial remote refresh keeps known opening and does not attach a different credits end', () => {
  const result=mergePlaybackMarkers({source:'aniskip',creditsStart:1120},{source:'aniskip',introStart:10,introEnd:90,creditsStart:1100,creditsEnd:1150});
  assert.equal(result?.introEnd,90);assert.equal(result?.creditsStart,1120);assert.equal(result?.creditsEnd,undefined);
});
