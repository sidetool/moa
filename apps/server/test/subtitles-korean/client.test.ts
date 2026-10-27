import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateCandidates } from "../../src/subtitles/korean/index.js";
import { createOfflineSubtitleClient as createSubtitleClient } from "./fixtures/synthetic.js";
import type { SubtitleCache, SubtitleCandidate, SubtitleCreator } from "../../src/subtitles/korean/index.js";

const candidate: SubtitleCandidate = { id: "result", creatorId: "fast", creatorName: "빠른 제작자", sourceUrl: "https://public.example/post",
  format: "vtt", content: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n반가워요\n", filename: "03.vtt",
  episode: 3, matchedEpisode: 3, title: "구름 정원 2기", season: 2, confidence: 0.9 };
const creator = (name: string): SubtitleCreator => ({ id: name, name, website: "https://public.example", source: "anissia",
  title: "구름 정원 2기", season: 2, episodeOffset: 11, isCurrentEpisode: true, confidence: 0.9 });

function offline(client: ReturnType<typeof createSubtitleClient>) {
  return client as unknown as { metadata: { creators: (...args: any[]) => Promise<SubtitleCreator[]> }; collector: { collect: (creator: SubtitleCreator, episode: number, signal: AbortSignal) => Promise<SubtitleCandidate | null>; discover: (...args: any[]) => Promise<SubtitleCandidate[]> } };
}

test("global deadline returns completed results and cancels slower work", async () => {
  const client = createSubtitleClient({ enableKairan: false, enableCsora: false, enableMelody: false });
  const internal = offline(client);
  internal.metadata.creators = async () => [creator("fast"), creator("slow")];
  let slowAborted = false;
  internal.collector.collect = async (c, _episode, signal) => {
    if (c.name === "fast") return { ...candidate };
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { slowAborted = true; reject(signal.reason); }, { once: true }));
  };
  const start = performance.now();
  const results = await client.searchSubtitles({ title: "Example TV", season: 2, episode: 3, timeoutMs: 60 });
  assert.equal(results.length, 1);
  assert.ok(performance.now() - start < 500);
  assert.equal(slowAborted, true);
});

test("positive cache hits bypass sources; cache errors and hangs stay bounded", async () => {
  let writes = 0, reads = 0, fetches = 0;
  let stored: Awaited<ReturnType<SubtitleCache["get"]>>;
  const cache: SubtitleCache = { get: async () => { reads++; return stored; }, set: async (_key, entry) => { writes++; stored = entry; } };
  const client = createSubtitleClient({ cache, enableKairan: false, enableCsora: false, enableMelody: false });
  const internal = offline(client);
  internal.metadata.creators = async () => [creator("fast")];
  internal.collector.collect = async () => { fetches++; return { ...candidate }; };
  const query = { title: "Example TV", season: 2, episode: 3 };
  assert.equal((await client.searchSubtitles(query)).length, 1);
  assert.equal((await client.searchSubtitles(query)).length, 1);
  assert.equal(reads, 2); assert.equal(writes, 1); assert.equal(fetches, 1);
  const hung = createSubtitleClient({ enableKairan: false, enableCsora: false, enableMelody: false, cache: { get: () => new Promise(() => {}), set: async () => {} } });
  const start = performance.now();
  assert.deepEqual(await hung.searchSubtitles({ ...query, timeoutMs: 30 }), []);
  assert.ok(performance.now() - start < 500);
});

test("expired/empty failures and globally timed-out partial searches are not cached", async () => {
  let writes = 0;
  const cache: SubtitleCache = { get: async () => ({ expiresAt: 0, value: [candidate] }), set: async () => { writes++; } };
  const client = createSubtitleClient({ cache, enableKairan: false, enableCsora: false, enableMelody: false });
  const internal = offline(client);
  internal.metadata.creators = async () => [creator("none")];
  internal.collector.collect = async () => null;
  assert.deepEqual(await client.searchSubtitles({ title: "Example TV", season: 2, episode: 3 }), []);
  internal.metadata.creators = async () => [creator("fast"), creator("slow")];
  internal.collector.collect = async (c, _ep, signal) => c.name === "fast" ? { ...candidate } : new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  assert.equal((await client.searchSubtitles({ title: "Example TV", season: 2, episode: 3, timeoutMs: 30 })).length, 1);
  assert.equal(writes, 0);
});

