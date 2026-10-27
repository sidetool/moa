# 웹사이트 플러그인

플러그인은 MOA 화면에 도구·알림·작품 정보·자막 기능을 추가합니다. 영상 목록과 재생 주소를 제공하는 소스 확장과는 다릅니다. API 2는 작품 표시 정보 수정과 상세 패널도 지원합니다.

처음 만드실 때는 [템플릿](../plugins/template/README.md)에서 가장 가까운 예제를 선택해 주세요. 아래 SDK 표가 현재 공개 기능의 목록이며, 응답 타입은 [`packages/shared/src/index.ts`](../packages/shared/src/index.ts)에서 확인할 수 있습니다.

## 설치와 관리

관리자는 설정 → 플러그인에서 ZIP, 폴더, manifest·실행 파일을 선택하거나 끌어 놓아 설치합니다. 같은 폴더에 `manifest.json`과 `plugin.js` 또는 `index.html`이 있어야 합니다. GitHub ZIP처럼 바깥 폴더가 있어도 가장 얕은 manifest를 사용합니다. 묶음 `.moa-plugin.json`도 지원합니다. 설치 전에 권한과 외부 접속 출처를 확인하세요.

공개 HTTPS ZIP·`.moa-plugin.json` 링크로도 설치할 수 있습니다. 링크를 저장해 업데이트 확인에 사용하며 패키지 ID가 같아야 합니다. 선택 `updateUrl`로 같은 주소를 선언할 수 있습니다. 이동 경로도 공개 HTTPS여야 하며 크기·격리 제한을 유지합니다. 업데이트는 미리 확인한 뒤 설치합니다.

관리자는 다중 선택으로 사용·중지·삭제할 수 있으며 실패한 항목만 선택을 남겨 재시도합니다. 설치 목록 `/plugins`는 관리자 전용입니다. 일반 프로필에는 사용 중인 호환 기능의 표시 정보만 전달하고 버전·설정·중지된 플러그인 목록은 노출하지 않습니다. **데이터 보기**에서 관리자가 프로필별 JSON, 외부 출처, 업데이트 링크와 저장 용량을 확인할 수 있습니다. 실행 중 플러그인은 자기 프로필 데이터만 읽습니다.

같은 ID 업데이트는 코드만 교체하고 사용 여부·데이터를 유지합니다. JS는 패키지 버전·프로필 변경 시 다시 시작합니다. 중지·삭제는 SDK 호출을 즉시 막고 배경 인스턴스는 최대 30초 뒤 목록 갱신 시 제거합니다. 삭제는 플러그인 데이터도 지우지만 가져온 자막은 남깁니다. HTML 도구는 업데이트 후 다시 열어야 합니다.

JS 패키지는 자동 실행하며 승인된 기능을 별도 확인 없이 쓸 수 있습니다. 신뢰하는 제작자의 코드만 설치하세요.

## 패키지 형식

```json
{
  "apiVersion": 1,
  "id": "pause-tool",
  "name": "Pause tool",
  "version": "1.0.0",
  "description": "Pause playback from playback settings.",
  "placements": ["player"],
  "permissions": ["player.control"],
  "connect": [],
  "actions": [{ "id": "pause", "label": "Pause playback" }],
  "script": "moa.on('action', async ({ id }) => { if (id === 'pause') await moa.player.pause(); });"
}
```

`script`와 `html` 중 하나만 지정합니다. `actions`, `hooks`, `minMoaVersion`, `updateUrl`은 선택 필드이며 알려지지 않은 필드는 거부합니다. API 1도 계속 지원합니다. 지원보다 높은 API 패키지는 설치할 수 있지만 MOA를 업데이트하기 전에는 실행하지 않습니다. 관리 화면에 최소 API·MOA 버전을 표시합니다.

ID는 영문 소문자로 시작하는 2~64자의 소문자·숫자·하이픈입니다. 버전은 `major.minor.patch`와 선택 사전 릴리스 표기를 사용합니다.

| 필드 | 역할 |
| --- | --- |
| `script` | 실행 범위가 열릴 때 한 번 실행하는 JS입니다. 의존성도 함께 묶습니다. |
| `html` | 도구를 열 때 모달에 표시할 HTML·내부 스타일·스크립트입니다. |
| `placements: ["player"]` | 영상이 열린 동안 실행하며 재생 설정의 플러그인에 표시합니다. |
| `placements: ["app"]` | 플레이어 밖 앱 화면에서 실행합니다. |
| `placements: ["settings"]` | 기존 패키지용 `app` 별칭입니다. |
| `placements: ["home"]` | 홈 `/`, `/tabs/home`에 JS·HTML 패널을 표시합니다. 분류 탭·로컬 목록에는 표시하지 않습니다. |
| `placements: ["detail"]` | API 2에서 작품 헤더 아래·회차 목록 위에 패널을 표시합니다. 작품이 바뀌면 다시 시작합니다. |
| `placements: ["player", "app"]` | 범위가 바뀔 때 새 인스턴스를 시작합니다. |
| `minMoaVersion` | 선택 최소 버전입니다. 사전 릴리스까지 비교하며 릴리스 버전이 없는 개발 빌드는 충족하지 못합니다. |
| `hooks: ["catalog.transform"]` | API 2 JS와 `catalog.modify` 권한으로 작품 표시를 바꿉니다. |
| `hooks: ["title.people"]` / `["title.reviews"]` | API 2 JS로 기존 출연진·리뷰 UI에 데이터를 제공합니다. 각각 `metadata.read`·`reviews.read` 권한이 필요합니다. |
| `actions` | JS 전용 선택 버튼입니다. 고유 ID는 소문자로 시작하는 최대 40자의 소문자·숫자·하이픈이며 읽을 수 있는 label을 둡니다. |
| `connect` | `moa.fetch`로 접근할 정확한 HTTPS 출처 목록입니다. |

