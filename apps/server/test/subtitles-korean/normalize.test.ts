import test from "node:test";
import assert from "node:assert/strict";
import { aliases } from "./fixtures/synthetic.js";
import { createSubtitleClient, normalizeTitle, parseSeason, parseEpisodes } from "../../src/subtitles/korean/index.js";

test("season spellings and release filenames normalize consistently", () => {
  for (const token of ["S2", "Season 2", "2nd Season", "2기", "第2期", "Ⅱ", "II", "2th"]) assert.equal(parseSeason(`Example TV ${token}`), 2, token);
  assert.deepEqual(normalizeTitle("[Group] Example.TV.S02E03 [1080p].mkv"), { baseTitle: "Example TV", season: 2 });
  assert.deepEqual(normalizeTitle("【雲の庭】第2期"), { baseTitle: "雲の庭", season: 2 });
  assert.equal(parseSeason("Robot No. 8"), undefined);
  assert.equal(parseSeason("86"), undefined);
  assert.equal(normalizeTitle("Example TV S3", 2).season, 2);
  assert.throws(() => normalizeTitle(" "));
  assert.throws(() => normalizeTitle("Title", 0));
});

test("aliases are local, extensible, and preserve season", async () => {
  const client = createSubtitleClient({ aliases: [...aliases, { korean: "작은 시험 작품", aliases: ["Little Test"] }] });
  for (const title of ["Example TV", "雲の庭", "예제", "구름정원"]) assert.equal(await client.resolveKoreanTitle(title, { season: 2 }), "구름 정원 2기");
  assert.equal(await client.resolveKoreanTitle("Little Test Season 2"), "작은 시험 작품 2기");
  assert.equal((await client.resolveTitle("Example TV", { season: 2 })).episodeOffset, 11);
});

test("episode matching is numeric and does not confuse season, title or quality", () => {
  assert.deepEqual(parseEpisodes("작품 S02E03.ass"), [3]);
  assert.deepEqual(parseEpisodes("작품 2기 03화.zip"), [3]);
  assert.deepEqual(parseEpisodes("작품 1-3화.zip"), [1, 2, 3]);
  assert.deepEqual(parseEpisodes("작품 01~03.zip"), [1, 2, 3]);
  assert.deepEqual(parseEpisodes("작품 12.5화"), [12.5]);
  assert.deepEqual(parseEpisodes("[Group] Example TV - 14 [1080p].ass"), [14]);
  assert.deepEqual(parseEpisodes("로봇 8호.ass"), []);
  assert.deepEqual(parseEpisodes("작품 S2 [1080p].ass"), []);
  assert.equal(parseEpisodes("작품 13화").includes(3), false);
});
