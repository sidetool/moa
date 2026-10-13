# Website plugins

Website plugins add JavaScript behavior and optional tools to MOA. They can build their own tools, respond to page changes, navigate within MOA, react to playback, control the player, retrieve and import subtitles, store profile-specific data, and show notifications. API 2 also lets plugins transform catalog display data and add inline title panels. They are separate from video-source extensions and do not register media catalogs or playback sources.

## Installation and management

Open **Plugins** from the profile menu, My page, or the Settings link. Administrators select one ZIP package or an entire plugin folder. The package contains `manifest.json` and either `plugin.js` or `index.html` in the same directory. A wrapper directory, such as GitHub's downloaded ZIP, is supported; the shallowest manifest is selected, so nested examples do not override the main plugin. Bundled `.moa-plugin.json` files remain supported. Review the permissions and allowed network origins, then install it. Administrators can update packages or select multiple packages to enable, disable, or delete them together. A failed operation leaves only failed items selected for retry. Only administrators can access the installed inventory at `/plugins`; other profiles can use compatible, enabled tools and inline features. Runtime descriptors expose only the fields needed to render those features, without package versions, configuration, or disabled plugins.

ZIPs, loose manifest and entry files, and folders can also be dropped onto the installation area. A public HTTPS link to a ZIP or bundled `.moa-plugin.json` can be loaded there. MOA remembers that link for **Check for updates**; package IDs must match and each update is previewed before installation. A package may declare the same link in optional `updateUrl`. Redirects must remain public HTTPS, and the normal package size and sandbox limits still apply.

The inventory shows each plugin's granted permissions and stored byte count. **View data** lets administrators inspect its JSON values by profile, external connection origins, and update link. Runtime clients only receive their own profile's storage through the SDK.

Packages and plugin data are stored on the server. Updating an ID replaces its code while preserving its enabled setting and saved data. JavaScript instances restart when the package revision or profile changes. Disabling or deleting blocks subsequent SDK calls immediately; background instances disappear when the list refreshes, within 30 seconds. Deleting a plugin also deletes its profile data, but keeps subtitles it imported. HTML tools must be closed and reopened after updating.

JavaScript packages run automatically. Only install code from authors you trust: plugins can consume browser resources and use their declared permissions without opening a dialog.

## Package format

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

Use exactly one of `script` or `html`. All other fields except `actions`, `hooks`, and `minMoaVersion` are required. Unknown fields are rejected. API 1 remains supported; API 2 adds catalog hooks and the detail placement. A package declaring a higher API version can be installed but does not execute until MOA supports it. The management page shows its minimum API and MOA versions and an update action. IDs contain 2–64 lowercase letters, digits, or hyphens and start with a letter. Versions use `major.minor.patch` with an optional prerelease suffix.

| Field | Behavior |
| --- | --- |
| `script` | Plain JavaScript executed once when its scope mounts. Bundle any dependencies into this string. |
| `html` | HTML, inline styles, and inline scripts shown in a dialog when the user opens the tool. |
| `placements: ["player"]` | JavaScript runs while a video is open. Actions and tools appear under Playback settings → Plugins. |
| `placements: ["app"]` | JavaScript runs across regular application pages outside the player. Actions and tools appear on the Plugins page. |
| `placements: ["settings"]` | Compatibility alias for `app`. Existing packages continue to work. |
| `placements: ["home"]` | Displays the plugin inline on Home (`/` and `/tabs/home`), for both JavaScript and HTML packages. It is removed when leaving Home. |
| `placements: ["detail"]` | API 2: displays an inline panel on a title page, below the title header and above its episode list. |
| `minMoaVersion` | Optional minimum MOA release, such as `1.2.0` or `1.2.0-rc.1`. MOA compares semantic versions, including prereleases. Development builds without a release version cannot satisfy this requirement. |
| `hooks: ["catalog.transform"]` | API 2 JavaScript packages with `catalog.modify` can transform displayed catalog fields. |
| `placements: ["player", "app"]` | Both scopes. A new instance starts when moving between them. |
| `actions` | Optional JavaScript-only buttons, each with a unique `id` and readable `label`. IDs start with a lowercase letter and contain up to 40 lowercase letters, digits, or hyphens. |
| `connect` | Exact HTTPS origins the plugin may request through `moa.fetch`. |