같은 실행 범위에서 페이지·도구 모달·재생 설정을 열고 닫아도 JS 인스턴스는 유지합니다. 범위·프로필·회차 변경, 업데이트, 중지·삭제 시 정리하며 타이머·이벤트도 제거합니다. 영구 데이터는 `moa.storage`에 저장하세요. `home`/`detail`과 `app`/`settings`를 함께 쓰면 해당 페이지는 인라인 인스턴스 하나, 나머지는 새 앱 인스턴스를 사용합니다. 인라인 배경은 투명하며 `--moa-text`, `--moa-muted`, `--moa-accent`, `--moa-surface`를 제공합니다.

## SDK와 이벤트

코드 실행 전에 `window.moa`가 제공됩니다. `on`을 제외한 메서드는 Promise를 반환하며 잘못된 입력·권한 없음·접근 취소·요청 실패를 거부합니다. 일반 호출 오류는 플러그인에서 처리해 주세요. 이벤트 처리 오류는 알림으로 표시합니다. 첫 `ready`를 받으려면 `plugin.js` 최상위에서 동기적으로 이벤트를 등록합니다.

| 메서드 | 권한 | 결과 |
| --- | --- | --- |
| `moa.app.context()` | `app.context` | 현재 `{ pathname, search, hash }` |
| `moa.app.navigate(path)` | `app.navigate` | `/search?q=example`, `/title/id`, `/watch/episodeId` 등 내부 절대 경로로 이동하며 외부 주소는 거부합니다. |
| `moa.ui.open()` / `close()` | `ui` | 도구·인라인 패널을 열고 닫습니다. JS DOM은 실행 범위 내에서 유지합니다. |
| `moa.ui.resize(height)` | `ui` | 인라인 높이를 올림해 120~1200 CSS px로 제한합니다. 유한수가 아니거나 인라인 밖이면 거부합니다. |
| `moa.context()` | `player.context` | `{ episodeId, title, currentTime }` 또는 플레이어 밖에서 null |
| `moa.metadata.details()` | `metadata.read` | 현재 연결 작품의 공개 TMDB 정보 |
| `moa.metadata.lookup({title,type?})` | `metadata.read` | 제목에 맞는 TMDB 포스터와 기존 MOA 작품 ID |
| `moa.metadata.credits()` | `metadata.read` | 현재 상세 작품의 출연진·제작진 |
| `moa.metadata.person({provider,id})` | `metadata.read` | 현재 작품 크레딧에 있는 인물의 참여 작품 |
| `moa.history.list({limit?,cursor?,since?})` | `history.read` | 현재 프로필의 시청 기록 페이지 |
| `moa.watchlist.list({limit?,cursor?,since?})` | `watchlist.read` | 현재 프로필의 찜 목록 페이지 |
| `moa.watchlist.news()` | `watchlist.read` + `schedule.read` | 찜한 작품의 예정 개봉·방영 소식 |
| `moa.discovery.trending({kind,window})` | `discovery.read` | 영화·TV의 일간·주간 인기 작품 |
| `moa.discovery.schedule({kind,date})` | `schedule.read` | 한국 시간 기준 개봉·방영 일정 |
| `moa.discovery.boxOffice({period})` | `boxoffice.read` | 국내 극장 일간·주간 박스오피스 |
| `moa.reviews.list(provider?,selection?)` | `reviews.read` | 현재 상세 작품의 리뷰·작품 후보. 공급자 기본값은 `tmdb`입니다. |
| `moa.player.play()` / `pause()` | `player.control` | 재생·일시정지입니다. 브라우저 자동재생 정책으로 재생이 거부될 수 있습니다. |
| `moa.player.seek(seconds)` | `player.control` | 영상 범위 안에서 이동하며 실시간은 지원하지 않습니다. |
| `moa.importSubtitles(file)` | `subtitles.import` | 서버 저장 후 true |
| `moa.storage.get()` / `set(object)` | `storage` | 현재 프로필의 JSON 객체입니다. 초기값은 `{}`이고 set은 전체 교체하며 동시 저장은 마지막 완료값을 사용합니다. |
| `moa.notify(text)` | `notifications` | 플러그인 이름이 붙은 일반 텍스트 알림 |
| `moa.fetch(url)` | `connect`의 정확한 HTTPS 출처 | 내려받은 바이트의 브라우저 `Response` |
| `moa.hooks.register("catalog.transform", handler)` | `catalog.modify`와 hook 선언 | 비동기 표시 변환 등록. 선언 없음·권한 취소는 거부합니다. |
| `moa.hooks.register("title.people", handler)` | `metadata.read`와 hook 선언 | 기존 출연진·인물 UI에 응답을 제공합니다. |
| `moa.hooks.register("title.reviews", handler)` | `reviews.read`와 hook 선언 | 기존 리뷰 UI에 응답을 제공합니다. |
| `moa.on(event, handler)` | 이벤트별 권한 | 등록 해제 함수 |

| 이벤트 | 내용 | 시점 |
| --- | --- | --- |
| `ready` | 허용된 재생 정보 또는 null | 호스트 연결 후 한 번 |
| `routechange` | `{ pathname, search, hash }` | `app.context` 권한으로 처음 및 경로 변경 후 |
| `timeupdate` | 재생 정보 | `player.context` 권한으로 약 1초마다 |
| `action` | `{ id }` | 선언한 버튼을 누를 때 |

재생 정보의 위치는 초 단위입니다. 소스 인증·영상 URL·계정·API 키는 제공하지 않으며 모든 호출을 호스트에서 검사합니다.

### 작품 정보

`moa.metadata.details()`는 인수 없이 상세 페이지에서 사용합니다. 응답은 `{provider,status,title,details}`입니다. `title`은 확인된 MOA/공급자 식별 정보입니다. `details`는 `title`, `genres`와 선택 `originalTitle`, `overview`, `year`, `runtime`(분), `rating`(0~10), `certification`, `poster`, `backdrop`을 포함합니다.

