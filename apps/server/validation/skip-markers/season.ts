import { tmpdir } from 'node:os';
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { AniSkipClient, AudioSkipAnalyzer, runCommand, type CacheEntry, type CacheStore } from "../../src/playback/skip-markers/index.js";

const mediaDirectory = process.env.MOA_TEST_MEDIA;
if (!mediaDirectory) throw new Error("Set MOA_TEST_MEDIA to a directory of generated videos");
const outputDirectory = process.env.MOA_TEST_OUTPUT ?? join(tmpdir(), "skip-marker-verification");
class FileCache implements CacheStore {
  async get(key: string): Promise<CacheEntry | undefined> {
    try { return JSON.parse(await readFile(join(outputDirectory, "cache", `${key.replaceAll(":", "_")}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async set(key: string, entry: CacheEntry): Promise<void> {
    await mkdir(join(outputDirectory, "cache"), { recursive: true });
    await writeFile(join(outputDirectory, "cache", `${key.replaceAll(":", "_")}.json`), JSON.stringify(entry));
  }
}
const cache = new FileCache();
const episodes = (await readdir(mediaDirectory)).filter(name => name.endsWith(".mkv")).sort().map(name => ({
  id: name.match(/(?:S\d+E| - )(\d+)/i)?.[1] ?? name, episodeNumber: Number(name.match(/(?:S\d+E| - )(\d+)/i)?.[1]), path: join(mediaDirectory, name),
}));
const backend = process.env.MOA_TEST_BACKEND === "spectrum" ? "spectrum" : "auto";
const analyzer = new AudioSkipAnalyzer({ cache: process.env.MOA_TEST_COLD ? undefined : cache, concurrency: 2, backend });
let lastPhase = "", last = 0;
const started = performance.now();
const analysis = await analyzer.analyzeSeason(episodes, { onProgress: progress => {
  if (progress.phase !== lastPhase || performance.now() - last > 3000 || progress.phase === "complete") {
    console.log(`${(performance.now() - started).toFixed(0)}ms ${progress.phase} ${progress.completed}/${progress.total} ${(progress.ratio * 100).toFixed(1)}% ${progress.episodeId ?? ""}`);
    lastPhase = progress.phase; last = performance.now();
  }
} });
console.log(JSON.stringify(analysis, null, 2));
await mkdir(outputDirectory, { recursive: true });
const analysisPath = join(outputDirectory, `analysis-${backend}.json`);
await writeFile(analysisPath, JSON.stringify(analysis, null, 2) + "\n");
const warmStart = performance.now();
const warm = process.env.MOA_TEST_COLD ? null : await analyzer.analyzeSeason(episodes);
const warmMs = performance.now() - warmStart;
const versions = await Promise.all([runCommand("node", ["--version"]), runCommand("ffmpeg", ["-version"]), runCommand("fpcalc", ["-version"])]);
const ani = new AniSkipClient({ cache });
const comparison: unknown[] = [];
let match: Awaited<ReturnType<typeof ani.findAnime>> | null = null;
if (process.env.MOA_TEST_TITLE) {
  try {
    match = await ani.findAnime({ title: process.env.MOA_TEST_TITLE, season: Number(process.env.MOA_TEST_SEASON || 1) });
    console.log("AniList", match);
    if (match) for (const episode of episodes) {
      const local = analysis.episodes.find(value => value.id === episode.id)!;
      try {
        const intervals = await ani.getSkipTimes(match.malId, episode.episodeNumber, local.duration);
        comparison.push({ episode: episode.episodeNumber, file: basename(episode.path), duration: local.duration, detected: local.markers, intervals });
      } catch (error) { comparison.push({ episode: episode.episodeNumber, error: String(error) }); }
    }
  } catch (error) { comparison.push({ lookupError: String(error) }); }
}
const report = { generatedAt: new Date().toISOString(), backend: analysis.backend, versions: versions.map(output => output.toString().split("\n")[0]),
  elapsedMs: analysis.elapsedMs, cached: analysis.cached, warmMs: warm ? warmMs : null, warmAnalysisMs: warm?.elapsedMs,
  match, analysis, comparison };
await writeFile(join(outputDirectory, `report-${backend}.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(comparison, null, 2));
