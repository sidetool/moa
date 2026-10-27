import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { convertSubtitle, toVtt, decodeSubtitleBuffer, detectSubtitleEncoding } from "../../src/subtitles/korean/index.js";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("UTF-8, CP949/EUC-KR and UTF-16 BOM/endian detection preserves Korean", () => {
  const text = fixture("sample.srt");
  for (const encoding of ["utf8", "cp949", "euc-kr", "utf16le", "utf16be"]) {
    const input = iconv.encode(text, encoding);
    assert.equal(decodeSubtitleBuffer(input), text, encoding);
  }
  for (const [encoding, bom] of [["utf16le", [255, 254]], ["utf16be", [254, 255]]] as const) {
    assert.equal(decodeSubtitleBuffer(Buffer.concat([Buffer.from(bom), iconv.encode(text, encoding)])), text);
  }
  const cp = iconv.encode("뷁 쀍 안녕하세요", "cp949");
  assert.equal(detectSubtitleEncoding(cp), "cp949");
  assert.equal(decodeSubtitleBuffer(cp), "뷁 쀍 안녕하세요");
  assert.equal(decodeSubtitleBuffer(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)])), text);
  const japanese = '｢日本語の字幕｣ → ★';
  assert.equal(decodeSubtitleBuffer(iconv.encode(japanese, 'shift_jis'), 'shift_jis'), japanese);
  assert.equal(decodeSubtitleBuffer(Buffer.from(text), 'unknown-charset'), text);
});

test("SRT becomes valid VTT with milliseconds, multiple lines and escaped entities", () => {
  const vtt = toVtt(fixture("sample.srt"), ".SRT");
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.includes("00:00:01.200 --> 00:00:03.450\n안녕하세요.\n오늘도 반가워요 &amp; 잘 부탁해요."));
  assert.equal((vtt.match(/-->/g) ?? []).length, 2);
  assert.ok(!vtt.includes("<i>"));
  assert.throws(() => toVtt("<html>login</html>", "srt"));
  assert.throws(() => toVtt("1\n00:00:05,000 --> 00:00:02,000\n안녕", "srt"));
});

test("SMI selects Korean, honors explicit clear cues and retains the final sync", () => {
  const vtt = toVtt(fixture("sample.smi"), "smi");
  assert.ok(vtt.includes("00:00:01.200 --> 00:00:03.450\n안녕하세요.\n두 줄입니다."));
  assert.ok(vtt.includes("00:00:04.000 --> 00:00:09.000\n마지막 대사 &lt;확인&gt;"));
  assert.ok(!vtt.includes("English"));
  assert.equal((vtt.match(/-->/g) ?? []).length, 2);
  assert.ok(toVtt("<SYNC Start=0><P>첫 대사<SYNC Start=20000><P>&nbsp;", "smi").includes("00:00:00.000 --> 00:00:20.000"));
});

test("ASS is kept verbatim and native VTT cue settings survive", () => {
  const ass = fixture("sample.ass");
  assert.deepEqual(convertSubtitle(ass, "ass"), { format: "ass", content: ass });
  assert.throws(() => toVtt(ass, "ass"), /kept as ASS/);
  const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\n<i>안녕</i>\n";
  assert.equal(toVtt(vtt, "vtt"), vtt);
  assert.throws(() => convertSubtitle("<!DOCTYPE html><html><body>로그인</body></html>"));
});
