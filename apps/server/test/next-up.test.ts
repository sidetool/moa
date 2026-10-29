import test from 'node:test';
import assert from 'node:assert/strict';
import { nextUpTiming } from '../../web/src/player/playback/next-up.js';

test('unmarked episodes wait for the actual end unless a lead time is selected', () => {
  for (const duration of [20, 1380, 1440, 1499, 3600]) {
    assert.equal(nextUpTiming(duration, duration - 10, undefined).creditsAt, duration);
    assert.equal(nextUpTiming(duration, duration - 10, { introStart: 0, introEnd: 5 }).hasCredits, false);
  }
  assert.equal(nextUpTiming(1440, 1350, undefined, 90).creditsAt, 1350);
  for (const lead of [-1, 1.5, 601, Infinity, NaN]) assert.equal(nextUpTiming(1440, 0, undefined, lead).creditsAt, 1440);
  assert.equal(nextUpTiming(60, 0, undefined, 90).creditsAt, 60);
  assert.equal(nextUpTiming(90, 0, undefined, 90).creditsAt, 90);
  assert.equal(nextUpTiming(0, 0, undefined, 90).creditsAt, Infinity);
});

test('actual ending markers keep their timing regardless of the unmarked-video preference', () => {
  for (const lead of [0, 30, 90, 600]) {
    const timing = nextUpTiming(1440, 1325, { source: 'aniskip', creditsStart: 1320, creditsEnd: 1440 }, lead);
    assert.equal(timing.creditsAt, 1320);
    assert.equal(timing.hasCredits, true);
    assert.equal(timing.inCredits, true);
    const tail = nextUpTiming(1440, 1325, { source: 'aniskip', creditsStart: 1300, creditsEnd: 1340 }, lead);
    assert.equal(tail.creditsAt, 1425);
    assert.equal(tail.postCredits, true);
  }
});

test('invalid ending markers fall back to the configured unmarked-video behavior', () => {
  for (const markers of [{ creditsStart: -1 }, { creditsStart: NaN }, { creditsStart: 1440 }, { creditsStart: 1320, creditsEnd: 1300 }]) {
    assert.equal(nextUpTiming(1440, 1400, markers).hasCredits, false);
    assert.equal(nextUpTiming(1440, 1400, markers, 90).creditsAt, 1350);
  }
});
