import { setImmediate } from "node:timers/promises";
import { decodeFingerprint, hammingDistance, spectrumCorrelation, chromaCorrelation, type AudioFingerprint, type DecodedFingerprint } from "./fingerprint.js";

export interface ComparisonOptions {
  minDuration?: number;
  maxDuration?: number;
  /** Fraction of all season episodes that must contain the same interval. Default: strict majority. */
  minimumSeasonFraction?: number;
  boundaryTolerance?: number;
}
export interface PairMatch { aStart: number; aEnd: number; bStart: number; bEnd: number; similarity: number }
export interface CommonInterval { start: number; end: number; confidence: number; support: number }
interface Run { start: number; end: number; mean: number }

/** Close short dropouts, but never manufacture a fixed-length interval. End is exclusive. */
export function matchingRuns(values: ArrayLike<number>, threshold: number, maxGap: number, minFrames: number): Run[] {
  const runs: Run[] = [];
  let start = -1, last = -1;
  const finish = () => {
    if (start >= 0 && last - start + 1 >= minFrames) {
      let sum = 0, good = 0;
      for (let i = start; i <= last; i++) { sum += values[i]; if (values[i] >= threshold) good++; }
      if (good / (last - start + 1) >= 0.85) runs.push({ start, end: last + 1, mean: sum / (last - start + 1) });
    }
    start = -1; last = -1;
  };
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= threshold) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > maxGap) finish();
  }
  finish();
  return runs;
}
function hashActive(fp: DecodedFingerprint, index: number): boolean {
  const time = index * fp.fingerprint.step + (fp.fingerprint.backend === "chromaprint" ? 1.3 : 0);
  return !!fp.active[Math.round(time / fp.fingerprint.spectrumStep)];
}
/** Byte-level locality sensitive indexing generates candidate alignments without an NxM matrix. */
function candidateOffsets(a: DecodedFingerprint, b: DecodedFingerprint): number[] {
  const index = new Map<number, number[]>();
  for (let j = 0; j < b.hashes.length; j++) {
    if (!hashActive(b, j)) continue;
    for (let part = 0; part < 4; part++) {
      const key = part * 256 + ((b.hashes[j] >>> (part * 8)) & 255);
      const bucket = index.get(key);
      if (bucket) bucket.push(j); else index.set(key, [j]);
    }
  }
  const votes = new Map<number, number>();
  for (let i = 0; i < a.hashes.length; i += 3) {
    if (!hashActive(a, i)) continue;
    for (let part = 0; part < 4; part++) {
      const bucket = index.get(part * 256 + ((a.hashes[i] >>> (part * 8)) & 255));
      if (!bucket || bucket.length > b.hashes.length * 0.15) continue;
      for (const j of bucket) {
        if (hammingDistance(a.hashes[i], b.hashes[j]) > 8) continue;
        const delta = j - i;
        votes.set(delta, (votes.get(delta) ?? 0) + 1);
      }
    }
  }
  return [...votes].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([delta]) => delta);
}
function smooth(values: Float64Array, half: number): Float64Array {
  const result = new Float64Array(values.length);
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < values.length; i++) {
    const left = Math.max(0, i - half), right = Math.min(values.length, i + half + 1);
    result[i] = (prefix[right] - prefix[left]) / (right - left);
  }
  return result;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function varyingSpectrum(fp: DecodedFingerprint, start: number, end: number): boolean {
  let variation = 0, count = 0;
  const stride = Math.max(1, Math.round(1 / fp.fingerprint.spectrumStep));
  for (let i = Math.max(0, start); i + stride < Math.min(fp.active.length, end); i += stride) {
    if (!fp.active[i] || !fp.active[i + stride]) continue;
    variation += 1 - spectrumCorrelation(fp, i, fp, i + stride); count++;
  }
  return count > 5 && variation / count > 0.01;
}
function refine(a: DecodedFingerprint, b: DecodedFingerprint, deltaSeconds: number, seedStart: number, seedEnd: number, min: number, max: number): PairMatch[] {
  const step = a.fingerprint.spectrumStep;
  const base = Math.round(deltaSeconds / step);
  // Chromaprint is temporally smoothed. Recheck the actual spectra with a sub-second offset search.
  let bestOffset = base, best = -Infinity;
  for (let offset = base - 4; offset <= base + 4; offset++) {
    let sum = 0, count = 0;
    for (let i = Math.max(0, Math.ceil((seedStart + 3) / step)); i < Math.min(a.active.length, Math.floor((seedEnd - 3) / step)); i += 5) {
      const j = i + offset;
      if (j < 0 || j >= b.active.length) continue;
      sum += Math.max(spectrumCorrelation(a, i, b, j), chromaCorrelation(a, i, b, j)); count++;
    }
    const score = count ? sum / count : -1;
    if (score > best) { best = score; bestOffset = offset; }
  }
  if (best < 0.9) return [];
  const begin = Math.max(0, -bestOffset, Math.floor((seedStart - 5) / step));
  const finish = Math.min(a.active.length, b.active.length - bestOffset, Math.ceil((seedEnd + 5) / step));
  const scores = new Float64Array(Math.max(0, finish - begin));
  for (let i = begin; i < finish; i++) scores[i - begin] = Math.max(spectrumCorrelation(a, i, b, i + bestOffset), chromaCorrelation(a, i, b, i + bestOffset));
  return matchingRuns(smooth(scores, 2), 0.92, Math.round(0.7 / step), Math.ceil(min / step))
    .filter(run => run.mean >= 0.94 && (run.end - run.start) * step <= max && varyingSpectrum(a, begin + run.start, begin + run.end) && varyingSpectrum(b, begin + run.start + bestOffset, begin + run.end + bestOffset))
    .map(run => {
      // A spectrum frame covers FFT_SIZE/sampleRate; use its center as the timestamp.
      const start = (begin + run.start) * step + step;
      const end = (begin + run.end) * step + step;
      return { aStart: start + a.fingerprint.offset, aEnd: Math.min(end, a.fingerprint.duration) + a.fingerprint.offset,
        bStart: start + bestOffset * step + b.fingerprint.offset, bEnd: Math.min(end + bestOffset * step, b.fingerprint.duration) + b.fingerprint.offset, similarity: run.mean };
    });
}

