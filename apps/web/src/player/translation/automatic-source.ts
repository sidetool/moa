import type { SubtitleTrack } from "@moa/shared";
import { isKorean, subtitleLanguage } from "../subtitles/subtitle-language";

/** Only automatic suggestions use this ranking; the manual list stays unrestricted. */
export function automaticTrackRank(track: SubtitleTrack): number | null {
  if (isKorean(track) || track.source === "translation") return null;
  const label = track.label.normalize("NFKC").replace(/[_-]/g, " ");
  const dialogue = /\b(?:full|dialogue|dialog|complete)\b|전체|대사/i.test(label);
  // Inclusion and absence describe a full track's contents, not a partial-only track.
  const partialLabel = label
    .replace(/\b(?:no|without|excluding|including|with)\s+(?:signs?|songs?|forced)(?:\s*(?:&|and|\/)\s*(?:signs?|songs?))?\b/gi, " ")
    .replace(/\b(?:signs?|songs?|forced)(?:\s*(?:&|and|\/)\s*(?:signs?|songs?))?\s+(?:included|excluded)\b/gi, " ")
    .replace(/(?:간판|노래|강제)\s*(?:포함|없음|제외)/g, " ");
  const partial = /\b(?:signs?|songs?|forced)\b|간판|노래|강제/i.test(partialLabel);
  // Full tracks commonly advertise that signs are included too.
  if (partial && !dialogue) return null;
  if (/\b(?:AI|machine|auto(?:matic)?|dubtitles?)\b|기계\s*번역|자동\s*번역/i.test(label)) return 2;
  return dialogue ? 0 : 1;
}

export function selectAutomaticTrack(tracks: SubtitleTrack[], current: SubtitleTrack | null): SubtitleTrack | null {
  const eligible = tracks.filter(track => automaticTrackRank(track) !== null);
  const known = eligible.filter(track => subtitleLanguage(track));
  // Keep the established language certainty protection. Unknown site languages
  // are only a fallback after the player's configured protection has passed.
  const candidates = known.length ? known : eligible;
  const preferred = (track: SubtitleTrack) => ["en", "ja"].includes(subtitleLanguage(track) ?? "");
  let best: SubtitleTrack | null = null;
  let bestRank = Infinity;
  for (const track of candidates) {
    const rank = automaticTrackRank(track);
    if (rank === null) continue;
    if (rank < bestRank || rank === bestRank && (track.id === current?.id
      || best?.id !== current?.id && best !== null && preferred(track) && !preferred(best))) {
      best = track;
      bestRank = rank;
    }
  }
  return best;
}
