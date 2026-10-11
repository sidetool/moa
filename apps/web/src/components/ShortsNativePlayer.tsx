import type Hls from "hls.js";
import { AlertCircle, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ShortsNativeSession } from "../api/shorts";
import { ApiError } from "../lib/api";
import { NativePool } from "../lib/shorts-native-pool";
import { ShortsCaptions } from "./ShortsCaptions";
import { useWatchTime, type ShortsControl, type ShortsSession } from "./ShortsPlayer";
import { Spinner } from "./ui";

const PREPARE_TIMEOUT = 85_000; // the server may try two references for up to 40s each
const READY_TIMEOUT = 20_000; // prepared media that never starts is treated as failed
const HLS = "application/vnd.apple.mpegurl";

const HOLD_MS = 450;
/** Index for a fixed quality: the tallest variant at or under `target`, else the shortest; first wins ties. */
export function levelFor(levels: Array<{ height?: number }>, target: number) {
  let fit = -1, low = -1;
  levels.forEach((level, index) => {
    const h = level.height || 0;
    if (h <= target && (fit < 0 || h > (levels[fit].height || 0))) fit = index;
    if (low < 0 || h < (levels[low].height || 0)) low = index;
  });
  return fit >= 0 ? fit : low;
}

type Phase = "prepare" | "loading" | "ready" | "blocked" | "unavailable" | "error";

/** Experimental: the server prepares the trailer and MOA plays it in its own <video>. Mounted only for the
 *  settled, visible work; unmounting cancels preparation, stops the media and releases the lease. Failures
 *  wait for the person (retry or the YouTube player) and never advance by themselves. */
