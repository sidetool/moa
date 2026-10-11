export type MarkerSource = "manual" | "fingerprint" | "aniskip" | "theintrodb";
export interface MarkerInterval { start: number; end: number; source: MarkerSource; confidence: number }
export interface SkipMarkers {
  introStart?: number;
  introEnd?: number;
  creditsStart?: number;
  /** Keep the end for post-credit scenes; the current shared contract omits it. */
  creditsEnd?: number;
  source: MarkerSource;
  /** Conservative minimum of the selected interval confidences; not a calibrated probability. */
  confidence: number;
  provenance?: { intro?: MarkerSource; credits?: MarkerSource };
}
export interface CacheEntry { value: unknown; expiresAt?: number }
/** JSON-serializable values only. Persist milliseconds since epoch for expiresAt. */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}
export interface FileIdentity { path: string; size: number; mtimeMs: number }
export interface LocalEpisode { id: string; path: string; episodeNumber?: number }
export interface EpisodeAnalysis {
  id: string;
  file: FileIdentity;
  duration: number;
  markers: SkipMarkers | null;
  intro: MarkerInterval | null;
  credits: MarkerInterval | null;
  reason?: "no-common-audio" | "insufficient-episodes" | "file-error";
  error?: string;
}
export interface AnalysisProgress {
  phase: "fingerprinting" | "comparing-intros" | "comparing-credits" | "complete";
  completed: number;
  total: number;
  ratio: number;
  episodeId?: string;
  cached?: boolean;
}
export interface SeasonAnalysis {
  version: number;
  cacheKey: string;
  episodes: EpisodeAnalysis[];
  elapsedMs: number;
  cached: boolean;
  backend: "chromaprint" | "spectrum";
}
export interface AnalysisContext { signal?: AbortSignal; onProgress?: (progress: AnalysisProgress) => void }