test("duplicate creator/episode keeps the highest confidence and inputs validate", async () => {
  assert.equal(deduplicateCandidates([candidate, { ...candidate, id: "better", confidence: 0.95 }])[0]?.id, "better");
  const client = createSubtitleClient({ enableKairan: false, enableCsora: false, enableMelody: false, onDiagnostic: () => { throw new Error("observer"); } });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await client.searchSubtitles({ title: "Example TV", episode: 3, signal: controller.signal }), []);
  await assert.rejects(client.searchSubtitles({ title: "Example TV", episode: NaN }));
  await assert.rejects(client.searchSubtitles({ title: "Example TV", episode: 1, episodeOffset: -1 }));
  assert.throws(() => createSubtitleClient({ concurrency: 0 }));
});

test('Anissia Naver history is searched even when the same creator has a Blogger archive', async () => {
  const client = createSubtitleClient({enableCsora:false,enableMelody:false});
  const internal = offline(client), sites: string[] = [];
  internal.metadata.creators = async () => [{...creator('Example Creator A'),website:'https://blog.naver.com/example_creator/123'}];
  internal.collector.collect = async c => { sites.push(c.website); return c.website.includes('naver.com') ? {...candidate,creatorName:'Example Creator A'} : null; };
  assert.equal((await client.searchSubtitles({title:'별빛 학교',episode:1})).length,1);
  assert.ok(sites.some(site=>site.includes('example-creator-a.blogspot.com')));
  assert.ok(sites.some(site=>site.includes('naver.com')));
});

test('Second archive is independently enabled and returned candidates retain attribution', async () => {
  const client = createSubtitleClient({enableKairan:false,enableMelody:false});
  const internal = offline(client);
  internal.metadata.creators = async () => [];
  internal.collector.collect = async c => { assert.equal(c.website,'https://example-creator-b.blogspot.com/'); return {...candidate,creatorName:c.name}; };
  assert.equal((await client.searchSubtitles({title:'별빛 학교',episode:1}))[0]?.creatorName,'Example Creator B');
});


test('Legacy archive is independently enabled with verified alternate names and source attribution', async () => {
  const client = createSubtitleClient({enableKairan:false,enableCsora:false});
  const internal = offline(client);
  internal.metadata.creators = async () => [];
  internal.collector.collect = async c => {
    assert.equal(c.website,'https://example-legacy.tistory.com/');
    assert.ok(c.aliases?.includes('Verified Alternative'));
    assert.equal(c.season,1);
    return {...candidate,creatorName:c.name,sourceUrl:c.website+'example'};
  };
  const result=await client.searchSubtitles({title:'가상의 작품 1기',season:1,episode:3,aliases:['Verified Alternative']});
  assert.equal(result[0]?.creatorName,'Example Legacy Creator');
  assert.equal(result[0]?.sourceUrl,'https://example-legacy.tistory.com/example');
});

test('successful existing providers never wait for or request the legacy archive', async () => {
  const client=createSubtitleClient(); const internal=offline(client), names:string[]=[];
  internal.metadata.creators=async()=>[];
  internal.collector.collect=async c=>{names.push(c.name);if(c.name==='Example Legacy Creator') throw new Error('unexpected fallback');return c.name==='Example Creator A'?{...candidate}:null;};
  assert.equal((await client.searchSubtitles({title:'가상 작품',episode:3})).length,1);
  assert.ok(!names.includes('Example Legacy Creator'));
});

test('public discovery only runs after existing sources miss and shares the global deadline', async () => {
  const client = createSubtitleClient(), internal = offline(client), calls: string[] = [];
  internal.metadata.creators = async () => [];
  internal.collector.collect = async c => { calls.push(c.name); return null; };
  internal.collector.discover = async () => { calls.push('discovery'); return [{ ...candidate }]; };
  assert.equal((await client.searchSubtitles({ title: '구름 정원', episode: 3 })).length, 1);
  assert.equal(calls.at(-1), 'discovery');
  assert.equal(calls.filter(name => name === 'Example Creator A').length, 2);
  calls.length = 0;
  internal.collector.collect = async () => ({ ...candidate });
  assert.equal((await client.searchSubtitles({ title: '구름 정원', episode: 3 })).length, 1);
  assert.deepEqual(calls, []);
  internal.collector.collect = async () => null;
  let aborted = false;
  internal.collector.discover = async (_title, _episode, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  const start = performance.now();
  assert.deepEqual(await client.searchSubtitles({ title: '구름 정원', episode: 3, timeoutMs: 30 }), []);
  assert.equal(aborted, true);
  assert.ok(performance.now() - start < 500);
});
