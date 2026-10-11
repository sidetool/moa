# Trailer playback

MOA obtains YouTube Trailer/Teaser references from TMDB. It does not download trailers or obtain YouTube login cookies. A valid TMDB reference does not guarantee playback in the viewer's country or permit embedding.

## Candidates and compatibility

- Metadata requests include Korean, English, Japanese and unlabelled videos. Korean language, official status, then Trailer type determine priority. Language is not used as proof of regional availability.
- Keep up to five distinct, valid YouTube IDs. `MediaDetail.trailers` carries the list; `trailer` remains the first ID for older clients.
- Legacy cached records are upgraded on detail access, coalescing requests by TMDB identity. A failed lookup keeps the old video and backs off five minutes. A successful empty result clears a stale reference. There is no database-wide refresh or schema migration; subsequent normal metadata TTL applies.
- No YouTube Data API key is required for normal fallback. Viewer-side playback results are not used to blacklist videos for other users.

## Playback boundary

Use the official YouTube IFrame API to detect video-specific playback failures and try the remaining candidates without looping. Client identification errors (153), API-loading failure and HTML5 player errors do not mean every candidate is unavailable. Browser autoplay blocking is handled as a user interaction requirement, not a failed video. Long buffering, pause and playback completion do not trigger automatic candidate changes.

The viewer can try another candidate within MOA. MOA does not offer an external YouTube link as playback recovery. If no candidate works, the dialog reports failure rather than claiming a particular country is blocked. Region restrictions are not uniquely classified by the documented IFrame error codes. Logging into YouTube can help with age verification on YouTube itself; it is not a general solution for territorial or embedding restrictions.

Official references: [IFrame API errors](https://developers.google.com/youtube/iframe_api_reference#onError), [country restrictions](https://support.google.com/youtube/answer/92571), [age restrictions](https://support.google.com/youtube/answer/2802167).

## Optional YouTube Data API precheck

Administrators can save a YouTube Data API v3 key in Settings, or set `MOA_YOUTUBE_API_KEY`. Environment keys take precedence. The server never returns saved keys to clients. Clearing the saved key restores ordinary TMDB-only candidate playback unless an environment key remains. Enable YouTube Data API v3 on the Google project; a TMDB key is not a YouTube key. No YouTube account login/cookies or browser service is involved. A stored key is configuration, not proof that Google accepted it.

`GET /api/media/:id/trailers` uses the existing title's references and preserves normal account/profile/PIN/kids access checks. It performs no source requests or title matching. The web client requests it only when opening a trailer, with a bounded wait. No key, network failure, bad credentials, exhausted quota, malformed response, or an occupied request limit preserves the original candidates.

One `videos.list` request checks up to five existing video IDs. Known missing/private/unembeddable/age-restricted videos are excluded. Videos allowed in the configured playback region (default KR) come first. Region-blocked candidates remain at the end: this preference is not IP detection, and a different viewer may actually be in another country. Language is never used to establish geographic eligibility. API metadata is advisory; the real embedded player remains authoritative.

Results live in a bounded 512-entry memory cache for six hours, shared across viewers with the same candidate list and region; requests coalesce and are capped at four simultaneous lookups. Upstream failures trigger a five-minute shared backoff. Each lookup times out after four seconds. Updating configuration clears cached results and aborts old lookups. Region-specific decisions never overwrite TMDB metadata.

Automatic YouTube search is deliberately outside this change: title-only searches can select a different season, a remake, or a fan-made trailer. Existing candidates keep their TMDB work association. A later optional search provider needs an explicit matching policy before it can automatically play results.

References: [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), [region restrictions and embeddability](https://developers.google.com/youtube/v3/docs/videos), [API credentials](https://developers.google.com/youtube/registering_an_application).
