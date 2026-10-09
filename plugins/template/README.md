# MOA plugin template

Create JavaScript plugins that run inside MOA. The default example saves a playback bookmark per profile, announces an available bookmark when an episode opens, and adds actions to save or resume playback. It needs no HTML interface, dependencies, or bundler.

## Build and install

In MOA, open **Plugins** from the profile menu, My page, or Settings link. As an administrator, choose **Select folder** and select this entire template directory, or choose **Select ZIP file** and select its ZIP package. Review the permissions and choose **Install/update**. Open a video and use **Playback settings → Plugins → Save bookmark / Resume bookmark**. One bookmark is stored per profile and survives browser and server restarts.

To distribute one ZIP package, use Node.js 22.15 or later. From this template directory:

```sh
node build.mjs
```

Install or share `dist/playback-bookmark.zip`. It contains the manifest and script. Users select only this ZIP file.

When working inside the MOA repository, build with `node plugins/template/build.mjs` and use the output path it prints.

## Write a plugin

Edit `manifest.json` for the ID, version, placements, permissions, allowed HTTPS origins, and action labels. Edit `plugin.js` for behavior. MOA supplies `window.moa` before the script runs:

```js
moa.on('ready', async context => {
  if (context) await moa.notify(`Playing ${context.title}`);
});

moa.on('action', async ({ id }) => {
  if (id === 'pause') await moa.player.pause();
});
```

The example needs `player.context`, `notifications`, and `player.control` permissions and an action with ID `pause`. After editing, select the entire folder again or rebuild and install the new ZIP package using the same ID to update it. Give a separate plugin its own ID. Scripts run automatically in their declared scope and should request only the permissions they use.

For automatic subtitle retrieval, declare `player.context` and `subtitles.import` and add your service's exact HTTPS origin to `connect`:

```js
moa.on('ready', async context => {
  if (!context) return;
  const url = new URL('/subtitle', 'https://subtitles.example.org');
  url.searchParams.set('title', context.title);
  const response = await moa.fetch(url.href);
  await moa.importSubtitles(new File([await response.arrayBuffer()], 'downloaded.srt'));
});
```

Replace the example endpoint with a service you operate or are permitted to use. MOA validates, converts, and saves imported subtitles through its regular upload path.

## Website tool example

`examples/page-notes` adds a page notebook and a search form. It uses no playback or subtitle permissions. Select that entire folder in MOA, then open **Page notes** on the Plugins page or in the profile menu. Notes are stored on the server for the active profile; changing pages updates the note context. JavaScript can build its own interface with DOM APIs, use `moa.ui.open()` and `moa.ui.close()`, listen for `routechange`, and navigate through `moa.app.navigate(path)`.

To distribute one ZIP file:

```sh
node build.mjs examples/page-notes
```

## Catalog and inline detail example

`examples/catalog-labels` uses API 2 to change catalog badges through `catalog.transform` and show an inline title panel. It receives sanitized catalog data and returns patches for existing titles, without changing the server database. Only `catalog.modify` and `ui` permissions are needed.

```sh
node build.mjs examples/catalog-labels
```

An optional `minMoaVersion` in the manifest declares the minimum MOA release. Packages requiring a newer API or release stay installed but do not execute; their management row shows the requirement and an update action. See the API documentation for hook limits and failure handling.

## HTML subtitle example

`examples/subtitle-helper` provides a file picker and text input for importing subtitles. Build it with:

```sh
node build.mjs examples/subtitle-helper
```

Install `dist/subtitle-helper.zip`, or select the entire `examples/subtitle-helper` folder. Open the tool in **Playback settings → Plugins**. The example shows the optional HTML interface; JavaScript plugins can import subtitles without opening a dialog.

## API and license

Read the [plugin API documentation](../../docs/PLUGINS.md) for events, methods, permissions, lifecycle, limits, and sandbox boundaries.

This template is licensed under GPL-3.0-or-later, as is MOA. Include a license and explain every permission when distributing your plugin.
