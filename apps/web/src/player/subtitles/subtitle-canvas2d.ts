// Dedicated ASS worker: use JASSUB's transparent Canvas2D fallback on devices
// where compositing a WebGL subtitle surface over hardware video is unreliable.
// This override lives only in this worker, never in the page/video context.
const getContext = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, kind: string, options?: unknown) {
  if (kind === 'webgl' || kind === 'webgl2') return null;
  return (getContext as Function).call(this, kind, options);
} as typeof getContext;
export {};
