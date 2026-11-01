import type { PlaybackSession } from '@moa/shared';

/** Known ending markers take priority; unmarked videos use the profile's explicit lead time. */
export function nextUpTiming(total: number, time: number, markers: PlaybackSession['markers'], leadSeconds = 0) {
  const start = markers?.creditsStart, end = markers?.creditsEnd;
  const hasCredits = Number.isFinite(start) && start! >= 0 && start! < total
    && (end === undefined || Number.isFinite(end) && end > start!);
  const creditsEnd = Math.min(end ?? total, total);
  const postCredits = Boolean(hasCredits && end !== undefined && total - end > 20);
  const lead = Number.isInteger(leadSeconds) && leadSeconds > 0 && leadSeconds <= 600 && leadSeconds < total ? leadSeconds : 0;
  return {
    hasCredits,
    creditsAt: total > 0 ? postCredits ? total - 15 : hasCredits ? start! : total - lead : Infinity,
    creditsEnd,
    inCredits: Boolean(hasCredits && time >= start! && time < creditsEnd - .1),
    postCredits,
  };
}
