import assert from "node:assert/strict";
import test from "node:test";
import { compareFingerprints, detectCommonIntervals, matchingRuns } from "../../src/playback/skip-markers/compare.js";
import { decodeFingerprint, encodeHashes, fingerprintPcm, hammingDistance, SAMPLE_RATE, CHROMAPRINT_STEP } from "../../src/playback/skip-markers/fingerprint.js";
import { episodePcm, melody } from "./fixtures.js";

const near = (actual: number, expected: number, tolerance = 0.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
test("uint32 Hamming distance includes sign bit", () => {
  assert.equal(hammingDistance(0, 0xffffffff), 32);
  assert.equal(hammingDistance(0x80000000, 0), 1);
  assert.equal(hammingDistance(12345, 12345), 0);
});
test("dropouts close only bounded gaps, end exclusive, short matches excluded", () => {
  const scores = [0, ...Array(20).fill(1), 0, 0, ...Array(20).fill(1), ...Array(4).fill(0), ...Array(10).fill(1)];
  assert.deepEqual(matchingRuns(scores, 0.9, 2, 15).map(run => [run.start, run.end]), [[1, 43]]);
});
test("PCM shared theme aligns broadcast offsets, gain/noise changes, and boundaries", async () => {
  const theme = melody(24, 31);
  const a = await fingerprintPcm(episodePcm(65, 1, [{ start: 4.2, signal: theme }]));
  const b = await fingerprintPcm(episodePcm(65, 2, [{ start: 18.6, signal: theme, gain: 0.7, noise: 0.001 }]));
  const matches = await compareFingerprints(a, b);
  assert.ok(matches.length > 0);
  near(matches[0].aStart, 4.2); near(matches[0].aEnd, 28.2);
  near(matches[0].bStart, 18.6); near(matches[0].bEnd, 42.6);
  assert.ok(matches[0].similarity > 0.94);
  assert.deepEqual(decodeFingerprint(JSON.parse(JSON.stringify(a))).hashes, decodeFingerprint(a).hashes);
});
test("season majority excludes singleton, minority repeat, and late ED offsets are absolute", async () => {
  const theme = melody(22, 40), minority = melody(18, 50);
  const fps = [];
  for (let i = 0; i < 6; i++) fps.push(await fingerprintPcm(episodePcm(75, i + 100, [
    ...(i < 5 ? [{ start: 3 + i * 1.7, signal: theme }] : []),
    ...(i < 2 ? [{ start: 45, signal: minority }] : []),
  ]), 1200 + i * 4));
  const detected = await detectCommonIntervals(fps);
  for (let i = 0; i < 5; i++) {
    assert.ok(detected[i]); near(detected[i]!.start, 1203 + i * 5.7); near(detected[i]!.end, 1225 + i * 5.7);
    assert.ok(detected[i]!.support >= 4);
  }
  assert.equal(detected[5], null);
});
test("unrelated audio, silence and unchanging tone produce no interval", async () => {
  const a = await fingerprintPcm(episodePcm(35, 600));
  const b = await fingerprintPcm(episodePcm(35, 601));
  assert.deepEqual(await compareFingerprints(a, b), []);
  const silence = await fingerprintPcm(Buffer.alloc(SAMPLE_RATE * 35 * 2));
  assert.deepEqual(await compareFingerprints(silence, silence), []);
  const tone = Buffer.alloc(SAMPLE_RATE * 35 * 2);
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 10000), i * 2);
  const fp = await fingerprintPcm(tone);
  assert.deepEqual(await compareFingerprints(fp, fp), []);
});
test("matches shorter than 15s or longer than 150s do not become guessed 90s markers", async () => {
  const short = melody(10, 900);
  const a = await fingerprintPcm(episodePcm(35, 901, [{ start: 4, signal: short }]));
  const b = await fingerprintPcm(episodePcm(35, 902, [{ start: 8, signal: short }]));
  assert.deepEqual(await compareFingerprints(a, b), []);
  const long = await fingerprintPcm(episodePcm(160, 903));
  assert.deepEqual(await compareFingerprints(long, long), []);
});
test("cancellation interrupts CPU fingerprint extraction and comparisons", async () => {
  const controller = new AbortController();
  const pending = fingerprintPcm(episodePcm(40, 111), 0, controller.signal);
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
  const signal = AbortSignal.abort();
  const fp = await fingerprintPcm(episodePcm(20, 11));
  await assert.rejects(compareFingerprints(fp, fp, {}, signal), { name: "AbortError" });
});

test("synthetic Chromaprint words tolerate bit errors and align with PCM-derived boundaries", async () => {
  const theme = melody(24, 9911);
  const aStart = 50 * CHROMAPRINT_STEP, bStart = 100 * CHROMAPRINT_STEP;
  const a = await fingerprintPcm(episodePcm(55, 9912, [{ start: aStart, signal: theme }]));
  const b = await fingerprintPcm(episodePcm(55, 9913, [{ start: bStart, signal: theme }]));
  const words = (seed: number) => Array.from({ length: 420 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;
  });
  const left = words(30), right = words(40), shared = words(50);
  for (let frame = 0; frame < Math.floor(24 / CHROMAPRINT_STEP); frame++) {
    left[50 + frame] = shared[frame]; right[100 + frame] = (shared[frame] ^ 1) >>> 0;
  }
  const matches = await compareFingerprints(
    { ...a, backend: "chromaprint", step: CHROMAPRINT_STEP, hashes: encodeHashes(left) },
    { ...b, backend: "chromaprint", step: CHROMAPRINT_STEP, hashes: encodeHashes(right) },
  );
  assert.ok(matches[0]); near(matches[0].aStart, aStart); near(matches[0].bStart, bStart);
  near(matches[0].aEnd, aStart + 24); near(matches[0].bEnd, bStart + 24);
});
