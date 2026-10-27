import test from 'node:test';
import assert from 'node:assert/strict';
import { trimPreferenceState, validatePreferenceState } from '../../src/sources/extensions/preferences.js';

const blob = (kb: number) => 'x'.repeat(kb * 1024);

test('source catalog caches are trimmed instead of failing the call', () => {
  const state: Record<string, string> = { token: 'user-setting', domain: 'https://example.test' };
  for (let i = 0; i < 40; i++) state[`example_cache_list_${i}`] = blob(40);
  state.example_cache_detail_new = blob(450);
  assert.throws(() => validatePreferenceState(state), /source_storage_limit/);
  const trimmed = trimPreferenceState(state, ['example_cache_detail_new']);
  validatePreferenceState(trimmed);
  assert.equal(trimmed.token, 'user-setting');
  assert.equal(trimmed.domain, 'https://example.test');
  assert.ok(trimmed.example_cache_detail_new, 'the value this call just wrote is kept');
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 2 * 1024 * 1024 * 0.75 + 64 * 1024);
});

test('state under the limit is returned untouched', () => {
  const state = { a: '1', some_cache: blob(10) };
  assert.equal(trimPreferenceState(state), state);
});

test('settings without cache keys are never removed', () => {
  const state: Record<string, string> = {};
  for (let i = 0; i < 60; i++) state[`setting_${i}`] = blob(40);
  assert.deepEqual(trimPreferenceState(state), state);
});
