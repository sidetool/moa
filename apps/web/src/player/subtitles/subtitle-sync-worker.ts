import { alignCueTimes, cueTimes, findSubtitleTimingStep } from './subtitle-timing';
import { retimeSubtitle } from './segmented-subtitle';

self.onmessage = (event: MessageEvent<{ candidate: string; reference: string; format: 'vtt' | 'ass'; segmented: boolean }>) => {
  try {
    const data = event.data, candidate = cueTimes(data.candidate), reference = cueTimes(data.reference);
    if (data.segmented) {
      const step = findSubtitleTimingStep(candidate, reference);
      const content = step && retimeSubtitle(data.candidate, data.format, step);
      if (step && content) {
        const blob = new Blob([content], { type: data.format === 'ass' ? 'text/plain;charset=utf-8' : 'text/vtt;charset=utf-8' });
        self.postMessage({ status: 'aligned', offsetSeconds: 0, match: Math.min(step.beforeMatch, step.afterMatch), step, blob });
        return;
      }
    }
    self.postMessage(alignCueTimes(candidate, reference));
  } catch { self.postMessage({ status: 'uncertain', offsetSeconds: 0, match: 0 }); }
};
