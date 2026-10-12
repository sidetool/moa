# Experimental trailer feed

An opt-in, per-profile discovery feed. Uses TMDB's Trailer/Teaser references (official uploads ranked first) and YouTube's official iframe player. It does not cut, download, or transcode full episodes. Existing trailer dialogs, episode playback, downloads, and recommendations remain available independently.

## Candidate selection

Categories are independent from recommendation mode: movie, series, animation (all selected by default). At least one remains selected. Movies/TV animation use TMDB genre 16; nonanimated movies and TV series are separate. TV news/reality/talk genres are excluded from the series pool. Sports/variety are not offered because reliable classification is unavailable. Unknown genre metadata is skipped rather than guessed. Existing personal candidates with old genre-less caches become eligible when metadata refreshes normally.

Popularity uses fixed first-page TMDB discover queries sorted by popularity, with genre filters. Each category contributes up to 20; animation interleaves movies and shows. These three public lists cache 30 minutes and coalesce concurrent requests; failures back off one minute. No source catalog extraction runs to populate the feed.

- `shortsEnabled`: off by default. OFF performs no feed discovery. Child profiles are excluded in this first version because public trending metadata lacks consistent age certification.
- `shortsScreenFit`: true by default. In embed mode on mobile, the player fits within the available width and height while preserving its landscape viewport; disabling uses a compact presentation. The surrounding feed uses the plain app background, without poster blur or artificial fill. YouTube owns the aspect fitting inside its player. No iframe crop, control clipping, or swipe overlay is used. Desktop keeps its layout.
- `shortsMode`: `mixed` (default), `personal`, or `popular`. Mixed interleaves up to two existing recommendation candidates with one popular candidate, then uses the remaining pool. Personal mode falls back to popular when there are no personal candidates. Existing recommendation opt-out and dismissals are respected.
- `shortsHideWatched`: true by default; exclude titles with episode progress. This does not erase history. Personal recommendations already exclude watched titles; disabling this option mainly allows them in the popular pool.
- Failed playback is remembered separately per profile: unavailable trailers are excluded for the repeat window (at least one day), temporary connection/player errors for one hour. This also applies to replay mode and does not mark episodes watched or change recommendations. Resetting Shorts history clears these exclusions. Prefetch errors are recorded only if that work is actually opened; autoplay blocking is not a failure.
- `shortsRepeatDays`: 7 by default, selectable 0/1/7/30 (0 disables the repeat exclusion). Five seconds of playback or an intentional forward skip suppress repeats, independently of episode progress, by profile and TMDB work identity. A skip is not a permanent dislike and does not alter recommendations. Automatic transitions, failed trailers and background navigation are not skip signals. Switching videos within a work does not evade the repeat window.
- Candidate pool: at most 40 personal and 60 popular, deduplicated by `(kind, TMDB id)`. Popular order is stable for a profile/day. Feed pages contain up to eight works. `replay=1` bypasses trailer-view exclusions for that request without deleting any history; watched-episode and dismissal exclusions still apply. A finite empty state is preferable to silently replaying excluded works.
- Linked works open their MOA detail; unknown works open in-app search. There is no promise that every advertised title exists in the installed sources.

## API

All endpoints use existing account ownership, profile, and PIN guards. Responses are private/no-store.

- `GET /api/shorts?cursor=…&replay=1` → `ShortsFeed`. A cursor advances through the original bounded candidate pool, rather than the filtered page, so marking page one seen does not skip page two. Client deduplication is still required if metadata changes between pages.
- `GET /api/shorts/:key/trailers` → `{trailers,checked}`. Loads only the currently selected work. At most four metadata resolutions run concurrently; equal requests coalesce, public results cache for six hours (max 256 entries). Configuration changes invalidate cached metadata. Optional YouTube Data API checks remain fail-open to ordinary player fallback.
- `POST /api/shorts/:key/seen` → `{ok:true}`. Called once after five seconds of actual foreground playback, not when a card is loaded, skipped before playback, or fails. Timestamp is server-owned. At most 2,000 recent keys per profile, with 30-day expiry cleanup.
- `POST /api/shorts/:key/skip` → `{ok:true}`. Sent once on an intentional forward transition from the currently presented work, even before five seconds. Uses the same profile-scoped exclusion window, expiry, reset and replay rules as viewed trailers. Rapidly crossed, unsettled cards are not individually excluded.
- `DELETE /api/shorts/seen` resets this profile's trailer-view exclusions only.
- Settings use the existing `GET/PATCH /api/settings` contract.

