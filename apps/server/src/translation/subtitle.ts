import { convertSubtitle } from '../subtitles/korean/index.js';
import { ApiFailure } from '../util.js';
export interface Line {
  id: number;
  text: string;
}
export interface TimedLine extends Line { start: number; end: number }
export interface Document {
  format: 'vtt' | 'ass';
  lines: TimedLine[];
  render: (translated: Record<string, string>, partial?: boolean) => string;
}
const clean = (text: string) =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
export function subtitleDocument(content: string, format: string): Document {
  if (Buffer.byteLength(content) > 1024 * 1024) throw new ApiFailure(413, 'translation-subtitle-too-large');
  let normalized;
  try {
    normalized = convertSubtitle(content, format);
  } catch {
    throw new ApiFailure(400, 'translation-invalid-subtitle');
  }
  const lines: TimedLine[] = [],
    replacements: { index: number; prefix: string }[] = [];
  const parts = normalized.content.replace(/\r\n?/g, '\n').split(normalized.format === 'ass' ? '\n' : /\n\s*\n/);
  if (normalized.format === 'ass') {
    let events = false,
      fields: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const row = parts[index];
      if (/^\[/.test(row)) {
        events = /^\[Events\]/i.test(row);
        continue;
      }
      if (!events) continue;
      if (/^Format\s*:/i.test(row)) {
        fields = row
          .slice(row.indexOf(':') + 1)
          .split(',')
          .map((x) => x.trim().toLowerCase());
        continue;
      }
      if (!/^Dialogue\s*:/i.test(row)) continue;
      if (!fields.length || fields.at(-1) !== 'text') throw new ApiFailure(400, 'translation-invalid-subtitle');
      let offset = row.indexOf(':') + 1;
      for (let n = 0; n < fields.length - 1; n++) {
        offset = row.indexOf(',', offset) + 1;
        if (!offset) throw new ApiFailure(400, 'translation-invalid-subtitle');
      }
      const raw = row.slice(offset);
      // ASS drawings are vector data, not dialogue. Keep them byte-for-byte.
      if (/\{[^}]*\\p[1-9]/i.test(raw)) continue;
      const text = raw
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\[Nn]/g, '\n')
        .replace(/\\h/g, ' ')
        .trim();
      if (!text) continue;
      const overrides = raw.match(/^(?:\{[^}]*\})*/)?.[0] || '';
      replacements.push({ index, prefix: row.slice(0, offset) + overrides });
      const values = row.slice(row.indexOf(':') + 1).split(',');
      lines.push({ id: lines.length, text, start: timestamp(values[fields.indexOf('start')]), end: timestamp(values[fields.indexOf('end')]) });
    }
  } else {
    for (let index = 0; index < parts.length; index++) {
      const rows = parts[index].split('\n'),
        timing = rows.findIndex((x) => x.includes('-->'));
      if (timing < 0) continue;
      const text = clean(rows.slice(timing + 1).join('\n'));
      if (!text) continue;
      replacements.push({ index, prefix: rows.slice(0, timing + 1).join('\n') + '\n' });
      const times = rows[timing].trim().split(/\s+-->\s+/);
      lines.push({ id: lines.length, text, start: timestamp(times[0]), end: timestamp(times[1]?.split(/\s/)[0]) });
    }
  }
  if (!lines.length || lines.length > 10000 || lines.some((l) => l.text.length > 8000 || !Number.isFinite(l.start) || !Number.isFinite(l.end) || l.end <= l.start))
    throw new ApiFailure(400, 'translation-invalid-subtitle');
  return {
    format: normalized.format,
    lines,
    render(translated, partial = false) {
      const output = parts.slice();
      for (const [i, replacement] of replacements.entries()) {
        const value = translated[String(i)];
        if (typeof value !== 'string' || !value.trim()) {
          if (!partial) throw new ApiFailure(502, 'translation-incomplete');
          output[replacement.index] = '';
          continue;
        }
        const safe =
          normalized.format === 'ass'
            ? value
                .replace(/[{}\\]/g, '')
                .replace(/\r/g, '')
                .replace(/\n+/g, '\\N')
            : value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\r/g, '')
                .replace(/\n{2,}/g, '\n');
        output[replacement.index] = replacement.prefix + safe;
      }
      return output.join(normalized.format === 'ass' ? '\n' : '\n\n');
    },
  };
}
export function batches(lines: Line[], maxLines = 120): Line[][] {
  const groups: Line[][] = [];
  let group: Line[] = [],
    size = 0;
  for (const line of lines) {
    if (group.length && (group.length >= maxLines || size + line.text.length > 18000)) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(line);
    size += line.text.length;
  }
  if (group.length) groups.push(group);
  return groups;
}

function timestamp(value: string | undefined): number {
  const parts = (value || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}
/** Only intervals where every active dialogue cue is translated. */
export function translatedRanges(lines: TimedLine[], output: Record<string, string>) {
  const events = new Map<number, { total: number; missing: number }>();
  for (const line of lines) for (const [time, delta] of [[line.start, 1], [line.end, -1]]) {
    const event = events.get(time) || { total: 0, missing: 0 };
    event.total += delta; event.missing += output[line.id] ? 0 : delta;
    events.set(time, event);
  }
  const points = [...events].sort((a,b) => a[0]-b[0]);
  const ranges: {start:number;end:number}[] = [];
  let total = 0, missing = 0;
  for (let i=0;i<points.length-1;i++) {
    const [start, event] = points[i], end = points[i+1][0];
    total += event.total; missing += event.missing;
    if (total > 0 && missing === 0 && end > start) {
      const previous = ranges.at(-1);
      if (previous?.end === start) previous.end = end;
      else ranges.push({start,end});
    }
  }
  return ranges;
}
export function nextBatch(lines: TimedLine[], output: Record<string,string>, startAt: number, limit: number): TimedLine[] {
  const missing = lines.filter(line => !output[line.id]).sort((a,b) => a.start-b.start || a.id-b.id);
  const index = missing.findIndex(line => line.end > startAt);
  const remaining = index < 0 ? missing : missing.slice(index);
  return (batches(remaining, limit)[0] || []) as TimedLine[];
}
