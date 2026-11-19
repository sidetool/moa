import { ANIME4KJS_SIMPLE_S_2X, ImageUpscaler } from 'anime4k.js';

// EXT_disjoint_timer_query is optional on WebGL 1. Poll one query without waiting on the GPU.
interface TimerQuery {
  TIME_ELAPSED_EXT: number;
  QUERY_RESULT_AVAILABLE_EXT: number;
  QUERY_RESULT_EXT: number;
  GPU_DISJOINT_EXT: number;
  createQueryEXT(): object | null;
  beginQueryEXT(target: number, query: object): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(query: object, key: number): number;
  deleteQueryEXT(query: object): void;
}

export function createRenderer(video: HTMLVideoElement, onLost: () => void) {
  const canvas = document.createElement('canvas');
  canvas.className = 'player-anime4k';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, depth: false, stencil: false });
  if (!gl) throw new Error('WebGL unavailable');

  let upscaler: ImageUpscaler | undefined;
  let timer: TimerQuery | null = null;
  let query: object | null = null;
  let queryStart = 0;
  let lastErrorCheck = 0;
  const destroy = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.remove();
    try {
      if (query) timer?.deleteQueryEXT(query);
      upscaler?.detachSource();
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
  try {
    const longest = Math.max(video.videoWidth, video.videoHeight) * 2;
    if (longest > gl.getParameter(gl.MAX_TEXTURE_SIZE) || !gl.getExtension('OES_texture_float') ||
        !gl.getExtension('OES_texture_float_linear') || !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('Unsupported texture dimensions or format');
    }
    timer = gl.getExtension('EXT_disjoint_timer_query');
    upscaler = new ImageUpscaler(ANIME4KJS_SIMPLE_S_2X);
    upscaler.attachSource(video, canvas);
    if (canvas.width !== video.videoWidth * 2 || canvas.height !== video.videoHeight * 2 || gl.getError() !== gl.NO_ERROR) {
      throw new Error('Filter initialization failed');
    }
    canvas.addEventListener('webglcontextlost', onLost);
    video.after(canvas);
  } catch (error) {
    destroy();
    throw error;
  }
  const draw = (budgetMs: number) => {
    let gpuMs = 0;
    if (timer && query) {
      if (timer.getQueryObjectEXT(query, timer.QUERY_RESULT_AVAILABLE_EXT)) {
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs = timer.getQueryObjectEXT(query, timer.QUERY_RESULT_EXT) / 1e6;
        timer.deleteQueryEXT(query);
        query = null;
      } else if (performance.now() - queryStart > Math.max(250, 6 * budgetMs)) {
        throw new Error('GPU backlog');
      }
    }
    const measure = timer && !query ? timer.createQueryEXT() : null;
    if (timer && measure) timer.beginQueryEXT(timer.TIME_ELAPSED_EXT, measure);
    try { upscaler.upscale(); } finally {
      if (timer && measure) {
        timer.endQueryEXT(timer.TIME_ELAPSED_EXT);
        query = measure;
        queryStart = performance.now();
      }
    }
    // The library signals a submitted frame by making the canvas visible. A failed
    // internal support probe can otherwise silently leave the output transparent.
    if (canvas.style.visibility !== 'visible') throw new Error('Filter frame unavailable');
    // getError can synchronize with the GL implementation. Check before revealing
    // a new/resumed frame, then once per second for late errors such as OUT_OF_MEMORY.
    // Context loss is also reported by the event listener independently of frame delivery.
    const now = performance.now();
    if (canvas.hidden || now - lastErrorCheck >= 1000) {
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Filter frame failed');
      lastErrorCheck = now;
    }
    if (canvas.style.transform !== video.style.transform) canvas.style.transform = video.style.transform;
    canvas.hidden = false;
    return gpuMs;
  };
  return { canvas, draw, width: video.videoWidth, height: video.videoHeight, destroy };
}
