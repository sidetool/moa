import test from 'node:test';
import assert from 'node:assert/strict';
import { detectedCrop } from '../src/playback/thumbnail.js';

test('cropdetect removes cinematic bars, preserves full-frame anime, rejects dark transient crops', () => {
  const metadata = (w: number, h: number, x: number, y: number) => `frame:0\nlavfi.cropdetect.w=${w}\nlavfi.cropdetect.h=${h}\nlavfi.cropdetect.x=${x}\nlavfi.cropdetect.y=${y}\n`;
  assert.deepEqual(detectedCrop(metadata(1920, 800, 0, 140), 1920, 1080), { width: 1920, height: 800, left: 0, top: 140 });
  assert.deepEqual(detectedCrop(metadata(1920, 1080, 0, 0), 1920, 1080), { width: 1920, height: 1080, left: 0, top: 0 });
  assert.deepEqual(detectedCrop(metadata(200, 200, 0, 0) + metadata(1920, 800, 0, 140), 1920, 1080), { width: 1920, height: 800, left: 0, top: 140 });
});
