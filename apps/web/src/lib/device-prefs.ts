import { useSyncExternalStore } from "react";

/** Preferences that belong to this device rather than the profile. */
export interface DevicePrefs {
  /** Enter fullscreen when playback is opened from a tap. */
  fullscreenOnPlay: boolean;
  /** Skip openings and endings automatically when markers are known. */
  autoSkip: boolean;
  /** Seconds for double tap, ±buttons and J/L. */
  seekStep: 5 | 10 | 15 | 30;
  /** Crop to fill the screen instead of letterboxing. */
  videoFill: boolean;
  /** Experimental: the detail season menu gathers regular seasons from every source. */
  seasonSwitcher: boolean;
  /** Experimental: merge equivalent source cards in search and feeds. */
  titleGrouping: boolean;
}

const KEYS: Record<keyof DevicePrefs, string> = { fullscreenOnPlay: "moa.fullscreenOnPlay", autoSkip: "moa.autoSkip", seekStep: "moa.seekStep", videoFill: "moa.videoFill", seasonSwitcher: "moa.seasonSwitcher", titleGrouping: "moa.titleGrouping" };
const DEFAULTS: DevicePrefs = { fullscreenOnPlay: true, autoSkip: false, seekStep: 10, videoFill: false, seasonSwitcher: true, titleGrouping: true };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

export function devicePrefs(): DevicePrefs {
  const flag = (k: "fullscreenOnPlay" | "autoSkip" | "videoFill" | "seasonSwitcher" | "titleGrouping") => { const v = read(KEYS[k]); return v === null ? DEFAULTS[k] : v === "1"; };
  const step = Number(read(KEYS.seekStep));
  return { fullscreenOnPlay: flag("fullscreenOnPlay"), autoSkip: flag("autoSkip"), videoFill: flag("videoFill"), seasonSwitcher: flag("seasonSwitcher"), titleGrouping: flag("titleGrouping"), seekStep: ([5, 10, 15, 30] as const).find(s => s === step) ?? DEFAULTS.seekStep };
}

export function setDevicePref<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) {
  try { localStorage.setItem(KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value)); } catch { /* private browsing */ }
  window.dispatchEvent(new Event("moa:device-prefs"));
}

const subscribe = (notify: () => void) => {
  window.addEventListener("moa:device-prefs", notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener("moa:device-prefs", notify); window.removeEventListener("storage", notify); };
};
export function useTitleGrouping() {
  return useSyncExternalStore(subscribe, () => devicePrefs().titleGrouping, () => true);
}
