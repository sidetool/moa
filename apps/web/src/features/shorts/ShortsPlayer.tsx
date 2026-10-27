import { AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { markShortFailed, markShortSeen, shortsTrailers } from "../../api/shorts";
import { isVideoUnavailable, loadYouTubeApi, trailerKeys, youtubeEmbedUrl, YOUTUBE_ENDED, YOUTUBE_PLAYING, type YouTubePlayer } from "../../lib/youtube";
import { Spinner } from "../../components/ui";

const READY_TIMEOUT = 15_000;
const LIST_TIMEOUT = 10_000;
const SEEN_AFTER = 5_000;
const AUTO_NEXT_DELAY = 1_600;

/** Per-feed memory shared by every player of one feed session. */
export interface ShortsSession {
  /** Foreground playing milliseconds per work, kept across candidates and revisits. */
  watched: Map<string, number>;
  /** Works already reported as seen or skipped; each is sent at most once. */
  reported: Set<string>;
  /** Works whose trailers currently can't play here; moving on from them isn't a choice about the work. */
  failed: Set<string>;
  failureReports?: Map<string, "unavailable" | "temporary">;
}

/** Report only failures presented by an active player, never speculative preparation or autoplay denial. */
export function reportShortFailure(itemKey: string, session: ShortsSession, reason: "unavailable" | "temporary") {
  session.failed.add(itemKey);
  const reports = session.failureReports ??= new Map();
  const previous = reports.get(itemKey);
  if (previous === "unavailable" || previous === reason) return;
  reports.set(itemKey, reason);
  markShortFailed(itemKey, reason).catch(() => {});
}

/** Foreground playing time for one work. `since` is set while it plays; `flush` banks it. Reports seen
 *  once after five seconds; best effort, no retries. */
export function useWatchTime(itemKey: string, session: ShortsSession) {
  const since = useRef<number | null>(null);
  const flush = () => {
    if (since.current === null) return;
    session.watched.set(itemKey, (session.watched.get(itemKey) ?? 0) + performance.now() - since.current);
    since.current = null;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (since.current === null || session.reported.has(itemKey)) return;
      if ((session.watched.get(itemKey) ?? 0) + performance.now() - since.current < SEEN_AFTER) return;
      session.reported.add(itemKey);
      markShortSeen(itemKey).catch(() => {});
    }, 500);
    return () => { window.clearInterval(tick); flushRef.current(); };
  }, [itemKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { since, flush };
}

type Phase = "list" | "list-error" | "loading" | "ready" | "blocked" | "none" | "env";

/** Plays one work's trailers; only ever mounted for the settled slide. Video-specific failures
 *  try the next reference, environment failures stop and wait for the user. */
export interface ShortsControl { play(): void }

