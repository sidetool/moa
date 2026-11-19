import type { createRenderer } from './anime4k-renderer';

type PresentationVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

function sameOriginMedia(src: string) {
  if (!src) return false;
  try {
    const url = new URL(src, document.baseURI);
    // MOA serves both local files and proxied remote sources on its own origin.
    return ['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin === location.origin;
  } catch { return false; }
}

/** Only the overlay is owned here. The engine retains the original video, audio, captions and clock. */
export function attachAnime4k(video: PresentationVideo, sessionUrl: string, onFailure: () => void) {
  if (!sameOriginMedia(sessionUrl) || typeof OffscreenCanvas === 'undefined' ||
      typeof video.requestVideoFrameCallback !== 'function' || typeof video.cancelVideoFrameCallback !== 'function') return;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let renderer: ReturnType<typeof createRenderer> | undefined;
  let create: typeof createRenderer | undefined;
  let loading = false;
  let frame: number | null = null;
  let previous: VideoFrameCallbackMetadata | undefined;
  let previousDropped = 0;
  let slowFrames = 0;
  let source = '', readable = false;

  function eligible() {
    if (video.currentSrc !== source) { source = video.currentSrc; readable = sameOriginMedia(source); }
    return readable && !video.srcObject && !video.mediaKeys && !video.paused && !video.seeking && !video.ended && !video.error &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoWidth <= 1920 &&
      video.videoHeight > 0 && video.videoHeight <= 1080 && video.ownerDocument === document && !document.hidden &&
      document.pictureInPictureElement !== video &&
      document.fullscreenElement !== video && !video.webkitDisplayingFullscreen && !video.webkitCurrentPlaybackTargetIsWireless &&
      (!video.webkitPresentationMode || video.webkitPresentationMode === 'inline') &&
      (!video.remote || video.remote.state === 'disconnected') &&
      !Array.from(video.textTracks).some(track => track.mode === 'showing');
  }

  function suspend() {
    if (frame !== null) video.cancelVideoFrameCallback(frame);
    frame = null;
    previous = undefined;
    slowFrames = 0;
    if (renderer) renderer.canvas.hidden = true;
  }
  function release() {
    suspend();
    const active = renderer;
    renderer = undefined;
    active?.destroy();
  }
  function stop() {
    listeners.abort();
    release();
  }
  function fail() {
    if (listeners.signal.aborted) return;
    onFailure();
    stop();
  }
  function draw(_now: number, metadata: VideoFrameCallbackMetadata) {
    frame = null;
    if (listeners.signal.aborted) return;
    if (!eligible() || !create) { suspend(); return; }
    try {
      if (renderer && (renderer.width !== video.videoWidth || renderer.height !== video.videoHeight)) release();
      renderer ??= create(video, fail);
      const count = previous ? Math.max(1, metadata.presentedFrames - previous.presentedFrames) : 1;
      const frameMs = previous ? (metadata.mediaTime - previous.mediaTime) * 1000 / (count * video.playbackRate) : 1000 / 30;
      const budget = Math.max(8, Math.min(100, frameMs));
      const start = performance.now();
      const gpuMs = renderer.draw(budget);
      const dropped = video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
      if (previous) {
        const slow = Math.max(performance.now() - start, gpuMs) > budget * 0.8 || count > 1 || dropped > previousDropped;
        slowFrames = slow ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames >= 6) { fail(); return; }
      }
      previous = metadata;
      previousDropped = dropped;
      frame = video.requestVideoFrameCallback(draw);
    } catch { fail(); }
  }
  function refresh() {
    if (listeners.signal.aborted) return;
    if (!eligible()) { suspend(); return; }
    if (create) {
      if (frame === null) frame = video.requestVideoFrameCallback(draw);
    } else if (!loading) {
      loading = true;
      void import('./anime4k-renderer').then(module => {
        create = module.createRenderer;
        refresh();
      }).catch(fail);
    }
  }

  for (const event of ['playing', 'seeked', 'loadeddata', 'resize', 'leavepictureinpicture', 'webkitendfullscreen',
    'webkitpresentationmodechanged', 'webkitcurrentplaybacktargetiswirelesschanged']) video.addEventListener(event, refresh, options);
  for (const event of ['pause', 'seeking', 'waiting', 'ended', 'enterpictureinpicture', 'webkitbeginfullscreen']) video.addEventListener(event, suspend, options);
  for (const event of ['loadstart', 'emptied', 'error']) video.addEventListener(event, release, options);
  for (const event of ['change', 'addtrack', 'removetrack']) video.textTracks.addEventListener(event, refresh, options);
  for (const event of ['connecting', 'connect', 'disconnect']) video.remote?.addEventListener(event, refresh, options);
  document.addEventListener('visibilitychange', refresh, options);
  document.addEventListener('fullscreenchange', refresh, options);
  refresh();
  return stop;
}
