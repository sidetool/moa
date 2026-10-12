import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { PlaybackSession } from '@moa/shared';
import { Spinner } from '../components/ui';

export function SeekPreview({ session, seconds }: { session: PlaybackSession; seconds: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const target = useRef(seconds);
  const deadline = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [image, setImage] = useState('');
  const at = Math.min(Math.max(0, Math.floor(seconds / 2) * 2), session.duration > 0 ? Math.max(0, session.duration - .01) : Infinity);
  target.current = at;
  const server = session.mode !== 'direct';

  useEffect(() => {
    if (!server) return;
    const abort = new AbortController();
    let blob = '';
    setImage(''); setFailed(false);
    const timer = window.setTimeout(() => {
      fetch(`/api/playback/${encodeURIComponent(session.sessionId)}/preview?at=${at}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]), credentials: 'same-origin' })
        .then(response => response.ok ? response.blob() : Promise.reject(new Error('preview')))
        .then(value => { if (!abort.signal.aborted) { blob = URL.createObjectURL(value); setImage(blob); } })
        .catch(() => { if (!abort.signal.aborted) setFailed(true); });
    }, 200);
    return () => { window.clearTimeout(timer); abort.abort(); if (blob) URL.revokeObjectURL(blob); };
  }, [server, session.sessionId, at]);

  useEffect(() => {
    const element = video.current;
    if (server || failed || !element) return;
    let stopped = false;
    const seek = () => { if (Number.isFinite(element.duration)) element.currentTime = Math.min(target.current, Math.max(0, element.duration - .1)); };
    const loaded = () => {
      if (element.readyState >= 2 && Math.abs(element.currentTime - target.current) < 2) { window.clearTimeout(deadline.current); setReady(true); hls.current?.stopLoad(); }
    };
    const error = () => setFailed(true);
    element.addEventListener('loadedmetadata', seek);
    element.addEventListener('loadeddata', loaded);
    element.addEventListener('seeked', loaded);
    element.addEventListener('error', error);
    const timer = window.setTimeout(async () => {
      const isHls = session.mime === 'application/vnd.apple.mpegurl' || /\.m3u8(?:\?|$)/.test(session.url);
      if (!isHls || element.canPlayType('application/vnd.apple.mpegurl')) { element.src = session.url; return; }
      try {
        const { default: HlsClass } = await import('hls.js');
        if (stopped) return;
        if (!HlsClass.isSupported()) { setFailed(true); return; }
        const instance = new HlsClass({ startPosition: target.current, startLevel: 0, maxBufferLength: 2, maxMaxBufferLength: 4, backBufferLength: 0, maxBufferSize: 2 * 1024 * 1024 });
        hls.current = instance;
        instance.on(HlsClass.Events.ERROR, (_, data) => { if (data.fatal) { setFailed(true); instance.stopLoad(); } });
        instance.loadSource(session.url); instance.attachMedia(element);
      } catch { if (!stopped) setFailed(true); }
    }, 200);
    return () => {
      stopped = true; window.clearTimeout(timer); window.clearTimeout(deadline.current);
      element.removeEventListener('loadedmetadata', seek); element.removeEventListener('loadeddata', loaded); element.removeEventListener('seeked', loaded); element.removeEventListener('error', error);
      hls.current?.destroy(); hls.current = null;
      element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [server, failed, session.sessionId, session.url, session.mime]);

  useEffect(() => {
    if (server || failed) return;
    setReady(false);
    deadline.current = window.setTimeout(() => setFailed(true), 10_000);
    const timer = window.setTimeout(() => {
      const element = video.current;
      if (!element || element.readyState < 1 || !Number.isFinite(element.duration)) return;
      if (Math.abs(element.currentTime - at) < .1 && element.readyState >= 2) { window.clearTimeout(deadline.current); setReady(true); return; }
      hls.current?.startLoad(at);
      element.currentTime = Math.min(at, Math.max(0, element.duration - .1));
    }, 200);
    return () => { window.clearTimeout(timer); window.clearTimeout(deadline.current); };
  }, [server, failed, at]);

  if (failed) return null;
  return <span className="seek-preview" aria-hidden="true">
    {server ? image && <img src={image} alt="" /> : <video ref={video} muted playsInline preload="metadata" style={{ opacity: ready ? 1 : 0 }} />}
    {!(server ? image : ready) && <Spinner size={18} />}
  </span>;
}
