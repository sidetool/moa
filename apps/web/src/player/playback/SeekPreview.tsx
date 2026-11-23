import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type Hls from 'hls.js';
import { PROFILE_HEADER, type PlaybackSession } from '@moa/shared';
import { Spinner } from '../../components/ui';
import { currentProfileId } from '../../lib/api';
import { cx } from '../../lib/format';
import { hasPreviewFragments, previewBufferedLevel, previewFragmentOptions } from './preview-fragments';
import { captureVideoStill } from './resume-scene';
import type { SeekFrames } from './seek-frames';

const DWELL_MS = 180;
const EXACT_SECONDS = .001;
// Only a frame stored for the exact requested time is final; 1ms away can already be across a cut.
const FINAL_SECONDS = 0;
// After the dwell a stand-in must be within one sheet cell, or the cache's nearby window without a sheet.
const NEAR_SECONDS = 8;
class PreviewBusy extends Error {}

async function jpeg(url: string, signal: AbortSignal, limit: number) {
  const profile = currentProfileId();
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    credentials: 'same-origin',
    headers: profile ? { [PROFILE_HEADER]: profile } : {}
  });
  if (response.status === 429) throw new PreviewBusy();
  if (!response.ok) throw new Error('preview-unavailable');
  const blob = await response.blob();
  if (blob.type !== 'image/jpeg' || !blob.size || blob.size > limit) throw new Error('invalid-preview');
  const image = new Image();
  const objectUrl = URL.createObjectURL(blob);
  try {
    image.src = objectUrl;
    await image.decode();
    signal.throwIfAborted();
    return objectUrl;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

// The preview video has its own decoder. A successful readback releases it immediately
// after at most one nearby frame from media it has already buffered.
function decodePreview(video: HTMLVideoElement, session: PlaybackSession, position: number, cache: SeekFrames, showVideo: () => void, failed: () => void) {
  let hls: Hls | undefined;
  let disposed = false;
  let target = position;
  let warming = false;
  let timer: number;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(timer);
    video.removeEventListener('loadedmetadata', seek);
    video.removeEventListener('loadeddata', loaded);
    video.removeEventListener('seeked', loaded);
    video.removeEventListener('error', fail);
    hls?.destroy();
    video.removeAttribute('src');
    video.load();
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    if (!warming) failed();
  };
  const seek = () => {
    if (!Number.isFinite(video.duration)) return;
    // A different length on the preview rendition cannot supply this timestamp.
    if (position > video.duration + EXACT_SECONDS) { fail(); return; }
    target = Math.min(position, Math.max(0, video.duration - EXACT_SECONDS));
    video.currentTime = target;
  };
  const loaded = () => {
    if (disposed || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - target) > EXACT_SECONDS) return;
    window.clearTimeout(timer);
    hls?.stopLoad();
    // Key the sample by what was asked for. The currentTime tolerance and end clamp above still apply.
    const frame = captureVideoStill(video, warming ? target : position);
    if (!frame) {
      if (warming) dispose();
      else showVideo(); // A paused native frame still works when canvas readback is unavailable.
      return;
    }
    cache.add(frame, true);
    const neighbor = position + 4;
    if (!warming && neighbor < video.duration && !cache.nearest(neighbor, FINAL_SECONDS, true)) {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= neighbor && neighbor + .25 < video.buffered.end(i)) {
          warming = true;
          target = neighbor;
          timer = window.setTimeout(dispose, 350);
          video.currentTime = neighbor;
          return;
        }
      }
    }
    dispose();
  };

  timer = window.setTimeout(fail, 10_000);
  video.addEventListener('loadedmetadata', seek);
  video.addEventListener('loadeddata', loaded);
  video.addEventListener('seeked', loaded);
  video.addEventListener('error', fail);
  void (async () => {
    try {
      const isHls = session.mime === 'application/vnd.apple.mpegurl' || /\.m3u8(?:\?|$)/i.test(session.url);
      if (isHls && (hasPreviewFragments(session.sessionId) || !video.canPlayType('application/vnd.apple.mpegurl'))) {
        const { default: HlsClass } = await import('hls.js');
        if (disposed) return;
        if (HlsClass.isSupported()) {
          hls = new HlsClass({
            ...previewFragmentOptions(session.sessionId, HlsClass.DefaultConfig.loader),
            startPosition: position, startLevel: previewBufferedLevel(session.sessionId, position) ?? 0, maxBufferLength: 2, maxMaxBufferLength: 4,
            backBufferLength: 0, maxBufferSize: 2 * 1024 * 1024
          });
          hls.on(HlsClass.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
          hls.loadSource(session.url);
          hls.attachMedia(video);
          return;
        }
        if (!video.canPlayType('application/vnd.apple.mpegurl')) { fail(); return; }
      }
      video.src = session.url;
    } catch { fail(); }
  })();
  return dispose;
}

