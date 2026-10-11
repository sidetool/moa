# Server video storage

Server saves require an online connection to MOA. This is not a PWA/device offline feature.

Compose mounts a dedicated `/downloads` volume, separate from `/data` (updater backups) and read-only `/media`. Optionally set `MOA_DOWNLOAD_PATH` to an absolute host folder before creating containers. The feature stays disabled until an administrator sets a capacity in Settings → Server storage. Do not reuse the media or data directory. Native installs set `MOA_DOWNLOAD_ROOT` to an existing writable directory.

Fresh release installations inherit this mount. The new updater preserves existing mounts and adds an empty dedicated volume when missing, without setting a quota. An older updater applying this release may preserve its old compose instead: in that case add the `/downloads` mount and `MOA_DOWNLOAD_ROOT=/downloads` once to the installation's active compose file, then recreate MOA with the same image. The next updater preserves that mount. No implicit relocation of existing media/data occurs.

Administrators choose a single episode/quality. One transfer runs at a time, up to eight queue entries. Tokens are short-lived and quality is re-resolved before starting. APK extraction leases are released after choices and reacquired/renewed only for the active transfer. Jobs never persist signed URLs or cookies. Cancel, failure, and server shutdown release workers.

Supported: finite HTTPS MP4, finite ordinary HLS, master variants with default audio, AES-128 HLS. Downloaded HLS is remuxed with codec copy. Source policies and per-source proxy apply to every upstream request; ffmpeg only sees local files. DRM/SAMPLE-AES, live, DASH, EDL, inline playlists, separate extension audio arrays and ambiguous quality matches are not supported for saving in this version. Playback support is unchanged. Some unusual HLS directives are rejected explicitly. External VTT/SRT/ASS sidecars are best-effort (up to eight); unavailable sidecars produce a warning without failing an otherwise valid video. HLS segmented subtitles are not included in the initial implementation.

The capacity includes staging/remux overhead. A job is limited to 20 GiB and six hours of content; a minimum 512 MiB free-disk reserve is enforced. Completed assets are not automatically evicted. Partial failed jobs restart from scratch on manual retry—changed signed URLs are never blindly concatenated.

Saved playback uses the same episode and history. Auto playback resolves the saved file first, without requesting the source site. Original-source playback remains selectable. Saved copies and in-progress requests prevent destructive source removal. Deleting an idle copy preserves the title, history and watchlist; playing copies cannot be deleted.

An update request stops the queue and interrupts the active job before handing control to the host updater. Interrupted jobs require manual retry after restart. Video blobs stay out of the data backup. Keep a separate backup if needed. Startup removes known abandoned partial directories but retains unknown completed files after metadata rollback; an administrator must inspect orphaned `job-*` directories rather than silently losing saved videos. Missing mounted storage retains asset metadata and reports an unavailable state.

To block new saves while keeping stored playback, set `MOA_DOWNLOADS_ENABLED=0` in the application environment and restart. Keep the storage mount. Existing saved videos and history are retained; restarting interrupts queued/active work without automatic retry.