A script instance survives page changes within its scope and opening and closing its tool dialog or playback settings. It is destroyed when leaving its scope, changing profile or episode, updating the package, or observing disable/deletion. Timers and event listeners inside the iframe disappear with it. Persist durable data through `moa.storage`.

Combining `home` or `detail` with `app` or `settings` uses one inline instance on that page and a new application instance elsewhere. Home plugins do not appear on category tabs or the local library. Detail panels restart when the title changes. Inline frames have transparent backgrounds and expose `--moa-text`, `--moa-muted`, `--moa-accent`, and `--moa-surface` CSS variables.

## Events and SDK

MOA supplies `window.moa` before plugin code runs. SDK methods return promises and reject on invalid input, missing permission, revoked access, or a failed request. Handle errors in normal method calls. Rejected event handlers are reported as a plugin notification.

| Method | Permission | Result |
| --- | --- | --- |
| `moa.app.context()` | `app.context` | Current `{ pathname, search, hash }` inside MOA |
| `moa.app.navigate(path)` | `app.navigate` | Opens a root-relative MOA page such as `/search?q=example`, `/title/id`, or `/watch/episodeId`; external addresses are rejected |
| `moa.ui.open()` | `ui` | Shows the plugin dialog or its inline panel; build its contents using normal JavaScript DOM APIs |
| `moa.ui.close()` | `ui` | Hides the inline panel or closes the dialog; a JavaScript instance and its DOM stay alive in its scope |
| `moa.ui.resize(height)` | `ui` | Sets an inline panel's height in CSS pixels, rounded up and clamped to 120–1200; rejects non-finite values and calls outside inline panels |
| `moa.context()` | `player.context` | `{ episodeId, title, currentTime }`, or `null` outside the player |
| `moa.player.play()` | `player.control` | Starts playback; browser autoplay restrictions may still reject it |
| `moa.player.pause()` | `player.control` | Pauses playback |
| `moa.player.seek(seconds)` | `player.control` | Seeks within the video's duration; unavailable for live playback |
| `moa.importSubtitles(file)` | `subtitles.import` | `true` after importing and storing subtitles on the server |
| `moa.storage.get()` | `storage` | This plugin's saved JSON object for the active profile, initially `{}` |
| `moa.storage.set(object)` | `storage` | Replaces and returns that object's saved value; concurrent writes use the last completed write |
| `moa.notify(text)` | `notifications` | Displays a plain-text notification labeled with the plugin name |
| `moa.fetch(url)` | Exact HTTPS origin in `connect` | A browser `Response` containing downloaded bytes |
| `moa.hooks.register("catalog.transform", handler)` | `catalog.modify` and a declared hook | Registers an asynchronous catalog display transformation; rejects undeclared or revoked access |
| `moa.on(event, handler)` | Depends on event | Registers a handler and returns an unsubscribe function |

Register event handlers synchronously at the top level of `plugin.js` so they receive the first `ready` event.

| Event | Payload | Delivery |
| --- | --- | --- |
| `ready` | Playback context when granted and available; otherwise `null` | Once after the host connects |
| `routechange` | `{ pathname, search, hash }` | Initially and after a route changes, with `app.context` permission |
| `timeupdate` | Playback context | About once per second in the player with `player.context` permission |
| `action` | `{ id }` | When the user clicks a declared action |

The context contains the episode ID, display title, and position in seconds. It does not expose source credentials, video URLs, account details, or API keys. Permissions are enforced by the host, even when a plugin calls a method directly.

### Build a website tool

Use `placements: ["app"]` with `ui`, `app.context`, `app.navigate`, and `storage` to make a page notebook, reading tracker, custom search form, or another tool independent of subtitles and playback. The plugin's **Open** button displays its own DOM. Application scripts with `ui` also appear in the profile menu, so their tools are reachable from other pages. It can also open its interface from an action through `moa.ui.open()`.

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

The `examples/page-notes` template stores notes for each visited page and includes a MOA search form. It uses the same sandbox and permissions as every other plugin. A script can combine these operations with its own timers, calculations, downloaded data, and custom UI. The host DOM and unrestricted server APIs remain outside the plugin boundary.

### Display a Home panel

Declare `placements: ["home"]` to display content above the regular Home rows. Each plugin gets an isolated iframe with a default height of 320 pixels. The plugin supplies its own heading and responsive layout; include the `ui` permission to adjust the frame height. Use internal scrolling for content taller than 1200 pixels.

