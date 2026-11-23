import type { SubtitleTimingStep } from './subtitle-timing';

function seconds(value: string) {
  return value.trim().split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

function stamp(time: number, ass: boolean) {
  const scale = ass ? 100 : 1000;
  const ticks = Math.round(time * scale);
  const whole = Math.floor(ticks / scale);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(Math.floor(whole / 3600)).padStart(ass ? 1 : 2, '0')}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}.${String(ticks % scale).padStart(ass ? 2 : 3, '0')}`;
}

/** Only the disposable render copy changes. Classify a whole event by its authored start on
 * the source clock, so overlapping cues, ASS relative animations and repeated seeks stay stable. */
export function retimeSubtitle(content: string, format: 'ass' | 'vtt', step: SubtitleTimingStep) {
  let invalid = false;
  const shifted = (raw: string, offset: number) => {
    const time = seconds(raw) + offset;
    if (!Number.isFinite(time) || time < 0) invalid = true;
    return offset ? stamp(time, format === 'ass') : raw;
  };
  const offsetAt = (raw: string) => seconds(raw) < step.boundary ? step.before : step.after;
  let result: string;
  if (format === 'ass') {
    let events = false, start = -1, end = -1;
    result = content.replace(/^[^\r\n]+/gm, line => {
      if (/^\s*\[/.test(line)) { events = /^\s*\[Events\]/i.test(line); start = end = -1; }
      if (!events) return line;
      if (/^Format\s*:/i.test(line)) {
        const fields = line.slice(line.indexOf(':') + 1).toLowerCase().split(',').map(x => x.trim());
        start = fields.indexOf('start'); end = fields.indexOf('end');
        if (fields.at(-1) !== 'text') invalid = true;
      }
      if (!/^Dialogue\s*:/i.test(line)) return line;
      const colon = line.indexOf(':') + 1, fields = line.slice(colon).split(',');
      if (start < 0 || end < 0 || ![fields[start], fields[end]].every(x => /^\s*\d+:\d\d:\d\d\.\d{2}\s*$/.test(x))) {
        invalid = true; return line;
      }
      const offset = offsetAt(fields[start]);
      fields[start] = shifted(fields[start], offset);
      fields[end] = shifted(fields[end], offset);
      return line.slice(0, colon) + fields.join(',');
    });
  } else {
    // A mapped transport clock needs the MPEG timestamp in addition to the local cue time.
    if (!/^\uFEFF?WEBVTT\b/.test(content) || /^X-TIMESTAMP-MAP\s*=/im.test(content)) return null;
    const cue = /^((?:\d{2,}:)?\d\d:\d\d\.\d{3})([ \t]+-->[ \t]+)((?:\d{2,}:)?\d\d:\d\d\.\d{3})(?=[ \t\r\n]|$)/m;
    result = content.split(/(\r?\n[ \t]*\r?\n)/).map(block => {
      if (/^(?:WEBVTT\b|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block) || !block.includes('-->')) return block;
      const match = cue.exec(block);
      if (!match) { invalid = true; return block; }
      const offset = offsetAt(match[1]);
      if (!offset) return block;
      const header = shifted(match[1], offset) + match[2] + shifted(match[3], offset);
      const payload = block.slice(match.index + match[0].length)
        .replace(/<((?:\d{2,}:)?\d\d:\d\d\.\d{3})>/g, (_, value: string) => `<${shifted(value, offset)}>`);
      return block.slice(0, match.index) + header + payload;
    }).join('');
  }
  return invalid ? null : result;
}
