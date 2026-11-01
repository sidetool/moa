import { preferredResolutionIndex } from '@moa/shared';

/** Read only explicit pixel dimensions, p-labels or a bare numeric height. */
export function sourceVideoHeight(label: unknown): number | undefined {
  if (typeof label !== 'string') return;
  const heights = [
    ...Array.from(label.matchAll(/(?:^|[^\d])\d{2,5}\s*[x×]\s*(\d{2,5})(?!\d)/gi), match => Number(match[1])),
    ...Array.from(label.matchAll(/(?:^|[^\d])(\d{3,4})\s*p(?:\d{2,3})?\b/gi), match => Number(match[1])),
  ];
  if (/^\s*\d{3,4}\s*$/.test(label)) heights.push(Number(label));
  const unique = [...new Set(heights.filter(height => height > 0 && height <= 16384))];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Auto preserves source order. A fixed target chooses the highest available height <= it. */
export function preferredSourceIndex(heights: readonly (number | undefined)[], preference: string): number {
  if (!['480', '720', '1080'].includes(preference)) return 0;
  return preferredResolutionIndex(heights, Number(preference)) ?? 0;
}
