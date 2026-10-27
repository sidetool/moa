import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleLanguage, isKorean, hasUnlabelledSiteSubtitle } from '../../web/src/player/subtitles/subtitle-language.js';
const track = (label: string, lang?: string) => ({ id: 's', url: '/s', format: 'vtt' as const, source: 'extension' as const, label, lang });
test('site labels recognize explicit foreign languages and protect unknown site subtitles', () => {
  for (const [label, lang] of [['English', 'en'], ['English CC', 'en'], ['사이트 자막 (ENG)', 'en'], ['日本語', 'ja'], ['Japanese', 'ja'], ['한국어', 'ko'], ['Korean', 'ko'], ['中文', 'zh'], ['Español', 'es'], ['영어 자막', 'en']]) {
    assert.equal(subtitleLanguage(track(label)), lang);
    assert.equal(hasUnlabelledSiteSubtitle([track(label)]), false);
  }
  for (const label of ['사이트 자막', '자막 1', 'Default', 'Subtitles']) {
    assert.equal(subtitleLanguage(track(label)), undefined);
    assert.equal(hasUnlabelledSiteSubtitle([track(label)]), true);
  }
  assert.equal(subtitleLanguage(track('사이트 자막', 'en-US')), 'en');
  assert.equal(subtitleLanguage(track('English', 'und')), 'en');
  assert.equal(isKorean(track('사이트 자막', 'ko-KR')), true);
  assert.equal(hasUnlabelledSiteSubtitle([track('English'), track('사이트 자막')]), true);
  assert.equal(hasUnlabelledSiteSubtitle([{ ...track('Unknown'), source: 'embedded' }]), false);
  assert.equal(hasUnlabelledSiteSubtitle([{ ...track('사이트 자막'), source: 'translation' }]), false);
});
