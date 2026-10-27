import test from 'node:test';
import assert from 'node:assert/strict';
import { vodInitialization } from '../src/playback/hls.js';

const box = (type: string, contents: Buffer) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(contents.length + 8); header.write(type, 4);
  return Buffer.concat([header, contents]);
};
test('VOD init records a finite duration without changing codec boxes or input', () => {
  for (const version of [0, 1]) {
    const header = Buffer.alloc(version === 0 ? 100 : 112);
    header[0] = version; header.writeUInt32BE(1000, version === 0 ? 12 : 20);
    const codec = box('trak', Buffer.from('codec configuration'));
    const source = Buffer.concat([box('ftyp', Buffer.from('iso6')), box('moov', Buffer.concat([box('mvhd', header), codec]))]);
    const modified = vodInitialization(source, 1530.048);
    const offset = modified.indexOf('mvhd') - 4;
    assert.equal(version === 0 ? modified.readUInt32BE(offset + 24) : Number(modified.readBigUInt64BE(offset + 32)), 1_530_048);
    assert.equal(source.length, modified.length);
    assert.ok(modified.subarray(-codec.length).equals(codec));
    assert.equal(version === 0 ? source.readUInt32BE(offset + 24) : Number(source.readBigUInt64BE(offset + 32)), 0);
    assert.deepEqual(vodInitialization(modified, 1530.048), modified);
  }
  assert.throws(() => vodInitialization(Buffer.from('invalid'), 30), /Missing MP4/);
});
