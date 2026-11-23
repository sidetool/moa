// hls.js transfers segment buffers to its demux worker. Keep a small independent copy for
// the preview decoder, scoped to this playback and discarded when the main engine detaches.
import type { FragmentLoaderContext, HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';

const BYTE_LIMIT = 12 * 1024 * 1024;
const ENTRY_LIMIT = 32;

interface Segment {
  bytes: ArrayBuffer;
  start: number;
  end: number;
  level: number;
}

class FragmentWindow {
  segments = new Map<string, Segment>();
  size = 0;

  remember(key: string, context: FragmentLoaderContext, data: unknown) {
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > BYTE_LIMIT / 2 || this.segments.has(key)) return;
    if (context.rangeEnd && data.byteLength !== context.rangeEnd - (context.rangeStart ?? 0)) return;
    while (this.segments.size >= ENTRY_LIMIT || this.size + data.byteLength > BYTE_LIMIT) {
      const first = this.segments.entries().next().value;
      if (!first) break;
      this.size -= first[1].bytes.byteLength;
      this.segments.delete(first[0]);
    }
    const { start, end } = context.frag;
    const level = context.frag.type === 'main' && typeof context.frag.sn === 'number' ? context.frag.level : -1;
    this.segments.set(key, { bytes: data.slice(0), start, end, level });
    this.size += data.byteLength;
  }
}

const windows = new Map<string, FragmentWindow>();

function fragmentKey(context: FragmentLoaderContext) {
  const { frag } = context;
  if (context.part || frag.encrypted || context.resetIV || context.responseType !== 'arraybuffer') return;
  // The same file can contain several byte ranges or appear on both sides of a discontinuity.
  return JSON.stringify([context.url, context.rangeStart, context.rangeEnd, frag.cc, frag.sn, frag.type]);
}

export function hasPreviewFragments(sessionId: string) {
  return windows.has(sessionId);
}

export function previewBufferedLevel(sessionId: string, seconds: number) {
  for (const frame of windows.get(sessionId)?.segments.values() ?? []) {
    if (frame.start <= seconds && seconds < frame.end && frame.level >= 0) return frame.level;
  }
}

export function retainPlaybackFragments(sessionId: string, Base: HlsConfig['loader']) {
  const cache = new FragmentWindow();
  windows.set(sessionId, cache);
  class RecordingLoader extends Base {
    declare context: FragmentLoaderContext | null;
    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      const key = fragmentKey(context);
      if (!key) return super.load(context, config, callbacks);
      super.load(context, config, {
        ...callbacks,
        // XHR delivers the full buffer through onProgress first. Copy before the worker can detach it.
        onProgress: callbacks.onProgress && ((stats, ctx, data, network) => {
          if (stats.loading.end && data instanceof ArrayBuffer && data.byteLength === stats.total) cache.remember(key, context, data);
          callbacks.onProgress!(stats, ctx, data, network);
        }),
        onSuccess: (response, stats, ctx, network) => {
          cache.remember(key, context, response.data);
          callbacks.onSuccess(response, stats, ctx, network);
        },
      });
    }
  }
  return {
    fLoader: RecordingLoader,
    release() {
      if (windows.get(sessionId) === cache) windows.delete(sessionId);
      cache.segments.clear();
      cache.size = 0;
    },
  };
}

export function previewFragmentOptions(sessionId: string, Base: HlsConfig['loader']): Pick<HlsConfig, 'fLoader'> {
  const cache = windows.get(sessionId);
  if (!cache) return {};
  return { fLoader: class extends Base {
    declare context: FragmentLoaderContext | null;
    private cancelHit?: () => void;
    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      const key = fragmentKey(context);
      const hit = key && cache.segments.get(key);
      if (!hit) return super.load(context, config, callbacks);
      this.context = context;
      const stats = this.stats;
      stats.loading.start = performance.now();
      this.cancelHit = () => {
        stats.aborted = true;
        callbacks.onAbort?.(stats, context, null);
      };
      queueMicrotask(() => {
        if (!this.cancelHit) return;
        this.cancelHit = undefined;
        const data = hit.bytes.slice(0);
        stats.loading.end = stats.loading.first = performance.now();
        stats.total = stats.loaded = data.byteLength;
        callbacks.onProgress?.(stats, context, data, null);
        callbacks.onSuccess({ url: context.url, data, code: context.rangeEnd ? 206 : 200 }, stats, context, null);
      });
    }
    abort() {
      const cancel = this.cancelHit;
      this.cancelHit = undefined;
      if (cancel) cancel(); else super.abort();
    }
    destroy() {
      this.cancelHit = undefined;
      super.destroy();
    }
  } };
}
