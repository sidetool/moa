# Trailer playback

MOA obtains YouTube Trailer/Teaser references from TMDB. It does not download trailers or obtain YouTube login cookies. A valid TMDB reference does not guarantee playback in the viewer's country or permit embedding.

## Candidates and compatibility

- Metadata requests include Korean, English, Japanese and unlabelled videos. Korean language, official status, then Trailer type determine priority. Language is not used as proof of regional availability.
- Keep up to five distinct, valid YouTube IDs. `MediaDetail.trailers` carries the list; `trailer` remains the first ID for older clients.
- Legacy cached records are upgraded on detail access, coalescing requests by TMDB identity. A failed lookup keeps the old video and backs off five minutes. A successful empty result clears a stale reference. There is no database-wide refresh or schema migration; subsequent normal metadata TTL applies.
- No new YouTube Data API key or server geolocation check is required. This version does not preflight geographic restrictions. Viewer-side playback results are not used to blacklist videos for other users.

## Playback boundary

Use the official YouTube IFrame API to detect video-specific playback failures and try the remaining candidates without looping. Client identification errors (153), API-loading failure and HTML5 player errors do not mean every candidate is unavailable. Browser autoplay blocking is handled as a user interaction requirement, not a failed video. Long buffering, pause and playback completion do not trigger automatic candidate changes.

The viewer can try another candidate within MOA. MOA does not offer an external YouTube link as playback recovery. If no candidate works, the dialog reports failure rather than claiming a particular country is blocked. Region restrictions are not uniquely classified by the documented IFrame error codes. Logging into YouTube can help with age verification on YouTube itself; it is not a general solution for territorial or embedding restrictions.

Official references: [IFrame API errors](https://developers.google.com/youtube/iframe_api_reference#onError), [country restrictions](https://support.google.com/youtube/answer/92571), [age restrictions](https://support.google.com/youtube/answer/2802167).