```js
document.body.innerHTML = '<h2>Weekly picks</h2><p>Choose a title to search MOA.</p>';
moa.on('ready', () => moa.ui.resize(160));
```

The [anime schedule plugin](../plugins/anime-schedule/README.md) provides Monday–Sunday tabs with Anissia's Korean-time schedule and opens MOA search for the selected title. It uses `moa.fetch`, `moa.app.navigate`, and `moa.ui.resize` without access to the host DOM.

### Transform displayed catalog data

Declare `apiVersion: 2`, `hooks: ["catalog.transform"]`, `permissions: ["catalog.modify"]`, and `placements: ["app"]`. Register the callback at the top level of your script:

```js
moa.hooks.register('catalog.transform', ({ items }) => items
  .filter(item => item.genres?.length)
  .map(item => ({ id: item.id, badge: item.genres[0] }))
).catch(error => { document.body.textContent = error.message; });
```

The callback receives `{ path, items }` when MOA loads Home, library, search, watchlist, source lists, or title details. `items` contains only `id`, `title`, `type`, `year`, `genres`, `overview`, and `badge`; it never includes source credentials, media URLs, or playback targets. Registering a hook refreshes visible catalog queries so it also applies to the initial page.

Return patches for existing IDs, with any of `title`, `overview`, `badge`, or `genres`. A hook cannot add titles, change IDs, rewrite URLs, or change playback behavior. Changes affect presentation in that browser session and do not rewrite the server catalog. Every hook receives the original input. Valid patches merge in plugin ID order, so later IDs win when they change the same field.

MOA verifies the enabled package revision and permission on each dispatch. Calls run concurrently with a 1.2-second deadline per hook, including authorization. Exceptions, timeouts, revoked packages, and invalid outputs leave the original data available and do not block other plugins. At most 128 distinct titles are dispatched per response; larger responses are left unchanged. Each result is limited to 64 KiB of JSON and one patch per input ID. Titles allow 500 characters, overviews 4000, badges 80, and genres 16 entries of 80 characters each. Input overviews are capped at 1000 characters.

The `examples/catalog-labels` plugin uses this hook to show the first genre as each title's badge and renders a small inline detail panel. It requests no network or playback access.

### Save and restore a position

Declare `player.context`, `player.control`, `storage`, and `notifications` and actions named `save` and `resume`:

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

### Retrieve subtitles automatically

Declare `player.context` and `subtitles.import`, and add your service's exact origin to `connect`:

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

Replace the example URL with a real service. Import requires an open player. Supported files are SRT, VTT, VVT, ASS, SSA, SMI, SAMI, ZIP, 7z, and RAR. A single imported subtitle is selected automatically; archives with multiple subtitles add choices to the list. MOA validates, converts, and saves files through its regular subtitle upload path.

`moa.fetch` makes a GET through the MOA server. It sends no MOA cookies or authorization headers and does not follow redirects. Private, loopback, and link-local addresses are blocked by the existing DNS-pinned HTTP client. Declaring an origin does not bypass that policy. Only successful HTTP responses are returned; remote headers are not forwarded. Use `Response.text()`, `json()`, `blob()`, or `arrayBuffer()` to read the result.

### Import through an HTML tool

An HTML package needs the `subtitles.import` permission:

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

## Isolation and limits

Both script and HTML packages execute in sandboxed browser iframes with same-origin access disabled. Outside inline panels, scripts use a hidden iframe until a tool dialog opens, so an interface is optional. Closing a script dialog hides its iframe without rerunning the script; closing an HTML tool destroys that instance. They cannot access MOA's DOM, cookies, local storage, or JavaScript state. Each instance uses a dedicated message channel. A restrictive Content Security Policy blocks direct fetches, external scripts, forms, and nested frames. Use the SDK for supported operations. This boundary does not prevent malicious code from exhausting browser resources or navigating its own frame.

| Resource | Limit |
| --- | --- |
| Installed plugins | 32 |
| ZIP or folder | 4 MiB, 256 entries; ZIP expansion is also limited to 4 MiB |
| Assembled package JSON | 256 KiB |
| Script or HTML content | 200 KiB |
| Actions | 8, labels up to 60 characters |
| Allowed HTTPS origins | 10 |
| Profile storage per plugin | 16 KiB JSON object, up to 128 top-level properties |
| Notification | 200 characters, shown for 6 seconds |
| SDK requests per instance | Four at once, 30-second timeout |
| SDK network response | 4 MiB, 15-second timeout |
| Concurrent SDK network requests | One per profile/plugin, four server-wide |
| Uploaded file | 10 MiB |
| Individual decoded subtitle | 4 MiB |
| Imported subtitles per operation | 32 |

