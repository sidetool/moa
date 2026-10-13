# 개봉·방영 일정

MOA 홈에서 오늘부터 7일간의 한국 극장 개봉일과 국내 드라마 회차 일정을 조회합니다. 날짜를 선택할 때만 조회하며, 항목을 누르면 MOA 제목 검색으로 이동합니다. 자동 재생이나 백그라운드 수집은 하지 않습니다.

## 설치 조건

MOA 0.1.2-beta.3 이상의 `schedule.read` 권한과 `moa.discovery.schedule` SDK를 포함한 MOA가 필요합니다. 이전 버전에는 ZIP만 설치해도 동작하지 않습니다. 기존 인기·인물·리뷰 플러그인과는 별도 패키지입니다.

영화는 MOA 서버에 설정된 TMDB 인증을 사용합니다. 플러그인에 키를 넣지 않습니다. 드라마는 별도 API 키 없이 TVmaze를 사용합니다. 키즈 프로필에서는 제공하지 않습니다.

## 데이터 범위

- 영화: TMDB의 한국 지역 극장 개봉(type 2/3) 날짜를 작품별로 재확인합니다. 재개봉도 포함하며 OTT 공개일은 아닙니다. 첫 페이지에서 최대 12개 후보를 확인하므로 전체 개봉 목록을 보장하지 않습니다. 일부 조회 실패나 후보 제한은 화면에 표시합니다.
- 드라마: TVmaze 한국 채널 일정 중 Scripted 작품만 표시합니다. 글로벌 스트리밍 서비스 일정은 빠질 수 있으며 제목이 원어로 표시될 수 있습니다. 자정 회차는 실제 방영 시각을 한국 시간으로 변환합니다. 정확한 시간이 없으면 '시간 미정'으로 표시합니다.
- 조회 결과가 없다는 것은 등록된 일정이 없다는 뜻이며, 실제 개봉·방영이 없다는 뜻은 아닙니다.
- 서버 캐시는 30분입니다. '다시 확인'도 이 캐시를 사용할 수 있습니다. 실패 응답은 60초간 재사용합니다. 최대 14개 날짜/종류 조합과 동시 외부 조회 2개로 제한합니다.

## 권한

`schedule.read`는 읽기 전용 일정 조회, `app.navigate`는 MOA 내부 검색, `ui`는 홈 패널 높이 조절에 사용합니다. 외부 연결 권한은 없으며 공급자 요청은 서버에서만 수행합니다. 기존 플러그인에 새 권한이 자동 부여되지 않습니다.

## 출처

[TMDB API](https://developer.themoviedb.org/reference/discover-movie) 및 [지역별 개봉일](https://developer.themoviedb.org/reference/movie-release-dates). 공식 로고와 다음 고지를 화면에 표시합니다: This product uses the TMDB API but is not endorsed or certified by TMDB.

드라마 일정은 [TVmaze](https://www.tvmaze.com)의 [API](https://www.tvmaze.com/api)에서 제공하며 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 조건을 따릅니다. 한국 드라마 선별, 날짜·시간의 한국 시간 변환을 적용했습니다. 가공된 일정 데이터의 재배포에도 원본의 표시·동일조건변경허락 조건이 적용됩니다.

## 빌드와 검사

저장소 루트에서:

```sh
node plugins/template/build.mjs ../release-calendar
pnpm --filter @moa/server exec tsx --test test/plugin-schedule.test.ts
# Playwright 및 Chromium 경로를 환경변수로 지정
pnpm --filter @moa/server exec tsx scripts/verify-schedule-plugin.mts
```

ZIP에는 manifest.json과 plugin.js만 포함합니다. 브라우저 검사는 실제 서버·SDK를 사용하되 외부 응답은 합성 데이터로 대체합니다. 운영 설치·배포는 별도로 진행해야 합니다.
