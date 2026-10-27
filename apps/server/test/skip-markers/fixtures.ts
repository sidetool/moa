import { SAMPLE_RATE } from "../../src/playback/skip-markers/fingerprint.js";

function random(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
/** A changing polyphonic signal; seeds provide distinct episode audio, no real media bundled. */
export function melody(seconds: number, seed: number): Float64Array {
  const rng = random(seed);
  const samples = new Float64Array(Math.ceil(seconds * SAMPLE_RATE));
  const block = Math.floor(SAMPLE_RATE * 0.37);
  for (let offset = 0; offset < samples.length; offset += block) {
    const notes = Array.from({ length: 4 }, () => 80 * 2 ** (rng() * 5.5));
    for (let j = 0; j < block && offset + j < samples.length; j++) {
      const t = j / SAMPLE_RATE;
      const envelope = Math.min(1, j / 100, (block - j) / 100);
      samples[offset + j] = notes.reduce((sum, hz, index) => sum + Math.sin(2 * Math.PI * hz * t) * (0.12 - index * 0.02), 0) * envelope;
    }
  }
  return samples;
}
export function episodePcm(duration: number, seed: number, inserts: { start: number; signal: Float64Array; gain?: number; noise?: number }[] = []): Buffer {
  const signal = melody(duration, seed);
  const rng = random(seed + 1000);
  for (const insert of inserts) {
    const offset = Math.round(insert.start * SAMPLE_RATE);
    for (let i = 0; i < insert.signal.length && offset + i < signal.length; i++) signal[offset + i] = insert.signal[i] * (insert.gain ?? 1) + (rng() - 0.5) * (insert.noise ?? 0);
  }
  const result = Buffer.alloc(signal.length * 2);
  for (let i = 0; i < signal.length; i++) result.writeInt16LE(Math.round(Math.max(-1, Math.min(1, signal[i])) * 30000), i * 2);
  return result;
}