준비되지 않으면 title·details는 null이고 상태는 `unconfigured | unlinked | restricted | unavailable`입니다. 어린이 프로필은 사용할 수 없습니다. 자동 제목 매칭·임의 외부 ID·URL·쿼리·키를 노출하지 않습니다. 기존 TMDB 캐시와 같은 요청 병합을 사용하고 응답 후 권한·프로필 정책·작품 연결을 다시 검사합니다. 이미지는 `connect`에 `https://image.tmdb.org`를 넣어야 하며 UI에 TMDB 출처를 표시하세요.

### 제목으로 작품 찾기

`moa.metadata.lookup({title,type?})`는 MOA 0.1.3-beta.1 이상에서 지원하며 manifest에 `minMoaVersion: "0.1.3-beta.1"` 이상을 지정합니다. 홈·앱 도구에서도 사용할 수 있습니다. `title`은 1~200자이며 선택 항목 `type`은 `anime | movie | series`입니다. 내부 요청은 `POST /api/plugin-runtime/:id/metadata/lookup`, 본문은 `{revision,query}`입니다.

응답은 `{provider,status,mediaId?,poster?}`입니다. `status`는 `ready | unconfigured | restricted | unavailable`이며 포스터와 작품 ID는 확인된 경우에만 포함됩니다. 정확한 제목·기존 TMDB 연결로 저장된 작품을 찾고, 같은 작품의 여러 소스는 묶어서 처리합니다. 동명 작품이나 시즌이 모호하면 ID를 반환하지 않습니다. 원격 소스의 전체 목록을 새로 검색하거나 작품 연결을 저장하지 않습니다.

```js
const match = await moa.metadata.lookup({title: '작품 제목', type: 'anime'});
await moa.app.navigate(match.mediaId
  ? `/title/${encodeURIComponent(match.mediaId)}`
  : `/search?q=${encodeURIComponent('작품 제목')}`);
```

TMDB 미설정·조회 실패 상태에도 기존 작품이 확인되면 `mediaId`를 반환할 수 있습니다. 어린이 프로필은 `restricted`이며 결과를 제공하지 않습니다. 공개 TMDB 결과만 캐시하고 작품 접근 권한은 매번 확인합니다. 요청 후 플러그인 권한·버전·프로필과 TMDB 설정을 다시 검사합니다.

`poster`는 TMDB `w342` 이미지 주소입니다. `connect`에 `https://image.tmdb.org`를 선언하고 `moa.fetch()`로 받은 바이트를 Blob URL로 표시합니다. 편성표와 이미지 요청은 동시 요청 한도 안에서 병렬로 처리할 수 있습니다. 같은 작품·이미지의 요청은 재사용하고, 이미지 오류가 작품 선택을 막지 않게 해 주세요. 이미지를 해제할 때 Blob URL도 정리합니다. 전체 요일을 미리 불러오고 작은 화면에서 화살표로 이동하는 예제는 [`anime-schedule`](../plugins/anime-schedule/README.md)을 참고해 주세요.

### 이미지 캐시

업데이트된 서버는 `moa.fetch`로 요청한 `https://image.tmdb.org/t/p/(w숫자|original)/파일명.(jpg|png|webp)` 형식의 공개 이미지 원본을 저장합니다. 쿼리·fragment·포트·사용자 정보가 붙은 URL은 캐시 대상에서 제외합니다. 정상 이미지 응답만 저장하며 실패는 다음 요청에서 다시 시도합니다.

보관 기간은 30일이며 기존 서버 이미지와 256MiB 용량을 공유하고 오래 사용하지 않은 항목부터 정리합니다. 같은 URL의 동시 요청은 합치며 새로고침·서버 재시작 뒤에도 유효한 캐시를 재사용합니다. 캐시 만료·삭제 시 다시 내려받습니다. 설치·활성 상태, 리비전과 `connect` 권한은 캐시 요청 전후에도 검사합니다. 플러그인 ZIP만 교체한 기존 서버에서는 이미지 요청이 기존 방식으로 동작합니다.

### 도구 예제

앱 도구는 `placements:["app"]`과 필요한 `ui`, `app.context`, `app.navigate`, `storage`를 선언합니다. 열기 버튼 또는 `moa.ui.open()`으로 자체 DOM을 표시합니다. `ui`가 있는 앱 스크립트는 다른 화면에서도 도구 진입을 제공할 수 있습니다. 호스트 DOM·제한 없는 서버 API에는 접근하지 못합니다.

```js
document.body.innerHTML = '<label>Search <input id="query"></label><button id="search">Search MOA</button>';
document.querySelector('#search').onclick = async () => {
  const query = document.querySelector('#query').value;
  await moa.ui.close();
  await moa.app.navigate(`/search?q=${encodeURIComponent(query)}`);
};

moa.on('routechange', async page => {
  const saved = await moa.storage.get();
  await moa.storage.set({ ...saved, lastPage: page.pathname });
});
```

홈 패널은 `placements:["home"]`으로 기본 320px 높이의 격리 iframe에 표시합니다. 제목·반응형 배치는 플러그인이 제공하고 `ui` 권한으로 높이를 조정합니다. 1200px보다 긴 내용은 내부 스크롤을 사용하세요.

```js
document.body.innerHTML = '<h2>Weekly picks</h2><p>Choose a title to search MOA.</p>';
moa.on('ready', () => moa.ui.resize(160));
```

[요일별 신작 예제](../plugins/anime-schedule/README.md)는 왼쪽에 모은 원형 요일 버튼과 가로 포스터 카드를 표시합니다. 목록 양끝에 붙인 포스터 높이의 화살표 버튼은 안쪽 모서리만 둥글게 표시합니다. 마우스를 목록에 올리거나 키보드로 선택하면 나타나며 터치 화면에서는 항상 표시합니다. 마우스가 목록을 벗어나거나 더 이동할 페이지가 없으면 버튼을 페이드로 숨깁니다. 저장된 작품이 있으면 상세 페이지를 엽니다. 전체 요일의 정보와 이미지를 미리 불러오고 로딩 중에는 스켈레톤을 표시합니다.

### 작품 표시 바꾸기