/** Mount only while the slide is settled, mostly on screen and the page is visible; unmounting is the stop. */
export function ShortsPlayer({ itemKey, title, session, control, muted, onMuted, onBlocked, onPlaying, onEnded, autoNext, onAutoNext }: {
  itemKey: string; title: string; session: ShortsSession; control: React.RefObject<ShortsControl | null>;
  muted: boolean; onMuted: (muted: boolean) => void; onBlocked: (blocked: boolean) => void;
  onPlaying: () => void; onEnded: () => void;
  /** Whether an unplayable work may hand over to the next one by itself. */
  autoNext: boolean; onAutoNext: () => void;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [listRound, setListRound] = useState(0);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>("list");
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const { since, flush } = useWatchTime(itemKey, session);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const callbacks = useRef({ onMuted, onBlocked, onPlaying, onEnded, onAutoNext });
  callbacks.current = { onMuted, onBlocked, onPlaying, onEnded, onAutoNext };

  // Only the selected work's references are requested.
  useEffect(() => {
    let live = true;
    const control = new AbortController();
    const timer = window.setTimeout(() => control.abort(), LIST_TIMEOUT);
    setPhase("list");
    shortsTrailers(itemKey, control.signal).then(data => {
      if (!live) return;
      const found = trailerKeys({ trailers: Array.isArray(data?.trailers) ? data.trailers : [] });
      setKeys(found); setIndex(0);
      setPhase(found.length ? "loading" : "none");
    }, () => { if (live) setPhase("list-error"); }).finally(() => window.clearTimeout(timer));
    return () => { live = false; window.clearTimeout(timer); control.abort(); };
  }, [itemKey, listRound]);

  // One player per candidate; `live` drops late events from a replaced or closed player.
  const key = phase === "list" || phase === "list-error" ? undefined : keys[index];
  useEffect(() => {
    if (!key) return;
    let live = true, mutedRetry = false;
    const element = frame.current;
    setPhase("loading");
    const readyTimer = window.setTimeout(() => { if (live) { live = false; setPhase("env"); } }, READY_TIMEOUT);
    const settle = () => window.clearTimeout(readyTimer);
    const envError = () => { if (live) { live = false; settle(); setPhase("env"); } };
    loadYouTubeApi().then(YT => {
      if (!live || !element) return;
      try { player.current = new YT.Player(element, {
        host: "https://www.youtube-nocookie.com",
        events: {
          onReady: () => { if (!live) return; settle(); if (mutedRef.current) player.current?.mute?.(); setPhase(old => old === "loading" ? "ready" : old); },
          onStateChange: event => {
            if (!live) return;
            if (event.data === YOUTUBE_PLAYING) {
              settle(); setPhase("ready"); session.failed.delete(itemKey); callbacks.current.onPlaying();
              if (since.current === null && document.visibilityState === "visible") since.current = performance.now();
              return;
            }
            flush(); // paused, buffering, cued, ended: none of it counts
            if (event.data === YOUTUBE_ENDED) { live = false; callbacks.current.onEnded(); }
          },
          // First denial: retry muted. Second: ask for a tap; never move to another video for it.
          onAutoplayBlocked: () => {
            if (!live) return;
            settle();
            if (!mutedRetry && !mutedRef.current) { mutedRetry = true; callbacks.current.onMuted(true); player.current?.mute?.(); player.current?.playVideo(); }
            else setPhase("blocked");
          },
          onError: event => {
            if (!live) return;
            settle(); flush();
            live = false;
            if (!isVideoUnavailable(event.data)) { setPhase("env"); return; }
            if (index + 1 < keys.length) setIndex(index + 1); else setPhase("none");
          }
        }
      }); } catch { envError(); }
    }, envError);
    return () => {
      live = false;
      settle(); flush();
      try { player.current?.destroy(); } catch { /* already gone */ }
      player.current = null;
    };
  }, [key, index, round]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (muted) player.current?.mute?.(); else player.current?.unMute?.(); }, [muted]);


  useEffect(() => {
    if (phase !== "none" || !autoNext) return;
    const timer = window.setTimeout(() => callbacks.current.onAutoNext(), AUTO_NEXT_DELAY);
    return () => window.clearTimeout(timer);
  }, [phase, autoNext]);

  useEffect(() => {
    callbacks.current.onBlocked(phase === "blocked");
    if (phase === "none") reportShortFailure(itemKey, session, "unavailable");
    else if (phase === "env" || phase === "list-error") reportShortFailure(itemKey, session, "temporary");
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    control.current = { play: () => { player.current?.playVideo(); setPhase(old => old === "blocked" ? "ready" : old); } };
    return () => { control.current = null; callbacks.current.onBlocked(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => { setIndex(0); setRound(old => old + 1); setPhase("loading"); };
  return <>
    {key && phase !== "none" && phase !== "env" && <iframe key={`${round}:${index}:${key}`} ref={frame} src={youtubeEmbedUrl(key)} title={`${title} 예고편`}
      referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />}
    {phase === "list" && <div className="shorts-overlay is-quiet"><Spinner size={28} /></div>}
    {phase === "none" && <div className="shorts-overlay" role="status">
      <b>재생할 수 있는 예고편이 없어요</b>
      <small>{autoNext ? "다음 작품으로 넘어가요" : "아래 화살표로 넘겨 주세요"}</small>
    </div>}
    {(phase === "env" || phase === "list-error") && <div className="shorts-overlay" role="alert">
      <AlertCircle size={26} />
      <b>{phase === "env" ? "YouTube 플레이어를 열지 못했어요" : "예고편을 불러오지 못했어요"}</b>
      <button type="button" className="text-btn" onClick={phase === "env" ? retry : () => setListRound(old => old + 1)}>다시 시도</button>
    </div>}
  </>;
}