The SDK does not expose arbitrary MOA API calls, authentication material, filesystem paths, or server-side JavaScript execution.

## Template

The [plugin template](../plugins/template/README.md) contains `manifest.json`, `plugin.js`, a standard-library build script, and JavaScript and HTML examples. Copy `plugins/template` from the MOA repository to start a new plugin.

```sh
node plugins/template/build.mjs
node plugins/template/build.mjs examples/subtitle-helper
node plugins/template/build.mjs examples/page-notes
node plugins/template/build.mjs examples/catalog-labels
```

Install the generated ZIP from `plugins/template/dist`, or select the entire template folder without building. The build script uses Node.js 22.15 or later and needs no dependencies. Include one `manifest.json` and one `plugin.js` or `index.html` at the package root; bundle dependencies into that JavaScript or HTML file. Unrelated documentation files are ignored. Encrypted ZIPs, symbolic links, duplicate paths, and unsafe paths are rejected. Change the plugin ID before publishing a separate plugin, increase its version for updates, document requested permissions, and include a license.

## Read-only viewing history

Declare `history.read` to use `await moa.history.list({ limit: 50, cursor, since })`.
Installation/update previews show the new permission for approval. It is never granted to packages without the declaration.
The server checks the installed revision and current unlocked profile on every call. The SDK cannot select a different profile.
The response is `{ revision, items, nextCursor }`; limit is 1–100 and `since` is an ISO timestamp.
Each item includes MOA `mediaId`, `episodeId`, display titles, season/episode numbers, last `position`, `duration`, `completed`, `updatedAt`, and an optional confirmed `tmdb: {kind,id}`.
Positions are resume positions, **not accumulated viewing time**. No account details, stream URLs, cookies or credentials are returned.
Kids filtering applies. An empty page may have a nextCursor when filtered records were skipped.
If history changes during pagination, the server returns `history-changed`; restart pagination without the cursor.
No history mutation API is exposed. A plugin with both history and external-network permissions can send records to its declared origins: only grant these permissions to trusted plugins. Revoking access cannot erase copies the plugin already stored.

## Read-only watchlist (unreleased)

Declare `watchlist.read` to call `await moa.watchlist.list({ limit: 50, cursor, since })`.
This additive permission is independent of `history.read`; existing packages receive no additional access.
The response is `{ revision, items, nextCursor }`. Each item contains only `mediaId`, `title`,
`type`, `addedAt` and an optional confirmed `tmdb: { kind, id }`. No stream URLs, source metadata,
credentials or other profiles are included. `since` filters the time the title was added.
The server validates the installed package revision, permission, current profile ownership and PIN lock.
Default page size is 50, maximum 100; ordering is added time descending, then media ID descending.
Kids filtering can leave an empty page with a non-null `nextCursor`; continue using that cursor.
A changed list, different profile or relevant policy/identity revision returns `watchlist-changed` (409);
restart pagination without a cursor. The API provides no watchlist mutation.
Both host routes `/api/plugin-runtime/:id/watchlist` and `/api/plugins/:id/watchlist`
accept POST `{ revision, query? }`. The latter also requires admin access.
A plugin granted external network access can send the returned records to its declared origins, just as
with `history.read`. Installation must disclose both permissions. Removing a title from MOA cannot
revoke data a plugin already saved or sent. This SDK is not available in the published beta yet;
set `minMoaVersion` to the release that actually includes it when distributing a plugin.

```js
// The manifest must explicitly include watchlist.read.
const page = await moa.watchlist.list({ limit: 50 });
for (const title of page.items) {
  // Use title.mediaId only for MOA navigation, and title.tmdb only as a TMDB identity.
}
```

## Trending discovery (unreleased)

The `discovery.read` permission enables
`moa.discovery.trending({ kind: 'movie' | 'tv', window: 'day' | 'week' })`.
This additive SDK is integrated into `feat/next-media-features`; it is not present in v0.1.1.
Packages using it currently declare `minMoaVersion: "0.1.2-beta.1"` as the proposed
integration target. Confirm the actual release before distributing the ZIP.

