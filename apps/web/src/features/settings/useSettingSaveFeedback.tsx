import { useLayoutEffect, useRef, useState } from 'react';
import type { SettingsPatch } from '../../api/queries';
import { currentProfileId } from '../../lib/api';
import { deviceSettingsPatch, unsyncedDevicePrefs } from '../../lib/device-prefs';

type Choice = { field: string; value: unknown; group: string; device: boolean; origin: HTMLElement | null };
type Failure = Choice & { retrying?: boolean };

/** Keep failed choices beside their controls. A later edit supersedes only its own fields. */
export function useSettingSaveFeedback(write: (patch: SettingsPatch) => Promise<void>) {
  const profile = currentProfileId();
  const latest = useRef(new Map<string, SettingsPatch>());
  const [failures, setFailures] = useState<Failure[]>([]);

  const saveFields = async (choices: Choice[], retry: boolean) => {
    if (!choices.length) return;
    const patch: SettingsPatch = Object.fromEntries(choices.map(item => [item.field, item.value]));
    for (const { field } of choices) latest.current.set(field, patch);
    setFailures(old => retry
      ? old.map(item => Object.hasOwn(patch, item.field) ? { ...item, retrying: true } : item)
      : old.filter(item => !Object.hasOwn(patch, item.field)));
    let success = true;
    try {
      await write(patch);
    } catch {
      success = false;
    }
    if (currentProfileId() !== profile || (success && !retry)) return;
    const current = choices.filter(item => latest.current.get(item.field) === patch);
    if (!current.length) return;
    setFailures(old => [...old.filter(item => !current.some(choice => choice.field === item.field)), ...(success ? [] : current)]);
  };

  const persist = async (choices: Choice[], retry: boolean) => {
    // Each endpoint can succeed independently when one action changes both kinds of preference.
    await Promise.all([saveFields(choices.filter(item => !item.device), retry), saveFields(choices.filter(item => item.device), retry)]);
  };

  const save = (patch: SettingsPatch, group = Object.keys(patch)[0]) => {
    const local = deviceSettingsPatch(patch);
    const active = document.activeElement;
    const origin = active instanceof HTMLElement && active !== document.body ? active : null;
    return persist(Object.entries(patch).map(([field, value]) => ({ field, value, group, device: Object.hasOwn(local, field), origin })), false);
  };

  const dirty = failures.some(item => item.device) ? unsyncedDevicePrefs() : {};
  const feedback = (group: string) => {
    const failed = failures.filter(item => item.group === group && (item.retrying || !item.device || Object.hasOwn(dirty, item.field)));
    if (!failed.length) return null;
    const retry = () => {
      // Device writes retain local edits. Retry the current dirty values, including newer slider changes.
      const local: Record<string, unknown> = unsyncedDevicePrefs();
      const choices = failed.filter(item => !item.device || Object.hasOwn(local, item.field))
        .map(item => item.device ? { ...item, value: local[item.field] } : item);
      return persist(choices, true);
    };
    return <SettingSaveError deviceOnly={failed.every(item => item.device)} pending={failed.some(item => item.retrying)}
      origin={failed[failed.length - 1].origin} onRetry={retry} />;
  };

  return { save, feedback };
}

function SettingSaveError({ deviceOnly, pending, origin, onRetry }: {
  deviceOnly: boolean; pending: boolean; origin: HTMLElement | null; onRetry: () => Promise<void>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const retry = button.current;
    return () => {
      if (!retry || document.activeElement !== retry) return;
      returnTo.current?.focus();
      // Enabling Shorts replaces the landing screen, including its original enable button.
      if (document.activeElement === retry) retry.closest<HTMLElement>('main[tabindex="-1"]')?.focus();
    };
  }, []);
  const activate = async () => {
    if (running.current || pending) return;
    running.current = true;
    returnTo.current = origin;
    try { await onRetry(); } finally { running.current = false; }
  };
  const message = deviceOnly ? '이 기기에 적용했지만 서버에 저장하지 못했어요.' : '설정을 저장하지 못했어요.';
  return <p className="settings-error" role="alert" aria-busy={pending || undefined}>
    {pending ? '저장 중…' : message} <button ref={button} type="button" className="text-btn" aria-disabled={pending || undefined} onClick={() => void activate()}>다시 시도</button>
  </p>;
}
