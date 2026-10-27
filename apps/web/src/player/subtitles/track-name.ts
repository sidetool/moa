export const LANG_NAME: Record<string, string> = { ko: "한국어", kor: "한국어", ja: "일본어", jpn: "일본어", jp: "일본어", en: "영어", eng: "영어", zh: "중국어", chi: "중국어", zho: "중국어", und: "알 수 없음" };

/** Readable track names: "jpn" → "일본어", "외부 자막 (ko)" → "한국어 · 외부 파일". */
export function trackName(track: { label: string; lang?: string }) {
  const raw = track.label.trim();
  const code = (track.lang ?? "").toLowerCase();
  const plain = LANG_NAME[raw.toLowerCase()];
  if (plain) return plain;
  const external = /^외부 자막 \((\w+)\)$/.exec(raw);
  if (external) return `${LANG_NAME[external[1].toLowerCase()] ?? external[1]} · 외부 파일`;
  if (!raw && LANG_NAME[code]) return LANG_NAME[code];
  return raw || LANG_NAME[code] || "자막";
}
