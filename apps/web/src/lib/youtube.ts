/** Minimal typing for the official YouTube IFrame Player API (only what the trailer dialog uses). */
export interface YouTubePlayer {
  playVideo(): void;
  destroy(): void;
}
export interface YouTubeEvent { target: YouTubePlayer; data?: number }
export interface YouTubeApi {
  Player: new (element: HTMLIFrameElement, options: {
    host?: string;
    events: Partial<Record<"onReady" | "onError" | "onStateChange" | "onAutoplayBlocked", (event: YouTubeEvent) => void>>;
  }) => YouTubePlayer;
}
declare global {
  interface Window { YT?: Partial<YouTubeApi>; onYouTubeIframeAPIReady?: () => void }
}

export const YOUTUBE_PLAYING = 1;
const API_URL = "https://www.youtube.com/iframe_api";
const KEY = /^[A-Za-z0-9_-]{11}$/;

/** Ordered, valid, unique candidates: the new list first, then the legacy single key. */
export function trailerKeys(media: { trailers?: string[]; trailer?: string }) {
  const keys: string[] = [];
  for (const key of [...(media.trailers ?? []), media.trailer]) if (typeof key === "string" && KEY.test(key) && !keys.includes(key) && keys.length < 5) keys.push(key);
  return keys;
}

export const youtubeEmbedUrl = (key: string) => {
  const params = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1", enablejsapi: "1", origin: location.origin });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?${params}`;
};

/** Per-video errors: this candidate can't play here, try the next one. 153 (missing referrer/identity),
 *  5 (HTML5 player) and anything unknown point at the environment, so they stop instead of burning candidates. */
export const isVideoUnavailable = (code: number | undefined) => code === 2 || code === 100 || code === 101 || code === 150;

let loading: Promise<YouTubeApi> | null = null;

/** Loads the API script once. A failure or timeout clears the cache so a later open can retry. */
export function loadYouTubeApi(timeoutMs = 10_000): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT as YouTubeApi);
  loading ??= new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    let settled = false;
    // Settles once; a late callback from an abandoned attempt can't touch a newer attempt's script or handler.
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
      if (error || !window.YT?.Player) { loading = null; script.remove(); reject(error ?? new Error("youtube-api-invalid")); }
      else resolve(window.YT as YouTubeApi);
    };
    // Another library's handler failing must not leave this load hanging.
    const ready = () => { try { previous?.(); } finally { finish(null); } };
    const timer = window.setTimeout(() => finish(new Error("youtube-api-timeout")), timeoutMs);
    window.onYouTubeIframeAPIReady = ready;
    script.src = API_URL;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onerror = () => finish(new Error("youtube-api-load"));
    document.head.append(script);
  });
  return loading;
}