`apiVersion:2`, `hooks:["catalog.transform"]`, `permissions:["catalog.modify"]`, `placements:["app"]`를 선언하고 최상위에서 등록합니다.

```js
moa.hooks.register('catalog.transform', ({ items }) => items
  .filter(item => item.genres?.length)
  .map(item => ({ id: item.id, badge: item.genres[0] }))
).catch(error => { document.body.textContent = error.message; });
```

홈·라이브러리·검색·찜·소스·상세의 `{path,items}`를 받습니다. 항목은 `id`, `title`, `type`, `year`, `genres`, `overview`, `badge`만 포함합니다. 등록하면 표시 중인 작품 요청도 갱신합니다.

기존 ID의 `title`, `overview`, `badge`, `genres`만 반환할 수 있습니다. 작품 추가·ID·주소·재생 변경은 허용하지 않습니다. 브라우저 표시만 바꾸며 서버 원본을 수정하지 않습니다. 각 hook은 같은 원본을 받고 ID 순으로 결과를 합쳐 뒤 ID의 수정이 우선합니다.

활성 패키지 버전·권한을 매번 검사하고 권한 확인 포함 hook당 1.2초로 병렬 실행합니다. 오류·초과·취소·잘못된 결과는 원본을 유지하고 다른 플러그인을 막지 않습니다. 응답당 서로 다른 작품 최대 128개이며 더 크면 변환하지 않습니다. 결과는 JSON 64KiB·입력 ID당 수정 1개, 제목 500자·소개 4000자·배지 80자·장르 16개×80자로 제한합니다. 입력 소개는 1000자까지 제공합니다.

### 위치 저장과 자막 가져오기

위치 저장 예제는 `player.context`, `player.control`, `storage`, `notifications`와 `save`·`resume` action을 선언합니다.

```js
moa.on('action', async ({ id }) => {
  const context = await moa.context();
  if (!context) throw new Error('Open a video first');
  if (id === 'save') {
    await moa.storage.set({ episodeId: context.episodeId, time: context.currentTime });
    await moa.notify('Position saved');
  } else if (id === 'resume') {
    const saved = await moa.storage.get();
    if (saved.episodeId !== context.episodeId || !Number.isFinite(saved.time)) return;
    await moa.player.seek(saved.time);
    await moa.player.play();
  }
});
```

자동 자막 가져오기는 `player.context`, `subtitles.import`와 서비스의 정확한 출처를 선언합니다.

```json
"connect": ["https://subtitles.example.org"]
```

```js
moa.on('ready', async context => {
  if (!context) return;
  const url = new URL('/download', 'https://subtitles.example.org');
  url.searchParams.set('title', context.title);
  const response = await moa.fetch(url.href);
  await moa.importSubtitles(new File([await response.arrayBuffer()], 'downloaded.srt'));
});
```

예제 주소를 실제 서비스로 바꾸세요. 플레이어가 열려 있어야 하며 SRT·VTT·VVT·ASS·SSA·SMI·SAMI·ZIP·7z·RAR를 지원합니다. 하나면 자동 선택하고 여러 자막은 목록에 추가합니다. 기존 업로드 경로에서 검증·변환·저장합니다.

`moa.fetch`는 서버 GET이며 MOA 쿠키·인증 헤더를 보내거나 리다이렉트를 따라가지 않습니다. DNS·공개 IP를 고정해 내부·loopback·link-local 주소를 막습니다. 출처 선언으로 이 제한을 우회하지 않습니다. 성공 응답만 반환하고 원격 헤더는 전달하지 않습니다. `text()`, `json()`, `blob()`, `arrayBuffer()`로 읽습니다.

HTML 도구도 `subtitles.import` 권한이 필요합니다.

```html
<input id="subtitle" type="file" accept=".srt,.vtt,.ass,.smi,.zip,.7z,.rar">
<p id="status" role="status"></p>
<script>
  document.querySelector('#subtitle').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await moa.importSubtitles(file);
      document.querySelector('#status').textContent = 'Subtitle saved';
    } catch (error) {
      document.querySelector('#status').textContent = error.message;
    }
  };
</script>
```

## 격리와 한도

JS·HTML은 같은 출처 접근이 금지된 iframe에서 실행합니다. JS 도구는 닫으면 숨기고 인스턴스를 유지하지만 HTML 도구는 파기합니다. 호스트 DOM·쿠키·localStorage·JS 상태를 읽을 수 없고 전용 메시지 채널을 사용합니다. CSP는 직접 fetch·외부 스크립트·폼·중첩 프레임을 막습니다. 브라우저 자원 소모나 자기 프레임 이동까지 막는 경계는 아닙니다.

| 자원 | 한도 |
| --- | --- |
| 설치 플러그인 | 32개 |
| ZIP·폴더 | 4MiB·256항목, ZIP 해제도 4MiB |
| 완성 패키지 JSON | 256KiB |
| script·html | 200KiB |
| action | 8개·label 60자 |
| HTTPS 출처 | 10개 |
| 플러그인·프로필별 저장 | JSON 16KiB·최상위 속성 128개 |
| 알림 | 200자·6초 |
| 인스턴스 SDK 요청 | 동시 4개·30초 |
| SDK 네트워크 응답 | 4MiB·15초 |
| SDK 네트워크 동시 요청 | 프로필/플러그인 4개·서버 전체 16개 |
| 업로드 파일 | 10MiB |
| 개별 해제 자막 | 4MiB |
| 한 번에 가져오는 자막 | 32개 |

네트워크 한도를 넘으면 HTTP 429 `plugin-busy`를 반환합니다. 구버전 서버는 프로필/플러그인 1개·전체 4개로 제한하므로 병렬 요청을 사용할 때는 이 오류에 한해 동시 요청 수를 줄여 제한된 횟수만 재시도해 주세요. 인증·권한 오류는 재시도하지 않습니다. 인스턴스의 다른 SDK 호출에도 여유를 남겨 주세요.

임의 MOA API·인증 정보·파일 경로·서버 JS 실행은 제공하지 않습니다.