The result is `{ provider, status, items, updatedAt, stale }`. `status` is `ready`,
`unconfigured` (administrator must configure TMDB), `restricted` (child/missing
profile), or `unavailable` (no usable provider result). Items use `DiscoveryItem`: `{ provider, kind, id, title, originalTitle?, year?,
poster?, overview? }`. Identity is the tuple `(provider, kind, id)`. `id` is an
opaque string: never parse it as a number, drop leading zeroes, or treat it as a
MOA media ID. Do not merge identities across providers. The response-level
`provider` identifies the selected feed even when items are empty. These are
external metadata, not playable source entries.

`moa.discovery.trending` and `discovery.read` are provider-neutral names. The host
currently selects a single TMDB adapter behind a small `TrendingProvider` contract;
no provider-selection setting or multi-provider registry is introduced. Additional
adapters must preserve policy, attribution and cache-isolation requirements.
The bundled plugin currently supports TMDB presentation/attribution only and
explicitly refuses other feeds, instead of labelling their results as TMDB.
Adding a provider also requires its correct UI attribution and image permission.
A ready empty list is distinct from an unavailable result. `updatedAt` is the host's
fetch timestamp in ISO UTC, not TMDB's ranking timestamp.

- Uses the host's existing TMDB credentials and request limiter. No keys, URLs,
  headers, arbitrary parameters or history are accepted or returned by this SDK.
- Fixed Korean-language first page (up to 20 non-adult titles), daily/weekly movie/TV
  endpoints only. This is global TMDB interest, not Korean viewing or OTT ranking.
- Four shared in-memory cache entries; fresh for 30 minutes. Failed refreshes retry
  after 60 seconds and may serve a marked stale snapshot younger than 24 hours.
  Credentials changed/cleared in settings invalidate this cache. No polling task.
- The host withholds the entire feed for kids profiles because trending data alone
  does not provide enough age-certification data. Client hiding is not the guard.
- `connect` is unnecessary for discovery itself. The iframe only displays data/blob
  images, so the sample plugin declares `https://image.tmdb.org` in `connect` and
  fetches poster bytes through `moa.fetch`, then renders object URLs. It preserves
  the existing CSP and server request checks.
- Plugin enablement, compatibility, package revision and declared permission are
  enforced before and after asynchronous retrieval. Account/profile/PIN checks use
  the existing API gate. The HTTP response is private and not cacheable by proxies.
- Render returned text as text, handle all states, include TMDB attribution, and
  use title search rather than implying that every external title can be played.

The POST transport is `/api/plugin-runtime/:id/discovery/trending` with
`{ revision, query }`; plugins use the SDK, not direct internal requests.

## 작품 크레딧과 인물 참여작 (구현 브랜치, 미출시)

`feat/people-plugin`은 기존 `feat/discovery-plugin` 위에 추가된 기능이다.
현재 정식 v0.1.1에는 없으며, 제공 버전이 확정되기 전의 최소 버전 후보는
`0.1.2-beta.1`이다. 패키지에 `metadata.read` 권한을 명시해야 한다.

```js
const credits = await moa.metadata.credits();
// 현재 상세 화면의 크레딧에 있는 인물만 조회한다.
const works = await moa.metadata.person({provider: person.provider, id: person.id});
```

호스트 SDK는 현재 `/title/:id`에서 MOA 작품 ID를 가져온다. 플러그인이 제목을
검색해서 작품을 재매칭하지 않는다. 서버는 기존 `auto`/`manual` 연결만 읽고,
연결을 만들거나 변경하지 않는다. 자동 연결의 정확도를 추가 보증하는 API는
아니며, 연결이 잘못됐다면 MOA 메타데이터 설정에서 바로잡아야 한다.

- 크레딧 응답: `{provider,status,title,cast,crew,truncated}`.
- 참여작 응답: `{provider,status,title,person,items,truncated}`.
- `status`: `ready`, `unlinked`(사용 가능한 기존 연결 없음),
  `unconfigured`(공급자 키 없음), `restricted`(키즈/없는 프로필),
  `unavailable`(조회 실패·조회 중 연결 변경·동시 요청 한도 등).
- 준비되지 않은 응답은 `title/person:null`, 빈 목록이며 이전 데이터를 표시하지 않는다.
- `title`: `{mediaId,provider,kind,id,name,scope}`. `mediaId`는 MOA ID,
  `id`는 공급자 ID다. `scope`는 영화 `movie` 또는 TV 시리즈 전체 `series`다.
