import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubtitleTrack } from '@moa/shared';
import { automaticTrackRank, selectAutomaticTrack } from '../src/player/translation/automatic-source.js';

const track = (id: string, label: string, lang = 'en', source: SubtitleTrack['source'] = 'extension'): SubtitleTrack => ({
  id, label, lang, source, format: 'vtt', url: `/synthetic/${id}.vtt`,
});

test('automatic source ranks full dialogue above ordinary tracks and AI or dubtitles last', () => {
  const full = track('full', 'Japanese Full Dialogue', 'ja');
  const ordinary = track('ordinary', 'English');
  const ai = track('ai', 'English AI Full');
  for (const label of ['English AI', 'English machine translated', 'English automatic', 'English Dubtitles', '자동 번역']) {
    assert.ok(automaticTrackRank(track('candidate', label))! > automaticTrackRank(ordinary)!, label);
  }
  assert.ok(automaticTrackRank(full)! < automaticTrackRank(ordinary)!);
  assert.ok(automaticTrackRank(ai)! > automaticTrackRank(ordinary)!);
  assert.equal(selectAutomaticTrack([ai, ordinary, full], ordinary), full);
  assert.equal(selectAutomaticTrack([full, ordinary, ai], ai), full);
});

test('automatic source excludes partial-only tracks but retains explicit full mixed tracks', () => {
  for (const label of ['English Signs', 'Japanese Songs', 'English Signs & Songs', 'English Forced', '간판 전용', '노래 전용', '강제 자막']) {
    assert.equal(automaticTrackRank(track('partial', label)), null, label);
  }
  for (const label of ['English Full (Signs included)', 'Japanese Dialogue + Songs', 'English Complete / Forced', '전체 대사 (간판 포함)']) {
    assert.notEqual(automaticTrackRank(track('mixed', label)), null, label);
  }
  assert.equal(selectAutomaticTrack([track('signs', 'English Signs'), track('songs', 'Japanese Songs', 'ja')], null), null);
});

test('automatic source preserves current track within its rank with the existing English/Japanese tie preference', () => {
  const english = track('english', 'English');
  const japanese = track('japanese', 'Japanese', 'ja');
  const french = track('french', 'French', 'fr');
  assert.equal(selectAutomaticTrack([english, japanese, french], japanese), japanese);
  assert.equal(selectAutomaticTrack([japanese, english, french], english), english);
  assert.equal(selectAutomaticTrack([french, english, japanese], null), english);
  assert.equal(selectAutomaticTrack([english, japanese], { ...japanese, url: '/previous-session.vtt' }), japanese);
});

test('automatic source leaves human Korean and saved translations to their existing preference paths', () => {
  const korean = track('korean', '한국어 Full', 'ko');
  const saved = track('saved', 'English Full', 'en', 'translation');
  const ordinary = track('ordinary', 'Japanese', 'ja');
  assert.equal(automaticTrackRank(korean), null);
  assert.equal(automaticTrackRank(saved), null);
  assert.equal(selectAutomaticTrack([korean, saved, ordinary], saved), ordinary);
  assert.equal(selectAutomaticTrack([], null), null);
});

test('automatic source policy never mutates the manual track inventory or track objects', () => {
  const tracks = [track('signs', 'English Signs'), track('full', 'English Full'), track('ai', 'English AI')];
  const snapshot = structuredClone(tracks);
  tracks.forEach(Object.freeze);
  Object.freeze(tracks);
  assert.equal(selectAutomaticTrack(tracks, tracks[0]), tracks[1]);
  assert.deepEqual(tracks, snapshot);
});

test('automatic source keeps known-language protection ahead of rank and falls back only when no suitable known track exists', () => {
  const unknownFull = track('unknown', 'Full Dialogue', 'und');
  const knownOrdinary = track('known', 'English');
  const knownSigns = track('known-signs', 'English Signs');
  const french = track('french', 'French', 'fr');
  const japanese = track('japanese', 'Japanese', 'ja');
  assert.equal(selectAutomaticTrack([unknownFull, knownOrdinary], unknownFull), knownOrdinary);
  assert.equal(selectAutomaticTrack([knownSigns, unknownFull], knownSigns), unknownFull);
  assert.equal(selectAutomaticTrack([french, knownOrdinary, japanese], french), french);
  assert.equal(selectAutomaticTrack([french, japanese, knownOrdinary], null), japanese);
  assert.equal(selectAutomaticTrack([french, knownOrdinary, japanese], null), knownOrdinary);
});

test('negated or included signs and songs do not label an ordinary dialogue track as partial-only', () => {
  const ordinary = automaticTrackRank(track('ordinary', 'English'));
  for (const label of ['English (No Signs)', 'English (No Songs)', 'English (Signs included)', 'English (Songs included)', 'English with Signs']) {
    assert.equal(automaticTrackRank(track('mixed', label)), ordinary, label);
  }
  assert.equal(automaticTrackRank(track('only', 'English Signs only')), null);
  assert.equal(automaticTrackRank(track('only', 'English Songs only')), null);
});
