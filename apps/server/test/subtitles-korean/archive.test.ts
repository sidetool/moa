import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { extractSubtitleBuffer, safeZipPath } from "../../src/subtitles/korean/index.js";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));

test("multi-file ZIP selects the requested episode and preserves ASS", async () => {
  const result = await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, season: 2 });
  assert.equal(result?.filename, "작품 S02E03.ass");
  assert.equal(result?.format, "ass");
  assert.ok(result?.content.includes("반가워요"));
  assert.equal(result?.matchedEpisode, 3);
  assert.equal(await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 9, season: 2 }), null);
});

test("absolute episode mapping and CP949 ZIP filenames", async () => {
  const absolute = await extractSubtitleBuffer(fixture("absolute.zip"), "batch.zip", { episode: 3, alternateEpisode: 14, season: 2 });
  assert.equal(absolute?.matchedEpisode, 14);
  const legacy = await extractSubtitleBuffer(fixture("cp949.zip"), "batch.zip", { episode: 3 });
  assert.equal(legacy?.filename, "예제 03.ass");
  assert.equal(await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 1, alternateEpisode: 3, season: 2 }), null);
});

test("path traversal and symlinks are ignored; archives never write to disk", async () => {
  for (const name of ["../03.ass", "/03.ass", "C:\\03.ass", "a/../../03.ass", "a\\..\\03.ass", "bad\0.ass"]) assert.equal(safeZipPath(name), false);
  const result = await extractSubtitleBuffer(fixture("unsafe.zip"), "batch.zip", { episode: 3 });
  assert.equal(result?.filename, "safe 03.ass");
});

test("ZIP size, count, bomb and forged size protections", async () => {
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, maxZipBytes: 10 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, maxEntries: 1 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("bomb.zip"), "batch.zip", { episode: 3 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("forged.zip"), "batch.zip", { episode: 3, maxZipBytes: 4096 }));
});

test("unnumbered singleton needs a confirmed post, contradictory singleton is rejected", async () => {
  const raw = fixture("sample.ass");
  assert.equal(await extractSubtitleBuffer(raw, "other 13.ass", { episode: 3, allowUnnumbered: true }), null);
  assert.equal(await extractSubtitleBuffer(raw, "download", { episode: 3 }), null);
  assert.equal((await extractSubtitleBuffer(raw, "download", { episode: 3, allowUnnumbered: true }))?.format, "ass");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, signal: controller.signal }));
});

test('a range-named subtitle cannot masquerade as one episode', async () => {
  assert.equal(await extractSubtitleBuffer(fixture('sample.ass'),'작품 1~25.ass',{episode:1,allowUnnumbered:true}),null);
});

// A stored ZIP is sufficient to exercise real yauzl selection without a new binary fixture.
function syntheticZip(entries: Array<[string, Buffer]>) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [filename, data] of entries) {
    const name = Buffer.from(filename), checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

test('direct subtitle files and real ZIP members share all three release-name improvements', async () => {
  const raw = fixture('sample.ass');
  for (const name of ['Example TV [03].ass', 'Example TV - 03Group.ass', 'Example_TV_03_1080p_x264.ass']) {
    const direct = await extractSubtitleBuffer(raw, name, { episode: 3, season: 1 });
    assert.equal(direct?.matchedEpisode, 3, name);
    const zip = syntheticZip([[name, raw], ['Example TV [04].ass', raw]]);
    const archive = await extractSubtitleBuffer(zip, 'batch.zip', { episode: 3, season: 1 });
    assert.equal(archive?.filename, name, name); assert.equal(archive?.matchedEpisode, 3, name);
    assert.equal(await extractSubtitleBuffer(raw, name, { episode: 4, season: 1, allowUnnumbered: true }), null, name);
  }
});

test('new release tokens never override a wrong season or make a multi-candidate file certain', async () => {
  const raw = fixture('sample.ass');
  for (const name of ['Example TV S02 [03].ass', 'Example TV [03] [04].ass', 'Example_TV_03_04_1080p.ass']) {
    assert.equal(await extractSubtitleBuffer(raw, name, { episode: 3, season: 1, allowUnnumbered: true }), null, name);
    assert.equal(await extractSubtitleBuffer(syntheticZip([[name, raw]]), 'batch.zip', { episode: 3, season: 1, allowUnnumbered: true }), null, name);
  }
});
