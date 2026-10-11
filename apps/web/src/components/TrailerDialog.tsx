import { AlertCircle, Play, SkipForward, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isVideoUnavailable, loadYouTubeApi, youtubeEmbedUrl, YOUTUBE_PLAYING, type YouTubePlayer } from "../lib/youtube";
import { IconButton, Spinner } from "./ui";

const READY_TIMEOUT = 15_000;

/** `env` = the page can't run YouTube embeds at all (API blocked, referrer/identity error): skipping won't help. */
type Phase = "loading" | "ready" | "blocked" | "all-failed" | "env";

/** Plays ordered YouTube candidates through the official IFrame API. A candidate that reports it can't
 *  play here (region, embedding off, removed) hands over to the next one, each tried at most once.
 *  Nothing about failures is stored; every open starts fresh on this device. */
export function TrailerDialog({ keys, title, onClose }: { keys: string[]; title: string; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0); // bumps on "다시 시도" so the same candidate remounts
  const [phase, setPhase] = useState<Phase>("loading");
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const failedRef = useRef(failed);
  failedRef.current = failed;

  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // One player per candidate. `live` turns false on switch/close, so late events from an old player are ignored.
  useEffect(() => {
    let live = true;
    const element = frame.current;
    setPhase("loading");
    // Env outcomes end this candidate too (live=false), so a late PLAYING/autoplay event can't revive it.
    const readyTimer = window.setTimeout(() => { if (live) { live = false; setPhase("env"); } }, READY_TIMEOUT);
    const advance = () => {
      const next = new Set(failedRef.current).add(index);
      setFailed(next);
      const later = keys.findIndex((_, i) => !next.has(i) && i > index);
      const any = later >= 0 ? later : keys.findIndex((_, i) => !next.has(i));
      if (any >= 0) setIndex(any); else setPhase("all-failed");
    };
    const settle = () => window.clearTimeout(readyTimer);
    const envError = () => { if (live) { live = false; settle(); setPhase("env"); } };
    loadYouTubeApi().then(YT => {
      if (!live || !element) return;
      try { player.current = new YT.Player(element, {
        host: "https://www.youtube-nocookie.com",
        events: {
          onReady: () => { if (live) { settle(); setPhase(old => old === "loading" ? "ready" : old); } },
          onStateChange: event => { if (live && event.data === YOUTUBE_PLAYING) { settle(); setPhase("ready"); } },
          // Autoplay policy, not an unavailable video: ask for a tap instead of skipping.
          onAutoplayBlocked: () => { if (live) { settle(); setPhase("blocked"); } },
          onError: event => {
            if (!live) return;
            settle();
            live = false; // this candidate is done; ignore anything else it sends
            if (isVideoUnavailable(event.data)) advance(); else setPhase("env");
          }
        }
      }); } catch { envError(); }
    }, envError);
    return () => {
      live = false;
      window.clearTimeout(readyTimer);
      try { player.current?.destroy(); } catch { /* player already gone */ }
      player.current = null;
    };
  }, [index, round, keys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = keys[index];
  const others = keys.length > 1;
  const pickOther = () => { setIndex((index + 1) % keys.length); };
  const restart = () => { setFailed(new Set()); setIndex(0); setRound(old => old + 1); setPhase("loading"); };

  return <div className="sheet-backdrop trailer-backdrop" onClick={onClose}>
    <div className="trailer-dialog" role="dialog" aria-modal="true" aria-label={`${title} 예고편`} onClick={event => event.stopPropagation()}>
      <div className="trailer">
        {key && phase !== "all-failed" && phase !== "env" && <iframe key={`${round}:${index}:${key}`} ref={frame} src={youtubeEmbedUrl(key)} title={`${title} 예고편`}
          referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />}
        {phase === "loading" && <div className="trailer-overlay is-quiet"><Spinner size={28} /></div>}
        {phase === "blocked" && <div className="trailer-overlay is-quiet">
          <button type="button" className="trailer-play" onClick={() => { player.current?.playVideo(); setPhase("ready"); }}><Play size={22} fill="currentColor" />재생</button>
          <small>브라우저가 자동 재생을 막았어요.</small>
        </div>}
        {phase === "all-failed" && <div className="trailer-overlay" role="alert">
          <AlertCircle size={28} />
          <b>예고편을 재생하지 못했어요</b>
          <small>{keys.length > 1 ? `예고편 ${keys.length}개 모두 ` : ""}지역 제한, 퍼가기 제한, 삭제·비공개 등으로 재생하지 못했어요.</small>
          <span className="trailer-overlay-actions"><button type="button" className="text-btn" onClick={restart}>다시 시도</button></span>
        </div>}
        {phase === "env" && <div className="trailer-overlay" role="alert">
          <AlertCircle size={28} />
          <b>YouTube 플레이어를 열지 못했어요</b>
          <small>네트워크·브라우저 확장·보안 설정이 YouTube 연결을 막았을 수 있어요.</small>
          <span className="trailer-overlay-actions"><button type="button" className="text-btn" onClick={restart}>다시 시도</button></span>
        </div>}
        <IconButton className="trailer-close" label="닫기" onClick={onClose}><X size={22} /></IconButton>
      </div>
      <div className="trailer-bar">
        <span className="trailer-count">{others ? `예고편 ${index + 1}/${keys.length}` : "예고편"}</span>
        {others && phase !== "all-failed" && phase !== "env" && <button type="button" className="trailer-next" onClick={pickOther}><SkipForward size={16} />다른 예고편</button>}
      </div>
    </div>
  </div>;
}
