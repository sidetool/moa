import type Hls from "hls.js";
import { AlertCircle, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { closeShortNative, prepareShortNative, type ShortsNativeSession } from "../api/shorts";
import { ApiError } from "../lib/api";
import { useWatchTime, type ShortsControl, type ShortsSession } from "./ShortsPlayer";
import { Spinner } from "./ui";

const PREPARE_TIMEOUT = 85_000; // the server may try two references for up to 40s each
const READY_TIMEOUT = 20_000; // prepared media that never starts is treated as failed
const HLS = "application/vnd.apple.mpegurl";

type Phase = "prepare" | "loading" | "ready" | "blocked" | "unavailable" | "error";

/** Experimental: the server prepares the trailer and MOA plays it in its own <video>. Mounted only for the
 *  settled, visible work; unmounting cancels preparation, stops the media and releases the lease. Failures
 *  wait for the person (retry or the YouTube player) and never advance by themselves. */
export function ShortsNativePlayer({ itemKey, title, session, control, muted, onMuted, onBlocked, onPlaying, onEnded, onEmbed }: {
  itemKey: string; title: string; session: ShortsSession; control: React.RefObject<ShortsControl | null>;
  muted: boolean; onMuted: (muted: boolean) => void; onBlocked: (blocked: boolean) => void;
  onPlaying: () => void; onEnded: () => void; onEmbed: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLElement>(null);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>("prepare");
  const [paused, setPaused] = useState(false);
  const { since, flush } = useWatchTime(itemKey, session);
  const callbacks = useRef({ onMuted, onBlocked, onPlaying, onEnded });
  callbacks.current = { onMuted, onBlocked, onPlaying, onEnded };
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // True only while the current attempt may change state; stale media events are ignored.
  const live = useRef(false);
  const attempt = useRef(0);
  const readyTimer = useRef(0);

  // Autoplay with sound first, then muted; a second refusal waits for a tap.
  const play = async () => {
    const el = video.current, gen = attempt.current;
    // An answer from an earlier attempt (before a retry) must not touch the current one.
    const current = () => live.current && attempt.current === gen && video.current === el;
    if (!el || !current()) return;
    try { await el.play(); } catch (error) {
      if (!current() || (error as DOMException)?.name !== "NotAllowedError") return;
      if (!el.muted) {
        el.muted = true; callbacks.current.onMuted(true);
        try { await el.play(); return; } catch { if (!current()) return; }
      }
      window.clearTimeout(readyTimer.current); // the media is fine; it just needs a tap
      setPhase("blocked");
    }
  };

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let lease: string | null = null, hls: Hls | null = null, stopped = false;
    attempt.current += 1;
    live.current = true;
    const abort = new AbortController();
    const prepareTimer = window.setTimeout(() => abort.abort(), PREPARE_TIMEOUT);
    // Ends this attempt completely: no request, no media network, no lease, no later events.
    const stop = () => {
      if (stopped) return;
      stopped = true; live.current = false;
      window.clearTimeout(prepareTimer); window.clearTimeout(readyTimer.current);
      abort.abort();
      flush();
      el.removeEventListener("error", onError);
      try { hls?.destroy(); } catch { /* already gone */ }
      hls = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
      if (lease) closeShortNative(lease);
      lease = null;
    };
    const fail = (next: "unavailable" | "error") => {
      if (stopped) return;
      stop(); session.failed.add(itemKey); setPhase(next);
    };
    function onError() { fail("error"); }
    setPhase("prepare");
    const start = async (prepared: ShortsNativeSession) => {
      el.muted = mutedRef.current;
      el.addEventListener("error", onError);
      readyTimer.current = window.setTimeout(() => fail("error"), READY_TIMEOUT);
      if (prepared.mime === HLS) {
        const { default: HlsClass } = await import("hls.js");
        if (stopped) return;
        if (HlsClass.isSupported()) {
          hls = new HlsClass({ maxBufferLength: 20, backBufferLength: 10 });
          hls.on(HlsClass.Events.ERROR, (_event, data) => { if (data.fatal) fail("error"); });
          hls.loadSource(prepared.url);
          hls.attachMedia(el);
        } else if (el.canPlayType(HLS)) el.src = prepared.url;
        else return fail("error");
      } else el.src = prepared.url;
      void play();
    };
    prepareShortNative(itemKey, abort.signal).then(prepared => {
      if (stopped) { closeShortNative(prepared.sessionId); return; } // a late answer still frees its lease
      window.clearTimeout(prepareTimer);
      lease = prepared.sessionId;
      setPhase("loading");
      start(prepared).catch(() => fail("error"));
    }, error => fail(error instanceof ApiError && error.status === 422 ? "unavailable" : "error"));
    return stop;
  }, [itemKey, round]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (video.current) video.current.muted = muted; }, [muted]);
  useEffect(() => { callbacks.current.onBlocked(phase === "blocked"); }, [phase]);
  useEffect(() => {
    control.current = { play: () => { setPhase(old => old === "blocked" ? "loading" : old); void play(); } };
    return () => { control.current = null; callbacks.current.onBlocked(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = phase === "unavailable" || phase === "error";
  return <>
    <video ref={video} className={phase === "ready" || phase === "blocked" ? "shorts-native-video is-on" : "shorts-native-video"} playsInline preload="auto" aria-label={`${title} 예고편`}
      onClick={() => { const el = video.current; if (!el || !live.current) return; if (el.paused) void play(); else el.pause(); }}
      onPlaying={() => {
        if (!live.current) return;
        window.clearTimeout(readyTimer.current);
        setPhase("ready"); setPaused(false); session.failed.delete(itemKey); callbacks.current.onPlaying();
        if (since.current === null && document.visibilityState === "visible") since.current = performance.now();
      }}
      onPause={() => { flush(); if (live.current) setPaused(true); }}
      onWaiting={flush}
      onEnded={() => { flush(); if (live.current) callbacks.current.onEnded(); }}
      onTimeUpdate={event => { const el = event.currentTarget; if (bar.current && el.duration) bar.current.style.width = `${(el.currentTime / el.duration) * 100}%`; }} />
    <span className="shorts-progress" aria-hidden="true"><i ref={bar} /></span>
    {phase === "ready" && paused && <span className="shorts-native-paused" aria-hidden="true"><Play size={30} fill="currentColor" /></span>}
    {(phase === "prepare" || phase === "loading") && <div className="shorts-overlay is-quiet"><Spinner size={28} /></div>}
    {failed && <div className="shorts-overlay" role="alert">
      <AlertCircle size={24} />
      <b>{phase === "unavailable" ? "직접 재생할 수 없는 예고편이에요" : "재생하지 못했어요"}</b>
      <span className="shorts-overlay-actions">
        {phase === "error" && <button type="button" className="text-btn" onClick={() => setRound(old => old + 1)}>다시 시도</button>}
        <button type="button" className="text-btn" onClick={onEmbed}>YouTube로 재생</button>
      </span>
    </div>}
  </>;
}
