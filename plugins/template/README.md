# MOA 플러그인 템플릿

MOA 안에서 실행하는 JavaScript 예제입니다. 기본 예제는 프로필별 재생 위치 하나를 저장하고 다시 이어 봅니다. HTML 화면이나 별도 의존성·번들러는 필요하지 않습니다.

## 만들기와 설치

관리자 계정의 **설정 → 플러그인**에서 폴더 전체 또는 ZIP을 선택하고 권한을 확인해 설치합니다. 기본 예제는 **재생 설정 → 플러그인 → 북마크 저장·이어 보기**에서 사용합니다. 북마크는 브라우저와 서버를 다시 시작해도 유지됩니다.

Node.js 22.15 이상에서 템플릿 폴더를 기준으로 실행합니다.

```sh
node build.mjs
```

`dist/playback-bookmark.zip`이 생성됩니다. 저장소 루트에서는 `node plugins/template/build.mjs`로 실행하고 출력된 경로를 사용합니다.

## 코드 작성

`manifest.json`에 ID·버전·표시 위치·권한·허용 HTTPS 주소·동작 이름을 설정하고 `plugin.js`에 기능을 작성합니다. MOA가 스크립트 실행 전에 `window.moa`를 제공합니다.

```js
moa.on('ready', async context => {
  if (context) await moa.notify(`Playing ${context.title}`);
});

moa.on('action', async ({ id }) => {
  if (id === 'pause') await moa.player.pause();
});
```

이 예제에는 `player.context`, `notifications`, `player.control` 권한과 ID가 `pause`인 동작이 필요합니다. 같은 ID로 다시 설치하면 업데이트하며 별도 플러그인은 다른 ID를 사용합니다. 필요한 권한만 요청해 주세요.

자동 자막 가져오기에는 `player.context`·`subtitles.import`와 서비스의 HTTPS 주소를 `connect`에 선언합니다.

```js
moa.on('ready', async context => {
  if (!context) return;
  const url = new URL('/subtitle', 'https://subtitles.example.org');
  url.searchParams.set('title', context.title);
  const response = await moa.fetch(url.href);
  await moa.importSubtitles(new File([await response.arrayBuffer()], 'downloaded.srt'));
});
```

예제 주소를 이용 권한이 있는 서비스로 바꿔 주세요. MOA는 일반 자막 업로드와 같은 검증·변환·저장 절차를 적용합니다.

## 포함된 예제

| 폴더 | 기능 |
| --- | --- |
| `examples/page-notes` | 프로필별 페이지 메모와 작품 찾기입니다. `metadata.lookup`으로 기존 작품 상세를 열고, 없거나 조회에 실패하면 검색합니다. `routechange`와 `moa.ui.open/close`도 사용합니다. MOA 0.1.2 이상이 필요합니다. |
| `examples/catalog-labels` | API 2의 `catalog.transform`으로 기존 작품 배지를 바꾸고 상세 패널을 표시합니다. `catalog.modify`·`ui`만 필요하며 서버 DB는 바꾸지 않습니다. |
| `examples/subtitle-helper` | 파일·텍스트 입력으로 자막을 가져오는 HTML 화면입니다. 재생 설정의 플러그인 메뉴에서 엽니다. |

템플릿 폴더에서 필요한 예제를 빌드합니다.

```sh
node build.mjs examples/page-notes
node build.mjs examples/catalog-labels
node build.mjs examples/subtitle-helper
```

`minMoaVersion`으로 최소 MOA 버전을 지정할 수 있습니다. 더 새 API·버전이 필요한 플러그인은 설치 상태를 유지하되 실행하지 않으며 관리 화면에서 필요한 업데이트를 안내합니다.

## 기능별 시작점

이미 있는 예제를 복사하거나 필요한 부분만 가져오시면 됩니다. 아래 경로는 템플릿 폴더 기준이며 `node build.mjs <폴더>`로 같은 방식으로 빌드합니다.