export function SeekPreview({ session, seconds, duration, cache }: { session: PlaybackSession; seconds: number; duration: number; cache: SeekFrames }) {
  const video = useRef<HTMLVideoElement>(null);
  const at = Math.max(0, Math.min(seconds, duration - EXACT_SECONDS));
  const [nativeAt, setNativeAt] = useState<number>();
  const [failedAt, setFailedAt] = useState<number>();
  const [settledAt, setSettledAt] = useState<number>();
  useSyncExternalStore(cache.subscribe, cache.version);
  const sheet = session.previewSheet;
  const tile = sheet ? Math.floor(at / sheet.interval) : 0;
  const cells = sheet ? sheet.columns * sheet.rows : 1;
  const index = Math.floor(tile / cells);
  const sheetImage = cache.sheet(index);
  const precise = cache.nearest(at, FINAL_SECONDS, true);
  const frame = precise ?? cache.nearest(at);
  const exact = Boolean(precise);
  const server = Boolean(sheet) || session.mode !== 'direct';

  useEffect(() => {
    if (!sheet || sheetImage || exact) return;
    const abort = new AbortController();
    // Moving within a sheet keeps the same request and yields its other seven cells for free.
    const timer = window.setTimeout(() => {
      void jpeg(`${sheet.url}?index=${index}`, abort.signal, 512 * 1024)
        .then(url => { if (abort.signal.aborted) URL.revokeObjectURL(url); else cache.addSheet(index, url); })
        .catch(() => {});
    }, 40);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [cache, sheet, sheetImage, index, exact]);

  useEffect(() => {
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    setNativeAt(undefined);
    setFailedAt(undefined);
    let retry: number | undefined;
    const fetchPrecise = (attempt: number) => {
      void jpeg(`/api/playback/${encodeURIComponent(session.sessionId)}/preview?at=${at}&exact=1`, abort.signal, 64 * 1024)
        .then(image => { if (abort.signal.aborted) URL.revokeObjectURL(image); else cache.add({ image, position: at }, true); })
        .catch(error => {
          if (abort.signal.aborted) return;
          if (error instanceof PreviewBusy && attempt < 3) retry = window.setTimeout(() => fetchPrecise(attempt + 1), 300 * (2 ** attempt));
          else setFailedAt(at);
        });
    };
    const timer = window.setTimeout(() => {
      setSettledAt(at);
      if (cache.nearest(at, FINAL_SECONDS, true)) return;
      if (server) fetchPrecise(0);
      else if (video.current) {
        dispose = decodePreview(video.current, session, at, cache, () => setNativeAt(at), () => setFailedAt(at));
      }
    }, DWELL_MS);
    return () => { window.clearTimeout(timer); window.clearTimeout(retry); abort.abort(); dispose?.(); };
  }, [at, cache, session, server]);

  const sheetDistance = sheet && sheetImage ? at - tile * sheet.interval : Infinity;
  const showSheet = sheet && sheetImage && (!frame || sheetDistance < Math.abs(frame.position - at)) && !exact;
  const nativeReady = nativeAt === at;
  // Moving shows the nearby picture as is. Once the pointer rests, it only stands in, dimmed with a
  // spinner, until the exact frame replaces it; a distant one is dropped rather than shown as this time.
  const waiting = settledAt === at && !exact && !nativeReady;
  const nearbyAt = showSheet ? tile * sheet.interval : frame?.position;
  const nearby = nearbyAt !== undefined && Math.abs(nearbyAt - at) <= (sheet ? sheet.interval : NEAR_SECONDS);
  const image = waiting && !nearby ? undefined : showSheet ? sheetImage : frame?.image;
  const style: CSSProperties | undefined = showSheet ? {
    position: 'absolute', width: `${sheet.columns * 100}%`, height: `${sheet.rows * 100}%`, maxWidth: 'none',
    left: `${-(tile % sheet.columns) * 100}%`, top: `${-Math.floor(tile % cells / sheet.columns) * 100}%`
  } : undefined;
  if (failedAt === at && !exact) return null;
  return <span className={cx("seek-preview", waiting && image && "is-approximate")} data-frame-time={nativeReady ? at : image ? nearbyAt : undefined} aria-hidden="true">
    {image && !nativeReady && <img src={image} alt="" style={style} />}
    {!server && <video ref={video} muted playsInline preload="metadata" style={{ position: 'absolute', opacity: nativeReady ? 1 : 0 }} />}
    {(!image || waiting) && !nativeReady && <Spinner size={18} />}
  </span>;
}
