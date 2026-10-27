# 한국어 온라인 자막

작품·시즌·회차에 맞는 자막 후보를 찾고 파일을 내려받아 ASS/SRT/SMI/VTT 형식으로 변환합니다. 공개 함수는 `createSubtitleClient`, `resolveKoreanTitle`, `listCreators`, `searchSubtitles`, `fetchCreatorSubtitle`이며 변환·압축 해제 함수도 제공합니다.

## 검색과 파일 선택

`SubtitleQuery`에 `title`, `season`, `episode`를 전달합니다. 확인된 별칭과 회차 보정은 `aliases`, `episodeOffset`으로 지정합니다. 요청 시간·응답 크기·취소 신호를 제한하고 진단 결과를 받을 수 있습니다.

Anissia 제작자 정보, AniList 제목 정보, 공개 제작자 아카이브를 조회합니다. `enableKairan`, `enableCsora`, `enableMelody`로 아카이브별 조회를 끌 수 있습니다. 후보가 없으면 남은 검색 시간 안에서 네이버 블로그를 최대 두 번 검색하고 글을 최대 네 개 확인합니다. 기본 전체 제한은 12초입니다.

작품·시즌·회차를 확인한 게시글이나 Anissia의 직접 파일은 축약된 파일명도 허용합니다. 파일에서는 회차와 명시된 시즌을 확인합니다. 새 검색 결과나 다른 회차의 게시글은 파일의 작품명도 검사합니다. 모든 경로에서 압축 크기·경로·형식과 한국어 본문을 확인하지만, 잘못 첨부된 파일이나 영상 판본 차이를 완전히 판별하지는 못합니다.

## 서버 연결

서버는 에피소드·프로필별로 후보를 조회하고 `searchId`·`candidateId`로 선택을 확인합니다. 선택한 파일을 변환·캐시한 뒤 접근 토큰을 발급해 재생 자막에 연결합니다. 임의 URL을 그대로 받는 공개 다운로드 API는 제공하지 않습니다. 실패하면 기존 자막을 유지합니다.

[API](../../../../../docs/DEVELOPMENT.md#api-개요)와 [자막·스킵 안내](../../../../../docs/PLAYBACK.md#자막-번역과-스킵)를 참고해 주세요. 테스트에는 직접 작성한 짧은 자막과 합성 ZIP·HTTP 응답을 사용합니다.

```sh
corepack pnpm --filter @moa/server build
corepack pnpm --filter @moa/server test
```
