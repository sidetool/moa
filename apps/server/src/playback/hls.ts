// FFmpeg's fragmented MP4 init has mvhd.duration=0. Chromium consequently
// classifies the stream as live, enabling a one-frame decoder preroll even
// when hls.js has a finite VOD playlist. Publish the known movie duration.
export function vodInitialization(source: Buffer, duration: number): Buffer {
  const init = Buffer.from(source);
  const find = (type: string, start = 0, end = init.length): number => {
    for (let offset = start; offset + 8 <= end;) {
      const size = init.readUInt32BE(offset);
      if (size < 8 || offset + size > end) throw new Error('Invalid MP4 initialization box');
      if (init.toString('ascii', offset + 4, offset + 8) === type) return offset;
      offset += size;
    }
    throw new Error(`Missing MP4 initialization ${type}`);
  };
  const moov = find('moov');
  const mvhd = find('mvhd', moov + 8, moov + init.readUInt32BE(moov));
  const version = init[mvhd + 8];
  if (version !== 0 && version !== 1) throw new Error('Unsupported MP4 movie header version');
  const timescale = init.readUInt32BE(mvhd + (version === 1 ? 28 : 20));
  const ticks = Math.max(1, Math.round(duration * timescale));
  if (!timescale || !Number.isSafeInteger(ticks) || duration <= 0) throw new Error('Invalid VOD duration');
  if (version === 1) init.writeBigUInt64BE(BigInt(ticks), mvhd + 32);
  else {
    if (ticks >= 0xffff_ffff) throw new Error('VOD exceeds MP4 version 0 duration range');
    init.writeUInt32BE(ticks, mvhd + 24);
  }
  return init;
}