| 만들 기능 | SDK·hook | 예제 |
| --- | --- | --- |
| 재생 조작·프로필 저장 | `context`, `player`, `storage`, `notify` | 기본 템플릿 |
| 앱 도구·페이지 이동 | `app`, `ui`, `routechange` | `examples/page-notes` |
| 자막 업로드 | `importSubtitles` | `examples/subtitle-helper` |
| 작품 표시 변경·상세 패널 | `catalog.transform` | `examples/catalog-labels` |
| 제목 찾기·포스터 미리 불러오기·페이드 탐색 화살표 | `metadata.lookup`, `fetch`, `ui.resize` | [`../anime-schedule`](../anime-schedule/README.md) |
| 인기 영화·TV | `discovery.trending` | [`../trending-titles`](../trending-titles/README.md) |
| 출연진·인물 참여작 | `metadata.credits/person`, `title.people` | [`../title-people`](../title-people/README.md) |
| 개봉·방영 일정 | `discovery.schedule` | [`../release-calendar`](../release-calendar/README.md) |
| 찜한 작품 소식 | `watchlist.news` | [`../watchlist-news`](../watchlist-news/README.md) |
| 국내 극장 박스오피스 | `discovery.boxOffice` | [`../korean-boxoffice`](../korean-boxoffice/README.md) |
| 기존 상세 UI의 리뷰 | `reviews.list`, `title.reviews` | [`../title-reviews`](../title-reviews/README.md) |

현재 상세 작품의 정보는 `moa.metadata.details()`, 프로필의 기록·찜은 `moa.history.list()`·`moa.watchlist.list()`로 읽습니다. 입력·응답·필요 권한·버전은 [API 문서](../../docs/PLUGINS.md)를 확인해 주세요. 모든 권한을 기본 manifest에 추가하지 말고 사용하는 기능만 선언합니다.

`moa.fetch`는 선언한 공개 HTTPS 출처의 GET만 지원합니다. 외부 이미지는 바이트를 받아 Blob URL로 표시하고 사용이 끝나면 해제합니다. 네트워크 요청은 플러그인·프로필별 4개, 서버 전체 16개까지 동시 실행하며 다른 SDK 호출의 여유도 남겨 주세요. 구버전 서버의 더 작은 한도에 걸리면 `plugin-busy` 오류에만 동시 요청 수를 줄여 제한된 횟수로 재시도합니다. 포스터 미리 불러오기와 중복 요청 재사용은 `anime-schedule` 예제를 참고해 주세요. 공급자 API 키는 패키지에 넣지 않습니다.

업데이트된 서버는 `moa.fetch`의 정규 TMDB 이미지 URL을 공유 이미지 캐시에 저장하므로 새로고침과 서버 재시작 후에도 재사용합니다. 별도 플러그인 저장소나 권한은 필요하지 않습니다. 캐시 대상·보관 기간·용량은 [이미지 캐시 안내](../../docs/PLUGINS.md#이미지-캐시)를 확인해 주세요. 서버를 업데이트하지 않아도 기존 다운로드 방식으로 동작합니다.

## 변경과 검증

플러그인 API를 추가하거나 바꾸면 [API 문서](../../docs/PLUGINS.md), 이 안내, 해당 예제의 manifest·코드를 함께 갱신합니다. SDK에 없는 기능을 예제에서 먼저 사용하지 않습니다. 패키지를 설치해 성공·빈 결과·실패·권한 취소를 확인하고, 화면 변경은 디자인 명세와 미리보기에도 반영해 주세요.

기본 패키지·권한 검사는 `apps/server/test/website-plugins.test.ts`, 템플릿 화면 검사는 `apps/web/scripts/verify-website-plugins.mjs`에서 유지합니다. 기능별 테스트는 서버의 `plugin-*.test.ts`, 홈 패널 검사는 `verify-home-plugins.mjs`에 있습니다. 임시 로그·스크린샷만 정리하고 회귀 테스트는 남깁니다.

Codex에 `moa-plugin` 스킬을 설치했다면 `$moa-plugin`으로 제작을 요청할 수 있습니다. 이 문서와 실제 SDK를 기준으로 필요한 예제·권한·검증을 선택합니다.

## API와 라이선스

이벤트·함수·권한·실행 범위는 [플러그인 API](../../docs/PLUGINS.md)를 참고해 주세요. 템플릿은 MOA와 같은 GPL-3.0-or-later 라이선스입니다. 배포할 때 라이선스와 권한 설명을 포함해 주세요.