## 템플릿

[템플릿](../plugins/template/README.md)을 복사해 ID·버전·권한·라이선스를 정합니다. `manifest.json`과 실행 파일 하나에 의존성을 묶습니다. Node.js 22.15 이상 표준 라이브러리만 사용하며 추가 의존성이 없습니다.

```sh
node plugins/template/build.mjs
node plugins/template/build.mjs examples/subtitle-helper
node plugins/template/build.mjs examples/page-notes
node plugins/template/build.mjs examples/catalog-labels
```

`plugins/template/dist`의 ZIP 또는 폴더를 설치합니다. 관련 없는 문서는 무시하며 암호 ZIP·심볼릭 링크·중복/안전하지 않은 경로는 거부합니다. 별도 플러그인은 ID를 바꾸고 업데이트는 버전을 올려 주세요.

## 시청 기록과 찜 읽기

두 기능은 별도 명시적 권한이며 기존 패키지에 자동 부여하지 않습니다. 현재 소유·잠금 해제된 프로필만 읽고 패키지 버전·권한을 매번 검사합니다. 다른 프로필 선택·기록 변경 API는 제공하지 않습니다.

| 호출 | 권한 | 응답 항목 |
| --- | --- | --- |
| `moa.history.list({limit:50,cursor,since})` | `history.read` | `mediaId`, `episodeId`, 표시 제목, 시즌·회차 번호, `position`, `duration`, `completed`, `updatedAt`, 선택 `tmdb:{kind,id}` |
| `moa.watchlist.list({limit:50,cursor,since})` | `watchlist.read` | `mediaId`, `title`, `type`, `addedAt`, 선택 `tmdb:{kind,id}` |

응답은 `{revision,items,nextCursor}`이며 크기는 1~100개, 기본 50개입니다. `since`는 ISO 시각이며 찜은 추가 시각을 기준으로 걸러냅니다. 찜 순서는 추가 시각 내림차순·작품 ID 내림차순입니다. 재생 위치는 누적 시청 시간이 아닙니다. 계정·영상 주소·소스 정보·쿠키·키는 제공하지 않습니다.

어린이 필터 때문에 빈 페이지에도 다음 cursor가 있을 수 있습니다. 페이지 조회 중 기록이 바뀌면 `history-changed`, 찜·프로필·관련 정책/식별 정보가 바뀌면 409 `watchlist-changed`이며 cursor 없이 다시 시작합니다.

찜은 MOA `0.1.2-beta.3` 이상이며 `/api/plugin-runtime/:id/watchlist`, 관리자용 `/api/plugins/:id/watchlist`에 POST `{revision,query?}`를 사용합니다. 기록 읽기에는 외부 네트워크 권한이 필요하지 않습니다. 함께 사용하는 경우 설치 시 두 권한을 모두 알려야 합니다. 조회한 기록을 외부 요청에 포함하거나 `storage`에 복사하면 권한 취소·원본 삭제로 이미 저장·전송한 복사본을 회수할 수는 없습니다.

```js
// The manifest must explicitly include watchlist.read.
const page = await moa.watchlist.list({ limit: 50 });
for (const title of page.items) {
  // Use title.mediaId only for MOA navigation, and title.tmdb only as a TMDB identity.
}
```

## 인기 작품 조회

`discovery.read`와 `minMoaVersion:"0.1.2-beta.1"` 이상에서 `moa.discovery.trending({kind:'movie'|'tv',window:'day'|'week'})`를 사용합니다. 내부 POST는 `/api/plugin-runtime/:id/discovery/trending`, 본문은 `{revision,query}`이며 플러그인은 SDK를 사용합니다.

응답은 `{provider,status,items,updatedAt,stale}`입니다. 상태는 `ready | unconfigured | restricted | unavailable`, 항목 `DiscoveryItem`은 `{provider,kind,id,title,originalTitle?,year?,poster?,overview?}`입니다. `(provider,kind,id)`가 식별자이며 id는 숫자로 바꾸거나 앞자리 0을 지우지 않는 문자열입니다. MOA 작품 ID가 아니고 서로 다른 공급자의 ID를 합치지 않습니다. 빈 결과에도 공급자를 표시하며 정상 빈 목록과 실패를 구분합니다. `updatedAt`은 서버 조회 ISO UTC 시각이지 순위 집계 시각이 아닙니다.

현재는 TMDB 하나를 `TrendingProvider`로 연결합니다. 샘플 UI도 TMDB 출처만 지원하며 다른 공급자를 TMDB라고 표시하지 않습니다. 추가 공급자는 표시·출처·이미지 권한·캐시 분리를 함께 구현해야 합니다.

- 기존 TMDB 키·요청 제한을 사용합니다. 임의 키·URL·헤더·매개변수·시청 기록은 받거나 반환하지 않습니다.
- 한국어 일/주 영화·TV 첫 페이지 최대 20개 비성인 작품입니다. 전 세계 관심도이며 국내 시청·OTT 순위가 아닙니다.
- 공유 메모리 캐시 4개·30분 유지, 실패 60초 대기이며 실패 시 24시간 미만의 이전 결과에 stale을 표시할 수 있습니다. 키 변경·삭제 시 초기화하며 정기 조회는 없습니다.
- 등급 정보가 부족해 어린이 프로필은 서버에서 전체 결과를 제한합니다. 요청 시 계정·프로필 접근과 플러그인 활성화·호환성·버전·권한을 검사하며, 조회 후에는 플러그인 권한과 프로필 정책을 다시 확인합니다. 응답은 비공개입니다.
- 조회 자체는 connect가 필요 없지만 포스터는 `https://image.tmdb.org` 권한으로 바이트를 받아 object URL로 표시합니다. CSP를 완화하지 않습니다. 텍스트는 텍스트로 표시하고 TMDB 출처와 내부 검색을 제공하세요.

## 작품 크레딧과 인물 참여작

MOA `0.1.2-beta.1` 이상을 요구하며 패키지에 `metadata.read` 권한을 명시해야 합니다.

