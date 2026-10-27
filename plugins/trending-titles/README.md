# 요즘 인기 영화·TV

홈에 TMDB 일간·주간 인기 영화와 TV 작품을 최대 20편 표시합니다. 작품을 누르면 MOA 제목 검색으로 이동하며, 방향키·Home·End 또는 모바일 가로 스크롤로 탐색할 수 있습니다.

## 데이터와 동작

[TMDB 트렌드](https://developer.themoviedb.org/reference/trending-all)는 전 세계 TMDB 이용자의 관심도 기준입니다. 국내·OTT 순위나 MOA 재생 가능 여부를 뜻하지 않습니다. 한국어 정보가 있으면 한국어로 표시하며 TV에는 드라마·예능·애니·다큐 등이 포함됩니다.

새로고침과 기간 변경 때 마지막 요청만 표시합니다. 서버가 새 결과를 받지 못하면 24시간 미만의 캐시와 갱신 시각을 보여 주며 오래된 결과임을 알립니다. 권한 거부·미설정·오류에서는 이전 목록을 지웁니다.

## 설치와 권한

MOA `0.1.2-beta.1` 이상의 `moa.discovery.trending()`과 `discovery.read`가 필요합니다. 관리자가 폴더나 ZIP을 설치하면 홈에 표시됩니다. [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

```sh
node plugins/template/build.mjs ../trending-titles
```

생성 파일은 `plugins/template/dist/trending-titles.zip`입니다.

| 권한 | 용도 |
| --- | --- |
| `discovery.read` | 서버에서 인기 작품을 조회합니다. TMDB 키는 서버에 남습니다. |
| `app.navigate` | MOA 검색으로 이동합니다. |
| `ui` | 패널 높이를 120–1200px로 조절합니다. |
| `https://image.tmdb.org` | 포스터를 가져옵니다. |

포스터는 `w342` 주소만 `moa.fetch`로 받아 blob URL로 표시합니다. 보이거나 곧 보일 이미지를 한 번에 하나씩 요청하며 목록이 바뀌면 남은 요청과 blob URL을 정리합니다. 미디어 소스·계정·시청 기록에는 접근하지 않습니다.

응답의 `provider`와 `(provider, kind, id)`를 함께 확인합니다. ID는 문자열이며 MOA 작품 ID와 다릅니다. 현재 패키지는 TMDB의 출처·이미지 규칙만 지원합니다.

## 검사와 출처

다음 검사는 합성 SDK로 상태·포스터·키보드·요청 취소를 확인합니다. Playwright가 필요합니다.

```sh
MOA_PLAYWRIGHT_PATH=/path/to/node_modules/playwright-core node plugins/trending-titles/test/smoke.mjs
```

화면에 TMDB 공식 로고와 다음 고지를 표시합니다.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

정보·포스터 권리는 TMDB와 각 권리자에게 있습니다. 플러그인 라이선스는 [GPL-3.0-or-later](../../LICENSE)를 따릅니다.