export function ShortsNativePlayer({ itemKey, title, session, pool, ahead, quality, control, muted, onMuted, onBlocked, onPlaying, onStarted, onEnded, onEmbed }: {
  itemKey: string; title: string; session: ShortsSession; pool: NativePool; ahead: string[]; control: React.RefObject<ShortsControl | null>;
  /** Profile setting; applies to HLS only (a single MP4 has one quality). */
  quality: "auto" | "360p" | "480p" | "720p";
  muted: boolean; onMuted: (muted: boolean) => void; onBlocked: (blocked: boolean) => void;
  /** `onPlaying` follows every resume; `onStarted` fires once per attempt (prefetch hangs off it). */
  onPlaying: () => void; onStarted: () => void; onEnded: () => void; onEmbed: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const seek = useRef<HTMLInputElement>(null);
  const [time, setTime] = useState({ at: 0, duration: 0 });
  const dragging = useRef(false);
  const [prepared, setPrepared] = useState<ShortsNativeSession | null>(null);
  const [places, setPlaces] = useState<{ rail: HTMLElement | null; info: HTMLElement | null }>({ rail: null, info: null });
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const [fast, setFast] = useState(false);
  const hold = useRef<{ timer: number; x: number; y: number; prev: number | null } | null>(null);
  const suppressClick = useRef(false);
  const startedRef = useRef(false);
  const aheadRef = useRef(ahead);
  aheadRef.current = ahead;
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>("prepare");
  const [paused, setPaused] = useState(false);
  const { since, flush } = useWatchTime(itemKey, session);
  const callbacks = useRef({ onMuted, onBlocked, onPlaying, onStarted, onEnded });
  callbacks.current = { onMuted, onBlocked, onPlaying, onStarted, onEnded };
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
    let hls: Hls | null = null, stopped = false, used = false;
    attempt.current += 1;
    live.current = true;
    startedRef.current = false;
    setPrepared(null); setTime({ at: 0, duration: 0 });
    const ticket = pool.take(itemKey, aheadRef.current);
    const prepareTimer = window.setTimeout(() => ticket.abort.abort(), PREPARE_TIMEOUT);
    // Ends this attempt completely: no request, no media network, no lease, no later events.
    const stop = () => {
      if (stopped) return;
      stopped = true; live.current = false;
      setPrepared(null); endHold();
      window.clearTimeout(prepareTimer); window.clearTimeout(readyTimer.current);
      flush();
      el.removeEventListener("error", onError);
      try { hls?.destroy(); } catch { /* already gone */ }
      hls = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
      // Never used (e.g. passed straight through): back to the slot. Used or failed: released.
      if (used) NativePool.close(ticket); else pool.giveBack(ticket);
    };
    const fail = (next: "unavailable" | "error") => {
      if (stopped) return;
      used = true; stop(); session.failed.add(itemKey); setPhase(next);
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
          hls.on(HlsClass.Events.MANIFEST_PARSED, (_event, data) => {
            // Auto: start at ≤360p (else the shortest) and adapt. A fixed setting holds its level from the start.
            if (!hls || !data.levels.length) return;
            const fixed = qualityRef.current !== "auto";
            const index = levelFor(data.levels, fixed ? Number.parseInt(qualityRef.current, 10) : 360);
            hls.startLevel = index;
            if (fixed) hls.nextLevel = index;
          });
          hls.loadSource(prepared.url);
          hls.attachMedia(el);
        } else if (el.canPlayType(HLS)) el.src = prepared.url;
        else return fail("error");
      } else el.src = prepared.url;
      void play();
    };
    ticket.promise.then(prepared => {
      if (stopped) return; // whoever holds the ticket now releases it
      window.clearTimeout(prepareTimer);
      used = true;
      setPhase("loading");
      setPrepared(prepared);
      start(prepared).catch(() => fail("error"));
    }, error => fail(error instanceof ApiError && error.status === 422 ? "unavailable" : "error"));
    return stop;
  }, [itemKey, round]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (video.current) video.current.muted = muted; }, [muted]);
  // Press and hold: 2× while held. Any release, cancel, drag, scroll or hiding restores the previous rate.
  function endHold() {
    const current = hold.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    if (current.prev !== null && video.current) video.current.playbackRate = current.prev;
    hold.current = null;
    setFast(false);
  }
  useEffect(() => {
    const feed = video.current?.closest(".shorts");
    const end = () => endHold();
    const onVisibility = () => { if (document.visibilityState !== "visible") endHold(); };
    feed?.addEventListener("scroll", end, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", end);
    return () => { feed?.removeEventListener("scroll", end); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("blur", end); endHold(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const holdHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLVideoElement>) => {
      suppressClick.current = false;
      endHold();
      if (!event.isPrimary || event.button > 0 || !live.current) return;
      const start = { x: event.clientX, y: event.clientY };
      hold.current = { ...start, prev: null, timer: window.setTimeout(() => {
        const el = video.current, current = hold.current;
        if (!el || !current || el.paused || !live.current) return;
        current.prev = el.playbackRate;
        el.playbackRate = 2;
        suppressClick.current = true; // the release after a hold is not a tap
        setFast(true);
      }, HOLD_MS) };
    },
    onPointerMove: (event: React.PointerEvent<HTMLVideoElement>) => {
      const current = hold.current;
      if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) endHold();
    },
    onPointerUp: endHold, onPointerCancel: endHold, onPointerLeave: endHold, onLostPointerCapture: endHold,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault()
  };
  // The caption menu lives in this slide's action rail; captions keep clear of its title block.
  useEffect(() => {
    const slide = video.current?.closest(".shorts-slide");
    setPlaces({ rail: slide?.querySelector<HTMLElement>(".shorts-rail-cc") ?? null, info: slide?.querySelector<HTMLElement>(".shorts-info") ?? null });
  }, []);
  // Dragging the seek bar is not a swipe: keep touch and wheel from reaching the feed's intent tracking.
  useEffect(() => {
    const el = seek.current;
    if (!el) return;
    const stop = (event: Event) => event.stopPropagation();
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("wheel", stop, { passive: true });
    return () => { el.removeEventListener("touchstart", stop); el.removeEventListener("wheel", stop); };
  }, []);
  useEffect(() => { callbacks.current.onBlocked(phase === "blocked"); }, [phase]);
  useEffect(() => {
    control.current = { play: () => { setPhase(old => old === "blocked" ? "loading" : old); void play(); } };
    return () => { control.current = null; callbacks.current.onBlocked(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = phase === "unavailable" || phase === "error";
  return <>
    <video ref={video} className={phase === "ready" || phase === "blocked" ? "shorts-native-video is-on" : "shorts-native-video"} playsInline preload="auto" aria-label={`${title} 예고편`}
      {...holdHandlers}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        const el = video.current; if (!el || !live.current) return; if (el.paused) void play(); else el.pause();
      }}
      onPlaying={() => {
        if (!live.current) return;
        window.clearTimeout(readyTimer.current);
        setPhase("ready"); setPaused(false); session.failed.delete(itemKey); callbacks.current.onPlaying();
        if (!startedRef.current) { startedRef.current = true; callbacks.current.onStarted(); }
        if (since.current === null && document.visibilityState === "visible") since.current = performance.now();
      }}
      onPause={() => { flush(); if (live.current) setPaused(true); }}
      onWaiting={flush}
      onEnded={() => { flush(); if (live.current) callbacks.current.onEnded(); }}
      onLoadedMetadata={event => setTime({ at: event.currentTarget.currentTime, duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0 })}
      onDurationChange={event => { const d = event.currentTarget.duration; setTime(old => ({ ...old, duration: Number.isFinite(d) ? d : 0 })); }}
      onTimeUpdate={event => { const at = event.currentTarget.currentTime; if (!dragging.current) setTime(old => ({ ...old, at })); }} />
    {/* Seeking keeps the current play/pause state; the value is clamped to the media. */}
    <input ref={seek} type="range" className="shorts-seek" aria-label="재생 위치" min={0} max={time.duration || 0} step={0.1} value={Math.min(time.at, time.duration || 0)} disabled={!time.duration || !prepared}
      style={{ "--seek": `${time.duration ? (Math.min(time.at, time.duration) / time.duration) * 100 : 0}%` } as React.CSSProperties}
      onPointerDown={() => { dragging.current = true; }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }} onBlur={() => { dragging.current = false; }}
      onChange={event => {
        const el = video.current, value = Number(event.currentTarget.value);
        if (!el || !live.current || !Number.isFinite(value) || !time.duration) return;
        const at = Math.max(0, Math.min(time.duration - 0.05, value));
        el.currentTime = at;
        setTime(old => ({ ...old, at }));
      }} />
    {prepared && video.current && <ShortsCaptions video={video.current} prepared={prepared} rail={places.rail} info={places.info} />}
    {fast && <span className="shorts-fast" aria-hidden="true">2×</span>}
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
