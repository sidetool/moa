# 리뷰 모아보기 (개발 중)

작품 상세에 MOA가 직접 그리는 접이식 리뷰 영역을 추가하는 데이터 플러그인입니다. 한국어 블로그 검색을 기본으로 제공하며, 사용자 리뷰와 블로그 글을 구분합니다. API 이름은 공급자와 무관한 `reviews.list` / `title.reviews`입니다.

## 현재 범위와 제한

- 키 없이: 작품 제목으로 네이버·다음 블로그 검색 페이지를 여는 링크. MOA 안에서 한국어 글 목록을 보여주는 것은 아닙니다.
- 네이버/카카오 검색 키가 있으면: 공식 API의 제목·작성자·요약을 최대 8개 표시합니다. 원문 본문을 수집하지 않습니다. 제목 검색이므로 동명이작·책·광고가 섞일 수 있습니다.
- 기존 TMDB 연결이 있으면: 확정된 작품 ID의 사용자 리뷰 첫 페이지를 표시합니다. 추가 키 발급은 필요 없습니다. 조회는 en-US이고, 실제 글의 언어나 작성자의 국적을 보증하지 않습니다.
- 해외 리뷰의 Google 번역 버튼은 **외부 원문 페이지의 번역을 여는 링크**입니다. MOA 내 자동번역이나 무료 번역 API가 아닙니다. 링크 대상 사이트/Google 지원 여부에 따라 번역이 안 될 수도 있습니다.
- AniList는 인증 없이 실제 리뷰 조회가 가능함을 확인했지만, 작품 ID 연결을 검증하지 않았으므로 아직 연결하지 않았습니다. Jikan은 이번 환경의 네트워크 오류로 실조회하지 못했습니다.
- 한국어 관람평을 폭넓게 제공하는 무인증 공개 API는 아직 확인하지 못했습니다. 내부 API/페이지 수집을 공식 API처럼 사용하지 않습니다.

`minMoaVersion: 0.1.2-beta.2`는 **아직 발행하지 않은 후보 번호**입니다. 리뷰 호스트 코드가 들어간 버전으로 통합 담당자가 확정해야 합니다. 기존 beta.1에 ZIP만 설치해서 동작하지 않습니다. 공개/운영 설치는 하지 않았습니다.

## 선택적 서버 설정

새 키 발급은 필수가 아닙니다. 필요한 경우만 서버 환경에 설정하고 앱을 다시 시작합니다:

- 네이버: `MOA_NAVER_CLIENT_ID`, `MOA_NAVER_CLIENT_SECRET`
- 카카오: `MOA_KAKAO_REST_KEY`
- TMDB: 기존 MOA 메타데이터 설정 그대로 사용

제공된 Compose 파일은 위 환경변수를 앱 컨테이너로 전달합니다. 이미 설치한 릴리스의 compose 파일은 이 브랜치 수정만으로 바뀌지 않으므로, 통합/업데이트 시 전달 여부를 확인해야 합니다. 키를 manifest, plugin.js, 공개 Git, 브라우저 저장소에 넣지 않습니다.

## 권한·표시

`reviews.read`만 요청하며 현재 작품 화면에서만 SDK 호출이 가능합니다. 일반 플러그인이 임의 검색어나 외부 URL을 서버에 가져오도록 요청하는 API가 아닙니다. 서버는 프로필/PIN·플러그인 활성 상태·권한·revision을 확인하고 응답 후 다시 확인합니다. 키즈 프로필에는 외부 리뷰와 검색 링크를 제공하지 않습니다.

펼치기 전에는 네트워크 요청을 하지 않습니다. 제목도 스포일러일 수 있음을 안내하고 요약은 별도로 접어 둡니다. UI는 플러그인을 끄면 사라집니다. 출처 전환·작품 이동·프로필 변경 때 이전 결과를 재사용하지 않습니다. 공급자 데이터는 서버 메모리에만 최대 64개/10분, 동시 요청 4개, 실패 30초 재시도 간격으로 제한합니다. 검색 HTTP는 8초/512KiB 제한이며 원문 링크를 서버가 다운로드하지 않습니다.

## 검증·패키징

```sh
pnpm --filter @moa/server exec tsx --test test/plugin-reviews.test.ts
# Playwright 경로와 실행 파일을 환경변수로 지정하면 실제 MOA/SDK/서버를 합성 데이터로 검증
pnpm --filter @moa/server exec tsx scripts/verify-reviews-plugin.mts
node plugins/template/build.mjs ../title-reviews
```

네이버·카카오 실키가 없어 목록 데이터는 합성 응답으로 검증했습니다. 캡처도 예시 데이터입니다. 서버 저장/추천 작업을 진행 중인 다른 작업 트리는 변경하지 않았습니다.

공식 자료:
- https://developers.naver.com/docs/serviceapi/search/blog/blog.md
- https://developers.kakao.com/docs/ko/daum-search/dev-guide
- https://developer.themoviedb.org/reference/movie-reviews
- https://developer.themoviedb.org/reference/tv-series-reviews
- https://support.google.com/translate/answer/2534559
- https://docs.anilist.co/guide/auth/
