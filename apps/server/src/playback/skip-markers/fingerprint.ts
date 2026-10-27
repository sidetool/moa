import { setImmediate } from "node:timers/promises";

export const SAMPLE_RATE = 11025;
export const SPECTRUM_STEP = 1024 / SAMPLE_RATE;
export const CHROMAPRINT_STEP = 1365 / SAMPLE_RATE;
const FFT_SIZE = 2048;
export const SPECTRUM_BANDS = 32;

/** All binary arrays use base64; uint32 words are explicitly little endian. */
export interface AudioFingerprint {
  version: 1;
  backend: "chromaprint" | "spectrum";
  offset: number;
  duration: number;
  step: number;
  hashes: string;
  /** 32 signed int8 normalized log-spectrum coefficients per frame. */
  spectrum: string;
  active: string;
  /** Optional 12 signed int8 centered pitch-class coefficients per frame. */
  chroma?: string;
  spectrumStep: number;
}
export interface DecodedFingerprint {
  fingerprint: AudioFingerprint;
  hashes: Uint32Array;
  spectrum: Int8Array;
  active: Uint8Array;
  chroma?: Int8Array;
}
export function encodeHashes(words: readonly number[] | Uint32Array): string {
  const buffer = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) buffer.writeUInt32LE(words[i] >>> 0, i * 4);
  return buffer.toString("base64");
}
export function decodeFingerprint(fingerprint: AudioFingerprint): DecodedFingerprint {
  const bytes = Buffer.from(fingerprint.hashes, "base64");
  if (fingerprint.version !== 1 || bytes.length % 4 !== 0) throw new Error("Invalid fingerprint encoding/version");
  const hashes = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < hashes.length; i++) hashes[i] = bytes.readUInt32LE(i * 4);
  const spectrumBytes = Buffer.from(fingerprint.spectrum, "base64");
  const active = Buffer.from(fingerprint.active, "base64");
  if (spectrumBytes.length !== active.length * SPECTRUM_BANDS) throw new Error("Invalid spectrum length");
  const chromaBytes = fingerprint.chroma ? Buffer.from(fingerprint.chroma, "base64") : undefined;
  if (chromaBytes && chromaBytes.length !== active.length * 12) throw new Error("Invalid chroma length");
  return { fingerprint, hashes, chroma: chromaBytes ? new Int8Array(chromaBytes.buffer, chromaBytes.byteOffset, chromaBytes.length) : undefined, spectrum: new Int8Array(spectrumBytes.buffer, spectrumBytes.byteOffset, spectrumBytes.length), active };
}

const reverse = new Uint16Array(FFT_SIZE);
const hann = new Float64Array(FFT_SIZE);
const cosine = new Float64Array(FFT_SIZE / 2);
const sine = new Float64Array(FFT_SIZE / 2);
const pitchForBin = new Int8Array(FFT_SIZE / 2).fill(-1);
const bandForBin = new Int8Array(FFT_SIZE / 2).fill(-1);
for (let i = 0; i < FFT_SIZE; i++) {
  let value = i;
  for (let b = 0; b < 11; b++) { reverse[i] = (reverse[i] << 1) | (value & 1); value >>= 1; }
  hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
}
for (let i = 0; i < FFT_SIZE / 2; i++) {
  cosine[i] = Math.cos(2 * Math.PI * i / FFT_SIZE);
  sine[i] = -Math.sin(2 * Math.PI * i / FFT_SIZE);
  const hz = i * SAMPLE_RATE / FFT_SIZE;
  if (hz >= 80 && hz < 2600) pitchForBin[i] = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
  if (hz >= 80 && hz < 5000) bandForBin[i] = Math.min(31, Math.floor(32 * Math.log(hz / 80) / Math.log(5000 / 80)));
}
function transform(real: Float64Array, imaginary: Float64Array): void {
  for (let width = 2; width <= FFT_SIZE; width *= 2) {
    const half = width / 2;
    const stride = FFT_SIZE / width;
    for (let block = 0; block < FFT_SIZE; block += width) {
      for (let j = 0; j < half; j++) {
        const left = block + j;
        const right = left + half;
        const wr = cosine[j * stride];
        const wi = sine[j * stride];
        const tr = real[right] * wr - imaginary[right] * wi;
        const ti = real[right] * wi + imaginary[right] * wr;
        real[right] = real[left] - tr;
        imaginary[right] = imaginary[left] - ti;
        real[left] += tr;
        imaginary[left] += ti;
      }
    }
  }
}

