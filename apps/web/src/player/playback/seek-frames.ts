import { useEffect, useMemo, type RefObject } from 'react';
import type { PlaybackSession } from '@moa/shared';
import { captureVideoStill, type VideoStill } from './resume-scene';

const WATCH_INTERVAL = 8;
const FRAME_LIMIT = 160;
const SHEET_LIMIT = 4;

// Both lists belong to one playback source. Only server JPEGs allocate object URLs.
function release(image: string) {
  if (image.startsWith('blob:')) URL.revokeObjectURL(image);
}

type SeekFrame = VideoStill & { precise: boolean };

export class SeekFrames {
  private frames: SeekFrame[] = [];
  private sheets = new Map<number, string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  version = () => this.revision;
  private changed() {
    this.revision++;
    this.listeners.forEach(listener => listener());
  }
  nearest(position: number, radius = WATCH_INTERVAL, preciseOnly = false): SeekFrame | undefined {
    let nearest: SeekFrame | undefined;
    for (const frame of this.frames) {
      if (preciseOnly && !frame.precise) continue;
      const difference = Math.abs(frame.position - position);
      if (difference <= radius) { nearest = frame; radius = difference; }
    }
    return nearest;
  }
  add(frame: VideoStill, precise: boolean) {
    this.frames.push({ ...frame, precise });
    if (this.frames.length > FRAME_LIMIT) release(this.frames.shift()!.image);
    this.changed();
  }
  sheet(index: number) { return this.sheets.get(index); }
  addSheet(index: number, image: string) {
    this.sheets.set(index, image);
    if (this.sheets.size > SHEET_LIMIT) {
      const oldest = this.sheets.keys().next().value!;
      release(this.sheets.get(oldest)!);
      this.sheets.delete(oldest);
    }
    this.changed();
  }
  clear() {
    this.frames.forEach(frame => release(frame.image));
    this.sheets.forEach(release);
    this.frames = [];
    this.sheets.clear();
    this.changed();
  }
}

export function useSeekFrames(session: PlaybackSession | null, media: RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const cache = useMemo(() => new SeekFrames(), [session?.sessionId, session?.url]);
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => {
    const video = media.current;
    if (!enabled || !video || !session || session.live || session.previewSheet) return;
    let callback: number | undefined;
    let lastBucket = -1;
    let readable = true;

    const eligible = () => readable && !video.ownerDocument.hidden && !video.seeking && !video.ended
      && !video.mediaKeys && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    const capture = (position: number) => {
      if (!eligible() || Math.abs(video.currentTime - position) > 1) return;
      lastBucket = Math.floor(position / WATCH_INTERVAL);
      if (cache.nearest(position, WATCH_INTERVAL / 2)) return;
      const frame = captureVideoStill(video, position);
      if (frame) cache.add(frame, false);
      else readable = false;
    };
    const sample = () => {
      if (!readable || callback !== undefined || Math.floor(video.currentTime / WATCH_INTERVAL) === lastBucket) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        callback = video.requestVideoFrameCallback((_, frame) => {
          callback = undefined;
          capture(frame.mediaTime);
        });
      } else capture(video.currentTime);
    };
    // Wait for events from the newly attached media. Never read or seek into buffered ranges here.
    video.addEventListener('loadedmetadata', sample);
    video.addEventListener('loadeddata', sample);
    video.addEventListener('timeupdate', sample);
    return () => {
      video.removeEventListener('loadedmetadata', sample);
      video.removeEventListener('loadeddata', sample);
      video.removeEventListener('timeupdate', sample);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    };
  }, [session, media, enabled, cache]);
  return cache;
}