- `PersonCredit`: `{provider,id,name,photo?,roles:string[]}`. 출연진과 제작진을
  별도 목록으로 반환한다. 같은 인물의 여러 배역·직책을 보존한다.
- `items`는 인기 API와 같은 `DiscoveryItem[]`이다. 작품·인물의 외부 ID는
  불투명 문자열이다. 공급자가 다른 ID를 합치거나 숫자로 변환하지 않는다.
- 출연진/제작진 각각 최대 60명, 각 목록에서 인물당 8개 역할, 참여작 최대 40개.
  제한 때문에 누락된 데이터가 있으면 `truncated:true`다. 목록 순서는 공급자
  순서이며, 인기 순위나 전체 필모그래피라고 표현하지 않는다.
- 배역의 `(voice)` 등 원문 표기를 유지하지만 더빙 언어·판본을 추측하지 않는다.
  TV aggregate credits는 시즌/회차 전용 크레딧이 아니다.
- 키즈 프로필은 참여작 전체의 등급을 판정할 수 없어 외부 호출 없이 제한한다.
  일반 회원은 자신이 접근 가능한 프로필로 사용할 수 있다.

SDK가 호출하는 HTTP 경로는 `POST /api/plugin-runtime/:pluginId/metadata/credits`
및 `/metadata/person`이다. 본문은 `{revision,mediaId}` 및
`{revision,mediaId,person:{provider,id}}`다. 관리자 경로 `/api/plugins/:pluginId/…`도
같은 계약을 사용한다. JSON의 ID 타입을 강제로 변환하지 않는다. HTTP 경로는
현재 페이지를 입증하는 토큰이 아니므로, 권한은 현재 프로필이 볼 수 있는
연결된 작품 메타데이터를 읽는 것으로 해석해야 한다. 임의 외부 ID 조회는
제공하지 않으며 참여작 요청의 인물은 해당 작품 크레딧에 있어야 한다.

각 요청에 계정/프로필·활성화·패키지 revision·권한을 검사하고, 외부 응답 후에도
권한·프로필 정책·작품 연결·공급자 설정을 다시 확인한다. SDK는 상세 화면 이동
또는 프로필 전환 뒤 도착한 결과도 전달하지 않는다. 응답은 `private, no-store`.

내부 `PeopleProvider`는 연결 읽기·크레딧·참여작만 제공하는 작은 계약이다.
현재 구현은 TMDB 하나이고, 키나 임의 URL/헤더는 플러그인에 노출하지 않는다.
공개 공급자 응답만 6시간, 최대 128개 메모리 캐시에 보관한다. 동일 요청은
합치고 동시 공급자 요청은 최대 4개, 실패는 60초 뒤 재시도한다. 만료된 자료는
실패 시 재사용하지 않는다. 계정 기록·시청기록·관심목록은 읽지 않는다.
공급자/설정 변경 시 캐시를 무효화한다. 새로운 상주 프로세스나 DB 테이블은 없다.

