# Server video storage

Server saves require an online connection to MOA. This is not a PWA/device offline feature.

Compose mounts a dedicated `/downloads` volume, separate from `/data` (updater backups) and read-only `/media`. Optionally set `MOA_DOWNLOAD_PATH` to an absolute host folder before creating containers. The feature is OFF by default, including an installation upgraded from beta.1 with an existing quota. An administrator must set a capacity and explicitly enable it in Settings → Server management → Downloads. Do not reuse the media or data directory. Native installs set `MOA_DOWNLOAD_ROOT` to an existing writable directory.

Fresh release installations inherit this mount. The new updater preserves existing mounts and adds an empty dedicated volume when missing, without setting a quota. An older updater applying this release may preserve its old compose instead: in that case add the `/downloads` mount and `MOA_DOWNLOAD_ROOT=/downloads` once to the installation's active compose file, then recreate MOA with the same image. The next updater preserves that mount. No implicit relocation of existing media/data occurs.

Administrators click a movie or episode download button once; the server immediately queues it and selects quality during extraction. The global download-quality setting defaults to 1080p and offers best/1080p/720p/480p. It chooses the highest known resolution at or below the preference, or the lowest available resolution if none fit. If no resolution is known, it uses the source default. Equal resolutions retain source order. HLS master variants follow the same preference. The preference is captured for each new job; changing it does not alter already queued jobs. The older token/choice API remains available for compatible clients. One transfer runs at a time, up to eight queue entries. One-click jobs acquire/renew an APK lease only while the job runs and release it on completion or interruption. Legacy explicit choices still release their initial lease and reacquire it for transfer. Jobs never persist signed URLs or cookies. Cancel, failure, and server shutdown release workers.

Supported: finite HTTPS MP4, finite ordinary HLS, master variants with default audio, AES-128 HLS. Downloaded HLS is remuxed with codec copy. Source policies and per-source proxy apply to every upstream request; ffmpeg only sees local files. DRM/SAMPLE-AES, live, DASH, EDL, inline playlists, separate extension audio arrays and ambiguous legacy explicit-choice matches are not supported for saving in this version. Playback support is unchanged. Some unusual HLS directives are rejected explicitly. External VTT/SRT/ASS sidecars are best-effort (up to eight); unavailable sidecars produce a warning without failing an otherwise valid video. HLS segmented subtitles are not included in the initial implementation.

The capacity includes staging/remux overhead. A job is limited to 20 GiB and six hours of content; a minimum 512 MiB free-disk reserve is enforced. Completed assets are not automatically evicted. Partial failed jobs restart from scratch on manual retry—changed signed URLs are never blindly concatenated.

Saved playback uses the same episode and history. Auto playback resolves the saved file first, without requesting the source site. Original-source playback remains selectable. Saved copies and in-progress requests prevent destructive source removal. Deleting an idle copy preserves the title, history and watchlist; playing copies cannot be deleted.

An update request stops the queue and interrupts the active job before handing control to the host updater. Interrupted jobs require manual retry after restart. Video blobs stay out of the data backup. Keep a separate backup if needed. Startup removes known abandoned partial directories but retains unknown completed files after metadata rollback; an administrator must inspect orphaned `job-*` directories rather than silently losing saved videos. Missing mounted storage retains asset metadata and reports an unavailable state.

To block new saves while keeping stored playback, set `MOA_DOWNLOADS_ENABLED=0` in the application environment and restart. Keep the storage mount. Existing saved videos and history are retained; restarting interrupts queued/active work without automatic retry.


The management list groups by the stored title ID rather than its name; identically named titles from different sources are not implicitly merged. List pages use a stable creation-time/ID cursor, so progress updates and deletion of a page boundary do not hide older jobs. The API supports filtering by `mediaId` for title-detail status. A selection acts on loaded entries, not unseen pages. Each deletion uses the same server-side active-playback and opening-session checks; a mixed result must retain and identify failed entries. Removing a saved copy never removes watch history or the title.


Management UI verification used 67 synthetic jobs with a reduced page size: loaded all pages, selected a 14-episode group, deleted 13 while retaining one protected copy and its error/selection, and checked the expanded layout at 390px width. Server regression checks separately cover more than 200 jobs, a deleted cursor boundary, status updates between pages, title filtering, and independent protected/successful removals. These checks do not delete any real saved video.


### Explicit enable and progress (after v0.1.2-beta.1)

The persistent `downloadEnabled` setting requires a separate administrator opt-in. Merely mounting storage, setting a quota, or setting `MOA_DOWNLOADS_ENABLED=1` does not turn it on. The environment value `0` is an upper-level prohibition that the web UI cannot override. Enabling requires usable storage and a positive quota; configuration updates are serialized and validated before saving.

Turning it off interrupts active and queued transfers without deleting completed files or viewing history. Re-enabling does not silently restart interrupted jobs. Existing saved playback and deletion remain available; title-page download controls are hidden while disabled. The settings entry remains visible so an administrator can configure the feature and manage existing copies.

The UI distinguishes initial request/queue/extraction/transfer/finalization/completion/failure. MP4 Content-Length supplies the known transfer total; HLS without a trustworthy total uses indeterminate progress and received bytes rather than an invented percentage. The normal per-item deletion and playback guards are unchanged.
