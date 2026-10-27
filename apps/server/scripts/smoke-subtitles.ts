import { createSubtitleClient } from "../src/subtitles/korean/index.js";
import type { Diagnostic } from "../src/subtitles/korean/index.js";

const [title, rawSeason = "1", rawEpisode = "1", rawTimeout = "12000"] = process.argv.slice(2);
if (!title) throw new Error('Usage: smoke.ts <title> [season] [episode] [timeoutMs]');
const query = { title, season: Number(rawSeason), episode: Number(rawEpisode), timeoutMs: Number(rawTimeout) };
const diagnostics: Diagnostic[] = [];
const client = createSubtitleClient({ onDiagnostic: d => diagnostics.push(d) });
const start = performance.now();
const resolved = await client.resolveTitle(title, { season: query.season, timeoutMs: query.timeoutMs });
const resolutionMs = Math.round(performance.now() - start);
const discoveryStart = performance.now();
const creators = await client.listCreators(query);
const discoveryMs = Math.round(performance.now() - discoveryStart);
const searchStart = performance.now();
const candidates = await client.searchSubtitles(query);
const searchMs = Math.round(performance.now() - searchStart);
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), query, resolved, resolutionMs, discoveryMs, searchMs,
  totalMs: Math.round(performance.now() - start),
  creators: creators.map(c => ({ name: c.name, latestEpisode: c.latestEpisode, source: c.source, website: c.website })),
  candidates: candidates.map(({ content, ...candidate }) => ({ ...candidate, bytes: Buffer.byteLength(content), koreanText: /[가-힣]/.test(content) })),
  diagnostics,
}, null, 2));
process.exitCode = candidates.length ? 0 : 1;
