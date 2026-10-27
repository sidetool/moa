import assert from "node:assert/strict";
import test from "node:test";
import { AniSkipClient, SkipApiError, parseSeason, scoreAnimeMatch, type AniListMedia } from "../../src/playback/skip-markers/aniskip.js";
import { MemoryCache } from "../../src/playback/skip-markers/cache.js";
import { mergeMarkers } from "../../src/playback/skip-markers/merge.js";
const media = (id: number, title: string, format = "TV"): AniListMedia => ({ id, idMal: id, title: { romaji: title }, format });
test("title, season, and movie format matching reject unrelated/mismatched series", () => {
  assert.equal(parseSeason("구름 정원 2기"), 2);
  assert.equal(parseSeason("Example TV S2"), 2);
  assert.equal(parseSeason("Example TV 2nd Season"), 2);
  const query = { title: "Example TV", season: 2 };
  assert.ok(scoreAnimeMatch(media(1, "Example TV 2nd Season"), query) > scoreAnimeMatch(media(2, "Example TV"), query));
  assert.ok(scoreAnimeMatch(media(1, "Example TV 2nd Season"), query) > scoreAnimeMatch(media(2, "Example TV 2nd Season", "MOVIE"), query));
  assert.equal(scoreAnimeMatch(media(3, "Totally Unrelated"), query), -Infinity);
  assert.ok(scoreAnimeMatch(media(4, "Example", "MOVIE"), { title: "Example", format: "MOVIE" }) > scoreAnimeMatch(media(5, "Example"), { title: "Example", format: "MOVIE" }));
});
test("AniList variables, AniSkip duration and types, injected cache and negative caching", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = new AniSkipClient({ cache: new MemoryCache(), fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    return Response.json(url.includes("anilist") ? { data: { Page: { media: [media(9001, 'Example TV 2nd Season'), media(100, 'Example TV'), media(999, 'Unrelated')] } } } : {
      found: true, results: [{ skipType: "op", interval: { startTime: 0, endTime: 63 } }, { skipType: "ed", interval: { startTime: 1177, endTime: 1224 } }, { skipType: "op", interval: { startTime: 0, endTime: 63 } }, { skipType: "op", interval: { startTime: NaN, endTime: 2000 } }],
    });
  }) as typeof fetch });
  const query = { title: 'Example TV " 2nd Season', season: 2, episodeNumber: 1, episodeLength: 1440 };
  const result = await client.lookup(query);
  assert.equal(result.match?.malId, 9001);
  assert.deepEqual(result.intervals.map(i => [i.type, i.start, i.end]), [["op", 0, 63], ["ed", 1177, 1224]]);
  assert.equal(result.markers?.introStart, 0);
  assert.equal(requests.length, 2);
  const params = new URL(requests[1].url).searchParams;
  assert.equal(params.get("episodeLength"), "1440.000"); assert.deepEqual(params.getAll("types[]"), ["op", "ed"]);
  assert.equal(JSON.parse(requests[0].init!.body as string).variables.search, query.title);
  await client.lookup(query); assert.equal(requests.length, 2);
  await client.getSkipTimes(9001, 1, 1450); assert.equal(requests.length, 3);
  let misses = 0;
  const missing = new AniSkipClient({ cache: new MemoryCache(), fetch: (async () => { misses++; return Response.json({ found: false }, { status: 404 }); }) as typeof fetch });
  assert.deepEqual(await missing.getSkipTimes(1, 1, 100), []);
  assert.deepEqual(await missing.getSkipTimes(1, 1, 100), []); assert.equal(misses, 1);
});
test("transient errors and malformed responses are not cached, abortion propagates", async () => {
  let calls = 0;
  const client = new AniSkipClient({ cache: new MemoryCache(), fetch: (async () => { calls++; return new Response("error", { status: 429 }); }) as typeof fetch });
  await assert.rejects(client.getSkipTimes(1, 1, 1400), SkipApiError);
  await assert.rejects(client.getSkipTimes(1, 1, 1400), SkipApiError); assert.equal(calls, 2);
  await assert.rejects(client.getSkipTimes(1, 1, 1400, AbortSignal.abort()), { name: "AbortError" });
  const bad = new AniSkipClient({ fetch: (async () => Response.json({ found: true })) as typeof fetch });
  await assert.rejects(bad.getSkipTimes(1, 1, 1400), SkipApiError);
});
test("ambiguous AniList candidates and incorrect season return no match", async () => {
  const client = (items: AniListMedia[]) => new AniSkipClient({ fetch: (async () => Response.json({ data: { Page: { media: items } } })) as typeof fetch });
  assert.equal(await client([media(1, "Example"), media(2, "Example")]).findAnime({ title: "Example" }), null);
  assert.equal(await client([media(1, "Example")]).findAnime({ title: "Example", season: 2 }), null);
  assert.equal(await client([media(1, "Example", "MOVIE")]).findAnime({ title: "Example", format: "TV" }), null);
});
test("merge is interval-atomic, uses manual > fingerprint > AniSkip and preserves zero", () => {
  const result = mergeMarkers(
    { introStart: 5, introEnd: 95, creditsStart: 1300, source: "aniskip", confidence: 0.75 },
    { introStart: 6, introEnd: 96, source: "fingerprint", confidence: 0.96 },
    { introStart: 0, introEnd: 90, source: "manual", confidence: 1 },
  );
  assert.deepEqual(result, { introStart: 0, introEnd: 90, creditsStart: 1300, source: "manual", confidence: 0.75, provenance: { intro: "manual", credits: "aniskip" } });
  const again = mergeMarkers(result, { creditsStart: 1302, creditsEnd: 1392, source: "fingerprint", confidence: 0.98 });
  assert.equal(again?.creditsStart, 1302); assert.equal(again?.provenance?.credits, "fingerprint");
  assert.equal(again?.introStart, 0);
  assert.equal(mergeMarkers(null, undefined), null);
  assert.equal(mergeMarkers({ introStart: 0, source: "manual", confidence: 1 }), null);
});