The server does not infer successful playback from a feed request and never marks full episodes watched from trailer events. View reports are advisory preference signals, not audited viewing statistics.

## Player constraints

One active YouTube player, stopped/destroyed when leaving the feed, changing work, or hiding the page. Do not crop landscape footage or cover player controls with a swipe interception layer. Actions sit in a right-hand rail and title/description sit at the bottom without a separate information panel, outside the iframe. Mobile gestures must use the surrounding feed surface; explicit navigation remains available. Autoplay denial asks for a tap, not a new video. Video-specific failure tries other references; network/API failures must not endlessly advance the feed.

References: [YouTube required player behavior](https://developers.google.com/youtube/terms/required-minimum-functionality), [IFrame API](https://developers.google.com/youtube/iframe_api_reference).

## Release boundary

Available as an opt-in experiment starting in v0.1.2-beta.2. The standard image supports the YouTube embed. Native playback requires the separate setup below; the extractor is not installed in release images.

## Native player experiment (opt-in, separate from the embed)

`shortsPlayback` defaults to `embed`. `native` uses MOA's own video element; mobile screen fit crops **the video** with `object-fit: cover`, while disabling fit keeps the complete frame. Native playback permits the feed's controls and captions over the picture. The embed keeps its existing unobscured layout. There is no artificial artwork fill.

The server must explicitly set `MOA_SHORTS_EXTRACTOR` to an installed **yt-dlp executable** with its matching EJS scripts; Node 22+ is used as the JavaScript runtime. The standard image does not install or enable this dependency. `GET /api/shorts/native` reports configuration availability, not a guarantee that YouTube will accept a request. Profile settings select the mode separately. Existing trailer dialogs and episode playback are unaffected.

The server resolves at most two existing TMDB/YouTube trailer candidates for the active work. It never accepts a client-provided video URL. The extractor uses a fixed YouTube watch URL, ignores user configs/plugins, has no login cookies, and performs no runtime component downloads. Only non-live, non-DRM previews up to ten minutes with H.264/AAC MP4 or HLS, at most 720p, are accepted. Split HLS uses its master playlist: compatible video variants and their matching audio groups are retained together. A video-only media playlist is never passed off as a complete movie. Split progressive MP4/WebM without a usable HLS master remains unsupported; no transcoding or full-file downloads are performed. Extraction and media relay use the same snapshot of the server default proxy, when configured.

- `POST /api/shorts/:key/native {}` prepares `{sessionId,url,mime,subtitles}`. The URL is an opaque same-origin media lease, never the signed upstream URL.
- `GET /api/playback/:sessionId/shorts/:assetId` streams media with existing account, profile-PIN and watch-permission checks, public-IP/DNS pinning and redirect validation. HLS assets are rewritten into the same lease; encrypted playlists are rejected.
- `DELETE /api/shorts/native/:sessionId` stops a profile-owned lease. The client aborts preparation and releases playback when it leaves the card. After playback starts, it prepares the next two cards sequentially and hands over the same request/lease when the user advances. Hiding/leaving the feed cancels prefetch and releases unused leases; prefetch never plays or reports a view. Failed prefetch is not automatically repeated.
- Native preparation and retained media leases count as active work for the updater, so an update waits for them to be released or expire. Maximum two concurrent extractions, forty seconds per candidate; child process groups are killed on timeout/cancellation/exit. Three leases per profile (current plus two ahead), thirty-two globally, expire after ten minutes. Each lease permits eight simultaneous media requests, 128 MiB total, at most 1024 HLS assets and 512 KiB per playlist. Successful references are reused for up to two minutes, scoped to profile, candidate list and proxy, capped at 64 entries, and invalidated on upstream HTTP failure. No account cookies or upstream URLs are sent to the client. All lease metadata stays in memory and clears on shutdown. Temporary network/extraction failures retain their error class rather than being mislabeled unsupported media.

YouTube extraction may require additional tokens or fail after upstream changes. No automatic account-cookie/PO-token provisioning is implemented. A failure offers the existing inline embed; it does not count as watched/disliked. This is an isolated experiment, not a replacement for the supported embed or a guarantee of regional availability.

Upstream installation/runtime references: [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation), [EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

### Local trial setup

The tested dependency is official yt-dlp `2026.08.19` with bundled EJS `0.8.0`. The optional derivative Dockerfile pins and checks the Unix zipimport archive; it adds Python only to the trial image. It is **not** part of release image builds and is not activated by the standard Compose configuration.

```sh
# Run from the release source, without replacing the running app.
docker build -t moa:shorts-native-base .
docker build -f deploy/shorts-native/Dockerfile -t moa:shorts-native-trial .
```

For a separate trial instance, choose the trial image and explicitly set `MOA_SHORTS_EXTRACTOR=/usr/local/bin/yt-dlp` (Compose's empty default overrides an image ENV). Use separate test data/ports. Enable Shorts and then 직접 재생 for the profile. With a host development server, set the variable to the isolated executable instead. Changing images does not itself select native playback for existing profiles. Removing the binary/configuration preserves the embed; no migrations or downloaded trailer files need cleanup.

Real checks so far: one public trailer prepared through the actual app API, then a bounded 5 MiB authenticated MP4 Range response; cross-account access denied and released lease rejected. Offline Chromium decoded both video frames and audio bytes from that API response without a media error; audible output was not human-checked. The verified muxed stream was 360p. Higher resolutions may only exist as separate video/audio and are not merged here. One other public trailer was unavailable. Subsequent bounded live checks decoded audio and video from split HLS as well. The optional derivative image was subsequently built locally; its extractor and MP4 relay were verified using the configured server proxy before personal deployment. Profile modes are not enabled automatically.


### Native startup buffering and captions

Once the current work actually starts playing, the feed prepares the next two works in order. Preparing the second starts after the first extraction settles, retaining foreground extraction capacity. `POST /api/shorts/native/:sessionId/warm` caches only the root, video/audio playlists matching the selected quality (auto: 360p), initialization data and fragments until six seconds are covered or three fragments have been fetched per track (MP4: first 512 KiB). Audio and video warm concurrently, with sequential fragments within each track. Limits: two simultaneous warmers, at most four warm requests in flight, twelve seconds, 8 MiB per attempt, 2 MiB per segment and 32 MiB cached media server-wide. Playback reuses these assets; automatic quality may then adapt up to 720p. Leases are released when no longer ahead, the page hides or the feed closes. This reduces later startup latency but does not eliminate initial extraction or slow upstream requests.

The extractor includes available original VTT captions and original automatic captions; no audio transcription runs. Clients receive only opaque lease-bound caption URLs. Downloads are bounded to 1 MiB/track, four concurrent fetches, 4 MiB cached captions/lease and 16 MiB globally. Captions are normalized before delivery. Translation uses the existing configuration, permission, shared queue, pacing and cache; it starts only for the active work, never prefetch. Preview jobs do not create episodes, history or saved subtitle links. Leaving the lease cancels its job subscriptions. Native playback includes touch/keyboard seeking and a compact subtitle selector. Embed playback is unchanged.

### Lightweight native controls

The feed description can expand in place. Native playback supports holding the video to temporarily play at 2×; ending/cancelling the gesture restores its prior rate. Vertical navigation and the seek bar remain separate gestures. HLS quality is a per-profile setting under the collapsed Shorts options: automatic (the unchanged startup behavior), 360p, 480p or 720p. Manual selection uses the highest available variant at or below that height, or the lowest available variant if none fits. The player has no quality menu. A single-format MP4 or a browser-native HLS player cannot offer Hls.js variant selection. Embedded YouTube retains its own playback controls.

In experimental settings the Shorts enable switch remains visible, while the detailed options start collapsed. These controls do not change the server's media limits, prefetch depth or caption/translation settings.