export async function compareFingerprints(aFp: AudioFingerprint, bFp: AudioFingerprint, options: ComparisonOptions = {}, signal?: AbortSignal): Promise<PairMatch[]> {
  signal?.throwIfAborted();
  if (aFp.backend !== bFp.backend || aFp.step !== bFp.step || aFp.spectrumStep !== bFp.spectrumStep) throw new Error("Fingerprint backends/timing must match");
  const a = decodeFingerprint(aFp), b = decodeFingerprint(bFp);
  const min = options.minDuration ?? 15, max = options.maxDuration ?? 150;
  const matches: PairMatch[] = [];
  for (const delta of candidateOffsets(a, b)) {
    await setImmediate(); signal?.throwIfAborted();
    const begin = Math.max(0, -delta), finish = Math.min(a.hashes.length, b.hashes.length - delta);
    const scores = new Float64Array(Math.max(0, finish - begin));
    for (let i = begin; i < finish; i++) {
      scores[i - begin] = hashActive(a, i) && hashActive(b, i + delta) ? 1 - hammingDistance(a.hashes[i], b.hashes[i + delta]) / 32 : 0;
    }
    const coarse = matchingRuns(smooth(scores, 3), aFp.backend === "chromaprint" ? 0.78 : 0.73, Math.round(0.8 / aFp.step), Math.ceil(min / aFp.step));
    for (const run of coarse) {
      const words = new Set(a.hashes.slice(begin + run.start, begin + run.end));
      // Silence and unchanging tones are not identifiable themes.
      if (words.size < 20) continue;
      const refined = refine(a, b, delta * aFp.step, (begin + run.start) * aFp.step, (begin + run.end) * aFp.step + (aFp.backend === "chromaprint" ? 2.6 : 0), min, max);
      for (const match of refined) {
        if (!matches.some(existing => Math.abs(existing.aStart - match.aStart) < 2 && Math.abs(existing.bStart - match.bStart) < 2)) matches.push(match);
      }
    }
  }
  return matches.sort((a, b) => (b.aEnd - b.aStart) * b.similarity - (a.aEnd - a.aStart) * a.similarity).slice(0, 6);
}

/** Each peer votes once, clusters must agree on both boundaries, and minority duration outliers are removed. */
export async function detectCommonIntervals(fingerprints: (AudioFingerprint | null)[], options: ComparisonOptions = {}, context: { signal?: AbortSignal; onPair?: (completed: number, total: number) => void } = {}): Promise<(CommonInterval | null)[]> {
  const n = fingerprints.length;
  const required = Math.max(3, Math.floor(n * (options.minimumSeasonFraction ?? 0.5)) + 1);
  const tolerance = options.boundaryTolerance ?? 3;
  const proposals: { peer: number; start: number; end: number; similarity: number }[][] = Array.from({ length: n }, () => []);
  const total = n * (n - 1) / 2;
  let completed = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    context.signal?.throwIfAborted();
    if (fingerprints[i] && fingerprints[j]) {
      for (const match of await compareFingerprints(fingerprints[i]!, fingerprints[j]!, options, context.signal)) {
        proposals[i].push({ peer: j, start: match.aStart, end: match.aEnd, similarity: match.similarity });
        proposals[j].push({ peer: i, start: match.bStart, end: match.bEnd, similarity: match.similarity });
      }
    }
    context.onPair?.(++completed, total);
  }
  const intervals = proposals.map(list => {
    const clusters = list.map(seed => {
      const peers = new Map<number, typeof seed>();
      for (const proposal of list) if (Math.abs(seed.start - proposal.start) <= tolerance && Math.abs(seed.end - proposal.end) <= tolerance) {
        const current = peers.get(proposal.peer);
        if (!current || proposal.similarity > current.similarity) peers.set(proposal.peer, proposal);
      }
      const members = [...peers.values()];
      return { start: median(members.map(m => m.start)), end: median(members.map(m => m.end)),
        confidence: median(members.map(m => m.similarity)), support: members.length + 1 };
    }).filter(cluster => cluster.support >= required);
    clusters.sort((a, b) => (b.end - b.start) * b.support * b.confidence - (a.end - a.start) * a.support * a.confidence);
    return clusters[0] ?? null;
  });
  const found = intervals.filter((i): i is CommonInterval => i !== null);
  if (found.length < required) return intervals.map(() => null);
  // A shifted broadcast start is allowed; a minority fragment with a different duration is not.
  const dominant = found.map(seed => ({ duration: seed.end - seed.start, count: found.filter(other => Math.abs((seed.end - seed.start) - (other.end - other.start)) <= tolerance * 2).length })).sort((a, b) => b.count - a.count)[0];
  if (dominant.count < required) return intervals.map(() => null);
  return intervals.map(interval => interval && Math.abs(interval.end - interval.start - dominant.duration) <= tolerance * 2 ? interval : null);
}