공급자 자료: [영화 크레딧](https://developer.themoviedb.org/reference/movie-credits),
[TV 시리즈 전체 크레딧](https://developer.themoviedb.org/reference/tv-series-aggregate-credits),
[인물의 영화·TV 참여작](https://developer.themoviedb.org/reference/person-combined-credits).


### 기존 출연진 UI 확장: `title.people`

인물 플러그인은 별도 출연진 iframe 패널을 중복해서 그리지 않는다. 기존
`PeopleRow`와 MOA 컴포넌트로 렌더링되는 상세 시트에 데이터를 제공한다.
패키지는 `hooks:["title.people"]`, `permissions:["metadata.read"]`,
`placements:["app"]`, API 2 이상을 선언하고 아래처럼 등록한다.

```js
moa.hooks.register('title.people', request => request.action === 'credits'
  ? moa.metadata.credits()
  : moa.metadata.person(request.person));
```

요청은 `{action:'credits',mediaId}` 또는
`{action:'person',mediaId,person:{provider,id}}`다. 반환 계약은 위 API와 같다.
플러그인에는 화면에 임의 HTML을 삽입하는 권한을 주지 않는다. MOA가 문자열,
ID, 현재 작품, 지원 공급자, 목록 수와 이미지 URL을 검증해 기존 UI로 렌더링한다.
현재 렌더러는 TMDB 출처·이미지 규칙만 지원한다. 타 공급자는 조용히 TMDB로
표시하지 않고 명시적으로 거부하며, 추후 해당 공급자의 표시 규칙도 추가해야 한다.

인물 패키지는 자체 UI·네트워크·이미지 다운로드가 없어 `ui`, `app.navigate`,
`connect` 권한이 필요 없다. 검색은 사용자가 네이티브 참여작 링크를 선택할 때만
일어난다. 사진/포스터는 기존 MOA 이미지 표시 경로를 사용하며 iframe CSP는
완화하지 않는다. API 키와 원본 공급자 응답은 여전히 서버 경계 안에 있다.

등록된 공급 기능이 없으면 기존 출연진 행을 유지한다. 네이티브 `Person`에
선택적 `identity:{provider,id}`가 있으면 인물 탐색으로 연결할 수 있다.
예전 캐시에 ID가 없으면 이름으로 추측하지 않고 전체 크레딧 진입을 사용한다.
외부 ID는 메타데이터가 정상 갱신될 때 함께 저장되며, 이번 작업 때문에 기존
캐시를 일괄 무효화하거나 사이트 요청을 실행하지 않는다.

활성 프로필에서 여러 패키지가 등록되면 플러그인 ID 순 첫 번째를 사용한다.
등록 해제·프로필 변경·취소·20초 제한에 걸린 응답은 버린다. 결과는 최대
262,144자이며, 캐시나 영구 저장을 하지 않는다. 요청 전후에 활성화·revision·
권한을 확인하고 현재 상세 작품과 다른 응답을 거부한다.

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

릴리스 설치는 생성된 Compose 설정을 보존하므로 `.env`만 고쳐서는 실행 중 컨테이너의 환경변수가 바뀌지 않을 수 있습니다. 관리 중인 실제 배포 설정에 변수를 전달한 뒤 컨테이너를 갱신해야 합니다. 이 개발 작업은 운영 설정을 변경하지 않았습니다. 키가 없으면 뉴스 기능은 기존 TMDB 설정으로 동작하고 박스오피스만 미설정으로 표시됩니다.

공식 계약: [KOBIS 일별](https://www.kobis.or.kr/kobisopenapi/homepg/apiservice/searchServiceDesc.do?apiSvcId=searchDailyBoxOffice) · [주간](https://www.kobis.or.kr/kobisopenapi/homepg/apiservice/searchServiceDesc.do?apiSvcId=searchWeeklyBoxOffice) · [TMDB TV 상세](https://developer.themoviedb.org/reference/tv-series-details).
### 작품 리뷰 (`title.reviews`, 0.1.2-beta.3+)

0.1.2-beta.3 이상의 호스트에서 지원한다. `reviews.read` 권한과 `title.reviews` hook을 선언한 API 2 플러그인은 `moa.reviews.list(provider, selection?)`를 호출한다. 현재 provider는 `tmdb`, `anilist`이며 API 이름은 특정 공급자에 묶이지 않는다. 호스트가 현재 상세 페이지에서 작품을 결정하며 임의 쿼리/URL/키는 받지 않는다.

Hook 입력은 `{mediaId, provider, selection?}`, 응답은 shared의 `ReviewResponse`다. `selection`은 AniList 후보 ID 문자열이며 서버가 해당 작품에 대해 반환한 후보에 있어야 한다. 선택하지 않았거나 후보에 없는 ID면 `select` 상태와 후보 목록이 반환된다. 임의 첫 항목을 자동 선택하지 않는다.

호스트가 네이티브 리뷰 UI와 외부 링크를 렌더링하고 응답을 검증한다. 기존 플러그인은 새 기능을 선언하지 않으면 영향이 없다. 상태는 ready/select/unconfigured/unlinked/restricted/unavailable이며, ready+빈 목록은 리뷰 없음, select+빈 후보는 작품 검색 결과 없음이다. 평점 통합/국적 판별/원문 전체 저장은 제공하지 않는다. 설정·실측·한도·번역의 한계는 `plugins/title-reviews/README.md` 참조.

AniList 요청 한도는 리뷰와 추천 보강이 공유합니다. 서버 전체 20회/분·동시 4개이며, 429 또는 잔여 한도 0 응답의 대기 시간도 두 기능에 함께 적용합니다. 두 기능의 결과 캐시와 사용자 권한은 별도로 유지합니다.
