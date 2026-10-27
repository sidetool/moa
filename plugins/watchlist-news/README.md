# 찜한 작품 소식

홈에서 현재 프로필이 최근 찜한 작품의 개봉·방영 소식을 확인합니다. 오늘부터 30일간의 한국 시간 기준 일정이며 작품을 누르면 MOA 상세 화면으로 이동합니다.

## 설치와 데이터

MOA `0.1.2-beta.3` 이상의 `moa.watchlist.news`와 `watchlist.read`·`schedule.read`가 필요합니다. TMDB 인증은 서버에서 사용하며 키즈 프로필에는 제공하지 않습니다.

- 최근 찜 100개 중 TMDB 연결이 확정된 서로 다른 작품을 최대 12편 확인합니다. 제목으로 연결을 추측하지 않습니다.
- 영화는 한국 극장 개봉·재개봉일입니다. 시리즈·애니는 TMDB `next_episode_to_air`의 원방영일로, 한국·OTT 공개일을 보장하지 않습니다.
- MOA 영상 업로드나 재생 가능 알림은 아닙니다. 확인 상한·실패·조회 중 목록 변경이 있으면 일부만 확인했다고 표시합니다.
- 서버는 공개 일정을 30분 보관하고 찜 목록은 매번 읽습니다. 새 조회·실패·권한 거부 시 이전 결과를 지웁니다.

## 권한과 설치

`watchlist.read`·`schedule.read`는 조회, `app.navigate`는 상세 이동, `ui`는 패널 높이 조절에 사용합니다. 외부 연결 권한은 없으며 새 권한은 관리자가 승인합니다. [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

저장소 루트에서 실행합니다. 브라우저 검사에는 `MOA_PLAYWRIGHT_PATH`·`MOA_BROWSER_EXECUTABLE`과 합성 응답을 사용합니다.

```sh
node plugins/template/build.mjs ../watchlist-news
pnpm --filter @moa/server exec tsx scripts/verify-news-boxoffice.mts
```

## 출처

[TMDB API](https://developer.themoviedb.org/) 데이터를 사용하며 공식 로고와 다음 문구를 표시합니다.

> This product uses the TMDB API but is not endorsed or certified by TMDB.
