export interface MangayomiEntry {
  id: string;
  name: string;
  lang: string;
  version: string;
  baseUrl: string;
  apiUrl?: string;
  iconUrl?: string;
  additionalParams?: string;
  dateFormat?: string;
  dateFormatLocale?: string;
  typeSource?: string;
  isManga?: boolean;
  itemType: 1;
  sourceCodeUrl: string;
  format: 'mangayomi-js';
  isNsfw: boolean;
  hasCloudflare: boolean;
  appMinVerReq?: string;
  notes?: string;
}
export interface CompatibilityPreference {
  group?: string; disabled?: boolean; key: string; title: string; summary?: string;
  kind: 'text' | 'boolean' | 'select' | 'multi-select'; secret: boolean;
  value?: string | boolean | number | string[]; configured?: boolean;
  choices?: readonly { label: string; value: string | number }[];
}
export interface SourceWebViewRequest { url: string; headers?: Record<string, string>; script: string; waitUntil: 'load'; timeoutMs: number }
export interface SourceItem { type?: 'anime' | 'movie' | 'series'; name: string; link: string; imageUrl?: string; imageHeaders?: Record<string, string>; description?: string; genre?: string[]; status?: number; author?: string; chapters?: SourceEpisode[] }
export interface SourceEpisode { name: string; url: string; dateUpload?: string; scanlator?: string }
export interface SourcePage { list: SourceItem[]; hasNextPage: boolean; browse?: unknown }
export interface SourceVideo { url: string; originalUrl?: string; quality?: string; headers?: Record<string, string>; subtitles?: Array<{ file: string; label: string }>; audios?: Array<{ file: string; label: string }> }
