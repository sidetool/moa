# 요즘 인기 영화·TV

MOA 홈에 TMDB 일간·주간 인기 영화와 TV 작품을 표시하는 웹사이트 플러그인.

## 기능

- 영화·TV, 일간·주간을 선택해 인기 작품을 최대 20편 표시함.
- 작품을 선택하면 MOA 검색 화면에서 해당 제목을 검색함. 자동 재생하거나 특정 소스의 재생 가능 여부를 보장하지 않음.
- 새로고침과 다시 시도로 목록을 다시 요청함. 선택을 빠르게 바꾸면 마지막 선택의 응답만 표시함.
- 방향키와 Home·End 키로 작품 카드 사이를 이동할 수 있음. 모바일에서는 가로로 밀어 넘김.
- 응답과 캐시는 MOA 서버가 관리함. 플러그인은 화면에 보이는 선택의 최신 응답만 유지하고 별도 목록 캐시를 두지 않음.

## 데이터 범위와 한계

- TMDB [트렌드](https://developer.themoviedb.org/reference/trending-all)는 전 세계 TMDB 이용자의 관심도 기준임. 국내 인기 순위나 OTT 시청 순위가 아님. 제목·소개는 한국어 정보가 있으면 한국어로 표시됨.
- TV에는 드라마뿐 아니라 예능·애니메이션·다큐멘터리·토크쇼 등이 포함됨.
- 서버가 최신 목록을 가져오지 못하면 24시간 미만의 캐시가 있을 때에만 마지막 목록과 갱신 시각을 ‘최신 정보가 아닐 수 있음’과 함께 표시함.

## 상태

| 서버 상태 | 표시 |
| --- | --- |
| `ready` | 작품 목록. 결과가 없으면 빈 목록 안내 |
| `unconfigured` | 관리자가 MOA 설정에서 TMDB를 연결해야 함. 다시 시도 가능 |
| `restricted` | 현재 프로필(예: 키즈 프로필)에서는 목록을 표시하지 않음 |
| `unavailable` | 사용 가능한 캐시가 없는 경우 오류와 다시 시도. 오래된 캐시가 있으면 호스트는 `ready`와 `stale: true`를 반환함 |
| 요청 실패·잘못된 응답 | 오류와 다시 시도 |

`restricted`, `unconfigured`, 오류 상태에서는 이전 목록을 남기지 않고 포스터도 요청하지 않음.

## 설치

`moa.discovery.trending()`과 `discovery.read` 권한을 제공하는 MOA가 필요함. `minMoaVersion`은 아직 출시되지 않은 `0.2.0-beta.1`로 잠정 지정했으며, 실제 출시 버전에 맞춰 조정해야 함. 현재 v0.1.1은 새 권한을 알지 못해 설치 단계에서 거부할 수 있음. 본체에 이 API가 먼저 포함되어야 하며 ZIP만 설치해서 기능을 추가할 수는 없음.

관리자 계정으로 **플러그인 → 폴더 선택**에서 이 폴더를 선택해 설치하고 활성화하면 홈에 표시됨. ZIP으로 설치하려면 저장소 루트에서 템플릿 빌드 도구를 실행함.

```sh
node plugins/template/build.mjs ../trending-titles
```

생성된 `plugins/template/dist/trending-titles.zip`을 플러그인 화면에서 설치하면 됨. 패키지에는 `manifest.json`과 `plugin.js`만 포함됨.

## 권한

| 권한 | 용도 |
| --- | --- |
| `discovery.read` | MOA 서버를 통해 TMDB 인기 영화·TV 목록 조회. TMDB API 키는 서버에 남고 플러그인에 전달되지 않음 |
| `app.navigate` | 선택한 작품의 MOA 검색 화면으로 이동 |
| `ui` | 홈에 표시하는 플러그인 높이 조정(120–1200px) |
| `https://image.tmdb.org` | 포스터 이미지 다운로드 |

플러그인 iframe의 보안 정책은 `data:`·`blob:` 이미지만 허용함. 그래서 포스터는 `moa.fetch`로 MOA 서버를 거쳐 받아 blob URL로 표시함. `https://image.tmdb.org/t/p/w342/…` 형식의 주소만 요청하며, 화면에 보이거나 곧 보일 카드의 포스터만 한 번에 하나씩 가져옴. 목록이 바뀌면 남은 요청은 버리고 blob URL을 해제함. 포스터를 받지 못하면 제목을 대신 표시함. TMDB 이미지 서버에 소스 사이트의 쿠키나 TMDB API 키를 전송하지 않음.

미디어 소스·계정·시청 기록에는 접근하지 않음. 작품 정보는 텍스트로만 표시함.

## 출처

[TMDB](https://www.themoviedb.org/)의 공식 로고(MOA 정보 화면과 같은 원본 SVG)와 다음 문구를 표시함.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

작품 정보와 포스터의 저작권은 TMDB와 각 권리자에게 있음.

## 검사

`test/smoke.mjs`는 가짜 SDK와 호스트와 같은 CSP를 사용하는 브라우저 검사임. 상태별 화면, 요청 경쟁, 포스터 순차 다운로드와 허용 목록, 키보드 이동, 높이 범위, 신뢰할 수 없는 텍스트 처리를 확인함. Playwright를 별도로 설치해야 하며, 없으면 건너뜀.

```sh
MOA_PLAYWRIGHT_PATH=/path/to/node_modules/playwright-core node plugins/trending-titles/test/smoke.mjs [스크린샷-폴더]
```

라이선스는 저장소의 [GPL-3.0-or-later 라이선스](../../LICENSE)를 따름.
