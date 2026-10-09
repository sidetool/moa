# Website plugins

Website plugins add JavaScript behavior and optional tools to MOA. They can build their own tools, respond to page changes, navigate within MOA, react to playback, control the player, retrieve and import subtitles, store profile-specific data, and show notifications. API 2 also lets plugins transform catalog display data and add inline title panels. They are separate from video-source extensions and do not register media catalogs or playback sources.

## Installation and management

Open **Plugins** from the profile menu, My page, or the Settings link. Administrators select one ZIP package or an entire plugin folder. The package contains `manifest.json` and either `plugin.js` or `index.html` in the same directory. A wrapper directory, such as GitHub's downloaded ZIP, is supported; the shallowest manifest is selected, so nested examples do not override the main plugin. Bundled `.moa-plugin.json` files remain supported. Review the permissions and allowed network origins, then install it. Administrators can update packages or select multiple packages to enable, disable, or delete them together. A failed operation leaves only failed items selected for retry. Only administrators can access the installed inventory at `/plugins`; other profiles can use compatible, enabled tools and inline features. Runtime descriptors expose only the fields needed to render those features, without package versions, configuration, or disabled plugins.

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
