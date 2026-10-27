# 개봉·방영 일정

홈에서 오늘부터 7일간 한국 극장 개봉일과 국내 드라마 회차 일정을 확인합니다. 날짜를 선택할 때 조회하며 작품을 누르면 MOA 제목 검색으로 이동합니다.

## 설치와 데이터

MOA `0.1.2-beta.3` 이상과 `moa.discovery.schedule`이 필요합니다. 영화는 서버의 TMDB 인증을, 드라마는 키가 필요 없는 TVmaze를 사용합니다. 키즈 프로필에서는 제공하지 않습니다.

- 영화는 한국 극장 개봉(type 2/3) 날짜를 확인하며 재개봉도 포함합니다. 첫 페이지의 최대 12개 후보를 확인하므로 전체 개봉 목록이나 OTT 공개일을 뜻하지 않습니다.
- 드라마는 TVmaze 한국 채널의 `Scripted` 작품입니다. 원어 제목이나 일부 누락된 일정이 있을 수 있습니다. 시각은 한국 시간으로 바꾸며 불확실하면 시간 미정으로 표시합니다.
- 서버는 결과를 30분, 실패를 60초간 보관합니다. 최대 14개 날짜·종류 조합과 동시 외부 조회 2개로 제한합니다. 빈 결과는 등록된 일정이 없다는 뜻입니다.

## 권한과 설치

`schedule.read`는 일정 조회, `app.navigate`는 검색 이동, `ui`는 패널 높이 조절에 사용합니다. 외부 요청은 서버에서 처리하며 새 권한은 관리자가 승인해야 합니다. [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

```sh
node plugins/template/build.mjs ../release-calendar
pnpm --filter @moa/server exec tsx --test test/plugin-schedule.test.ts
pnpm --filter @moa/server exec tsx scripts/verify-schedule-plugin.mts
```

저장소 루트에서 실행합니다. 브라우저 검사에는 Playwright와 Chromium 경로를 지정하며 외부 응답은 합성 데이터로 대체합니다.

## 출처

영화는 [TMDB](https://developer.themoviedb.org/reference/discover-movie)의 [지역별 개봉일](https://developer.themoviedb.org/reference/movie-release-dates)을 사용합니다. 화면에 공식 로고와 다음 고지를 표시합니다.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

드라마는 [TVmaze API](https://www.tvmaze.com/api)의 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 데이터를 한국 드라마로 선별하고 한국 시간으로 바꿉니다. 가공 데이터 재배포에도 출처 표시·동일조건변경허락 조건이 적용됩니다.
