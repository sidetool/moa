import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { cacheKey, readCache } from "./cache.js";
import { detectCommonIntervals, type ComparisonOptions, type CommonInterval } from "./compare.js";
import { CHROMAPRINT_STEP, encodeHashes, fingerprintPcm, SAMPLE_RATE, type AudioFingerprint } from "./fingerprint.js";
import { mergeMarkers } from "./merge.js";
import { runCommand, Semaphore, type CommandRunner } from "./process.js";
import type { AnalysisContext, CacheStore, EpisodeAnalysis, FileIdentity, LocalEpisode, MarkerInterval, SeasonAnalysis } from "./types.js";

export const ANALYSIS_VERSION = 3;
export interface AudioAnalyzerOptions extends ComparisonOptions {
  cache?: CacheStore;
  introWindowSeconds?: number;
  creditsWindowSeconds?: number;
  concurrency?: number;
  backend?: "auto" | "chromaprint" | "spectrum";
  ffmpegPath?: string;
  ffprobePath?: string;
  fpcalcPath?: string;
  /** Relative audio stream index (0 = first audio stream). */
  audioStreamIndex?: number;
  commandRunner?: CommandRunner;
  processTimeoutMs?: number;
}
interface Runtime { backend: "chromaprint" | "spectrum"; ffmpeg: string; fpcalc?: string }
export interface EpisodeFingerprint {
  version: number;
  file: FileIdentity;
  duration: number;
  intro: AudioFingerprint;
  credits: AudioFingerprint;
}
function interval(value: CommonInterval | null, duration: number): MarkerInterval | null {
  if (!value || value.start < 0 || value.end > duration + 0.1 || value.end <= value.start) return null;
  return { start: Math.round(value.start * 100) / 100, end: Math.round(Math.min(duration, value.end) * 100) / 100, source: "fingerprint", confidence: Math.round(value.confidence * 1000) / 1000 };
}
export async function identifyFile(path: string): Promise<FileIdentity> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Expected a regular media file");
  return { path: absolute, size: info.size, mtimeMs: info.mtimeMs };
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean { return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs; }

