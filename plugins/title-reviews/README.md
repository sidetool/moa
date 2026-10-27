# 리뷰 모아보기

작품 상세에 접어서 보는 TMDB·AniList 리뷰를 추가합니다. 본체가 화면을 표시하며 플러그인에 키나 별도 화면은 넣지 않습니다. API는 `reviews.list`와 `title.reviews`입니다.

## 사용 방법

MOA `0.1.2-beta.3` 이상에서 설치하고 `reviews.read` 권한을 승인합니다. 키즈 프로필에는 제공하지 않습니다. 자세한 설치는 [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

- TMDB는 서버에 저장된 인증과 확정된 작품 ID를 사용합니다. 한국어 첫 페이지가 비었을 때만 영어 첫 페이지를 조회합니다.
- AniList는 키 없이 원제 또는 로컬 제목으로 애니 후보 5개를 찾습니다. 사용자가 제목·연도·형식을 확인해 선택하며 영구 작품 연결은 바꾸지 않습니다.
- 공급자별 최대 8개, 각 600자 이내 발췌를 보여 주고 전체 내용은 원문으로 연결합니다. 스포일러를 줄이기 위해 처음에는 접습니다.
- Google 번역은 외부 원문 페이지를 번역해 여는 링크입니다. 한국어 리뷰 찾기는 네이버·다음 검색 링크입니다.

## 요청과 보관

현재 작품과 프로필·PIN·권한·플러그인 상태를 확인합니다. 작품·출처·프로필을 바꾸거나 플러그인을 끄면 이전 결과를 지웁니다. 임의 URL·키로 서버 요청을 만들 수 없습니다.

서버 메모리에 최대 64개 결과를 10분 보관하며 외부 작업은 동시에 4개까지 처리합니다. 실패 후 30초 기다립니다. AniList는 추천 기능과 합쳐 분당 20회·동시 4개, 요청당 8초·512KiB로 제한합니다. 요청 제한 응답에서는 최소 60초, 공급자 지정에 따라 최대 1시간 기다립니다. 계정 동기화·시청 기록 전송·정기 수집은 하지 않습니다.

## 빌드와 검사

저장소 루트에서 실행합니다. 브라우저 검사는 `MOA_PLAYWRIGHT_PATH`·`MOA_BROWSER_EXECUTABLE`과 합성 응답을 사용합니다.

```sh
pnpm --filter @moa/server exec tsx --test test/plugin-reviews.test.ts
pnpm --filter @moa/server exec tsx scripts/verify-reviews-plugin.mts
node plugins/template/build.mjs ../title-reviews
```

## 공식 자료

[TMDB 영화 리뷰](https://developer.themoviedb.org/reference/movie-reviews), [TV 리뷰](https://developer.themoviedb.org/reference/tv-series-reviews), [AniList 공개 API](https://docs.anilist.co/guide/auth/), [리뷰 형식](https://docs.anilist.co/reference/object/review), [Google 페이지 번역](https://support.google.com/translate/answer/2534559)을 참고해 주세요.

[AniList 이용 조건](https://docs.anilist.co/guide/terms-of-use)은 대량 수집·백업과 경쟁 서비스 사용을 제한합니다. 사용자가 연 작품의 리뷰만 조회하며 운영 방식이 바뀌면 조건을 다시 확인해 주세요.
