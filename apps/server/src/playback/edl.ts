import { ApiFailure } from '../util.js';

export interface EdlStream { type?: 'video' | 'audio'; segments: { url: string; start: number; length: number }[] }
const fail = (code = 'unsupported-edl') => { throw new ApiFailure(502, code); };
/** mpv length quoting counts UTF-8 bytes, not JavaScript characters. */
export function parseEdl(input: string): EdlStream[] {
  if (!input.startsWith('edl://') || Buffer.byteLength(input) > 2 * 1024 * 1024) return fail('invalid-edl');
  const data = Buffer.from(input.slice(6)), streams: EdlStream[] = [{ segments: [] }];
  let pos = 0;
  while (pos < data.length) {
    if ([10, 59].includes(data[pos])) { pos++; continue; }
    const fields: string[] = [];
    do {
      let prefix = '';
      const begin = pos;
      while (pos < data.length && ![44, 59, 10].includes(data[pos])) {
        if (data[pos] === 37 && (pos === begin || /^(file|start|length)=$/.test(data.subarray(begin,pos).toString()))) break;
        pos++;
      }
      prefix = data.subarray(begin, pos).toString();
      if (data[pos] === 37) {
        if (prefix && !prefix.endsWith('=')) return fail('invalid-edl');
        const end = data.indexOf(37, pos + 1), raw = data.subarray(pos + 1, end).toString();
        if (end < 0 || !/^\d+$/.test(raw)) return fail('invalid-edl');
        const length = Number(raw); pos = end + 1;
        if (!Number.isSafeInteger(length) || length < 1 || pos + length > data.length) return fail('invalid-edl');
        prefix += data.subarray(pos, pos + length).toString('utf8'); pos += length;
        if (pos < data.length && ![44, 59, 10].includes(data[pos])) return fail('invalid-edl');
      }
      fields.push(prefix);
      if (data[pos] !== 44) break;
      pos++;
    } while (pos <= data.length);
    let stream = streams[streams.length - 1];
    if (fields[0].startsWith('!')) {
      if (fields[0] === '!new_stream' && fields.length === 1) {
        if (stream.segments.length) streams.push({ segments: [] });
      } else if (fields[0] === '!delay_open' && !stream.segments.length && !stream.type) {
        const values = Object.fromEntries(fields.slice(1).map(f => f.split('=')));
        if (!['video','audio'].includes(values.media_type) || fields.slice(1).some(f => !/^(media_type|codec)=/.test(f))) return fail();
        if (values.codec && !['h264','hevc','aac','mp3'].includes(values.codec)) return fail('unsupported-edl-codec');
        stream.type = values.media_type as EdlStream['type'];
      } else return fail('unsupported-edl-header');
      continue;
    }
    const values: Record<string,string> = {};
    fields.forEach((f, i) => {
      const named = /^(file|start|length)=(.*)$/s.exec(f), name = named?.[1] || ['file','start','length'][i];
      if (!name || name in values || !named && i > 0 && f.includes('=')) return fail();
      values[name] = named ? named[2] : f;
    });
    let url: URL;
    try { url = new URL(values.file); } catch { return fail('unsupported-edl-url'); }
    if (url.protocol !== 'https:' || url.username || url.password || /[\r\n]/.test(values.file)) return fail('unsupported-edl-url');
    const start = Number(values.start || 0), length = Number(values.length);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0) return fail('unsupported-edl-timing');
    stream.segments.push({ url: url.href, start, length });
    if (stream.segments.length > 10000 || streams.length > 16) return fail('edl-limit');
  }
  if (streams.some(s => !s.segments.length)) return fail('invalid-edl');
  return streams;
}
/** Duration hints preserve the EDL timeline; segment bytes are not trimmed. */
export function edlPlaylist(stream: EdlStream, asset: (url: string) => string) {
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...stream.segments.map(s => s.length)))}`, '#EXT-X-MEDIA-SEQUENCE:0',
    ...stream.segments.flatMap(s => [`#EXTINF:${s.length},`, asset(s.url)]), '#EXT-X-ENDLIST', ''].join('\n');
}
export function edlMaster(video: string, audio: { url: string; label: string }[]) {
  const quote = (s: string) => s.replace(/["\r\n\\]/g, ' ').slice(0, 100);
  return ['#EXTM3U', '#EXT-X-VERSION:3', ...audio.map((a,i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${i+1} ${quote(a.label)}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${a.url}"`),
    `#EXT-X-STREAM-INF:BANDWIDTH=8000000${audio.length ? ',AUDIO="audio"' : ''}`, video, ''].join('\n');
}
