import { useRef, useState } from 'react';
import type { SettingsPatch } from '../../api/queries';
import { currentProfileId } from '../../lib/api';
import { deviceSettingsPatch, unsyncedDevicePrefs } from '../../lib/device-prefs';

type Failure = { field: string; value: unknown; group: string; device: boolean };

/** Keep failed choices beside their controls. A later edit supersedes only its own fields. */
export function useSettingSaveFeedback(write: (patch: SettingsPatch) => Promise<void>) {
  const profile = currentProfileId();
  const latest = useRef(new Map<string, SettingsPatch>());
  const [failures, setFailures] = useState<Failure[]>([]);

  const saveFields = async (fields: [string, unknown][], group: string, device: boolean) => {
    if (!fields.length) return;
    const patch: SettingsPatch = Object.fromEntries(fields);
    for (const [field] of fields) latest.current.set(field, patch);
    setFailures(old => old.length ? old.filter(item => !Object.hasOwn(patch, item.field)) : old);
    try {
      await write(patch);
    } catch {
      if (currentProfileId() !== profile) return;
      const failed = fields.filter(([field]) => latest.current.get(field) === patch)
        .map(([field, value]) => ({ field, value, group, device }));
      if (failed.length) setFailures(old => [...old, ...failed]);
    }
  };

  const save = async (patch: SettingsPatch, group = Object.keys(patch)[0]) => {
    // Each endpoint can succeed independently when one action changes both kinds of preference.
    const local = deviceSettingsPatch(patch);
    const shared = Object.entries(patch).filter(([field]) => !Object.hasOwn(local, field));
    await Promise.all([saveFields(shared, group, false), saveFields(Object.entries(local), group, true)]);
  };

  const dirty = failures.some(item => item.device) ? unsyncedDevicePrefs() : {};
  const feedback = (group: string) => {
    const failed = failures.filter(item => item.group === group && (!item.device || Object.hasOwn(dirty, item.field)));
    if (!failed.length) return null;
    const retry = () => {
      // Device writes retain local edits. Retry the current dirty values, including newer slider changes.
      const local = Object.entries(unsyncedDevicePrefs()).filter(([field]) => failed.some(item => item.device && item.field === field));
      const shared = failed.filter(item => !item.device).map(item => [item.field, item.value]);
      void save(Object.fromEntries([...shared, ...local]), group);
    };
    return <SettingSaveError deviceOnly={failed.every(item => item.device)} onRetry={retry} />;
  };

  return { save, feedback };
}

export function SettingSaveError({ deviceOnly = false, onRetry }: { deviceOnly?: boolean; onRetry: () => void }) {
  return <p className="settings-error" role="alert">{deviceOnly ? '이 기기에 적용했지만 서버에 저장하지 못했어요.' : '설정을 저장하지 못했어요.'} <button type="button" className="text-btn" onClick={onRetry}>다시 시도</button></p>;
}
