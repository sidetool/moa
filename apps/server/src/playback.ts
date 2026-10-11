import { playbackMediaType } from './tmdb.js';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat, readFile, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AudioTrack, ClientCapabilities, PlaybackSession, SubtitleTrack } from '@moa/shared';
import { Store } from './db.js';
import { Catalog } from './catalog.js';
import type { Config } from './config.js';
import { ApiFailure, command, hash, safePath } from './util.js';
import { isAss, isHdr, textSubtitle, videoStream, type Probe, type StreamInfo } from './probe.js';
import { SubtitleCache } from './subtitles.js';
import { vodInitialization } from './hls.js';
import type { OnlineSubtitles } from './online.js';
import type { Enrichment } from './enrichment.js';

export function playbackMode(file: string, probe: Probe, caps: ClientCapabilities, audio?: StreamInfo): PlaybackSession['mode'] {
  const video = videoStream(probe);
  const playable = video.codec_name === 'h264' && caps.h264 || video.codec_name === 'hevc' && caps.hevc || video.codec_name === 'av1' && caps.av1 || video.codec_name === 'vp9' && (caps.vp9 ?? true) || video.codec_name === 'vp8';
  const downscale = caps.maxHeight !== undefined && (video.height || 0) > caps.maxHeight;
  const webm = path.extname(file).toLowerCase() === '.webm';
  const mp4 = ['.mp4', '.m4v'].includes(path.extname(file).toLowerCase());
  const audioDirect = !audio || (caps.audioCodecs ?? (webm ? ['opus', 'vorbis'] : ['aac', 'mp3'])).includes(audio.codec_name || '');
  const containerVideo = webm ? ['vp8', 'vp9', 'av1'].includes(video.codec_name || '') : ['h264', 'hevc', 'av1', 'vp9'].includes(video.codec_name || '');
  const firstAudio = probe.streams.find(s => s.codec_type === 'audio');
  if (playable && !downscale && (mp4 || webm) && audioDirect && containerVideo && (!audio || audio.index === firstAudio?.index)) return 'direct';
  if (playable && !downscale && ['h264', 'hevc', 'av1', 'vp9'].includes(video.codec_name || '')) return 'remux';
  if (!caps.h264) throw new ApiFailure(422, 'h264-required-for-transcoding');
  return 'transcode';
}
interface Run {
  child: ChildProcess; start: number; end: number; dir: string; stderr: string; closed: boolean;
  code?: number | null; hardware: boolean; stopped: boolean; exit: Promise<void>;
  next: number; paused: boolean; monitor: Promise<void>;
  peakSpeed: number;
}
export interface Session {
  response: PlaybackSession; root: string; profile: string; file: string; probe: Probe; audio?: StreamInfo; caps: ClientCapabilities;
  touched: number; dir: string; timeline: number[]; hardware: boolean; run?: Run; generation: number;
  segments: Map<number, string>; lock: Promise<void>; deleted: boolean; cursor: number;
  init?: Buffer; maxAheadSeconds: number;
  subtitleSources: Map<string, { file: string; stream?: number; format: 'ass' | 'vtt'; onlineId?: string }>;
  fontSources: Map<string, number>;
}
export class Playback {
  sessions = new Map<string, Session>();
  active = new Set<Run>();
  subtitleCache: SubtitleCache;
  private janitor: NodeJS.Timeout;
  constructor(private db: Store, private catalog: Catalog, public config: Config, private log: (value: Record<string, unknown>) => void, private online?: OnlineSubtitles, private enrichment?: Enrichment) {
    this.subtitleCache = new SubtitleCache(config);
    this.janitor = setInterval(() => {
      for (const [id, s] of this.sessions) if (Date.now() - s.touched > config.sessionTtlMs) void this.remove(id).catch(error => this.log({ event: 'session-cleanup-error', error: String(error) }));
    }, 60_000); this.janitor.unref();
  }
  async create(profile: string, episodeId: string, caps: ClientCapabilities, audioTrackId?: string, startPosition?: number, saved?: {root:string;path:string;probe:string;subtitles:string;size:number;mtime:number}): Promise<PlaybackSession> {
    const record = saved ?? this.db.get('SELECT * FROM files WHERE episode_id=?', episodeId);
    const root = saved?.root ?? this.config.mediaRoot;
    if (!record) throw new ApiFailure(404, 'episode-not-found');
    const file = await safePath(root, record.path);
    const probe: Probe = JSON.parse(record.probe);
    const audioStreams = probe.streams.filter(s => s.codec_type === 'audio');
    const audio = audioTrackId !== undefined ? audioStreams.find(a => String(a.index) === audioTrackId) : audioStreams.find(a => a.disposition?.default) || audioStreams[0];
    if (audioTrackId !== undefined && !audio) throw new ApiFailure(400, 'audio-track-not-found');
    const mode = playbackMode(file, probe, caps, audio);
    const sessionId = randomUUID(), base = `/api/playback/${sessionId}`;
    const progress = this.db.get('SELECT * FROM progress WHERE profile_id=? AND episode_id=?', profile, episodeId);
    const position = Math.min(Math.max(0, startPosition ?? (progress && !progress.completed ? progress.position : 0)), Math.max(0, probe.duration - .01));
    const subtitleSources: Session['subtitleSources'] = new Map(), subtitles: SubtitleTrack[] = [];
    for (const [i, sub] of (JSON.parse(record.subtitles) as string[]).entries()) {
      const id = `external-${i}`, format = /\.(ass|ssa)$/i.test(sub) ? 'ass' : 'vtt';
      subtitleSources.set(id, { file: sub, format });
      const langMatch = path.basename(sub).match(/\.(ko|kor|en|eng|ja|jpn)(?:\.[^.]+)$/i);
      const lang = langMatch?.[1] || 'ko';
      subtitles.push({ id, label: `외부 자막 (${lang})`, lang, format, url: `${base}/subtitles/${id}.${format}`, default: i === 0, source: 'local' });
    }
    for (const sub of probe.streams.filter(s => s.codec_type === 'subtitle' && textSubtitle(s))) {
      const id = `embedded-${sub.index}`, format = isAss(sub) ? 'ass' : 'vtt';
      subtitleSources.set(id, { file, stream: sub.index, format });
      subtitles.push({ id, label: sub.tags?.title || sub.tags?.language || `자막 ${sub.index}`, lang: sub.tags?.language, format, url: `${base}/subtitles/${id}.${format}`, default: !subtitles.length && Boolean(sub.disposition?.default), embedded: true, source: 'embedded' });
    }
    const savedSubtitles = this.online?.saved(episodeId) || [];
    if (savedSubtitles.length) for (const track of subtitles) track.default = false;
    const onlineTracks: SubtitleTrack[] = [];
    for (const [i, row] of savedSubtitles.entries()) {
      subtitleSources.set(row.id, { file: '', format: row.format, onlineId: row.id });
      onlineTracks.push({ ...this.online!.track(row, `${base}/subtitles/${row.id}.${row.format}`), default: i === 0 });
    }
    subtitles.unshift(...onlineTracks);
    const fontSources: Session['fontSources'] = new Map();
    for (const font of probe.streams.filter(s => s.codec_type === 'attachment' && (/\.(ttf|otf|woff2?)$/i.test(s.tags?.filename || '') || ['ttf', 'otf'].includes(s.codec_name || '')))) fontSources.set(String(font.index), font.index);
    const episode = this.db.get('SELECT e.*,m.type,m.title AS media_title FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?', episodeId)!;
    const episodes = this.catalog.episodes(episode.media_id, profile), index = episodes.findIndex(e => e.id === episodeId);
    const next = episode.type === 'movie' ? undefined : episodes[index + 1];
    const audioTracks: AudioTrack[] = audioStreams.map(a => ({ id: String(a.index), label: a.tags?.title || `${a.tags?.language || '오디오'} · ${a.codec_name} ${a.channels || 0}ch`, lang: a.tags?.language, default: a.index === audio?.index }));
    const markers = await this.enrichment?.markers(episodeId);
    const response: PlaybackSession = { ...(saved ? {saved:true} : {}), sessionId, episodeId, mediaId: episode.media_id, mediaTitle: this.db.displayTitle(episode.media_id, episode.media_title, episode.season), mediaType: playbackMediaType(this.db, episode.media_id, episode.type),
      ...(episode.type !== 'movie' ? { episodeTitle: episode.title, episodeLabel: `S${episode.season}:E${episode.number}` } : {}),
      mode, url: mode === 'direct' ? `${base}/original` : `${base}/index.m3u8`, mime: mode === 'direct' ? path.extname(file).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4' : 'application/vnd.apple.mpegurl', duration: probe.duration, startPosition: position, subtitles, audioTracks,
      next: next ? { episodeId: next.id, title: next.title, label: `S${next.season}:E${next.number}`, thumb: next.thumb } : null,
      ...(fontSources.size ? { fonts: [...fontSources.keys()].map(id => `${base}/fonts/${id}`) } : {}),
      ...(markers ? { markers } : {}),
    };
    const timeline = mode === 'remux' ? await this.keyframes(file, probe, record) : Array.from({ length: Math.ceil(probe.duration / 2) }, (_, i) => i * 2);
    // Some containers end with a few milliseconds of audio after the last video frame.
    // Fold tiny tails into the preceding segment so every advertised segment has video.
    if (mode === 'transcode' && timeline.length > 1 && probe.duration - timeline.at(-1)! < .5) timeline.pop();
    const dir = path.join(this.config.dataDir, 'sessions', sessionId); await mkdir(dir, { recursive: true });
    const afterPosition = timeline.findIndex(t => t > position);
    const cursor = afterPosition < 0 ? timeline.length - 1 : Math.max(0, afterPosition - 1);
    this.sessions.set(sessionId, { response, root, profile, file, probe, audio, caps, touched: Date.now(), dir, timeline, hardware: this.db.settings(profile).hardwareTranscoding, generation: 0, segments: new Map(), lock: Promise.resolve(), deleted: false, cursor, maxAheadSeconds: 0, subtitleSources, fontSources });
    return response;
  }
  private async keyframes(file: string, probe: Probe, record: Record<string, any>): Promise<number[]> {
    const cache = path.join(this.config.dataDir, 'keyframes', `${hash(`v2:${file}:${record.size}:${record.mtime}`)}.json`);
    try { return JSON.parse(await readFile(cache, 'utf8')); } catch {}
    const packets = await command(this.config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
    const points = packets.split('\n').filter(line => line.includes('K')).map(line => Number(line.split(',')[0]) - (probe.startTime || 0)).filter(n => Number.isFinite(n) && n > .1 && n < probe.duration);
    const timeline = [0, ...new Set(points)];
    await mkdir(path.dirname(cache), { recursive: true }); await writeFile(cache, JSON.stringify(timeline)); return timeline;
  }
  get(id: string, profile?: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.deleted || Date.now() - s.touched > this.config.sessionTtlMs) { if (s) void this.remove(id).catch(error => this.log({ event: 'session-cleanup-error', error: String(error) })); throw new ApiFailure(404, 'session-expired'); }
    if (profile && profile !== s.profile) throw new ApiFailure(403, 'session-profile-mismatch');
    // Session URL is an unguessable bearer capability, so <video>/<track>/libass can use it without custom headers.
    s.touched = Date.now(); return s;
  }
  playlist(s: Session) {
    const lengths = s.timeline.map((t, i) => (s.timeline[i + 1] ?? s.probe.duration) - t);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(lengths.reduce((max, n) => Math.max(max, n), 0))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
    if (s.response.startPosition > 0) lines.push(`#EXT-X-START:TIME-OFFSET=${s.response.startPosition.toFixed(3)},PRECISE=YES`);
    for (const [i, length] of lengths.entries()) lines.push(`#EXTINF:${length.toFixed(6)},`, `seg-${i}.m4s`);
    return [...lines, '#EXT-X-ENDLIST', ''].join('\n');
  }
  private async stop(s: Session) {
    const run = s.run;
    if (run && !run.closed) { run.stopped = true; run.child.kill('SIGKILL'); await run.exit; }
    if (run) await run.monitor;
  }
  async remove(id: string) {
    const s = this.sessions.get(id); if (!s) return;
    s.deleted = true; this.sessions.delete(id); await this.stop(s);
    // Waiting requests check deleted and cannot launch another process.
    await s.lock.catch(() => {}); await rm(s.dir, { recursive: true, force: true });
  }
  async close() { clearInterval(this.janitor); await Promise.all([...this.sessions.keys()].map(id => this.remove(id))); await Promise.all([...this.active].map(run => run.exit)); }
  async initialization(s: Session): Promise<string> {
    if (!s.init) await this.segment(s, s.cursor);
    if (!s.init) throw new ApiFailure(502, 'hls-initialization-failed');
    return path.join(s.dir, 'init.mp4');
  }
  private async exclusive<T>(s: Session, action: () => Promise<T>): Promise<T> {
    const previous = s.lock; let release!: () => void;
    s.lock = new Promise<void>(resolve => { release = resolve; }); await previous;
    try { return await action(); } finally { release(); }
  }
  async segment(s: Session, index: number): Promise<string> {
    if (!Number.isInteger(index) || index < 0 || index >= s.timeline.length) throw new ApiFailure(404, 'segment-not-found');
    await this.exclusive(s, async () => {
      if (s.deleted) throw new ApiFailure(404, 'session-expired');
      await safePath(s.root, s.file);
      s.cursor = index;
      if (s.segments.has(index)) { this.throttle(s); return; }
      const run = s.run;
      const producedUntil = s.timeline[run?.next ?? index] ?? s.probe.duration;
      if (!run || run.closed || index < run.start || s.timeline[index] > producedUntil + 12) {
        await this.stop(s); await this.launch(s, index);
      }
      this.throttle(s);
    });
    const deadline = Date.now() + 45_000;
    let run = s.run!, retried = false;
    while (Date.now() < deadline) {
      if (s.deleted) throw new ApiFailure(404, 'session-expired');
      if (s.segments.has(index)) return s.segments.get(index)!;
      // An obsolete request must not restart the encoder over a newer seek.
      if (s.run !== run || run.stopped) throw new ApiFailure(409, 'segment-superseded');
      if (run.closed) {
        await run.monitor;
        if (s.segments.has(index)) return s.segments.get(index)!;
        if (run.hardware && !retried && !s.init) {
          await this.exclusive(s, async () => {
            if (s.deleted) throw new ApiFailure(404, 'session-expired');
            if (s.run !== run) return;
            this.log({ event: 'vaapi-fallback', sessionId: s.response.sessionId, stderr: run.stderr });
            s.hardware = false; retried = true; await this.launch(s, index);
          });
          run = s.run!; continue;
        }
        this.log({ event: 'ffmpeg-error', sessionId: s.response.sessionId, stderr: run.stderr });
        throw new ApiFailure(502, 'transcoding-failed');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (s.run === run) await this.stop(s);
    throw new ApiFailure(504, 'segment-timeout');
  }
  private throttle(s: Session) {
    const run = s.run;
    if (!run || run.closed || run.stopped) return;
    const ahead = (s.timeline[run.next] ?? s.probe.duration) - s.timeline[s.cursor];
    s.maxAheadSeconds = Math.max(s.maxAheadSeconds, ahead);
    if (ahead >= this.config.hlsAheadSeconds && !run.paused) {
      run.child.kill('SIGSTOP'); run.paused = true;
      this.log({ event: 'ffmpeg-throttle', sessionId: s.response.sessionId, aheadSeconds: ahead });
    } else if (run.paused && ahead < this.config.hlsAheadSeconds * .65) {
      run.child.kill('SIGCONT'); run.paused = false;
      this.log({ event: 'ffmpeg-resume', sessionId: s.response.sessionId, aheadSeconds: ahead });
    }
  }
  private async monitor(s: Session, run: Run) {
    try {
      do {
        await this.collect(s, run);
        if (!s.deleted && !run.stopped) {
          this.throttle(s);
          for (const [index, file] of s.segments) {
            if (s.timeline[index] < s.timeline[s.cursor] - this.config.hlsBackSeconds || s.timeline[index] > s.timeline[s.cursor] + this.config.hlsAheadSeconds + 30) {
              s.segments.delete(index); await rm(file, { force: true });
            }
          }
        }
        if (!run.closed) await new Promise(resolve => setTimeout(resolve, 50));
      } while (!run.closed);
      // close can arrive during an awaited stat/cleanup, between loop checks.
      // Always collect the finalized last fragment and merged audio tail.
      await this.collect(s, run);
    } catch (error) {
      run.stderr += `\nMonitor: ${error}`;
      run.child.kill('SIGKILL');
      this.log({ event: 'hls-monitor-error', error: String(error), sessionId: s.response.sessionId });
    }
  }
  private async collect(s: Session, run: Run) {
    if (s.deleted) return;
    while (run.next < run.end) {
      const n = run.next;
      const last = n === s.timeline.length - 1;
      if (last && !run.closed) return;
      const file = path.join(run.dir, `seg-${n}.m4s`);
      try {
        if ((await stat(file)).size > 0) {
          if (run.next === run.start) {
            const init = vodInitialization(await readFile(path.join(run.dir, 'init.mp4')), s.probe.duration);
            if (!s.init) {
              await writeFile(path.join(s.dir, 'init.mp4.tmp'), init);
              await rename(path.join(s.dir, 'init.mp4.tmp'), path.join(s.dir, 'init.mp4'));
              s.init = init;
            } else if (!s.init.equals(init)) {
              this.log({ event: 'hls-init-difference', sessionId: s.response.sessionId, generation: s.generation });
            }
          }
          let output = file;
          if (last) {
            // fMP4 segments can contain multiple moof/mdat fragments. Include any
            // final fragment emitted at the merged tail's original 2-second cut.
            const tail = path.join(run.dir, `seg-${n + 1}.m4s`);
            try {
              if ((await stat(tail)).size) { output = path.join(run.dir, `joined-${n}.m4s`); await writeFile(output, Buffer.concat([await readFile(file), await readFile(tail)])); }
            } catch {}
          }
          s.segments.set(n, output); run.next++;
        }
        else return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
  private async launch(s: Session, index: number) {
    if (s.deleted) throw new ApiFailure(404, 'session-expired');
    if (this.active.size >= this.config.maxTranscodes) throw new ApiFailure(429, 'transcoding-limit');
    const dir = path.join(s.dir, `run-${++s.generation}`); await mkdir(dir, { recursive: true });
    // Recheck after mkdir: two sessions can reach this point at the same time.
    if (s.deleted) throw new ApiFailure(404, 'session-expired');
    if (this.active.size >= this.config.maxTranscodes) throw new ApiFailure(429, 'transcoding-limit');
    const start = s.timeline[index], end = s.timeline.length, duration = s.probe.duration - start;
    const hardware = s.response.mode === 'transcode' && s.hardware;
    const video = videoStream(s.probe), maxHeight = Math.min(video.height || 1080, s.caps.maxHeight || video.height || 1080);
    const [num, den] = (video.avg_frame_rate || '24/1').split('/').map(Number);
    const fps = Math.max(1, Math.round(num / den || 24));
    const height = Math.max(2, Math.floor(maxHeight / 2) * 2), width = Math.max(2, Math.floor((video.width || 1920) * height / (video.height || 1080) / 2) * 2);
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', '-progress', 'pipe:1', '-stats_period', '0.5'];
    if (hardware) args.push('-init_hw_device', `vaapi=va:${this.config.vaapiDevice}`, '-filter_hw_device', 'va', '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
    // FFmpeg subtracts 3/23 seconds from a demuxer seek when video has B-frames.
    // Compensate that heuristic and retain pre-roll, preserving the source A/V timestamps.
    // https://github.com/FFmpeg/FFmpeg/blob/n7.1/fftools/ffmpeg_demux.c
    const seekPad = video.has_b_frames ? 3 / 23 + .001 : .001;
    if (s.response.mode === 'remux') args.push('-seek_timestamp', '1', '-noaccurate_seek');
    const seek = s.response.mode === 'remux' ? start + (s.probe.startTime || 0) + seekPad : start;
    args.push('-ss', seek.toFixed(6), '-i', s.file, '-t', duration.toFixed(6), '-map', `0:${video.index}`);
    if (s.audio) args.push('-map', `0:${s.audio.index}`);
    args.push('-sn', '-dn', '-map_metadata', '-1');
    if (s.response.mode === 'remux') args.push('-c:v', 'copy', ...(video.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : []));
    else {
      const tone = 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=nv12';
      let filter: string;
      if (hardware && !isHdr(s.probe)) filter = `scale_vaapi=w=${width}:h=${height}:format=nv12`;
      else if (hardware) filter = `hwdownload,format=p010le,${tone},scale=${width}:${height},hwupload`;
      else filter = `${isHdr(s.probe) ? `${tone},` : ''}scale=${width}:${height},format=yuv420p`;
      args.push('-vf', filter, '-c:v', hardware ? 'h264_vaapi' : 'libx264');
      if (!hardware) args.push('-preset', 'veryfast', '-crf', '22', '-threads', '4');
      else args.push('-async_depth', '8', '-rc_mode', 'VBR', '-b:v', height >= 1080 ? '6M' : '3M', '-maxrate', '10M', '-bufsize', '12M');
      // Integer CFR makes every forced GOP exactly 2s, including after an input seek.
      args.push('-r', String(fps), '-fps_mode', 'cfr');
      // CAVLC reduces software-client decode work; B-frames allow frame-threaded
      // decoding and ordinary VOD preroll without changing the 2-second GOP.
      args.push('-profile:v', 'high', '-coder', '0', '-bf', '2', '-g', String(Math.round(fps * 2)), '-keyint_min', String(Math.round(fps * 2)), '-force_key_frames', 'expr:gte(t,n_forced*2)');
      if (!hardware) args.push('-sc_threshold', '0');
      if (isHdr(s.probe)) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    }
    if (s.audio) {
      const supported = s.caps.audioCodecs ?? ['aac'];
      const copy = s.response.mode === 'remux' && supported.includes(s.audio.codec_name || '') && ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'].includes(s.audio.codec_name || '');
      if (copy) args.push('-c:a', 'copy', ...(s.audio.codec_name === 'flac' ? ['-strict', '-2'] : []));
      else {
        if (s.caps.audioCodecs && !supported.includes('aac')) throw new ApiFailure(422, 'aac-required-for-transcoding');
        // Matroska's millisecond AAC timestamps can leave tiny decoded gaps.
        // A continuous sample clock prevents Chromium audio-buffer underflows.
        args.push('-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k');
      }
    }
    const outputOffset = s.response.mode === 'remux' ? start + seekPad : start;
    // Keep the absolute decode time in each fragment instead of moving the seek
    // offset into init's edit list. This is the fMP4 option used by Jellyfin too.
    args.push('-output_ts_offset', outputOffset.toFixed(6), '-avoid_negative_ts', 'disabled', '-max_muxing_queue_size', '2048', '-f', 'hls', '-hls_time', s.response.mode === 'remux' ? '0.001' : '2', '-hls_segment_type', 'fmp4', '-hls_segment_options', 'movflags=+frag_discont', '-hls_fmp4_init_filename', 'init.mp4', '-start_number', String(index), '-hls_segment_filename', path.join(dir, 'seg-%d.m4s'), '-hls_flags', 'temp_file+independent_segments', '-hls_list_size', '0', '-hls_playlist_type', 'vod', path.join(dir, 'generated.m3u8'));
    const child = spawn(this.config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let exitResolve!: () => void;
    const exit = new Promise<void>(resolve => { exitResolve = resolve; });
    const run: Run = { child, start: index, end, dir, stderr: '', closed: false, hardware, stopped: false, exit, next: index, paused: false, monitor: Promise.resolve(), peakSpeed: 0 };
    s.run = run; this.active.add(run);
    child.stderr!.on('data', data => { run.stderr = (run.stderr + data).slice(-16_384); });
    let progress = '';
    child.stdout!.on('data', data => {
      progress += data;
      const lines = progress.split('\n'); progress = lines.pop()!;
      // FFmpeg's speed uses output timestamps, including the absolute seek offset.
      // Frame throughput measures actual work and cannot inflate distant-seek speed.
      for (const line of lines) if (line.startsWith('fps=')) {
        const speed = Number.parseFloat(line.slice(4)) / fps; if (Number.isFinite(speed)) run.peakSpeed = Math.max(run.peakSpeed, speed);
      }
    });
    const finish = (code: number | null) => {
      run.closed = true; run.code = code; this.active.delete(run); exitResolve();
      this.log({ event: 'ffmpeg-stop', sessionId: s.response.sessionId, generation: s.generation, code, peakSpeed: run.peakSpeed });
    };
    child.on('error', error => { run.stderr += String(error); finish(-1); });
    child.on('close', finish);
    run.monitor = this.monitor(s, run);
    this.log({ event: 'ffmpeg-start', sessionId: s.response.sessionId, mode: s.response.mode, encoder: hardware ? 'h264_vaapi' : s.response.mode === 'remux' ? 'copy' : 'libx264', position: start, pid: child.pid });
  }
}
