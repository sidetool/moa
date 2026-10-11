# Experimental trailer feed

An opt-in, per-profile discovery feed. Uses TMDB's Trailer/Teaser references (official uploads ranked first) and YouTube's official iframe player. It does not cut, download, or transcode full episodes. Existing trailer dialogs, episode playback, downloads, and recommendations remain available independently.

## Candidate selection

Categories are independent from recommendation mode: movie, series, animation (all selected by default). At least one remains selected. Movies/TV animation use TMDB genre 16; nonanimated movies and TV series are separate. TV news/reality/talk genres are excluded from the series pool. Sports/variety are not offered because reliable classification is unavailable. Unknown genre metadata is skipped rather than guessed. Existing personal candidates with old genre-less caches become eligible when metadata refreshes normally.

Popularity uses fixed first-page TMDB discover queries sorted by popularity, with genre filters. Each category contributes up to 20; animation interleaves movies and shows. These three public lists cache 30 minutes and coalesce concurrent requests; failures back off one minute. No source catalog extraction runs to populate the feed.

- `shortsEnabled`: off by default. OFF performs no feed discovery. Child profiles are excluded in this first version because public trending metadata lacks consistent age certification.
- `shortsScreenFit`: true by default. On mobile, the iframe uses the available feed area; disabling restores the compact landscape layout. YouTube owns video aspect fitting. No iframe crop, control clipping, or swipe overlay is used. Desktop keeps its layout.
- `shortsMode`: `mixed` (default), `personal`, or `popular`. Mixed interleaves up to two existing recommendation candidates with one popular candidate, then uses the remaining pool. Personal mode falls back to popular when there are no personal candidates. Existing recommendation opt-out and dismissals are respected.
- `shortsHideWatched`: true by default; exclude titles with episode progress. This does not erase history. Personal recommendations already exclude watched titles; disabling this option mainly allows them in the popular pool.
- `shortsRepeatDays`: 7 by default, selectable 0/1/7/30 (0 disables the repeat exclusion). Five seconds of playback or an intentional forward skip suppress repeats, independently of episode progress, by profile and TMDB work identity. A skip is not a permanent dislike and does not alter recommendations. Automatic transitions, failed trailers and background navigation are not skip signals. Switching videos within a work does not evade the repeat window.
- Candidate pool: at most 20 personal and 60 popular, deduplicated by `(kind, TMDB id)`. Popular order is stable for a profile/day. Feed pages contain up to eight works. `replay=1` bypasses trailer-view exclusions for that request without deleting any history; watched-episode and dismissal exclusions still apply. A finite empty state is preferable to silently replaying excluded works.
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

One active YouTube player, stopped/destroyed when leaving the feed, changing work, or hiding the page. Do not crop landscape footage or cover player controls with a swipe interception layer. Mobile gestures must use the surrounding feed surface; explicit navigation remains available. Autoplay denial asks for a tap, not a new video. Video-specific failure tries other references; network/API failures must not endlessly advance the feed.

References: [YouTube required player behavior](https://developers.google.com/youtube/terms/required-minimum-functionality), [IFrame API](https://developers.google.com/youtube/iframe_api_reference).

## Release boundary

Development branch only. No live site extensions, production database, deployment settings, GitHub release, or container have been changed for this experiment.
