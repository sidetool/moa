import path from 'node:path';

export interface Config {
  requireAccount: boolean;
  downloadRoot?: string;
  downloadsEnabled?: boolean;
  dataDir: string; mediaRoot: string; webDir: string; ffmpeg: string; ffprobe: string;
  vaapiDevice: string; maxTranscodes: number; sessionTtlMs: number;
  hlsAheadSeconds: number; hlsBackSeconds: number;
}
export function config(overrides: Partial<Config> = {}): Config {
  return {
    downloadsEnabled: process.env.MOA_DOWNLOADS_ENABLED !== '0',
    downloadRoot: process.env.MOA_DOWNLOAD_ROOT ? path.resolve(process.env.MOA_DOWNLOAD_ROOT) : undefined,
    requireAccount: process.env.MOA_REQUIRE_ACCOUNT === '1',
    dataDir: path.resolve(process.env.MOA_DATA_DIR || '/data'),
    mediaRoot: path.resolve(process.env.MOA_MEDIA_ROOT || '/media'),
    webDir: path.resolve(process.env.MOA_WEB_DIR || '/app/web'),
    ffmpeg: process.env.MOA_FFMPEG || 'ffmpeg', ffprobe: process.env.MOA_FFPROBE || 'ffprobe',
    vaapiDevice: process.env.MOA_VAAPI_DEVICE || '/dev/dri/renderD128',
    maxTranscodes: Math.max(1, Number(process.env.MOA_MAX_TRANSCODES) || 2),
    sessionTtlMs: 30 * 60 * 1000,
    hlsAheadSeconds: Math.max(10, Number(process.env.MOA_HLS_AHEAD_SECONDS) || 90),
    hlsBackSeconds: Math.max(0, Number(process.env.MOA_HLS_BACK_SECONDS) || 60), ...overrides,
  };
}
