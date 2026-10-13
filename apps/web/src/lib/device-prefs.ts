import { useSyncExternalStore } from 'react';
import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings, type Settings } from '@moa/shared';
import { api, currentProfileId } from './api';
export { deviceId } from './device-id';

export type DevicePrefs = DeviceSettings;
const storageKey = (profile = currentProfileId()) => `moa.deviceSettings:${profile ?? ''}`;
const fallback = new Map<string, string>();
const saves = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const read = (key: string) => { try { return fallback.get(key) ?? localStorage.getItem(key); } catch { return fallback.get(key) ?? null; } };
const record = (key: string) => {
  try {
    const saved = JSON.parse(read(key) || 'null');
    if (!saved?.value || typeof saved.value !== 'object' || Array.isArray(saved.value)) return null;
    const limits: Record<string, [number, number]> = { subtitleScale: [50, 250], subtitleShadow: [0, 10], subtitleOutline: [0, 6], subtitleHeight: [0, 40], subtitlePadding: [0, 20] };
    const value = Object.fromEntries(Object.entries(saved.value).filter(([key, value]) => {
      if (!Object.hasOwn(DEFAULT_DEVICE_SETTINGS, key)) return false;
      if (key in limits) return value === null && ['subtitleScale', 'subtitleShadow', 'subtitleOutline'].includes(key)
        || typeof value === 'number' && Number.isFinite(value) && value >= limits[key][0] && value <= limits[key][1];
      if (key === 'shortsScreenFit') return value === null || typeof value === 'boolean';
      if (key === 'subtitleSize') return typeof value === 'string' && ['small', 'medium', 'large', 'xlarge'].includes(value);
      if (key === 'subtitleBackground') return typeof value === 'string' && ['original', 'none', 'soft', 'solid'].includes(value);
      return key === 'seekStep' ? [5, 10, 15, 30].includes(value as number) : typeof value === 'boolean';
    }));
    return { value: { ...DEFAULT_DEVICE_SETTINGS, ...value } as DeviceSettings, dirty: saved.dirty && typeof saved.dirty === 'object' ? Object.fromEntries(Object.keys(saved.dirty).filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null };
  } catch { return null; }
};
const write = (key: string, value: DeviceSettings, dirty: Partial<DeviceSettings> | null) => {
  const raw = JSON.stringify({ value, dirty });
  fallback.set(key, raw);
  try { localStorage.setItem(key, raw); fallback.delete(key); } catch {}
  window.dispatchEvent(new Event('moa:device-prefs'));
};
export function devicePrefs(): DevicePrefs {
  return { ...DEFAULT_DEVICE_SETTINGS, ...record(storageKey())?.value };
}
export function deviceSettingsPatch(settings: Partial<Settings> | Partial<DeviceSettings>): Partial<DeviceSettings> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => Object.hasOwn(DEFAULT_DEVICE_SETTINGS, key)));
}
export async function loadDevicePrefs(settings: Settings, signal: AbortSignal) {
  const profile = currentProfileId(), key = storageKey(profile);
  await saves.get(key)?.catch(() => {});
  if (signal.aborted || profile !== currentProfileId()) return;
  const revision = revisions.get(key), local = record(key);
  try {
    if (local?.dirty) { await saveDevicePrefs(local.dirty); return; }
    let result = await api<{ settings: DeviceSettings | null }>('/settings/device', { signal });
    if (signal.aborted || profile !== currentProfileId() || revisions.get(key) !== revision || !result) return;
    if (result.settings === null) {
      const legacy: Partial<DeviceSettings> = {};
      if (!read('moa.deviceSettingsMigrated')) {
        for (const name of ['fullscreenOnPlay', 'autoSkip', 'videoFill', 'seasonSwitcher', 'titleGrouping'] as const) {
          const value = read(`moa.${name}`); if (value !== null) legacy[name] = value === '1';
        }
        const step = Number(read('moa.seekStep'));
        if ([5, 10, 15, 30].includes(step)) legacy.seekStep = step as DeviceSettings['seekStep'];
        try {
          const old = JSON.parse(read('moa.subtitleAppearance') || 'null'), height = read('moa.subtitleHeight');
          if (settings.subtitleBackground === undefined && old && ['small', 'medium', 'large', 'xlarge'].includes(old.size) && ['original', 'none', 'soft', 'solid'].includes(old.background)) {
            legacy.subtitleSize = old.size; legacy.subtitleBackground = old.background;
            legacy.subtitleShadow = ({ none: 0, soft: 2, strong: 4 } as Record<string, number>)[old.shadow] ?? null;
            legacy.subtitleOutline = ({ none: 0, thin: 1, thick: 3 } as Record<string, number>)[old.outline] ?? null;
          }
          if (settings.subtitleHeight === undefined && height !== null && Number.isFinite(Number(height))) legacy.subtitleHeight = Math.max(0, Math.min(40, Number(height)));
        } catch {}
      }
      result = await api<{ settings: DeviceSettings }>('/settings/device', { method: 'PATCH', body: { settings: { ...DEFAULT_DEVICE_SETTINGS, ...deviceSettingsPatch(settings), shortsScreenFit: null, ...legacy, ...local?.value }, migrate: true }, signal });
    }
    if (signal.aborted || profile !== currentProfileId() || revisions.get(key) !== revision || !result?.settings) return;
    write(key, result.settings, null);
    try { localStorage.setItem('moa.deviceSettingsMigrated', '1'); } catch {}
  } catch {}
}
export function saveDevicePrefs(patch: Partial<DeviceSettings>) {
  const profile = currentProfileId(), key = storageKey(profile), value = { ...devicePrefs(), ...patch }, dirty = { ...record(key)?.dirty, ...patch };
  const revision = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, revision);
  write(key, value, dirty);
  const save = (saves.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (currentProfileId() !== profile || revisions.get(key) !== revision) return;
    const result = await api<{ settings: DeviceSettings }>('/settings/device', { method: 'PATCH', body: { settings: dirty }, keepalive: true });
    if (currentProfileId() === profile && revisions.get(key) === revision && result?.settings) write(key, result.settings, null);
  });
  saves.set(key, save);
  void save.finally(() => { if (saves.get(key) === save) saves.delete(key); }).catch(() => {});
  return save;
}
export function setDevicePref<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) {
  void saveDevicePrefs({ [key]: value }).catch(() => {});
}
const subscribe = (notify: () => void) => {
  window.addEventListener('moa:device-prefs', notify);
  window.addEventListener('storage', notify);
  return () => { window.removeEventListener('moa:device-prefs', notify); window.removeEventListener('storage', notify); };
};
export function useDevicePrefs() {
  useSyncExternalStore(subscribe, () => read(storageKey()), () => null);
  return devicePrefs();
}
export function useTitleGrouping() {
  return useSyncExternalStore(subscribe, () => devicePrefs().titleGrouping, () => true);
}