export class AudioSkipAnalyzer {
  private readonly workers: Semaphore;
  private readonly comparisons = new Semaphore(1);
  private readonly runner: CommandRunner;
  private readonly front: number;
  private readonly tail: number;
  private runtime?: Runtime;
  constructor(private readonly options: AudioAnalyzerOptions = {}) {
    this.workers = new Semaphore(options.concurrency ?? 2);
    this.runner = options.commandRunner ?? runCommand;
    this.front = options.introWindowSeconds ?? 300;
    this.tail = options.creditsWindowSeconds ?? 180;
    for (const value of [this.front, this.tail]) if (!Number.isFinite(value) || value < 15 || value > 1800) throw new RangeError("audio windows must be 15..1800 seconds");
    if (!Number.isInteger(options.audioStreamIndex ?? 0) || (options.audioStreamIndex ?? 0) < 0) throw new RangeError("Invalid audio stream index");
    if (![options.minDuration ?? 15, options.maxDuration ?? 150].every(Number.isFinite) || (options.minDuration ?? 15) < 15 || (options.maxDuration ?? 150) > 150 || (options.minDuration ?? 15) > (options.maxDuration ?? 150)) throw new RangeError("interval durations must be within 15..150 seconds");
    if (!Number.isFinite(options.minimumSeasonFraction ?? 0.5) || (options.minimumSeasonFraction ?? 0.5) < 0.5 || (options.minimumSeasonFraction ?? 0.5) >= 1) throw new RangeError("minimumSeasonFraction must be >=0.5 and <1");
    if (!Number.isFinite(options.boundaryTolerance ?? 3) || (options.boundaryTolerance ?? 3) <= 0 || (options.boundaryTolerance ?? 3) > 30) throw new RangeError("boundaryTolerance must be >0 and <=30 seconds");
  }
  private async getRuntime(signal?: AbortSignal): Promise<Runtime> {
    signal?.throwIfAborted();
    if (this.runtime) return this.runtime;
    const ffmpeg = (await this.runner(this.options.ffmpegPath ?? "ffmpeg", ["-version"], { signal, maxBytes: 65536 })).toString().split("\n")[0];
    let backend: Runtime["backend"] = "spectrum", fpcalc: string | undefined;
    if (this.options.backend !== "spectrum") {
      try {
        fpcalc = (await this.runner(this.options.fpcalcPath ?? "fpcalc", ["-version"], { signal, maxBytes: 65536 })).toString().trim();
        backend = "chromaprint";
      } catch (error) {
        signal?.throwIfAborted();
        if (this.options.backend === "chromaprint") throw error;
      }
    }
    this.runtime = { backend, ffmpeg, fpcalc };
    return this.runtime;
  }
  private extractionConfig(runtime: Runtime): unknown {
    return { version: ANALYSIS_VERSION, front: this.front, tail: this.tail, audioStream: this.options.audioStreamIndex ?? 0, sampleRate: SAMPLE_RATE, runtime };
  }
  private async extract(path: string, offset: number, seconds: number, runtime: Runtime, signal?: AbortSignal): Promise<AudioFingerprint> {
    const pcm = await this.runner(this.options.ffmpegPath ?? "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-ss", offset.toFixed(6), "-i", path,
      "-t", seconds.toFixed(6), "-map", `0:a:${this.options.audioStreamIndex ?? 0}`, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
      { signal, maxBytes: Math.ceil((seconds + 1) * SAMPLE_RATE * 2), timeoutMs: this.options.processTimeoutMs ?? 60_000 });
    if (pcm.length / 2 / SAMPLE_RATE < Math.min(seconds - 1, 15)) throw new Error("Too little decoded audio");
    const spectrum = await fingerprintPcm(pcm, offset, signal);
    if (runtime.backend === "spectrum") return spectrum;
    // Stop slightly before PCM EOF: fpcalc 1.5.1 otherwise treats FFmpeg EOF as an error.
    const output = await this.runner(this.options.fpcalcPath ?? "fpcalc", ["-raw", "-json", "-algorithm", "2", "-format", "s16le", "-rate", String(SAMPLE_RATE), "-channels", "1", "-length", Math.max(1, spectrum.duration - 0.2).toFixed(6), "-"],
      { signal, input: pcm, maxBytes: 1024 * 1024, timeoutMs: this.options.processTimeoutMs ?? 60_000 });
    const result = JSON.parse(output.toString()) as { fingerprint?: number[] };
    if (!Array.isArray(result.fingerprint) || result.fingerprint.length === 0 || result.fingerprint.some(value => !Number.isInteger(value))) throw new Error("Invalid/empty fpcalc fingerprint");
    return { ...spectrum, backend: "chromaprint", step: CHROMAPRINT_STEP, hashes: encodeHashes(result.fingerprint) };
  }
  private async fingerprint(file: FileIdentity, runtime: Runtime, signal?: AbortSignal): Promise<{ value: EpisodeFingerprint; cached: boolean }> {
    const key = cacheKey("file-v1", [file, this.extractionConfig(runtime)]);
    const cached = await readCache<EpisodeFingerprint>(this.options.cache, key);
    if (cached?.version === ANALYSIS_VERSION && sameFile(cached.file, file)) return { value: cached, cached: true };
    const output = await this.runner(this.options.ffprobePath ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file.path], { signal, maxBytes: 65536, timeoutMs: this.options.processTimeoutMs ?? 60_000 });
    const duration = Number((JSON.parse(output.toString()) as { format?: { duration?: string } }).format?.duration);
    if (!Number.isFinite(duration) || duration < 30) throw new Error("Missing/invalid media duration");
    const intro = await this.extract(file.path, 0, Math.min(duration, this.front), runtime, signal);
    const tailOffset = Math.max(0, duration - this.tail);
    const credits = await this.extract(file.path, tailOffset, duration - tailOffset, runtime, signal);
    signal?.throwIfAborted();
    if (!sameFile(file, await identifyFile(file.path))) throw new Error("File changed during fingerprinting");
    const value: EpisodeFingerprint = { version: ANALYSIS_VERSION, file, duration, intro, credits };
    await this.options.cache?.set(key, { value });
    return { value, cached: false };
  }
  async analyzeSeason(episodes: readonly LocalEpisode[], context: AnalysisContext = {}): Promise<SeasonAnalysis> {
    const started = performance.now();
    context.signal?.throwIfAborted();
    if (new Set(episodes.map(episode => episode.id)).size !== episodes.length || new Set(episodes.map(episode => resolve(episode.path))).size !== episodes.length) throw new Error("Episode IDs and paths must be unique");
    const runtime = await this.getRuntime(context.signal);
    const identities = await Promise.all(episodes.map(async episode => {
      try { return { file: await identifyFile(episode.path) }; }
      catch (error) { return { file: { path: resolve(episode.path), size: 0, mtimeMs: 0 }, error: String(error) }; }
    }));
    const config = { extraction: this.extractionConfig(runtime), min: this.options.minDuration ?? 15, max: this.options.maxDuration ?? 150,
      fraction: this.options.minimumSeasonFraction ?? 0.5, tolerance: this.options.boundaryTolerance ?? 3 };
    const key = cacheKey("season-v1", [episodes.map((episode, i) => [episode.id, identities[i].file]), config]);
    const cached = await readCache<SeasonAnalysis>(this.options.cache, key);
    context.signal?.throwIfAborted();
    if (cached?.version === ANALYSIS_VERSION && !identities.some(identity => identity.error)) {
      context.onProgress?.({ phase: "complete", completed: episodes.length, total: episodes.length, ratio: 1, cached: true });
      return { ...cached, cached: true, elapsedMs: performance.now() - started };
    }
    let completed = 0;
    context.onProgress?.({ phase: "fingerprinting", completed, total: episodes.length, ratio: 0 });
    const controller = new AbortController();
    const workSignal = AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]);
    const pending = episodes.map((episode, i) => this.workers.use(workSignal, async () => {
      let value: EpisodeFingerprint | null = null, error = identities[i].error, reused = false;
      try {
        if (!error) { const result = await this.fingerprint(identities[i].file, runtime, workSignal); value = result.value; reused = result.cached; }
      } catch (failure) { workSignal.throwIfAborted(); error = failure instanceof Error ? failure.message : String(failure); }
      context.onProgress?.({ phase: "fingerprinting", completed: ++completed, total: episodes.length, ratio: episodes.length ? 0.65 * completed / episodes.length : 0.65, episodeId: episode.id, cached: reused });
      return { value, error };
    }).catch(error => { controller.abort(error); throw error; }));
    const settled = await Promise.allSettled(pending);
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failure) throw failure.reason;
    const fingerprints = settled.map(entry => (entry as PromiseFulfilledResult<{ value: EpisodeFingerprint | null; error?: string }>).value);
    const detected = await this.comparisons.use(context.signal, async () => {
      const intros = await detectCommonIntervals(fingerprints.map(fp => fp.value?.intro ?? null), this.options, { signal: context.signal,
        onPair: (done, total) => context.onProgress?.({ phase: "comparing-intros", completed: done, total, ratio: 0.65 + 0.17 * done / total }) });
      const credits = await detectCommonIntervals(fingerprints.map(fp => fp.value?.credits ?? null), this.options, { signal: context.signal,
        onPair: (done, total) => context.onProgress?.({ phase: "comparing-credits", completed: done, total, ratio: 0.82 + 0.17 * done / total }) });
      return { intros, credits };
    });
    context.signal?.throwIfAborted();
    // Revalidate every file before returning/persisting a season result.
    const results: EpisodeAnalysis[] = await Promise.all(episodes.map(async (episode, i) => {
      const fp = fingerprints[i];
      const duration = fp.value?.duration ?? 0;
      let error = fp.error;
      if (!error) try { if (!sameFile(identities[i].file, await identifyFile(episode.path))) error = "File changed during season analysis"; } catch (failure) { error = String(failure); }
      // Reject intervals whose missing start/end was clipped by an extraction window.
      const introValue = detected.intros[i];
      const creditsValue = detected.credits[i];
      const intro = !error && introValue && (duration <= this.front || introValue.end < this.front - 0.3) ? interval(introValue, duration) : null;
      const credits = !error && creditsValue && creditsValue.start > Math.max(0, duration - this.tail) + 0.3 ? interval(creditsValue, duration) : null;
      const markers = mergeMarkers(intro ? { introStart: intro.start, introEnd: intro.end, source: "fingerprint", confidence: intro.confidence } : null,
        credits ? { creditsStart: credits.start, creditsEnd: credits.end, source: "fingerprint", confidence: credits.confidence } : null);
      return { id: episode.id, file: identities[i].file, duration, markers, intro, credits,
        ...(error ? { reason: "file-error" as const, error } : markers ? {} : { reason: episodes.length < 3 ? "insufficient-episodes" as const : "no-common-audio" as const }) };
    }));
    context.signal?.throwIfAborted();
    const result: SeasonAnalysis = { version: ANALYSIS_VERSION, cacheKey: key, episodes: results, elapsedMs: performance.now() - started, cached: false, backend: runtime.backend };
    if (!results.some(episode => episode.error)) await this.options.cache?.set(key, { value: result });
    context.onProgress?.({ phase: "complete", completed: episodes.length, total: episodes.length, ratio: 1 });
    return result;
  }
}
