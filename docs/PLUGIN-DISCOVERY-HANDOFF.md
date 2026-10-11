# Popular titles plugin integration

This branch implements the first item in `PLUGIN-CANDIDATES.md`. It intentionally
starts from the same committed planning base (`b52f797`) as `feat/next-media-features`;
the other agent's uncommitted next-version implementation was not copied or edited.
Do not replace that worktree with this branch.

## Ownership and merge boundaries

- Standalone plugin: `plugins/trending-titles/`. No dependency on private video
  extensions, history/recommendations, downloaded media or site identifiers.
- New module/test: `apps/server/src/plugin-discovery.ts` and
  `apps/server/test/plugin-discovery.test.ts`.
- Existing host edits are additive: `Tmdb.trending()` and credential-generation
  invalidation, plugin permission/route, SDK forwarding and shared response types.
- Shared files likely also edited by the other agent: `app.ts`,
  `website-plugins.ts`, `WebsitePlugins.tsx`, `packages/shared/src/index.ts`,
  `docs/PLUGINS.md`. Keep BOTH `history.read` and `discovery.read`, BOTH SDK objects,
  and both endpoint handlers when resolving conflicts. `registerWebsitePlugins`
  receives the new `PluginDiscovery` instance as its optional third argument.
- Keep the current API version unless the integrating branch intentionally bumps
  it. Update the manifest minimum release to the release actually containing this
  SDK; the provisional target is `0.1.2-beta.1`. Do not lower it to v0.1.1.

## Validation and deployment boundary

Run `plugin-discovery.test.ts`, TMDB and plugin regressions, typecheck, web build,
then the browser smoke for the packaged plugin and real host SDK. Include the new
server test in the final merged CI test list. Test shared permission parsing with
both permissions after integration. Do not rerun unrelated download experiments.

No operating container, installed plugin, public repository or release is changed
by this branch. Build/install requires the host API as well as the plugin ZIP;
installing the ZIP alone into current v0.1.1 will not add the SDK.

Live provider contract sample (2026-10-11): existing configured TMDB credentials
were used for two read-only requests, movie/week and tv/week in ko-KR. Each returned
HTTP 200, 20 titles, explicit non-adult flags and fixed-CDN poster paths. No token
was printed/copied into code or ZIP. This checks provider shape, not the final UI.

Other plugin candidates remain separate work: confirmed-title person metadata,
release schedules, KOBIS box office and watchlist schedules. No new history or
watchlist rights are requested by this plugin.

## Completed checks

- Five focused tests cover provider normalization, bounded cache/backoff and
  credential changes, profile-policy changes during a pending response, API
  account/permission/revision/revocation boundaries including ordinary members.
- Existing TMDB (3), catalog-hook (1) and plugin (3) tests passed. The archive
  fixture test requiring `bsdtar` was explicitly excluded on this machine. The
  actual generated ZIP passed `unpackPlugin` and minimum-version compatibility checks.
- Workspace typecheck and web production build passed.
- `apps/server/scripts/verify-trending-plugin.mts` starts an isolated synthetic
  app, installs the actual plugin and exercises the real SDK/API at loopback.
  It checks list queries, cache reuse, navigation, visible blob posters, mobile
  width, kids restriction and disabling the package. Poster bytes only are mocked;
  it does not claim a live CDN end-to-end test.

Run that browser check from the repository root:

```bash
MOA_PLAYWRIGHT_PATH=/path/to/playwright-core \
MOA_BROWSER_EXECUTABLE=/path/to/chromium \
MOA_VERIFY_DIR=/tmp/moa-trending-verify \
  corepack pnpm --filter @moa/server exec tsx scripts/verify-trending-plugin.mts
```

Screenshots use synthetic titles and artwork. No live viewing history is needed.

Read-only three-way merge preview against the other agent's in-progress files
found additive conflicts in `app.ts`, `website-plugins.ts`,
`WebsitePlugins.tsx`, `packages/shared/src/index.ts`, and `docs/PLUGINS.md`.
`tmdb.ts` and the CI workflow merged automatically in that preview. This is a
snapshot, not a guarantee for the final branch. No merge was applied to either
worktree; resolve the five shared files during integration and run both APIs' tests.

The plugin's standalone browser suite also passed at desktop 1280px and mobile
375px: stale-response races, restricted/error/empty/missing-SDK states, input
validation, text injection, poster queue/blob cleanup, keyboard navigation,
attribution and resize. The real-host screenshots are under the verification
output directory; standalone fake-SDK screenshots are not release evidence.

## Provider-neutral contract follow-up

`TrendingResponse` now carries `provider`, and `DiscoveryItem` replaces the TMDB
`MetadataCandidate` at this boundary. IDs are opaque strings scoped to
`(provider, kind, id)`. Existing metadata matching/recommendation types are unchanged.
`PluginDiscovery` depends on the small structural `TrendingProvider` port, not on
`Tmdb`. It invalidates cache entries and rejects pending results across provider
identity/configuration changes. TMDB is still the sole installed adapter.
The bundled UI explicitly rejects unfamiliar feeds to avoid wrong attribution;
provider-specific logos/ranking labels/image permissions remain deliberate work.
