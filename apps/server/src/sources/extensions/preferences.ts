import type { CompatibilityPreference } from './types.js';
import type { PreferenceValues } from './runtime.js';
export function preferenceSchema(raw: unknown): CompatibilityPreference[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('compatibility_preferences_invalid');
  const keys = new Set<string>();
  return raw.flatMap((row) => {
    if (!row || typeof row.key !== 'string' || row.key.length > 256 || keys.has(row.key))
      throw new Error('compatibility_preferences_invalid');
    keys.add(row.key);
    const input =
      row.editTextPreference ?? row.switchPreferenceCompat ?? row.listPreference ?? row.multiSelectListPreference;
    if (!input) return [];
    if (typeof input.title !== 'string' || input.title.length > 512)
      throw new Error('compatibility_preferences_invalid');
    const kind = row.switchPreferenceCompat
      ? 'boolean'
      : row.listPreference
        ? 'select'
        : row.multiSelectListPreference
          ? 'multi-select'
          : 'text';
    const choices =
      ['select', 'multi-select'].includes(kind) && Array.isArray(input.entries) && Array.isArray(input.entryValues)
        ? input.entries
            .slice(0, 128)
            .map((label: unknown, i: number) => ({ label: String(label).slice(0, 512), value: input.entryValues[i] }))
        : undefined;
    if (choices?.some((choice: { value: unknown }) => !['string', 'number'].includes(typeof choice.value)))
      throw new Error('compatibility_preferences_invalid');
    if (
      kind === 'multi-select' &&
      (!choices ||
        choices.some((choice: { value: unknown }) => typeof choice.value !== 'string') ||
        !Array.isArray(input.values ?? []) ||
        (input.values ?? []).some((v: unknown) => !choices.some((c: { value: unknown }) => c.value === v)))
    )
      throw new Error('compatibility_preferences_invalid');
    const defaultValue =
      kind === 'multi-select'
        ? [...(input.values ?? [])]
        : kind === 'select'
          ? input.valueIndex === undefined
            ? (input.value ?? choices?.[0]?.value)
            : choices?.[input.valueIndex]?.value
          : input.value;
    if (kind === 'multi-select') validatePreferenceChanges({ [row.key]: defaultValue });
    const secret = /(?:secret|password|token|access.?key|api.?key|credential|접속.?키|비밀번호)/i.test(
      row.key + ' ' + input.title,
    );
    return [
      {
        key: row.key,
        title: input.title,
        summary: typeof input.summary === 'string' ? input.summary.slice(0, 2000) : undefined,
        kind,
        secret,
        ...(Array.isArray(defaultValue) || ['string', 'boolean', 'number'].includes(typeof defaultValue)
          ? { value: defaultValue }
          : {}),
        ...(choices ? { choices } : {}),
      },
    ];
  });
}
export function validatePreferenceChanges(value: unknown): asserts value is PreferenceValues {
  validatePreferences(value, 48 * 1024, 256);
}

const STATE_BYTES = 2 * 1024 * 1024, STATE_KEYS = 8192;

/** SharedPreferences also contains source-managed catalog caches, not just form values. */
export function validatePreferenceState(value: unknown): asserts value is PreferenceValues {
  validatePreferences(value, STATE_BYTES, STATE_KEYS, 'source_storage_limit');
}

const isCacheKey = (key: string) => /cache/i.test(key);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Extensions keep growing catalog caches in SharedPreferences. When the state would outgrow
 * the limit, drop cache keys (largest first, untouched ones before the ones this call just wrote) down to
 * three quarters of the limit, so the call succeeds and the next few calls do not trim again.
 * Settings the user entered never match and are never removed.
 */
export function trimPreferenceState(state: PreferenceValues, changed: Iterable<string> = []): PreferenceValues {
  if (bytes(state) <= STATE_BYTES && Object.keys(state).length <= STATE_KEYS) return state;
  const fresh = new Set(changed), next = { ...state };
  const victims = Object.keys(next).filter(isCacheKey)
    .sort((a, b) => Number(fresh.has(a)) - Number(fresh.has(b)) || bytes(next[b]) - bytes(next[a]));
  let size = bytes(next);
  for (const key of victims) {
    if (size <= STATE_BYTES * 0.75 && Object.keys(next).length <= STATE_KEYS * 0.75) break;
    size -= bytes(next[key]) + Buffer.byteLength(JSON.stringify(key)) + 2;
    delete next[key];
  }
  return next;
}

function validatePreferences(
  value: unknown,
  maximumBytes: number,
  maximumKeys: number,
  limitError = 'compatibility_preferences_invalid',
): asserts value is PreferenceValues {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.keys(value).length > maximumKeys || Buffer.byteLength(JSON.stringify(value)) > maximumBytes)
  )
    throw new Error(limitError);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, v]) =>
        key.length > 256 ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (v !== null &&
          !['string', 'number', 'boolean'].includes(typeof v) &&
          !(
            Array.isArray(v) &&
            v.length <= 128 &&
            v.every((item) => typeof item === 'string' && item.length <= 2048) &&
            new Set(v).size === v.length
          )) ||
        (typeof v === 'number' && !Number.isFinite(v)),
    )
  )
    throw new Error('compatibility_preferences_invalid');
}