/** Independently implemented spectrum fingerprint. Input: 11025 Hz, mono, signed PCM16LE. */
export async function fingerprintPcm(pcm: Buffer, offset = 0, signal?: AbortSignal): Promise<AudioFingerprint> {
  signal?.throwIfAborted();
  const count = Math.max(0, Math.floor((pcm.length / 2 - FFT_SIZE) / 1024) + 1);
  const features = new Int8Array(count * SPECTRUM_BANDS);
  const active = new Uint8Array(count);
  const chroma = new Int8Array(count * 12);
  const pitches = new Float64Array(12);
  const hashes = new Uint32Array(count);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const energy = new Float64Array(SPECTRUM_BANDS);
  for (let frame = 0; frame < count; frame++) {
    if (frame % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    let power = 0;
    for (let j = 0; j < FFT_SIZE; j++) {
      const sample = pcm.readInt16LE((frame * 1024 + j) * 2) / 32768;
      power += sample * sample;
      real[reverse[j]] = sample * hann[j];
    }
    imaginary.fill(0);
    transform(real, imaginary);
    energy.fill(0);
    pitches.fill(0);
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const band = bandForBin[bin];
      const binPower = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      if (band >= 0) energy[band] += binPower;
      if (pitchForBin[bin] >= 0) pitches[pitchForBin[bin]] += Math.sqrt(binPower);
    }
    const floor = energy.reduce((sum, value) => sum + value, 0) * 1e-5 + 1e-9;
    let mean = 0;
    for (let band = 0; band < SPECTRUM_BANDS; band++) { energy[band] = Math.log(energy[band] + floor); mean += energy[band] / SPECTRUM_BANDS; }
    let norm = 0;
    for (let band = 0; band < SPECTRUM_BANDS; band++) { energy[band] -= mean; norm += energy[band] ** 2; }
    norm = Math.sqrt(norm);
    active[frame] = power / FFT_SIZE > 1e-7 && norm > 1e-3 ? 1 : 0;
    if (active[frame]) {
      const pitchMean = pitches.reduce((sum, value) => sum + value, 0) / 12;
      const pitchNorm = Math.sqrt(pitches.reduce((sum, value) => sum + (value - pitchMean) ** 2, 0));
      if (pitchNorm > 1e-6) for (let pitch = 0; pitch < 12; pitch++) chroma[frame * 12 + pitch] = Math.round((pitches[pitch] - pitchMean) / pitchNorm * 127);
      for (let band = 0; band < SPECTRUM_BANDS; band++) features[frame * SPECTRUM_BANDS + band] = Math.round(energy[band] / norm * 127);
    }
  }
  const smoothedChroma = new Int8Array(chroma.length);
  for (let frame = 0; frame < count; frame++) {
    const vector = new Float64Array(12);
    for (let neighbor = Math.max(0, frame - 3); neighbor <= Math.min(count - 1, frame + 3); neighbor++) {
      for (let pitch = 0; pitch < 12; pitch++) vector[pitch] += chroma[neighbor * 12 + pitch];
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm > 0) for (let pitch = 0; pitch < 12; pitch++) smoothedChroma[frame * 12 + pitch] = Math.round(vector[pitch] / norm * 127);
  }
  for (let frame = 0; frame < count; frame++) {
    if (!active[frame]) continue;
    let hash = 0;
    for (let bit = 0; bit < 16; bit++) {
      const left = bit % 12, right = (left + 1 + Math.floor(bit / 12) * 4) % 12;
      const current = smoothedChroma[frame * 12 + left] - smoothedChroma[frame * 12 + right];
      const previousFrame = Math.max(0, frame - 4);
      const previous = smoothedChroma[previousFrame * 12 + left] - smoothedChroma[previousFrame * 12 + right];
      if (current > 0) hash |= 1 << bit;
      if (current > previous) hash |= 1 << (bit + 16);
    }
    hashes[frame] = hash >>> 0;
  }
  return { version: 1, backend: "spectrum", offset, duration: pcm.length / 2 / SAMPLE_RATE, step: SPECTRUM_STEP,
    hashes: encodeHashes(hashes), chroma: Buffer.from(smoothedChroma.buffer).toString("base64"), spectrum: Buffer.from(features.buffer).toString("base64"), active: Buffer.from(active).toString("base64"), spectrumStep: SPECTRUM_STEP };
}

export function hammingDistance(a: number, b: number): number {
  let value = (a ^ b) >>> 0;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function spectrumCorrelation(a: DecodedFingerprint, i: number, b: DecodedFingerprint, j: number): number {
  if (!a.active[i] || !b.active[j]) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let band = 0; band < SPECTRUM_BANDS; band++) {
    const x = a.spectrum[i * SPECTRUM_BANDS + band];
    const y = b.spectrum[j * SPECTRUM_BANDS + band];
    dot += x * y; aa += x * x; bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function chromaCorrelation(a: DecodedFingerprint, i: number, b: DecodedFingerprint, j: number): number {
  if (!a.chroma || !b.chroma || !a.active[i] || !b.active[j]) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let pitch = 0; pitch < 12; pitch++) {
    const x = a.chroma[i * 12 + pitch], y = b.chroma[j * 12 + pitch];
    dot += x * y; aa += x * x; bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
