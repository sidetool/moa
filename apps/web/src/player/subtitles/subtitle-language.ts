import type { SubtitleTrack } from '@moa/shared';

const aliases: Record<string, string> = {
  ko: 'ko', kor: 'ko', en: 'en', eng: 'en', ja: 'ja', jp: 'ja', jpn: 'ja', zh: 'zh', chi: 'zh', zho: 'zh',
  fr: 'fr', fre: 'fr', fra: 'fr', de: 'de', ger: 'de', deu: 'de', es: 'es', spa: 'es', pt: 'pt', por: 'pt',
  ru: 'ru', rus: 'ru', ar: 'ar', ara: 'ar', th: 'th', tha: 'th', vi: 'vi', vie: 'vi', id: 'id', ind: 'id',
  it: 'it', ita: 'it', tr: 'tr', tur: 'tr', hi: 'hi', hin: 'hi', ms: 'ms', may: 'ms', msa: 'ms',
};
const names: [string, RegExp][] = [
  ['ko', /한국어|한국 자막|한글|\bkorean\b/i], ['en', /영어|영문|\benglish\b/i],
  ['ja', /일본어|日本語|\bjapanese\b/i], ['zh', /중국어|中文|汉语|漢語|\bchinese\b|\bmandarin\b/i],
  ['es', /스페인어|\bspanish\b|español/i], ['fr', /프랑스어|\bfrench\b|français/i],
  ['de', /독일어|\bgerman\b|\bdeutsch\b/i], ['pt', /포르투갈어|\bportuguese\b|português/i],
  ['ru', /러시아어|\brussian\b|русский/i], ['ar', /아랍어|\barabic\b|العربية/i],
  ['th', /태국어|\bthai\b|ภาษาไทย/i], ['vi', /베트남어|\bvietnamese\b|tiếng việt/i],
  ['id', /인도네시아어|\bindonesian\b/i], ['it', /이탈리아어|\bitalian\b/i],
  ['tr', /튀르키예어|터키어|\bturkish\b/i], ['hi', /힌디어|\bhindi\b/i], ['ms', /말레이어|\bmalay\b/i],
];
/** Site extensions often put the language in the label and leave lang empty. */
export function subtitleLanguage(track: Pick<SubtitleTrack, 'lang' | 'label'>): string | undefined {
  const raw = track.lang?.trim().toLowerCase(), code = raw?.split(/[-_]/)[0];
  if (code && aliases[code]) return aliases[code];
  for (const [lang, pattern] of names) if (pattern.test(track.label) || (raw && pattern.test(raw))) return lang;
  // Only recognize standalone known codes in labels, never arbitrary title words.
  for (const token of track.label.toLowerCase().split(/[^a-z]+/)) if (aliases[token]) return aliases[token];
  if (code && /^[a-z]{2}$/.test(code)) return code;
}
export const isKorean = (track: SubtitleTrack) => track.source !== 'translation' && subtitleLanguage(track) === 'ko';
export function hasUnlabelledSiteSubtitle(tracks: SubtitleTrack[]) {
  return tracks.some(track => (track.source === 'extension' || (!track.source && /사이트\s*자막/i.test(track.label))) && !subtitleLanguage(track));
}
