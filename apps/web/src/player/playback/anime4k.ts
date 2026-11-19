import type { Anime4kFailure, Anime4kStatus } from './Anime4kStatusNote';
import type { createRenderer } from './anime4k-renderer';

type PresentationVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

const IDLE_RELEASE_MS = 3000;

function sameOriginMedia(src: string) {
  if (!src) return false;
  try {
    const url = new URL(src, document.baseURI);
    // MOA serves both local files and proxied remote sources on its own origin.
    return ['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin === location.origin;
  } catch { return false; }
}

/** Only the overlay is owned here. The engine retains the original video, audio, captions and clock. */
export function attachAnime4k(video: PresentationVideo, sessionUrl: string, onStatus: (status: Anime4kStatus) => void) {
  if (!sameOriginMedia(sessionUrl)) { onStatus('media'); return; }
  if (typeof OffscreenCanvas === 'undefined' || typeof video.requestVideoFrameCallback !== 'function' ||
      typeof video.cancelVideoFrameCallback !== 'function') { onStatus('unsupported'); return; }
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let renderer: ReturnType<typeof createRenderer>;
  let create: typeof createRenderer | undefined;
  let loading = false;
  let frame: number | null = null;
  let idleRelease: number | undefined;
  let previous: VideoFrameCallbackMetadata | undefined;
  let previousDropped = 0;
  let slowFrames = 0;
  let source = '', readable = false;

  let status: Anime4kStatus | undefined;
  function report(next: Anime4kStatus) {
    if (status === next) return;
    status = next;
    onStatus(next);
  }
  function fallback(): Anime4kStatus | undefined {
    if (video.error) return 'videoError';
    if (video.ownerDocument !== document || document.pictureInPictureElement === video ||
        video.webkitPresentationMode === 'picture-in-picture') return 'pip';
    if (video.webkitCurrentPlaybackTargetIsWireless || (video.remote && video.remote.state !== 'disconnected')) return 'remote';
    if (document.fullscreenElement === video || video.webkitDisplayingFullscreen ||
        (video.webkitPresentationMode && video.webkitPresentationMode !== 'inline')) return 'fullscreen';
    if (document.hidden) return 'hidden';
    if (video.currentSrc !== source) { source = video.currentSrc; readable = sameOriginMedia(source); }
    if (video.srcObject || video.mediaKeys || (source && !readable)) return 'media';
    if (video.videoWidth > 1920 || video.videoHeight > 1080) return 'resolution';
    if (video.ended) return 'ended';
    if (Array.from(video.textTracks).some(track => track.mode === 'showing')) return 'captions';
    if (video.seeking) return 'seeking';
    if (!source || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return 'waiting';
    if (video.paused) return 'paused';
  }

  function cancelIdleRelease() {
    if (idleRelease === undefined) return;
    window.clearTimeout(idleRelease);
    idleRelease = undefined;
  }
  function releaseRenderer() {
    cancelIdleRelease();
    previous = undefined;
    slowFrames = 0;
    const active = renderer;
    renderer = undefined;
    active?.destroy();
  }
  function suspend(reason: Anime4kStatus) {
    if (frame !== null) video.cancelVideoFrameCallback(frame);
    frame = null;
    previous = undefined;
    slowFrames = 0;
    if (renderer) {
      if (reason === 'paused' || reason === 'seeking' || reason === 'waiting') {
        renderer.canvas.hidden = true;
        // Keep allocations for brief interruptions. Only a delivered frame ends the idle period.
        idleRelease ??= window.setTimeout(releaseRenderer, IDLE_RELEASE_MS);
      } else {
        releaseRenderer();
      }
    }
    report(reason);
  }
  function stop() {
    listeners.abort();
    if (frame !== null) video.cancelVideoFrameCallback(frame);
    frame = null;
    releaseRenderer();
  }
  function fail(reason: Anime4kFailure) {
    if (listeners.signal.aborted) return;
    report(reason);
    stop();
  }
  function draw(_now: number, metadata: VideoFrameCallbackMetadata) {
    frame = null;
    if (listeners.signal.aborted) return;
    const reason = fallback();
    if (reason) { suspend(reason); return; }
    if (!create) return;
    try {
      cancelIdleRelease();
      if (renderer && (renderer.width !== video.videoWidth || renderer.height !== video.videoHeight)) releaseRenderer();
      renderer ??= create(video, () => fail('filterError'));
      if (!renderer) { fail('unsupported'); return; }
      const count = previous ? Math.max(1, metadata.presentedFrames - previous.presentedFrames) : 1;
      const frameMs = previous ? (metadata.mediaTime - previous.mediaTime) * 1000 / (count * video.playbackRate) : 1000 / 30;
      const budget = Math.max(8, Math.min(100, frameMs));
      const start = performance.now();
      const gpuMs = renderer.draw(budget);
      if (gpuMs === null) { fail('performance'); return; }
      const dropped = video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
      if (previous) {
        const slow = Math.max(performance.now() - start, gpuMs) > budget * 0.8 || count > 1 || dropped > previousDropped;
        slowFrames = slow ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames >= 6) { fail('performance'); return; }
      }
      report('active');
      previous = metadata;
      previousDropped = dropped;
      frame = video.requestVideoFrameCallback(draw);
    } catch { fail('filterError'); }
  }
  function refresh() {
    if (listeners.signal.aborted) return;
    const reason = fallback();
    if (reason) { suspend(reason); return; }
    if (renderer && (renderer.width !== video.videoWidth || renderer.height !== video.videoHeight)) releaseRenderer();
    if (!renderer || renderer.canvas.hidden) report('preparing');
    if (create) {
      if (frame === null) frame = video.requestVideoFrameCallback(draw);
    } else if (!loading) {
      loading = true;
      void import('./anime4k-renderer').then(module => {
        create = module.createRenderer;
        refresh();
      }).catch(() => fail('filterError'));
    }
  }

  for (const event of ['playing', 'seeked', 'loadeddata', 'resize', 'leavepictureinpicture', 'webkitendfullscreen',
    'webkitpresentationmodechanged', 'webkitcurrentplaybacktargetiswirelesschanged']) video.addEventListener(event, refresh, options);
  const suspendEvents = { pause: 'paused', seeking: 'seeking', waiting: 'waiting', ended: 'ended',
    enterpictureinpicture: 'pip', webkitbeginfullscreen: 'fullscreen' } as const;
  for (const [event, reason] of Object.entries(suspendEvents)) {
    video.addEventListener(event, () => suspend(fallback() ?? reason), options);
  }
  for (const event of ['loadstart', 'emptied', 'error']) {
    video.addEventListener(event, () => { releaseRenderer(); suspend(event === 'error' ? 'videoError' : 'waiting'); }, options);
  }
  for (const event of ['change', 'addtrack', 'removetrack']) video.textTracks.addEventListener(event, refresh, options);
  for (const event of ['connecting', 'connect', 'disconnect']) video.remote?.addEventListener(event, refresh, options);
  document.addEventListener('visibilitychange', refresh, options);
  document.addEventListener('fullscreenchange', refresh, options);
  refresh();
  return stop;
}
