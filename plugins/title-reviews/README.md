# 리뷰 모아보기 (개발 중)

작품 상세에 MOA가 직접 그리는 접이식 리뷰 영역을 추가합니다. 공급자는 **TMDB와 AniList**이며, 플러그인에는 키나 별도 iframe UI를 넣지 않습니다. API 이름은 공급자와 무관한 `reviews.list` / `title.reviews`입니다.

## 사용 흐름

- **TMDB**: 기존 MOA 메타데이터 설정과 확정된 작품 ID를 사용합니다. 추가 키 발급이 필요 없습니다. 한국어 첫 페이지를 먼저 요청하고 빈 목록일 때만 영어 첫 페이지를 요청합니다. 실제 글 언어나 작성자 국적을 보증하지 않습니다.
- **AniList**: 키·로그인 없이 공개 API를 이용합니다. 연결된 메타데이터의 원제가 있으면 원제로, 없으면 로컬 제목으로 애니 후보 5개를 조회합니다. 한국어 제목만 있으면 검색 결과가 없을 수 있습니다.
- 시즌/극장판/단편을 혼동하지 않도록 사용자가 제목·연도·형식을 보고 후보를 선택합니다. 임의 ID나 후보 밖 ID로 리뷰를 가져올 수 없습니다. 선택은 현재 화면에만 유지하며 영구 메타데이터 연결을 수정하지 않습니다.
- 공급자별 리뷰 최대 8개와 600자 이내 발췌만 표시합니다. 전체 리뷰는 원문 링크에서 읽습니다. 제목도 스포일러일 수 있으므로 영역과 내용은 기본으로 접혀 있습니다.
- Google 번역 버튼은 **외부 원문 페이지를 번역해서 여는 링크**입니다. MOA 내 자동번역이나 무료 번역 API가 아닙니다. 원문 사이트/Google 지원 여부에 따라 안 될 수도 있습니다.
- 한국어 리뷰 검색은 보조적인 네이버/다음 검색 링크만 제공합니다. 블로그 검색 API·키 설정은 제거했습니다. 해외 리뷰 번역을 한국 이용자의 관람평으로 표시하지 않습니다.

`minMoaVersion: 0.1.2-beta.2`는 **미발행 후보 번호**입니다. 통합 담당자가 리뷰 호스트 코드가 들어간 버전으로 확정해야 합니다. 기존 beta.1에 ZIP만 설치해서 동작하지 않습니다. 운영 설치·공개 push는 하지 않았습니다.

## 권한·한도

`reviews.read` 권한만 요청합니다. SDK는 현재 작품 상세에서만 호출할 수 있고 호스트가 mediaId를 결정합니다. 사용자 쿼리·URL·키를 서버에 전달해 임의 네트워크 요청을 시킬 수 없습니다. 프로필/PIN·플러그인 활성 상태·권한·revision을 검사하고, 응답 후에도 다시 확인합니다. 키즈 프로필은 후보·리뷰·검색 링크를 반환하지 않습니다.

호스트 UI가 공급자별 원문 URL, 현재 작품, 상태, 크기, 후보를 검증합니다. 출처 전환·작품 이동·프로필 변경 때 기존 결과를 폐기합니다. 플러그인을 끄면 리뷰 영역이 사라집니다.

데이터는 최대 64개의 서버 메모리 캐시에 10분 보관합니다. 동시 공급자 작업 4개, 실패 30초 재시도 간격, AniList 조회 20회/분으로 제한합니다. 429 응답에는 공급자 전체 60~300초 대기를 적용합니다. AniList HTTP는 8초/512KiB 제한이고 앱 종료 시 취소됩니다. 주기 수집, 시청기록 전송, AniList 계정 동기화, 원문 보관은 없습니다. TMDB 요청은 기존 서버의 인증·동시성·취소 처리를 재사용합니다.

## 검증·패키징

```sh
pnpm --filter @moa/server exec tsx --test test/plugin-reviews.test.ts
# MOA_PLAYWRIGHT_PATH, MOA_BROWSER_EXECUTABLE을 로컬 환경에 맞게 지정
pnpm --filter @moa/server exec tsx scripts/verify-reviews-plugin.mts
node plugins/template/build.mjs ../title-reviews
```

실제 AniList API로 프리렌(154587)의 후보 조회와 리뷰 8건 조회를 확인했습니다. 단편/후속 시즌도 후보에 포함돼 자동 첫 항목 선택을 하지 않습니다. 실제 리뷰 본문은 테스트 fixture나 저장소에 저장하지 않았습니다.

격리 MOA에서 실제 플러그인 SDK→호스트→서버→합성 공급자까지 테스트하며, 데스크톱/모바일 화면·후보 선택·재선택·번역 링크·키즈 제한·비활성화를 확인합니다. 캡처는 합성 데이터입니다. TMDB 어댑터는 합성 응답으로 검증했으며 이 작업에서는 개인 운영 자격 증명을 읽거나 운영 서비스를 변경하지 않았습니다.

## 공식 자료

- https://developer.themoviedb.org/reference/movie-reviews
- https://developer.themoviedb.org/reference/tv-series-reviews
- https://docs.anilist.co/guide/auth/
- https://docs.anilist.co/reference/object/review
- https://docs.anilist.co/guide/terms-of-use
- https://support.google.com/translate/answer/2534559

AniList의 이용 조건은 데이터 대량 수집·백업 및 경쟁 서비스 사용을 제한합니다. 이 구현은 사용자가 연 작품의 리뷰만 조회하는 선택 기능이며, 서비스 운영 형태가 달라지면 해당 조건을 다시 확인해야 합니다.