```js
const credits = await moa.metadata.credits();
// Read works only for people credited on the current title.
const works = await moa.metadata.person({provider: person.provider, id: person.id});
```

호스트 SDK는 현재 `/title/:id`에서 MOA 작품 ID를 가져옵니다. 플러그인이 제목을
검색해서 작품을 재매칭하지 않습니다. 서버는 기존 `auto`/`manual` 연결만 읽고,
연결을 만들거나 변경하지 않습니다. 자동 연결의 정확도를 추가 보증하는 API는
아니며, 연결이 잘못됐다면 MOA 메타데이터 설정에서 바로잡아야 합니다.

- 크레딧 응답: `{provider,status,title,cast,crew,truncated}`.
- 참여작 응답: `{provider,status,title,person,items,truncated}`.
- `status`: `ready`, `unlinked`(사용 가능한 기존 연결 없음),
  `unconfigured`(공급자 키 없음), `restricted`(키즈/없는 프로필),
  `unavailable`(조회 실패·조회 중 연결 변경·동시 요청 한도 등).
- 준비되지 않은 응답은 `title/person:null`, 빈 목록이며 이전 데이터를 표시하지 않습니다.
- `title`: `{mediaId,provider,kind,id,name,scope}`. `mediaId`는 MOA ID,
  `id`는 공급자 ID입니다. `scope`는 영화 `movie` 또는 TV 시리즈 전체 `series`입니다.
- `PersonCredit`: `{provider,id,name,photo?,roles:string[]}`. 출연진과 제작진을
  별도 목록으로 반환합니다. 같은 인물의 여러 배역·직책을 보존합니다.
- `items`는 인기 API와 같은 `DiscoveryItem[]`입니다. 작품·인물의 외부 ID는
  불투명 문자열입니다. 공급자가 다른 ID를 합치거나 숫자로 변환하지 않습니다.
- 출연진/제작진 각각 최대 60명, 각 목록에서 인물당 8개 역할, 참여작 최대 40개.
  제한 때문에 누락된 데이터가 있으면 `truncated:true`입니다. 목록 순서는 공급자
  순서이며, 인기 순위나 전체 필모그래피라고 표현하지 않습니다.
- 배역의 `(voice)` 등 원문 표기를 유지하지만 더빙 언어·판본을 추측하지 않습니다.
  TV aggregate credits는 시즌/회차 전용 크레딧이 아닙니다.
- 키즈 프로필은 참여작 전체의 등급을 판정할 수 없어 외부 호출 없이 제한합니다.
  일반 회원은 자신이 접근 가능한 프로필로 사용할 수 있습니다.

SDK가 호출하는 HTTP 경로는 `POST /api/plugin-runtime/:pluginId/metadata/credits`
및 `/metadata/person`입니다. 본문은 `{revision,mediaId}` 및
`{revision,mediaId,person:{provider,id}}`입니다. 관리자 경로 `/api/plugins/:pluginId/…`도
같은 계약을 사용합니다. JSON의 ID 타입을 강제로 변환하지 않습니다. HTTP 경로는
현재 페이지를 입증하는 토큰이 아니므로, 권한은 현재 프로필이 볼 수 있는
연결된 작품 메타데이터를 읽는 것으로 해석해야 합니다. 임의 외부 ID 조회는
제공하지 않으며 참여작 요청의 인물은 해당 작품 크레딧에 있어야 합니다.

각 요청에 계정/프로필·활성화·패키지 revision·권한을 검사하고, 외부 응답 후에도
권한·프로필 정책·작품 연결·공급자 설정을 다시 확인합니다. SDK는 상세 화면 이동
또는 프로필 전환 뒤 도착한 결과도 전달하지 않습니다. 응답은 `private, no-store`.

내부 `PeopleProvider`는 연결 읽기·크레딧·참여작만 제공하는 작은 계약입니다.
현재 구현은 TMDB 하나이고, 키나 임의 URL/헤더는 플러그인에 노출하지 않습니다.
공개 공급자 응답만 6시간, 최대 128개 메모리 캐시에 보관합니다. 동일 요청은
합치고 동시 공급자 요청은 최대 4개, 실패는 60초 뒤 재시도합니다. 만료된 자료는
실패 시 재사용하지 않습니다. 계정 기록·시청기록·관심목록은 읽지 않습니다.
공급자/설정 변경 시 캐시를 무효화합니다. 새로운 상주 프로세스나 DB 테이블은 없습니다.

