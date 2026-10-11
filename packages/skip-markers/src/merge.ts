import type { SkipMarkers } from "./types.js";

const priority = { manual: 3, fingerprint: 2, aniskip: 1, theintrodb: 1 };
/** OP start/end are atomic: never combine boundaries from different sources. */
export function mergeMarkers(...candidates: (SkipMarkers | null | undefined)[]): SkipMarkers | null {
  const available = candidates.filter((m): m is SkipMarkers => !!m);
  const ordered = (kind: "intro" | "credits") => [...available].sort((a, b) => priority[b.provenance?.[kind] ?? b.source] - priority[a.provenance?.[kind] ?? a.source]);
  const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0;
  const intro = ordered("intro").find(m => finite(m.introStart) && finite(m.introEnd) && m.introEnd > m.introStart);
  const credits = ordered("credits").find(m => finite(m.creditsStart) && (m.creditsEnd === undefined || (finite(m.creditsEnd) && m.creditsEnd > m.creditsStart)));
  if (!intro && !credits) return null;
  const chosen = [intro, credits].filter((m): m is SkipMarkers => !!m);
  return {
    ...(intro ? { introStart: intro.introStart, introEnd: intro.introEnd } : {}),
    ...(credits ? { creditsStart: credits.creditsStart, ...(credits.creditsEnd === undefined ? {} : { creditsEnd: credits.creditsEnd }) } : {}),
    source: [intro ? intro.provenance?.intro ?? intro.source : undefined, credits ? credits.provenance?.credits ?? credits.source : undefined]
      .filter((source): source is SkipMarkers["source"] => source !== undefined).sort((a, b) => priority[b] - priority[a])[0],
    confidence: Math.min(...chosen.map(m => Number.isFinite(m.confidence) ? Math.max(0, Math.min(1, m.confidence)) : 0)),
    provenance: {
      ...(intro ? { intro: intro.provenance?.intro ?? intro.source } : {}),
      ...(credits ? { credits: credits.provenance?.credits ?? credits.source } : {}),
    },
  };
}
