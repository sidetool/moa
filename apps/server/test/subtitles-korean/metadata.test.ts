import test from "node:test";
import assert from "node:assert/strict";
import { MetadataClient } from "../../src/subtitles/korean/metadata.js";
import { aliases } from "./fixtures/synthetic.js";
import { PublicHttpClient, type HttpResponse } from "../../src/subtitles/korean/http.js";

function offlineHttp(fn: (url: string, body?: string) => unknown): PublicHttpClient {
  const http = new PublicHttpClient();
  http.get = async (url, options): Promise<HttpResponse> => ({ url, status: 200, headers: {}, body: Buffer.from(JSON.stringify(fn(url, options.body))) });
  return http;
}

test("Anissia selects the exact season and latest episode compares numerically", async () => {
  const metadata = new MetadataClient(offlineHttp(url => {
    if (url.includes("/anime/list/")) return { code: "ok", data: { content: [
      { animeNo: 1, subject: "구름 정원", originalSubject: "雲の庭" },
      { animeNo: 2, subject: "구름 정원 2기", originalSubject: "【雲の庭】第2期" },
      { animeNo: 3, subject: "구름 정원 3기", originalSubject: "雲の庭 第3期" },
    ], last: true } };
    assert.ok(url.endsWith("/caption/animeNo/2"));
    return { code: "ok", data: [
      { name: "숫자 확인", episode: "13", updDt: "2024-01-01T12:00:00", website: "https://public.example/post" },
      { name: "정확한 화", episode: "14", updDt: "2024-01-01T12:00:00", website: "https://public.example/post2" },
    ] };
  }), aliases);
  const signal = new AbortController().signal;
  const resolved = await metadata.resolve("Example TV", 2, signal);
  const creators = await metadata.creators(resolved, 3, signal);
  assert.equal(creators[0]?.isCurrentEpisode, false);
  assert.equal(creators[1]?.isCurrentEpisode, true);
  assert.equal(creators[0]?.updatedAt, "2024-01-01T12:00:00+09:00");
});

test("Japanese originalSubject resolves through schedules without requiring a local alias", async () => {
  const metadata = new MetadataClient(offlineHttp(url => {
    assert.ok(url.includes("schedule"));
    return { code: "ok", data: [{ animeNo: 9, subject: "작은 시험 애니메이션 2기", originalSubject: "小さなテストアニメ 第2期" }] };
  }), [], false);
  const title = await metadata.resolve("小さなテストアニメ 第2期", undefined, new AbortController().signal);
  assert.equal(title.title, "작은 시험 애니메이션 2기");
  assert.equal(title.source, "anissia");
});

test("AniList maps unknown English/Romaji to native title before Anissia matching", async () => {
  let aniListCalls = 0;
  const metadata = new MetadataClient(offlineHttp((url, body) => {
    if (url.includes("graphql.anilist.co")) {
      aniListCalls++;
      assert.equal(JSON.parse(body!).variables.search, "Tiny Fixture Anime");
      return { data: { Page: { media: [{ title: { english: "Tiny Fixture Anime", romaji: "Chiisana Fixture", native: "小さな試験" }, synonyms: [] }] } } };
    }
    return { code: "ok", data: [{ animeNo: 10, subject: "작은 픽스처 작품", originalSubject: "小さな試験" }] };
  }));
  const title = await metadata.resolve("Tiny Fixture Anime", undefined, new AbortController().signal);
  assert.equal(aniListCalls, 1);
  assert.equal(title.title, "작은 픽스처 작품");
  assert.equal(title.source, "anilist");
});

test('TMDB Korean title and Japanese original reach Anissia without losing season', async () => {
  const queries: string[] = [];
  const metadata = new MetadataClient(offlineHttp(url => {
    const u = new URL(url);
    if (u.searchParams.has('q')) queries.push(u.searchParams.get('q')!);
    return {code:'ok',data:{content:[],last:true}};
  }),aliases,false);
  const signal = new AbortController().signal;
  const resolved = await metadata.resolve('숲의 여행',2,signal,['森の旅']);
  await metadata.creators(resolved,1,signal);
  assert.deepEqual(queries,['숲의 여행','森の旅','Forest Journey']);
  assert.equal(resolved.season,2);
});

// Authored synthetic metadata responses; no recorded API data or network in tests.
import synthetic from './fixtures/anissia-anime-v2.json' with { type: 'json' };
test('synthetic Anissia arc labels and explicit seasons match only their release season', async () => {
  const metadata = new MetadataClient(offlineHttp(url => ({ code: 'ok', data: { content: synthetic[new URL(url).searchParams.get('q') as keyof typeof synthetic] ?? [], last: true } })), [], false);
  const signal = new AbortController().signal;
  for (const [title, season, id] of [['별빛 학교',1,9001],['별빛 학교',2,9002],['별빛 학교',3,9003],['하늘 탐험대',2,9022],['하늘 탐험대',3,9023],['하늘 탐험대',4,9024],['숲의 여행',1,9010]] as const) {
    assert.equal((await metadata.lookup([title],season,signal))?.animeNo,id);
  }
  assert.equal(await metadata.lookup(['하늘 탐험대'],1,signal),undefined, 'do not select OAD/movie/specials in place of absent season 1');
});

test('AniList synonyms survive resolution and ambiguous exact identities are rejected', async () => {
  const metadata = new MetadataClient(offlineHttp(url => url.includes('graphql') ? {data:{Page:{media:[{title:{english:'Fixture Anime',native:'試験'},synonyms:['시험 작품']}]}}} : {code:'ok',data:[]}), [], true);
  const resolved = await metadata.resolve('Fixture Anime',1,new AbortController().signal);
  assert.ok(resolved.aliases?.includes('시험 작품'));
  const duplicate = new MetadataClient(offlineHttp(() => ({code:'ok',data:{content:[{animeNo:1,subject:'시험 작품'},{animeNo:2,subject:'시험 작품'}]}})),[],false);
  assert.equal(await duplicate.lookup(['시험 작품'],1,new AbortController().signal),undefined);
});

test('verified Anissia arc titles are passed to article matching as complete aliases',async()=>{
  const subject='가상 작품 2기 「두 번째 이야기」';
  const metadata=new MetadataClient(offlineHttp(url=>url.includes('/anime/list/')?{code:'ok',data:{content:[{animeNo:123,subject,originalSubject:'Fixture Season 2'}],last:true}}:{code:'ok',data:[{name:'Maker',website:'https://public.example/post',episode:1}]}),[],false);
  const signal=new AbortController().signal;
  const creators=await metadata.creators(await metadata.resolve('가상 작품 2기',2,signal),1,signal);
  assert.ok(creators[0]?.aliases?.includes(subject));
});

// The production parser currently limits named Final Season handling to this title.
// All response fields and identifiers here are authored solely for this branch check.
test('named Final Season does not accept a completion special in its place', async () => {
  const metadata = new MetadataClient(offlineHttp(() => ({ code: 'ok', data: { content: [
    { animeNo: 9901, subject: '진격의 거인 The Final Season', originalSubject: '' },
    { animeNo: 9902, subject: '진격의 거인 The Final Season 완결편', originalSubject: '' },
  ], last: true } })), [], false);
  assert.equal((await metadata.lookup(['진격의 거인'], 4, new AbortController().signal))?.animeNo, 9901);
});