공급자 자료: [영화 크레딧](https://developer.themoviedb.org/reference/movie-credits),
[TV 시리즈 전체 크레딧](https://developer.themoviedb.org/reference/tv-series-aggregate-credits),
[인물의 영화·TV 참여작](https://developer.themoviedb.org/reference/person-combined-credits).

### 기존 출연진 UI 확장: `title.people`

인물 플러그인은 별도 출연진 iframe 패널을 중복해서 그리지 않습니다. 기존
`PeopleRow`와 MOA 컴포넌트로 렌더링되는 상세 시트에 데이터를 제공합니다.
패키지는 `hooks:["title.people"]`, `permissions:["metadata.read"]`,
`placements:["app"]`, API 2 이상을 선언하고 아래처럼 등록합니다.

```js
moa.hooks.register('title.people', request => request.action === 'credits'
  ? moa.metadata.credits()
  : moa.metadata.person(request.person));
```

요청은 `{action:'credits',mediaId}` 또는
`{action:'person',mediaId,person:{provider,id}}`입니다. 반환 계약은 위 API와 같습니다.
플러그인에는 화면에 임의 HTML을 삽입하는 권한을 주지 않습니다. MOA가 문자열,
ID, 현재 작품, 지원 공급자, 목록 수와 이미지 URL을 검증해 기존 UI로 렌더링합니다.
현재 렌더러는 TMDB 출처·이미지 규칙만 지원합니다. 타 공급자는 조용히 TMDB로
표시하지 않고 명시적으로 거부하며, 추후 해당 공급자의 표시 규칙도 추가해야 합니다.

인물 패키지는 자체 UI·네트워크·이미지 다운로드가 없어 `ui`, `app.navigate`,
`connect` 권한이 필요 없습니다. 검색은 사용자가 네이티브 참여작 링크를 선택할 때만
일어납니다. 사진/포스터는 기존 MOA 이미지 표시 경로를 사용하며 iframe CSP는
완화하지 않습니다. API 키와 원본 공급자 응답은 여전히 서버 경계 안에 있습니다.

등록된 공급 기능이 없으면 기존 출연진 행을 유지합니다. 네이티브 `Person`에
선택적 `identity:{provider,id}`가 있으면 인물 탐색으로 연결할 수 있습니다.
예전 캐시에 ID가 없으면 이름으로 추측하지 않고 전체 크레딧 진입을 사용합니다.
외부 ID는 메타데이터가 정상 갱신될 때 함께 저장되며, 기존 캐시를 일괄 무효화하거나 별도 사이트 요청을 실행하지 않습니다.

활성 프로필에서 여러 패키지가 등록되면 플러그인 ID 순 첫 번째를 사용합니다.
등록 해제·프로필 변경·취소·20초 제한에 걸린 응답은 버립니다. 결과는 최대
262,144자이며, 캐시나 영구 저장을 하지 않습니다. 요청 전후에 활성화·revision·
권한을 확인하고 현재 상세 작품과 다른 응답을 거부합니다.

### 개봉·방영 일정 (0.1.2-beta.3+)

새 명시적 권한 `schedule.read`를 승인하면
`moa.discovery.schedule({kind:'movie'|'tv',date:'YYYY-MM-DD'})`를 사용할 수 있습니다.
공급자에 종속되지 않는 계약이며 현재 구현은 영화 TMDB, 드라마 TVmaze입니다.
날짜는 한국 시간의 오늘부터 6일 후까지만 허용합니다.
응답은 `{provider,date,status,items,truncated}`이며 `status`는
`ready | restricted | unconfigured | unavailable`입니다. 항목은
`{id,title,date,time,detail}`이며 `time`은 한국 시간 HH:mm 또는 null입니다.
`id`는 공급자 범위의 일정 식별자로, MOA 작품 ID나 재생 가능한 영상 ID가 아닙니다.

읽기 전용이며 현재 프로필의 키즈 제한, 플러그인 활성화·권한·revision을
요청 전후 검사합니다. POST 경로는
`/api/plugin-runtime/:id/discovery/schedule`, 본문은 `{revision,query}`입니다.
외부 인증 정보는 전달하지 않습니다. 상세 수록 범위와 라이선스는
[일정 플러그인 안내](../plugins/release-calendar/README.md)를 참조하세요.

### 찜한 작품 소식과 국내 박스오피스 (0.1.2-beta.3+)

두 API는 `minMoaVersion: 0.1.2-beta.3` 이상의 호스트가 필요합니다.

- `moa.watchlist.news()` — **`watchlist.read`와 `schedule.read` 모두** 승인되어야 합니다. 현재 프로필의 최신 찜 100개 중 TMDB 연결이 확정된 서로 다른 작품 최대 12개를 확인합니다. 오늘부터 30일 후까지 한국 영화 극장 개봉(재개봉 포함), TV/애니의 다음 회차 원방영일을 반환합니다. 한국 OTT 공개일이나 소스 업로드를 보장하지 않습니다. 자동 제목 매칭·알림·새 시즌 발견 엔진은 포함하지 않습니다.
- `moa.discovery.boxOffice({period:'day'|'week'})` — 별도 **`boxoffice.read`** 권한이 필요합니다. KOBIS의 국내 극장 전체(한국·외국 영화) 관객수 순위이며 OTT 순위가 아닙니다. 한국 시간 기준 어제 또는 지난 완료 월~일 주간을 조회합니다. 집계가 아직 없거나 실패하면 가짜 순위나 과거 기간으로 대체하지 않습니다.

실제 POST 경로는 `/api/plugin-runtime/:id/watchlist/news`와
`/api/plugin-runtime/:id/discovery/boxoffice`입니다. 본문은 `{revision,query}`이며 뉴스의 query는 빈 객체입니다. 클라이언트가 프로필 ID나 공급자 URL/인증키를 지정할 수 없습니다. 활성화·권한·패키지 revision·프로필 정책을 확인하며 응답은 `private, no-store`입니다. 키즈 프로필에는 결과를 제공하지 않습니다.

공통 상태는 `ready | restricted | unconfigured | unavailable`입니다.
뉴스 응답은 `{provider,from,through,status,items,unlinked,checked,truncated}`,
항목은 `{mediaId,title,date,kind:'release'|'episode',detail}`입니다.
박스오피스 응답은 `{provider,period,from,through,status,items}`,
항목은 `{id,title,rank,audience,totalAudience,change,isNew}`입니다.
박스오피스 id는 KOBIS 식별자이며 MOA 작품 ID가 아닙니다. 날짜는 ISO 일자, 관객수는 음수가 아닌 정수, 순위 변화는 상승 양수/하락 음수 또는 미상 null입니다. 응답에 키를 포함하지 않습니다.

서버 캐시는 30분, 실패 재시도 간격은 60초이며 백그라운드 정기 조회는 없습니다. 뉴스는 20초 응답 한도를 두며 느린 공급자 조회가 진행 중인 동안 동시 조회 제한을 유지합니다. 뉴스는 공개 작품별 일정만 캐시하고 찜 목록을 매번 다시 확인합니다. 요청 도중 목록 삭제·연결 변경·키즈 제한 전환은 반환 전에 반영됩니다. 데이터 공급자는 현재 TMDB/KOBIS지만 SDK 이름은 공급자에 종속되지 않습니다.

#### KOBIS 키 설정

[KOBIS 키 발급/관리](https://www.kobis.or.kr/kobisopenapi/homepg/apikey/ckUser/findApikeyList.do)에서 발급받은 키를 **서버**의 `MOA_KOBIS_API_KEY` 환경변수에 설정하고 앱 프로세스를 재시작합니다. 일반 Compose 설치는 로컬 `.env`의 같은 변수를 compose.yaml에서 앱 컨테이너로 전달합니다. 키를 플러그인 ZIP·브라우저 저장소·공개 저장소에 넣지 마세요.

릴리스 설치는 생성된 Compose 설정을 보존하므로 `.env`만 고쳐서는 실행 중 컨테이너의 환경변수가 바뀌지 않을 수 있습니다. 관리 중인 실제 배포 설정에 변수를 전달한 뒤 컨테이너를 갱신해야 합니다. 키가 없으면 뉴스 기능은 기존 TMDB 설정으로 동작하고 박스오피스만 미설정으로 표시됩니다.

공식 계약: [KOBIS 일별](https://www.kobis.or.kr/kobisopenapi/homepg/apiservice/searchServiceDesc.do?apiSvcId=searchDailyBoxOffice) · [주간](https://www.kobis.or.kr/kobisopenapi/homepg/apiservice/searchServiceDesc.do?apiSvcId=searchWeeklyBoxOffice) · [TMDB TV 상세](https://developer.themoviedb.org/reference/tv-series-details).
### 작품 리뷰 (`title.reviews`, 0.1.2-beta.3+)

0.1.2-beta.3 이상의 호스트에서 지원합니다. `reviews.read` 권한과 `title.reviews` hook을 선언한 API 2 플러그인은 `moa.reviews.list(provider, selection?)`를 호출합니다. 현재 provider는 `tmdb`, `anilist`이며 API 이름은 특정 공급자에 묶이지 않습니다. 호스트가 현재 상세 페이지에서 작품을 결정하며 임의 쿼리/URL/키는 받지 않습니다.

Hook 입력은 `{mediaId, provider, selection?}`, 응답은 shared의 `ReviewResponse`입니다. `selection`은 AniList 후보 ID 문자열이며 서버가 해당 작품에 대해 반환한 후보에 있어야 합니다. 선택하지 않았거나 후보에 없는 ID면 `select` 상태와 후보 목록이 반환됩니다. 임의 첫 항목을 자동 선택하지 않습니다.

호스트가 네이티브 리뷰 UI와 외부 링크를 렌더링하고 응답을 검증합니다. 기존 플러그인은 새 기능을 선언하지 않으면 영향이 없습니다. 상태는 ready/select/unconfigured/unlinked/restricted/unavailable이며, `ready`와 빈 목록은 리뷰 없음, `select`와 빈 후보는 작품 검색 결과 없음을 뜻합니다. 평점 통합/국적 판별/원문 전체 저장은 제공하지 않습니다. 설정·한도·번역의 한계는 [리뷰 플러그인 안내](../plugins/title-reviews/README.md)를 참고해 주세요.

AniList 요청 한도는 리뷰와 추천 보강이 공유합니다. 서버 전체 20회/분·동시 4개이며, 429 또는 잔여 한도 0 응답의 대기 시간도 두 기능에 함께 적용합니다. 두 기능의 결과 캐시와 사용자 권한은 별도로 유지합니다.

## 제공 예제

예제는 직접 설치해야 하며 ZIP을 복사해도 호스트에 없는 API가 추가되지는 않습니다. 각 manifest의 최소 버전과 권한을 확인하세요.

| 패키지 | 기능 | 안내 |
| --- | --- | --- |
| `anime-schedule` | 요일별 애니·포스터 미리 불러오기·화살표 페이지 이동·기존 작품 상세 이동 | [설명](../plugins/anime-schedule/README.md) |
| `trending-titles` | TMDB 일·주간 영화·TV 탐색 | [설명](../plugins/trending-titles/README.md) |
| `title-people` | 기존 상세 UI의 출연진·인물 참여작 | [설명](../plugins/title-people/README.md) |
| `release-calendar` | 개봉·방영 일정 | [설명](../plugins/release-calendar/README.md) |
| `watchlist-news` | 찜한 작품의 예정 일정 | [설명](../plugins/watchlist-news/README.md) |
| `korean-boxoffice` | KOBIS 국내 극장 관객 순위 | [설명](../plugins/korean-boxoffice/README.md) |
| `title-reviews` | 메타데이터 제공자의 작품 리뷰 | [설명](../plugins/title-reviews/README.md) |

호스트가 이미 제공하는 조작은 hook으로 연결하세요. 공급자 키는 서버에 두고 출처와 사용 불가 상태를 정확히 표시합니다. 외부 정보만으로 소스 재생 가능·지역 권리·한국어 더빙·회차별 크레딧을 보장하지 않습니다. iframe은 호스트 작품 필터를 자동 상속하지 않으므로 문서의 프로필별 API와 제한을 사용해야 합니다.

## 기능을 추가하거나 바꿀 때

공개 API를 변경하면 같은 작업에서 아래 항목을 맞춰 주세요. 예전 플러그인은 기존 권한으로 계속 동작해야 합니다.

- 공유 타입, 서버의 manifest·요청 검사, 브라우저 SDK·권한 표시를 함께 확인합니다.
- 이 문서의 SDK 표·입력·응답·제한과 [템플릿 안내](../plugins/template/README.md)의 해당 예제를 갱신합니다. 기존 예제가 있으면 재사용합니다.
- 필요한 권한과 `minMoaVersion`을 예제 manifest에 반영하고 패키징·권한 거부·실패 상태를 검증합니다.
- 공개 화면이 바뀌면 디자인 명세·미리보기도 갱신합니다. 임시 검증 자료만 정리하고 단위·회귀 테스트는 유지합니다.

실제 구현은 [SDK·화면 연결](../apps/web/src/features/plugins/WebsitePlugins.tsx), [설치·런타임 검사](../apps/server/src/plugins/service.ts), [기능별 서버 모듈](../apps/server/src/plugins/)을 기준으로 확인해 주세요. 플러그인 코드는 HTTP 경로를 직접 호출하지 않고 `moa` SDK를 사용합니다.
