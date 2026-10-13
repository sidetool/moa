# 찜한 작품 소식

MOA 홈에서 현재 프로필이 **최근 찜한 작품** 중 일부의 앞으로 30일(한국 시간, 오늘 포함) 개봉·방영 소식을 보여줍니다. 항목을 누르면 MOA의 해당 작품 상세(`/title/<mediaId>`)로 이동합니다. 자동 재생, 백그라운드 수집, 푸시 알림은 하지 않습니다.

## 설치 조건

MOA 0.1.2-beta.3 이상의 `moa.watchlist.news` SDK와 `watchlist.read`·`schedule.read` 권한을 포함한 MOA가 필요합니다. 이전 버전에는 ZIP만 설치해도 동작하지 않습니다.

영화·시리즈 정보는 MOA 서버에 설정된 TMDB 인증을 사용하며 플러그인에는 키가 없습니다. TMDB가 연결되지 않은 서버에서는 연결 안내만 표시합니다. 키즈 프로필에서는 제공하지 않습니다.

## 데이터 범위와 한계

- 내 목록의 최근 100개 중 TMDB 연결이 확정된 서로 다른 작품 **최대 12편**만 확인합니다. 전체 찜 목록을 확인하지 않습니다.
- 영화: TMDB의 한국 지역 극장 개봉(재개봉 포함) 날짜입니다. OTT 공개일이 아닙니다.
- 시리즈·애니: TMDB `next_episode_to_air`의 **원방영일**입니다. 한국 방영이나 OTT 공개를 보장하지 않으며, 새 시즌 공개를 별도로 탐지하지 않습니다(다음 회차의 시즌 번호만 표시).
- MOA 소스에 업로드되었거나 재생 가능해졌다는 알림이 아닙니다.
- 제목으로 추측해 연결하지 않습니다. TMDB에 연결되지 않은 작품은 검사 범위(최근 100개) 안의 개수만 표시합니다.
- "확인 대상 N편"은 조회를 시도한 작품 수이며 모두 성공했다는 뜻은 아닙니다. 목록 상한, 일부 조회 실패, 조회 중 찜 변경이 있으면 "일부만 확인"을 표시합니다.
- 소식이 없다는 것은 등록된 일정이 없다는 뜻이며 실제 개봉·방영이 없다는 뜻은 아닙니다.
- 서버는 공개 작품 일정만 30분간 캐시하고 찜 목록은 매번 다시 읽습니다. 느린 조회는 잠시 "가져올 수 없음"으로 표시될 수 있으며, 잠시 후 다시 시도하면 준비된 결과를 볼 수 있습니다.
- 플러그인에는 이전 조회 결과를 재사용하는 클라이언트 캐시가 없습니다. 새로 조회할 때 이전 항목을 즉시 지우며, 늦게 도착한 이전 응답과 실패·권한 거부·미설정 응답 시에도 이전 항목을 남기지 않습니다.

## 권한

`watchlist.read`·`schedule.read`(두 권한 모두 있어야 조회), `app.navigate`(작품 상세 이동), `ui`(홈 패널 높이 조절). 외부 연결 권한(`connect`)은 없으며 공급자 요청은 서버에서만 수행합니다. 기존 플러그인에 새 권한이 자동 부여되지 않습니다.

## 출처

[TMDB API](https://developer.themoviedb.org/) 데이터를 사용합니다. 화면에 공식 로고와 다음 고지를 표시합니다: This product uses the TMDB API but is not endorsed or certified by TMDB.

## 빌드와 검사

저장소 루트에서:

```sh
node plugins/template/build.mjs ../watchlist-news
# Playwright 및 Chromium 경로를 환경변수(MOA_PLAYWRIGHT_PATH, MOA_BROWSER_EXECUTABLE)로 지정
pnpm --filter @moa/server exec tsx scripts/verify-news-boxoffice.mts
```

ZIP에는 manifest.json과 plugin.js만 포함합니다. 브라우저 검사는 실제 서버·SDK를 사용하고 TMDB·KOBIS 응답만 합성 데이터로 대체합니다. 운영 설치·배포는 별도로 진행해야 합니다.
