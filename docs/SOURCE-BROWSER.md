# Per-source proxy and experimental source browser

This optional Camoufox service supplies browser callbacks and authentication to
MOA's JS sources. The existing source **Connection** settings remain unchanged:
per-source proxy (blank inherits the server proxy), and **Use browser authentication** (default off). APK requests and sources without this option keep
their existing behavior. No browser port is published and no media relay is replaced.

Release-managed installations can install this service in Settings → About → Additional features. For manual Compose configuration, use the override below.

## Session HTTP and lifecycle

MOA keeps authentication cookies and the actual browser User-Agent in host memory,
separately from the browser/Python process. The host scopes sessions by installed
source, source settings generation, selected proxy and exact HTTPS origin. Source
credentials are currently configured per installed source, shared by viewing
profiles; this feature does not introduce per-profile website accounts.

At most 64 HTTP sessions are retained, with 60 minutes of inactivity expiry and
bounded cookie count/size. Nothing is written to the database or disk. MOA restart
requires fresh authentication. Preferences, proxy changes, removal, disabling,
installation and rollback invalidate the applicable authentication state. Requests
finishing after invalidation cannot restore the obsolete credentials.

Opted-in sources can explicitly request the session HTTP path:

```js
const client = new Client({
  timeout: 85,
  browserSession: { url: 'https://example.com/catalogue', readOnly: true }
});
const response = await client.get('https://example.com/catalogue');
```

`url` is a public HTTPS bootstrap page on the same origin as the request. GET and
HEAD are reads; POST additionally requires `readOnly: true` and must only be used
by the source for a known read operation. PUT/PATCH/DELETE are not allowed on this
path. Normal Client calls keep their existing transport. WebView scripts retain
their existing meaning; they are not automatically translated into HTTP.

The first session request authenticates via the browser. Subsequent requests use
the existing pinned Node HTTP transport with cookies selected for each redirect
hop. Set-Cookie updates are consumed by the host and not returned to guest code.
Cross-origin redirects never receive the origin's credentials. An explicit CF
challenge permits one coalesced authentication refresh and one retry. Ordinary
403/401/429/5xx and ambiguous transport failures do not replay POST. A failed
refresh has a 30-second cooldown. Cancelling one waiter does not cancel others;
when all waiters cancel, authentication is aborted. The private source handles
site-specific AJAX nonce expiry independently, without forcing CF authentication.

Owner images use the same session when the referer and image origin agree.
Existing browser image fallback remains available. Video DOM/JS extraction stays
on the browser path; playback continues through MOA's existing media relay.

Browser contexts are limited to two, serialized per source generation/proxy/origin.
Idle contexts close after 30 seconds (a 10-second reaper cadence). Once no contexts,
active requests, queued requests or cleanup operations remain, the entire Python
process group is stopped. Auth state stays in MOA; HTTP requests do not keep the
browser alive. The next browser operation starts a new worker. This reduces idle
process memory; peak authentication memory and file cache are separate costs.

## Deployment and rollback

```sh
docker compose -f compose.yaml -f compose.source-browser.yaml up -d
```

Preserve any other overrides already used by the installation. The override uses
published images matching `MOA_VERSION` and sets `MOA_SOURCE_BROWSER_URL` and the shared
`MOA_SOURCE_BROWSER_SECRET_FILE`. A dedicated volume holds the 0600 random RPC
token; MOA mounts it read-only. For a bind mount, use a UID-1000-writable directory
via `MOA_SOURCE_BROWSER_SECRET_PATH`. No site-specific source belongs in the image.

The browser is Camoufox **152.0.4-beta.30**, Python wrapper **0.4.11**, Playwright
**1.58.0**, Linux amd64. The build downloads one exact upstream archive and verifies
its fixed SHA256 before extraction. Runtime requires that binary and never fetches
browsers or addons. Upgrades require changing the pins and checking authentication;
they are not automatic. Provenance is in [NOTICE.md](../services/source-browser/NOTICE.md).
Keep the prior app/browser images and private source version for rollback together.
Disabling the preference returns sources to their non-browser path; extensions
requiring this experimental API will explicitly report it unavailable.

## Boundaries

Authenticated `POST /evaluate` accepts a host-issued scope, proxy, public HTTPS URL,
headers, script and timeout (up to 90 seconds). Optional `captureSession: true`
returns host-only cookies/UA alongside `result`; MOA strips this metadata before
returning the script result to the guest. Legacy result-only requests still work.
Bodies are bounded to 512 KiB request / 4 MiB response; the existing WebView guest
result limit is 1 MiB. Authentication, upload and queue time count toward deadlines.

Each evaluation attaches a fresh existing `openSourceBrowserProxy` to a stable
loopback relay. DNS/public-IP pinning, 32 MiB/512 connection budgets, TLS checks,
socket cleanup and bearer RPC authentication remain in force. Idle relays refuse
connections. The relay is container-local: do not colocate untrusted processes.
No cookies, tokens, URL details or raw browser diagnostics are logged.

Headless mode and humanization are enabled, locale/timezone explicit, and geo-IP
probing disabled. The global browser proxy fails closed; contexts use the guarded
relay. Media/popup, WebRTC, DoH and prefetch restrictions remain. A service-worker
registration shim preserves the tested routing behavior; it can affect compatibility.
Site success and long-lived CF clearance are not guaranteed. Health checks establish
RPC readiness, not website reachability.

## Focused verification

```sh
node --test services/source-browser/tests/*.test.mjs
python3 -m unittest discover -s services/source-browser/tests -p 'test_*.py'
corepack pnpm --filter @moa/server exec tsx --test test/source-session.test.ts test/source-browser.test.ts test/source-network.test.ts
docker compose -f compose.yaml -f compose.source-browser.yaml config --quiet
```

Live browser checks are optional and use isolated containers, synthetic/local
fixtures or privately managed sources. Never include private source artifacts in
public tests, repositories, image contexts or deployment documentation.
