import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AudioSkipAnalyzer, ANALYSIS_VERSION } from "../../src/playback/skip-markers/analyzer.js";
import { MemoryCache } from "../../src/playback/skip-markers/cache.js";
import { runCommand, type CommandRunner } from "../../src/playback/skip-markers/process.js";
import { episodePcm, melody } from "./fixtures.js";

test("file/season cache invalidation on size and mtime, bounded workers, progress and missing fpcalc fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moa-skip-markers-test-"));
  try {
    const theme = melody(20, 1234);
    const episodes = Array.from({ length: 4 }, (_, i) => ({ id: String(i), path: join(directory, `${i}.mkv`) }));
    for (const episode of episodes) await writeFile(episode.path, "media-placeholder");
    let extractionCalls = 0, active = 0, maximum = 0;
    const runner: CommandRunner = async (command, args, options) => {
      options?.signal?.throwIfAborted();
      if (command === "fpcalc") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (args.includes("-version")) return Buffer.from("ffmpeg test version\n");
      if (command === "ffprobe") return Buffer.from('{"format":{"duration":"60"}}');
      extractionCalls++; active++; maximum = Math.max(maximum, active);
      try { await delay(5, undefined, { signal: options?.signal }); }
      finally { active--; }
      const index = Number(args[args.indexOf("-i") + 1].split("/").at(-1)!.replace(".mkv", ""));
      return episodePcm(60, 1500 + index, [{ start: 5 + index, signal: theme }]);
    };
    const analyzer = new AudioSkipAnalyzer({ cache: new MemoryCache(), commandRunner: runner, concurrency: 2, introWindowSeconds: 60, creditsWindowSeconds: 60 });
    const ratios: number[] = [];
    const first = await analyzer.analyzeSeason(episodes, { onProgress: progress => ratios.push(progress.ratio) });
    assert.equal(first.version, ANALYSIS_VERSION); assert.equal(first.backend, "spectrum"); assert.equal(first.cached, false);
    assert.ok(maximum <= 2); assert.equal(extractionCalls, 8);
    assert.ok(first.episodes.every(episode => episode.markers));
    assert.equal(ratios.at(-1), 1); assert.ok(ratios.every((value, i) => !i || value >= ratios[i - 1]));
    assert.equal((await analyzer.analyzeSeason(episodes)).cached, true); assert.equal(extractionCalls, 8);
    await writeFile(episodes[0].path, "changed file size");
    const second = await analyzer.analyzeSeason(episodes); assert.equal(second.cached, false); assert.equal(extractionCalls, 10);
    assert.notEqual(first.cacheKey, second.cacheKey);
    await utimes(episodes[0].path, new Date(), new Date(Date.now() + 5000));
    await analyzer.analyzeSeason(episodes); assert.equal(extractionCalls, 12);
    await assert.rejects(analyzer.analyzeSeason(episodes, { signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("corrupt files yield explicit errors without guessing or caching a transient season failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moa-skip-markers-error-"));
  try {
    const path = join(directory, "bad.mkv"); await writeFile(path, "bad");
    let probes = 0;
    const analyzer = new AudioSkipAnalyzer({ backend: "spectrum", cache: new MemoryCache(), commandRunner: async (_, args) => {
      if (args.includes("-version")) return Buffer.from("ffmpeg test");
      probes++; throw new Error("corrupt audio");
    } });
    const result = await analyzer.analyzeSeason([{ id: "bad", path }]);
    assert.equal(result.episodes[0].markers, null); assert.equal(result.episodes[0].reason, "file-error");
    await analyzer.analyzeSeason([{ id: "bad", path }]); assert.equal(probes, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("process runner reports failures, bounds output and terminates on cancellation", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stderr.write('bad');process.exit(2)"]), /exited 2: bad/);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stdout.write('too long')"], { maxBytes: 2 }), /output limit/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
});

test("window-clipped OP end and ED start remain undetected instead of guessed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moa-skip-markers-clipped-"));
  try {
    const op = melody(44, 7010), ed = melody(24, 7020);
    const episodes = Array.from({ length: 3 }, (_, i) => ({ id: String(i), path: join(directory, `${i}.mkv`) }));
    for (const episode of episodes) await writeFile(episode.path, "media");
    const pcm = episodes.map((_, i) => episodePcm(90, 7100 + i, [{ start: 12, signal: op }, { start: 60, signal: ed }]));
    const analyzer = new AudioSkipAnalyzer({ backend: "spectrum", introWindowSeconds: 30, creditsWindowSeconds: 30, commandRunner: async (command, args) => {
      if (args.includes("-version")) return Buffer.from("ffmpeg test");
      if (command === "ffprobe") return Buffer.from('{"format":{"duration":"90"}}');
      const index = Number(args[args.indexOf("-i") + 1].split("/").at(-1)!.replace(".mkv", ""));
      const start = Math.round(Number(args[args.indexOf("-ss") + 1]) * 11025) * 2;
      const length = Math.round(Number(args[args.indexOf("-t") + 1]) * 11025) * 2;
      return pcm[index].subarray(start, start + length);
    } });
    const result = await analyzer.analyzeSeason(episodes);
    assert.ok(result.episodes.every(episode => episode.markers === null && episode.reason === "no-common-audio"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("cancellation drains active and queued file jobs before analyzeSeason rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moa-skip-markers-cancel-"));
  try {
    const episodes = Array.from({ length: 4 }, (_, i) => ({ id: String(i), path: join(directory, `${i}.mkv`) }));
    for (const episode of episodes) await writeFile(episode.path, "media");
    let active = 0, calls = 0;
    const analyzer = new AudioSkipAnalyzer({ backend: "spectrum", concurrency: 1, commandRunner: async (_, args, options) => {
      if (args.includes("-version")) return Buffer.from("ffmpeg test");
      active++; calls++;
      try { await delay(1000, undefined, { signal: options?.signal }); return Buffer.from("{}"); }
      finally { active--; }
    } });
    const controller = new AbortController();
    const pending = analyzer.analyzeSeason(episodes, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(active, 0); assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
