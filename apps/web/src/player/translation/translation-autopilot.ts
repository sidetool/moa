import { useCallback, useEffect, useRef, useState } from "react";
import type { SubtitleTrack } from "@moa/shared";
import { currentProfileId } from "../../lib/api";
import type { TranslationMode } from "../../api/translation";
import { jimakuSource, type JimakuState } from "./jimaku";
import { type TranslationOrigin, type TranslationSource } from "./subtitle-translation";
import { trackSource, translatableTracks } from "./TranslationPanel";
import { subtitleLanguage } from "../subtitles/subtitle-language";
import { trackName } from "../subtitles/track-name";

/**
 * What the player suggests when an episode has no Korean subtitle.
 * "source": one certain original (a known English/Japanese track or an episode-verified Jimaku file).
 * "choose": only uncertain originals; the viewer picks in the translation panel.
 */
export type TranslationOffer =
  /** Only the id: track URLs belong to a playback session, which can change (audio/server switch) while the offer is up. */
  | { kind: "track"; trackId: string; label: string }
  | { kind: "jimaku"; source: TranslationSource }
  | { kind: "choose" };

/** Per tab, profile and episode: never auto-start twice, and never again after a cancel or dismissal. */
type Memo = "started" | "cancelled" | "dismissed";
const memoKey = (episodeId: string) => `moa.translationAuto:${JSON.stringify([currentProfileId(), episodeId])}`;
const memory = new Map<string, Memo>();
export function autoMemo(episodeId: string): Memo | null {
  const key = memoKey(episodeId);
  try { return (sessionStorage.getItem(key) as Memo | null) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
}
export function rememberAuto(episodeId: string, memo: Memo) {
  const key = memoKey(episodeId);
  memory.set(key, memo);
  try { sessionStorage.setItem(key, memo); } catch { /* private mode */ }
}

export interface AutopilotInput {
  episodeId: string;
  mode: TranslationMode;
  sourcePriority: "site" | "jimaku";
  /** Admin turned translation on and a key exists. */
  enabled: boolean;
  /** Session, settings, saved translations and the online Korean search have all settled. */
  ready: boolean;
  /** Subtitles are off for this title, or the profile prefers another language. */
  skip: boolean;
  /** A human-made Korean subtitle exists or is showing. */
  hasKorean: boolean;
  /** A finished AI translation saved earlier for this episode. */
  saved: SubtitleTrack | null;
  /** This session's own tracks (no translations). */
  tracks: SubtitleTrack[];
  current: SubtitleTrack | null;
  /** The viewer changed subtitles themselves. */
  userChose: boolean;
  /** A translation job is already running (or resumed) for this episode. */
  busy: boolean;
  jimaku: JimakuState;
  searchJimaku: () => void;
  start: (source: TranslationSource, origin: TranslationOrigin) => void;
  useSaved: (track: SubtitleTrack) => void;
}

/** Prefer a track with an explicit language, keeping the current selection when possible. */
function certainTrack(tracks: SubtitleTrack[], current: SubtitleTrack | null) {
  const known = translatableTracks(tracks).filter(track => subtitleLanguage(track));
  return known.find(track => track.id === current?.id) ?? known[0] ?? null;
}

/**
 * Translation modes, once per episode: reuse Korean or a saved translation first,
 * then a site track or Jimaku according to the profile preference. "ask" suggests;
 * "auto" starts immediately, except Jimaku matches whose episode is uncertain.
 */
export function useTranslationAutopilot(input: AutopilotInput) {
  const [offer, setOffer] = useState<TranslationOffer | null>(null);
  const phase = useRef<"idle" | "searching" | "offered" | "done">("idle");
  const latest = useRef(input);
  latest.current = input;
  const { episodeId, mode, sourcePriority, enabled, ready, skip, hasKorean, saved, tracks, current, userChose, busy, jimaku } = input;

  useEffect(() => {
    if (phase.current === "done" || phase.current === "offered") return;
    // Settings or config may still change (e.g. load late); wait instead of finishing.
    if (mode === "manual" || !enabled || !ready) return;
    const { searchJimaku, start, useSaved } = latest.current;
    const stop = () => { phase.current = "done"; };
    if (skip || hasKorean) return stop();
    const memo = autoMemo(episodeId);
    if (memo === "cancelled" || memo === "dismissed") return stop();
    // A finished translation costs nothing to reuse, even right after this tab translated it ("started").
    if (saved) { if (!userChose) useSaved(saved); return stop(); }
    // "started" only blocks a second charge for the same episode.
    if (busy || memo === "started") return stop();
    const act = (next: TranslationOffer) => {
      // Anything uncertain, or a viewer who already picked subtitles, gets a question instead of a charge.
      if (next.kind !== "choose" && mode === "auto" && !userChose) {
        phase.current = "done";
        rememberAuto(episodeId, "started");
        start(next.kind === "jimaku" ? next.source : trackSource(track!), "auto");
      } else {
        phase.current = "offered";
        setOffer(next);
      }
    };
    const candidates = translatableTracks(tracks);
    // Unknown site language is allowed only after WatchPage's configured protection passes.
    const track = certainTrack(tracks, current) ?? candidates.find(t => t.id === current?.id) ?? candidates[0];
    const useTrack = () => act({ kind: "track", trackId: track!.id, label: trackName(track!) });
    if (sourcePriority === "site" && track) return useTrack();
    if (jimaku.status === "idle") {
      if (phase.current === "idle") { phase.current = "searching"; searchJimaku(); }
      return;
    }
    if (jimaku.status === "searching") return;
    if (jimaku.status === "done") {
      const verified = jimaku.result.candidates.filter(item => item.match !== "unverified");
      const best = verified.find(item => item.match === "episode") ?? verified[0];
      if (best) return act({ kind: "jimaku", source: jimakuSource(jimaku.result, best) });
    }
    // A failed/empty Jimaku search falls back to this video's track automatically.
    if (track) return useTrack();
    if (jimaku.status === "done" && jimaku.result.candidates.length) return act({ kind: "choose" });
    stop();
  }, [episodeId, mode, sourcePriority, enabled, ready, skip, busy, hasKorean, saved, tracks, current, userChose, jimaku]);

  // Withdraw a suggestion once it no longer applies: subtitles off, Korean picked, translation started from
  // the menu, the profile switched to manual, or the admin turned translation off.
  useEffect(() => {
    if (offer && (skip || hasKorean || busy || mode === "manual" || !enabled)) { setOffer(null); phase.current = "done"; }
  }, [offer, skip, hasKorean, busy, mode, enabled]);

  /** Starts the offered translation; returns false when the offered track is gone (the viewer should pick instead). */
  const accept = useCallback(() => {
    if (!offer || offer.kind === "choose") return false;
    // Read the track from the current session, not the one that was playing when the offer appeared.
    const track = offer.kind === "track" ? latest.current.tracks.find(item => item.id === offer.trackId) : null;
    if (offer.kind === "track" && !track) { setOffer(null); phase.current = "done"; return false; }
    rememberAuto(episodeId, "started");
    phase.current = "done";
    setOffer(null);
    latest.current.start(track ? trackSource(track) : (offer as Extract<TranslationOffer, { kind: "jimaku" }>).source, "manual");
    return true;
  }, [offer, episodeId]);
  const dismiss = useCallback(() => {
    rememberAuto(episodeId, "dismissed");
    phase.current = "done";
    setOffer(null);
  }, [episodeId]);
  /** Hide without remembering (e.g. it timed out or the viewer opened the panel). */
  const hide = useCallback(() => { phase.current = "done"; setOffer(null); }, []);

  return { offer, accept, dismiss, hide };
}
