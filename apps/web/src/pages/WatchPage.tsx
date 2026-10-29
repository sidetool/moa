import { mergePlaybackMarkers } from '../player/playback/skip-markers';
import { nextUpTiming } from '../player/playback/next-up';
import { SeekPreview } from '../player/playback/SeekPreview';
import { SubtitleStyleControls } from '../features/settings/SubtitleStyleControls';
import { importSubtitleFile, exportSubtitle, SUBTITLE_FILES } from '../player/subtitles/subtitle-files';
import { PluginScripts, PluginTools } from '../features/plugins/WebsitePlugins';
import { CastButton } from '../player/casting/CastButton';
import type { CastMedia } from '../player/casting/cast';
import { checkSubtitleAlignment } from '../player/subtitles/subtitle-sync';
import { preparePlayback, retirePlayback } from '../player/playback/session-lifecycle';
import { subtitlesOffForTitle, rememberSubtitlesOff, subtitleOffsetForEpisode, rememberSubtitleOffset, subtitlePreference, rememberSubtitle, loadSubtitlePreference, restoreSubtitle } from "../player/subtitles/subtitle-preference";
import { enterFullscreen } from "../lib/playback-fullscreen";
import { documentPipSupported, useDocumentPip } from "../player/playback/document-pip";
import { useDevicePrefs, setDevicePref } from "../lib/device-prefs";
import { isRemoteMode, type RemotePlayerEvent } from "../lib/remote";
import { PlaybackSources } from '../features/settings/PlaybackSources';
import {
  ArrowLeft, Captions, Check, ChevronLeft, ChevronRight, CloudDownload, Download, FileUp, ExternalLink, FastForward, Pencil, Search, ListVideo, Maximize, Minimize, Pause, PictureInPicture2,
  House, Play, Rewind, RotateCcw, RotateCw, Settings, Shuffle, SkipForward, SlidersHorizontal, Volume1, Volume2, VolumeX, X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { MediaCard, Page, OnlineSubtitleQuery, OnlineSubtitleSearch, PlaybackSession, SubtitleTrack } from "@moa/shared";
import { keyboardShortcutKey, playerShortcutLabel, type PlayerShortcutAction } from '@moa/shared';
import { useMe, useMedia, useSettings, useSaveSettings } from "../api/queries";
import { useEpisodeDownload } from "../api/downloads";
import { cancelTranslationJob, coveredUntil, isTranslationTrack, savedTranslations, translationModeOf, untranslatedGap, useTranslationConfig, type TranslatedRange, type TranslationJob } from "../api/translation";
import { useSubtitleTranslation } from "../player/translation/subtitle-translation";
import { hasUnlabelledSiteSubtitle } from "../player/subtitles/subtitle-language";
import { useJimakuSearch } from "../player/translation/jimaku";
import { isKorean, TranslationEntry, TranslationOfferCard, TranslationView } from "../player/translation/TranslationPanel";
import { rememberAuto, useTranslationAutopilot } from "../player/translation/translation-autopilot";
import { trackName } from "../player/subtitles/track-name";
import { Stepper } from "../player/Stepper";
import { Artwork } from "../components/Artwork";
import { Button, ProgressBar, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";

const KIDS_RESTRICTED = "어린이 프로필에서는 볼 수 없는 작품이에요";
import { clock, cx, episodeTitle } from "../lib/format";
import { attach, detectCapabilities, compatibilityPlayback, setCompatibilityPlayback, SubtitleController, type EngineHandle } from "../player/playback/engine";
import { QualityControl, ServerControl, preferredHeight } from "../player/playback/QualityControl";

type Panel = null | "subs" | "settings" | "episodes";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_AFTER = 2600;
const VOLUME_KEY = "moa.volume";
/** Longest a newer translation revision waits for a quiet moment (no translated cue on screen). */
const REVISION_MAX_WAIT = 45_000;

/** Where the server reads the video: a ready saved copy first (auto), or the original source on request. */
type PlaybackLocation = "auto" | "source";
type Session = PlaybackSession & { saved?: boolean; resumeFromHistory?: boolean };

function useSession(episodeId: string, startOverride: number | null, initialLocation: PlaybackLocation, initialResume: boolean) {
  const [session, setSession] = useState<Session | null>(null);
  const [location, setLocation] = useState(initialLocation);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [streamId, setStreamId] = useState<string | undefined>();
  const [compatible, setCompatible] = useState(compatibilityPlayback);
  const [audioTrackId, setAudioTrackId] = useState<string | undefined>();
  const resumeAt = useRef<number | null>(startOverride);
  const initialSession = useRef(true);
  const failedStreams = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    let created: PlaybackSession | null = null;
    setError(null);
    preparePlayback(async () => {
      if (cancelled) return;
      const resumeFromHistory = initialSession.current && (resumeAt.current === null || initialResume);
      initialSession.current = false;
      const result = await api<Session>("/playback", {
        method: "POST",
        body: { episodeId, capabilities: detectCapabilities(compatible), audioTrackId, streamId, ...(location !== "auto" ? { location } : {}), ...(resumeAt.current !== null ? { startPosition: resumeAt.current } : {}) }
      });
      created = result;
      if (cancelled) await retirePlayback(result.sessionId, result.runtimeDependent);
      else setSession({ ...result, resumeFromHistory });
    }).catch(e => { if (!cancelled) setError(e instanceof ApiError && e.code === "permission-denied" ? "영상 보기 권한이 없어요. 관리자에게 문의해 주세요." : e instanceof ApiError && e.code === "kids-restricted" ? KIDS_RESTRICTED : e instanceof ApiError && e.code === "apk_playback_capacity" ? "다른 기기에서 재생 중입니다. 재생이 끝난 뒤 다시 시도해 주세요." : e instanceof ApiError && e.code === "no-streams" ? "소스에서 재생할 영상을 찾지 못했습니다." : e instanceof ApiError && ["unsupported-stream-format", "unsupported-inline-hls"].includes(e.code) ? "소스가 반환한 영상 형식을 지원하지 않습니다." : "재생을 준비하지 못했습니다."); });
    return () => {
      cancelled = true;
      if (created) void retirePlayback(created.sessionId, created.runtimeDependent);
    };
  }, [episodeId, audioTrackId, streamId, compatible, attempt, location]);

  const switchAudio = (id: string, at: number) => { failedStreams.current.clear(); resumeAt.current = at; setSession(null); setAudioTrackId(id); };
  const switchStream = (id: string, at: number) => { failedStreams.current.clear(); resumeAt.current = at; setSession(null); setStreamId(id); };
  const advanceStream = (at: number) => {
    if (!session?.streams?.length) return false;
    const current = session.streamId ?? '0';
    failedStreams.current.add(current);
    const index = session.streams.findIndex(stream => stream.id === current);
    // A preferred resolution can start in the middle. Visit earlier candidates too, once each.
    const candidates = [...session.streams.slice(index + 1), ...session.streams.slice(0, index)];
    const next = candidates.find(stream => !failedStreams.current.has(stream.id));
    if (!next) return false;
    resumeAt.current = at; setSession(null); setStreamId(next.id);
    return true;
  };
  const switchCompatibility = (value: boolean, at: number) => { failedStreams.current.clear(); resumeAt.current = at; setCompatibilityPlayback(value); setSession(null); setCompatible(value); };
  const retry = (at: number, recovering = false) => { if (!recovering) failedStreams.current.clear(); resumeAt.current = at; setSession(null); setAttempt(n => n + 1); };
  const switchLocation = (value: PlaybackLocation, at: number) => { failedStreams.current.clear(); resumeAt.current = at; setSession(null); setStreamId(undefined); setAudioTrackId(undefined); setLocation(value); };
  return { retry, session, error, switchAudio, audioTrackId, switchStream, advanceStream, compatible, switchCompatibility, location, switchLocation };
}

/** Page zoom never helps while watching and turns double-tap seeks into zoom toggles. */
const SKIP_VISIBLE_MS = 5000;
const NEXT_IDLE_MS = 5000;

function useNoPageZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    meta.content = `${original},maximum-scale=1,user-scalable=no`;
    return () => { meta.content = original; };
  }, []);
}

export function WatchPage() {
  useNoPageZoom();
  const { episodeId = "" } = useParams();
  const fullscreenHost = useRef<HTMLDivElement>(null);
  // A stable portal slot can move into a Document PiP window without remounting the player.
  const [slot] = useState(() => Object.assign(document.createElement("div"), { className: "watch-player-slot" }));
  useLayoutEffect(() => { if (slot.ownerDocument === document) fullscreenHost.current?.append(slot); }, [slot]);
  const pip = useDocumentPip(slot, fullscreenHost);
  // The fullscreen target survives episode changes; only playback state resets.
  return <div className="watch-fullscreen-host" ref={fullscreenHost}>{createPortal(<WatchPlayer key={episodeId} episodeId={episodeId} fullscreenHost={fullscreenHost} pip={pip} />, slot)}</div>;
}

function WatchPlayer({ episodeId, fullscreenHost, pip: documentPip }: { episodeId: string; fullscreenHost: RefObject<HTMLDivElement | null>; pip: ReturnType<typeof useDocumentPip> }) {
  const pipWindow = documentPip.pipWindow;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const settings = useSettings().data;
  const account = useMe().data;
  const admin = account?.role === "admin";
  const canAddSubtitles = admin || Boolean(account?.permissions?.includes('subtitles.add'));
  const canTranslate = admin || Boolean(account?.permissions?.includes('subtitles.translate'));
  const carried = useLocation().state as { subtitle?: SubtitleTrack } | null;
  const t = params.get("t");
  const { retry, session, error: sessionError, switchAudio, audioTrackId, switchStream, advanceStream, compatible, switchCompatibility, location: playbackLocation, switchLocation } = useSession(episodeId, t === null ? null : Number(t), params.get("location") === "source" ? "source" : "auto", params.get("resume") === "1");
  // Only asked when the viewer chose the source over a saved copy, to offer the way back.
  const savedCopy = useEpisodeDownload(episodeId, playbackLocation === "source").data?.saved;
  const changeLocation = (value: PlaybackLocation) => {
    setPanel(null);
    switchLocation(value, video.current?.currentTime || 0);
    setParams(old => { const next = new URLSearchParams(old); next.delete("t"); if (value === "source") next.set("location", "source"); else next.delete("location"); return next; }, { replace: true, state: carried });
  };
  const media = useMedia(session?.mediaId ?? "");

  const root = useRef<HTMLDivElement>(null);
  const active = () => (root.current?.ownerDocument ?? document).activeElement;
  // Remote or keyboard focus choosing a next-card button; a clicked or tapped button keeps focus but is not choosing.
  const choosingNext = () => {
    const el = active();
    if (!el?.closest(".next-card")) return false;
    if (isRemoteMode()) return true;
    try { return el.matches(":focus-visible"); } catch { return false; }
  };
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<EngineHandle | null>(null);
  const [airplayMedia, setAirplayMedia] = useState<CastMedia | null>(null);
  const subs = useRef<SubtitleController | null>(null);
  const hideTimer = useRef<number>(0);
  const nextHideTimer = useRef<number>(0);
  const nextPress = useRef<AbortController | null>(null);
  const lastSaved = useRef(0);
  const castProgress = useRef<{ position: number; duration: number } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [playFeedback, setPlayFeedback] = useState(false);
  const playFeedbackTimer = useRef(0);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<{ sessionId: string; seconds: number }>();
  const duration = mediaDuration?.sessionId === session?.sessionId ? mediaDuration?.seconds ?? 0 : 0;
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(VOLUME_KEY) ?? 1));
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanelState] = useState<Panel>(null);
  const [subsView, setSubsView] = useState<"main" | "style" | "search" | "translate">("main");
  const [subQuery, setSubQuery] = useState<OnlineSubtitleQuery | null>(null);
  const setPanel = (next: Panel) => { setPanelState(next); setSubsView("main"); };
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [sourcePicker,setSourcePicker] = useState(false);
  const runtimeRecoveries = useRef(0);
  const resumePlaying = useRef<boolean | null>(null);
  const failPlayback = useRef<(message:string)=>void>(()=>{});
  const [fatal, setFatal] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(carried?.subtitle ?? null);
  const [resumeChip, setResumeChip] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [nextCancelled, setNextCancelled] = useState(false);
  const resumeNextChecked = useRef(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ key: number; side: "left" | "right" | "center"; label: string } | null>(null);
  const prefs = useDevicePrefs();
  const shortcutLabel = (action: PlayerShortcutAction, label: string) => {
    const key = playerShortcutLabel(prefs.playerShortcuts[action]);
    return key ? `${label} (${key})` : label;
  };
  const step = prefs.seekStep;
  const [boost, setBoost] = useState(false);
  const [ended, setEnded] = useState(false);
  const [randomPending, setRandomPending] = useState(false);
  const [recommendation, setRecommendation] = useState<MediaCard | null>(null);
  const [endMessage, setEndMessage] = useState("");
  const randomRequest = useRef<AbortController | null>(null);
  useEffect(() => () => randomRequest.current?.abort(), []);
  const [levels, setLevels] = useState<Array<{ index: number; height: number }>>([]);
  const [level, setLevel] = useState(-1);
  const [playingHeight, setPlayingHeight] = useState(0);
  // Settings may arrive after attach; the engine applies a late default unless the viewer already picked one.
  const defaultHeight = preferredHeight(settings?.preferredQuality);
  const defaultHeightRef = useRef(defaultHeight);
  defaultHeightRef.current = defaultHeight;
  useEffect(() => {
    const handle = engine.current;
    if (!handle) return;
    handle.setPreferredHeight(defaultHeight);
    setLevel(handle.level());
  }, [defaultHeight]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // HLS switches variants mid-play; the element reports each new frame size with "resize".
    const update = () => setPlayingHeight(v.videoHeight);
    update();
    for (const event of ["loadedmetadata", "resize", "emptied"]) v.addEventListener(event, update);
    return () => { for (const event of ["loadedmetadata", "resize", "emptied"]) v.removeEventListener(event, update); };
  }, [session]);
  const [manualSubOffset, setSubOffset] = useState(0);
  const [autoAlignment, setAutoAlignment] = useState<{key:string;offset:number} | null>(null);
  const alignmentKey = `${session?.sessionId}:${subtitle?.id}`;
  const autoSubOffset = settings?.experimentalSubtitleSync && autoAlignment?.key === alignmentKey ? autoAlignment.offset : 0;
  const manualSyncChoice = useRef(false);
  const subOffset = manualSyncChoice.current || manualSubOffset !== 0 ? manualSubOffset : autoSubOffset;
  const subOffsetRef = useRef(0);
  const saveSettings = useSaveSettings();
  const subSize = settings?.subtitleSize ?? 'medium';
  const subHeight = settings?.subtitleHeight ?? 0;
  const subBackground = settings?.subtitleBackground ?? 'original';
  const subShadow = settings?.subtitleShadow ?? 'original';
  const subOutline = settings?.subtitleOutline ?? 'original';
  const subScale = settings?.subtitleScale ?? undefined;
  const subPadding = settings?.subtitlePadding ?? 6;
  const subPreserveAss = settings?.subtitlePreserveAss === true;
  const originalSubAppearance = (subScale === undefined ? subSize === 'medium' : subScale === 100) && subBackground === 'original' && subShadow === 'original' && subOutline === 'original' && subHeight === 0;
  useEffect(() => { subs.current?.setHeight(subHeight); }, [subHeight, subtitle, session]);
  useEffect(() => { void subs.current?.setAppearance({ size: subSize, background: airplayMedia ? 'original' : subBackground, shadow: airplayMedia ? 'original' : subShadow, outline: airplayMedia ? 'original' : subOutline, scale: subScale, padding: subPadding, preserveAss: subPreserveAss }).catch(() => {}); }, [subSize, subBackground, subShadow, subOutline, subScale, subPadding, subPreserveAss, subtitle, session, airplayMedia]);
  const [extraSubs, setExtraSubs] = useState<SubtitleTrack[]>(carried?.subtitle ? [carried.subtitle] : []);
  const [importing, setImporting] = useState(false);
  const [draggingSubtitle, setDraggingSubtitle] = useState(false);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { uploadAbort.current?.abort(); }, []);
  const [online, setOnline] = useState<{ status: "idle" | "searching" | "done" | "error"; result?: OnlineSubtitleSearch; applying?: string }>({ status: "idle" });
  const [notice, setNotice] = useState<string | { text: string; action: { label: string; run: () => void } } | null>(null);
  const onlineAbort = useRef<AbortController | null>(null);
  const applyAbort = useRef<AbortController | null>(null);
  const subtitleChoice = useRef(carried?.subtitle ? 1 : 0);
  const [subtitlesReady, setSubtitlesReady] = useState<string | null>(null);
  const saveSubtitle = (...args: Parameters<typeof rememberSubtitle>) => { void rememberSubtitle(...args).catch(() => setNotice("자막 선택을 서버에 저장하지 못했어요. 다시 선택해 주세요.")); };

  useEffect(()=>{if(sourcePicker) video.current?.pause();},[sourcePicker]);
  const live = session?.live || false;
  const total = live ? 0 : Number.isFinite(duration) && duration > 0 ? duration : session?.duration || 0;
  const titleLine = session ? [session.mediaTitle, session.episodeLabel && `${session.episodeLabel}${session.episodeTitle ? ` ${episodeTitle(session.episodeTitle)}` : ""}`].filter(Boolean) : [];

  /* ---------- progress ---------- */
  const saveProgress = useCallback((keepalive = false, v = video.current) => {
    const position = castProgress.current?.position ?? v?.currentTime, duration = castProgress.current?.duration ?? v?.duration;
    if (!session || session.live || position === undefined || !Number.isFinite(duration) || !duration || position < 1) return;
    lastSaved.current = position;
    void api("/progress", { method: "POST", body: { episodeId: session.episodeId, position, duration }, keepalive }).then(() => {
      // Periodic saves mark caches stale; final saves also refresh screens already mounted after exit.
      void client.invalidateQueries({ queryKey: ["home"], refetchType: keepalive ? "active" : "none" });
      void client.invalidateQueries({ queryKey: ["recommendations"], refetchType: "none" });
      void client.invalidateQueries({ queryKey: ["history"], refetchType: keepalive ? "active" : "none" });
      void client.invalidateQueries({ queryKey: ["media", session.mediaId], refetchType: keepalive ? "active" : "none" });
    }).catch(() => {});
  }, [session, client]);

  /* ---------- attach ---------- */
  useEffect(() => {
    const v = video.current;
    if (!session || !v) return;
    setAirplayMedia(null);
    castProgress.current = null;
    let disposed = false;
    let advancedStream = false;
    window.clearTimeout(nextHideTimer.current); nextPress.current?.abort();
    setFatal(null); setEnded(false); setNextDismissed(false); setNextCancelled(false); setCountdown(null); setWaiting(true);

    const start = session.startPosition;
    // Home resume links carry ?t= too; an explicit positive position still offers restart.
    setResumeChip(!session.live && start > 30);
    const onFailure = (message:string) => {
      if (disposed || advancedStream) return;
      if (session.runtimeDependent && runtimeRecoveries.current < 1) {
        advancedStream = true; runtimeRecoveries.current++;
        resumePlaying.current = v.readyState === 0 || !v.paused;
        setNotice("재생 연결을 복구하고 있습니다.");
        retry(session.live ? 0 : v.currentTime || start, true);
        return;
      }
      if (advanceStream(session.live ? 0 : v.currentTime || start)) {
        advancedStream = true;
        setNotice("다른 재생 서버에 연결하고 있습니다.");
      } else setFatal(message);
    };
    failPlayback.current = onFailure;
    setLevels([]); setLevel(-1);
    attach(v, session, start, onFailure, false, { preferredHeight: defaultHeightRef.current }).then(handle => {
      if (disposed) { handle.destroy(); return; }
      engine.current = handle;
      handle.setPreferredHeight(defaultHeightRef.current);
      v.volume = volume;
      v.playbackRate = speed;
      const shouldPlay = resumePlaying.current !== false; resumePlaying.current = null;
      if (shouldPlay) v.play().catch(() => setPlaying(false)); else setPlaying(false);
    }).catch(() => { if(!disposed) onFailure("이 영상을 재생하지 못했습니다."); });
    subs.current = new SubtitleController(v, session.fonts);
    subs.current.setHeight(subHeight);
    void subs.current.setAppearance({size:subSize,background:subBackground,shadow:subShadow,outline:subOutline,scale:subScale,padding:subPadding}).catch(()=>{});
    return () => {
      disposed = true;
      failPlayback.current = ()=>{};
      saveProgress(true, v);
      engine.current?.destroy();
      engine.current = null;
      subs.current?.destroy();
      subs.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session?.runtimeDependent) return;
    let disposed = false, pending = false;
    const abort = new AbortController();
    const heartbeat = async () => {
      if (disposed || pending) return;
      pending = true;
      try { await api(`/playback/${session.sessionId}/heartbeat`, { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) }); }
      catch (error) {
        if (!disposed && error instanceof ApiError && ['session-expired','playback-restart-required'].includes(error.code))
          failPlayback.current('재생 연결이 만료되었습니다. 다시 연결해 주세요.');
      } finally { pending = false; }
    };
    const visible = () => { if (!document.hidden) void heartbeat(); };
    const leaving = (event: PageTransitionEvent) => { if (!event.persisted) void retirePlayback(session.sessionId, session.runtimeDependent); };
    void heartbeat(); const timer = window.setInterval(() => void heartbeat(), 30_000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible); window.addEventListener('pageshow', visible); window.addEventListener('pagehide', leaving);
    return () => {
      disposed = true; abort.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible); window.removeEventListener('pageshow', visible); window.removeEventListener('pagehide', leaving);
    };
  }, [session]);

  useEffect(() => {
    if (!session || !settings) return;
    const controller = new AbortController(), choice = subtitleChoice.current;
    void loadSubtitlePreference(episodeId, controller.signal, settings.defaultSubtitleLang !== 'off').then(async remembered => {
      if (controller.signal.aborted || subtitleChoice.current !== choice) return;
      rememberSubtitlesOff(session.mediaId, remembered === null);
      if (remembered !== undefined) {
        if (remembered === null) { subtitleChoice.current ||= 1; setSubtitle(null); return; }
        const track = await restoreSubtitle(episodeId, session.subtitles, remembered, controller.signal);
        if (controller.signal.aborted || subtitleChoice.current !== choice) return;
        if (track) {
          subtitleChoice.current ||= 1;
          setExtraSubs(list => [...list.filter(item => item.id !== track.id), track]);
          setSubtitle(track);
          setNotice(null);
          return;
        }
        setNotice("이전에 사용한 자막이 없어졌어요.");
      }
      if (subtitleChoice.current || isTranslationTrack(subtitle) || subtitle?.source === 'upload') {
        setSubtitle(current => current ? session.subtitles.find(track => track.id === current.id) ?? (current.provenance || isTranslationTrack(current) || current.source === 'upload' ? current : null) : null);
        return;
      }
      const preferred = settings.defaultSubtitleLang;
      const own = session.subtitles.filter(track => !isTranslationTrack(track));
      setSubtitle(preferred === "off" ? null
        : own.find(track => track.lang === preferred) ?? own.find(track => track.default) ?? own[0] ?? null);
    }).catch(() => { if (!controller.signal.aborted) setNotice("이전에 사용한 자막을 불러오지 못했어요. 다시 선택해 주세요."); })
      .finally(() => { if (!controller.signal.aborted) setSubtitlesReady(session.sessionId); });
    return () => controller.abort();
  }, [session, Boolean(settings)]);

  useLayoutEffect(() => {
    const saved = subtitleOffsetForEpisode(episodeId);
    manualSyncChoice.current = saved !== undefined;
    subOffsetRef.current = saved ?? 0; setSubOffset(saved ?? 0);
    subs.current?.setOffset(saved ?? 0);
  }, [episodeId]);

  useLayoutEffect(() => {
    subOffsetRef.current = subOffset;
    subs.current?.setOffset(airplayMedia ? 0 : subOffset);
  }, [subOffset, session, airplayMedia]);

  useEffect(() => {
    setAutoAlignment(null);
    if (!session || !subtitle || !settings?.experimentalSubtitleSync || manualSyncChoice.current || manualSubOffset !== 0) return;
    const stop = new AbortController(), choice = subtitleChoice.current;
    void checkSubtitleAlignment(subtitle, session.subtitles, stop.signal).then(result => {
      if (stop.signal.aborted || subtitleChoice.current !== choice || manualSyncChoice.current) return;
      if (result.status === 'aligned') setAutoAlignment({key:alignmentKey,offset:result.offsetSeconds});
      else if (result.status === 'mismatch' && choice === 0) {
        // A weak timing match vetoes automatic selection only; the track remains available manually.
        setSubtitle(session.subtitles.find(t => t.source !== 'online' && !isTranslationTrack(t)) ?? null);
      }
    });
    return () => stop.abort();
  }, [session, subtitle, settings?.experimentalSubtitleSync, manualSubOffset, alignmentKey]);

  const shownTrack = useRef<{ controller: SubtitleController | null; track: SubtitleTrack | null }>({ controller: null, track: null });
  useEffect(() => {
    const controller = subs.current;
    const track: SubtitleTrack | null = airplayMedia ? airplayMedia.subtitle ? { id: 'cast-caption', format: 'vtt', ...airplayMedia.subtitle } : null : subtitle;
    let cancelled = false;
    const previous = shownTrack.current;
    shownTrack.current = { controller, track };
    // A newer revision of the same track (live AI translation) is swapped in place instead of reloaded.
    const revision = Boolean(controller && track && previous.controller === controller && previous.track?.id === track.id);
    if (revision && previous.track!.url === track!.url) return;
    const load = revision ? controller!.replace(track!).catch(() => controller!.show(track)) : controller?.show(track);
    void load?.then(() => {
      if (!cancelled) controller!.setOffset(airplayMedia ? 0 : subOffsetRef.current);
    }).catch(() => { if (!cancelled) setNotice("자막을 불러오지 못했습니다. 다른 자막을 선택해 주세요."); });
    return () => { cancelled = true; };
  }, [subtitle, session, airplayMedia]);

  useEffect(() => {
    if(!session?.streams?.length || !waiting || fatal) return;
    const timer=window.setInterval(()=>{const v=video.current;if(v && !document.hidden && (!v.paused || v.readyState===0)) failPlayback.current('영상 응답이 지연되고 있습니다. 다시 연결해 주세요.');},45_000);
    return ()=>clearInterval(timer);
  },[session,waiting,fatal]);

  /* ---------- online Korean subtitles ---------- */
  const allSubs = useMemo(() => {
    const list = session?.subtitles ?? [];
    return [...list, ...extraSubs.filter(extra => !list.some(track => track.id === extra.id))];
  }, [session, extraSubs]);
  const searchOnline = useCallback(async (manual?: OnlineSubtitleQuery, refresh = false) => {
    if (!session) return null;
    onlineAbort.current?.abort();
    const controller = new AbortController();
    onlineAbort.current = controller;
    setOnline({ status: "searching" });
    try {
      const params = manual ? `?${new URLSearchParams({ title: manual.title.trim(), season: String(manual.season), episode: String(manual.episode), episodeOffset: String(manual.episodeOffset) })}` : refresh ? "?refresh=true" : "";
      const result = await api<OnlineSubtitleSearch>(`/episodes/${encodeURIComponent(session.episodeId)}/subtitles/online${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      setOnline({ status: "done", result });
      return result;
    } catch {
      if (!controller.signal.aborted) setOnline({ status: "error" });
      return null;
    }
  }, [session]);
  const applyOnline = useCallback(async (result: OnlineSubtitleSearch, candidateId: string, quiet = false, choice = subtitleChoice.current) => {
    if (!session) return;
    if (quiet && subtitleChoice.current !== choice) return;
    if (!quiet) choice = ++subtitleChoice.current;
    applyAbort.current?.abort();
    const controller = new AbortController();
    applyAbort.current = controller;
    setOnline(state => ({ ...state, applying: candidateId }));
    try {
      const track = await api<SubtitleTrack>(`/episodes/${encodeURIComponent(session.episodeId)}/subtitles/online`, { method: "POST", body: { searchId: result.searchId, candidateId }, signal: controller.signal });
      if (controller.signal.aborted || subtitleChoice.current !== choice) return;
      if (quiet && settings?.experimentalSubtitleSync) {
        const alignment = await checkSubtitleAlignment(track, session.subtitles, controller.signal);
        if (controller.signal.aborted || subtitleChoice.current !== choice) return;
        if (alignment.status === 'mismatch') return;
      }
      setExtraSubs(list => [...list.filter(item => item.id !== track.id), track]);
      setSubtitle(track);
      saveSubtitle(session.episodeId, track);
      if (!quiet) rememberSubtitlesOff(session.mediaId, false);
      const who = track.provenance?.creatorName ?? result.candidates.find(item => item.id === candidateId)?.creatorName;
      setNotice(quiet ? `${who ? `${who} 님의 ` : ""}한국어 자막을 찾아 적용했어요` : null);
    } catch {
      if (!controller.signal.aborted) setNotice("자막을 적용하지 못했습니다");
    } finally {
      if (applyAbort.current === controller) setOnline(state => ({ ...state, applying: undefined }));
    }
  }, [session, settings?.experimentalSubtitleSync]);

  useEffect(() => {
    // Translations belong to the episode, not the playback session, so they survive audio/stream switches.
    setExtraSubs(list => list.filter(track => isTranslationTrack(track) || track.source === 'upload')); setOnline({ status: "idle" }); setNotice(null);
    return () => { onlineAbort.current?.abort(); applyAbort.current?.abort(); };
  }, [session]);

  // Translation modes wait for the online Korean search to finish (found and applied, or not).
  const [onlineSettled, setOnlineSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!session || !settings || !account || subtitlesReady !== session.sessionId) return;
    const settle = () => setOnlineSettled(session.sessionId);
    if (!canAddSubtitles || session.mediaType !== "anime" || !settings.autoFetchSubtitles || settings.defaultSubtitleLang === "off") return settle();
    if (subtitleChoice.current || subtitlesOffForTitle(session.mediaId)) return settle();
    if (session.subtitles.some(track => isKorean(track) || ['upload', 'online', 'translation'].includes(track.source ?? '')) || (settings.skipSubtitleSearchWithSiteTrack !== false && hasUnlabelledSiteSubtitle(session.subtitles))) return settle();
    let cancelled = false;
    const choice = subtitleChoice.current;
    setOnlineSettled(null);
    void searchOnline().then(async result => {
      const best = result?.candidates.slice().sort((a, b) => b.confidence - a.confidence)[0];
      if (!cancelled && result && result.autoApply !== false && best && best.confidence >= 0.5) await applyOnline(result, best.id, true, choice);
    }).finally(() => { if (!cancelled) settle(); });
    return () => { cancelled = true; onlineAbort.current?.abort(); };
  }, [session, subtitlesReady, Boolean(account), canAddSubtitles, settings?.autoFetchSubtitles, settings?.defaultSubtitleLang, settings?.skipSubtitleSearchWithSiteTrack, searchOnline, applyOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- AI translation ---------- */
  const translationConfig = useTranslationConfig().data;
  const translationEnabled = canTranslate && Boolean(translationConfig?.configured && translationConfig.enabled);
  // Choice counter when a translation started; null for a job resumed from an earlier visit, -1 once the viewer moved on.
  const translationChoice = useRef<number | null>(null);
  // The live revision on screen (its translated cue times) and a newer one waiting for a quiet moment.
  const liveShown = useRef<{ id: string; ranges: TranslatedRange[] } | null>(null);
  const pendingRevision = useRef<{ track: SubtitleTrack; ranges: TranslatedRange[]; since: number } | null>(null);
  const showTranslated = (track: SubtitleTrack) => {
    if (session) { rememberSubtitlesOff(session.mediaId, false); saveSubtitle(session.episodeId, track); }
    applyAbort.current?.abort();
    setSubtitle(track);
  };
  /** Swap in a waiting revision when no translated cue of the current one can be on screen (or it waited too long). */
  const swapRevision = () => {
    const next = pendingRevision.current, v = video.current;
    if (!next) return;
    const shown = liveShown.current;
    const quiet = !shown || !v || v.paused || coveredUntil(shown.ranges, v.currentTime) === null;
    if (!quiet && Date.now() - next.since < REVISION_MAX_WAIT) return;
    pendingRevision.current = null;
    liveShown.current = { id: next.track.id, ranges: next.ranges };
    setSubtitle(current => current?.id === next.track.id ? next.track : current);
  };
  const onTranslationTrack = (track: SubtitleTrack, job: TranslationJob) => {
    if (!job.partial) setCompleteTranslations(ids => ids.has(track.id) ? ids : new Set(ids).add(track.id));
    setExtraSubs(list => list.some(item => item.id === track.id) ? list.map(item => item.id === track.id ? track : item) : [...list, track]);
    const final = job.state === "completed";
    if (subtitle?.id === track.id) {
      // Already on screen: newer cues arrive without taking over anything else.
      pendingRevision.current = { track, ranges: job.translatedRanges, since: Date.now() };
      swapRevision();
      if (final && !job.cached) setNotice("AI 번역을 마쳤어요");
      return;
    }
    const startedAt = translationChoice.current;
    // Apply only if the viewer has not picked another subtitle (or turned them off) since the translation started.
    const untouched = startedAt === -1 ? false : startedAt !== null ? subtitleChoice.current === startedAt : subtitleChoice.current === 0 && !(session && subtitlesOffForTitle(session.mediaId));
    if (untouched && (job.state === "running" || job.state === "queued" || final)) {
      liveShown.current = { id: track.id, ranges: job.translatedRanges };
      pendingRevision.current = null;
      showTranslated(track);
      if (final) setNotice(`AI 번역 자막을 적용했어요${job.cached ? " · 저장된 번역" : ""}`);
    } else {
      translationChoice.current = -1;
      if (final) setNotice({ text: "한국어 AI 번역이 끝났어요", action: { label: "적용", run: () => chooseSubtitle(track) } });
    }
  };
  const translation = useSubtitleTranslation(episodeId, onTranslationTrack);
  const jimaku = useJimakuSearch(episodeId);
  const startTranslation = (source: Parameters<typeof translation.start>[0], origin: "manual" | "auto" = "manual") => {
    if (!canTranslate) return Promise.resolve();
    translationChoice.current = origin === "auto" ? subtitleChoice.current : ++subtitleChoice.current;
    const v = video.current;
    return translation.start(source, { origin, startAt: v && !live ? v.currentTime || session?.startPosition || 0 : 0 });
  };
  const cancelTranslation = () => {
    // A cancelled episode is never restarted automatically in this tab.
    rememberAuto(episodeId, "cancelled");
    pendingRevision.current = null;
    return translation.cancel();
  };
  const liveJob = translation.state.status === "active" ? translation.state.job : null;
  const autoJob = (translation.state.status === "active" || translation.state.status === "reading") && translation.state.origin === "auto";
  // Leaving the episode stops a translation the player started on its own; partial cues stay cached for next time.
  const handingOff = useRef(false);
  const leaving = useRef({ autoJob, jobId: liveJob?.id, forget: translation.forget });
  leaving.current = { autoJob, jobId: liveJob?.id, forget: translation.forget };
  useEffect(() => () => {
    const { autoJob, jobId, forget } = leaving.current;
    if (!autoJob || !jobId || handingOff.current) return;
    forget();
    rememberAuto(episodeId, "started");
    void cancelTranslationJob(jobId, true).catch(() => {});
  }, [episodeId]);

  // Saved translations: listed always; reused automatically only by the ask/auto modes below.
  // Only finished translations may be reused: the saved list (server returns complete ones only) and jobs with
  // partial=false. Partial tracks left after a failure or cancel are listed but never reused automatically.
  const [completeTranslations, setCompleteTranslations] = useState<Set<string>>(() => new Set());
  const [savedLoaded, setSavedLoaded] = useState(false);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void savedTranslations(session.episodeId, controller.signal).then(tracks => {
      if (!controller.signal.aborted && tracks.length) setCompleteTranslations(ids => new Set([...ids, ...tracks.map(track => track.id)]));
      if (!controller.signal.aborted && tracks.length) setExtraSubs(list => [...list.filter(item => !tracks.some(track => track.id === item.id)), ...tracks]);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setSavedLoaded(true); });
    return () => controller.abort();
  }, [session?.episodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const translationMode = translationModeOf(settings);
  const ownTracks = useMemo(() => session?.subtitles.filter(track => !isTranslationTrack(track)) ?? [], [session]);
  const savedTrack = useMemo(() => allSubs.find(track => isTranslationTrack(track) && completeTranslations.has(track.id)) ?? null, [allSubs, completeTranslations]);
  const autopilot = useTranslationAutopilot({
    episodeId,
    mode: translationMode,
    sourcePriority: settings?.translationSourcePriority ?? "site",
    enabled: translationEnabled,
    ready: Boolean(session && subtitlesReady === session.sessionId && !session.live && settings && translationConfig && savedLoaded && onlineSettled === session.sessionId),
    // No separate track can mean burned-in subtitles; this guard also prevents a Jimaku offer/search.
    // Manual translation remains available through TranslationView.
    skip: !settings || settings.defaultSubtitleLang !== "ko" || Boolean(session && subtitlesOffForTitle(session.mediaId))
      || (settings.skipSubtitleSearchWithSiteTrack !== false && hasUnlabelledSiteSubtitle(ownTracks))
      || (settings.skipTranslationWithoutSubtitles !== false && ownTracks.length === 0),
    hasKorean: ownTracks.some(isKorean) || Boolean(subtitle && isKorean(subtitle)),
    saved: savedTrack,
    tracks: ownTracks,
    current: subtitle,
    userChose: subtitleChoice.current !== 0,
    busy: translation.busy,
    jimaku: jimaku.state,
    searchJimaku: () => void jimaku.search(),
    start: (source, origin) => {
      void startTranslation(source, origin);
      if (origin === "auto") setNotice({ text: `한국어 자막이 없어 ${source.label} 자막을 AI로 번역하고 있어요`, action: { label: "취소", run: () => void cancelTranslation() } });
    },
    useSaved: track => { showTranslated(track); setNotice("저장된 AI 번역 자막을 적용했어요"); }
  });
  // A suggestion steps aside after a while; the subtitle menu keeps offering translation.
  useEffect(() => {
    if (!autopilot.offer) return;
    let timer = 0;
    const expire = () => {
      if (root.current?.querySelector(".translate-offer:focus-within")) timer = window.setTimeout(expire, 25_000);
      else autopilot.hide();
    };
    timer = window.setTimeout(expire, 25_000);
    return () => clearTimeout(timer);
  }, [autopilot.offer, autopilot.hide]);
  // Pending revision / "translating here" hint while the live track is on screen.
  const showingLive = Boolean(liveJob?.track && subtitle?.id === liveJob.track.id);
  const translatingHere = showingLive && !live && untranslatedGap(liveJob!.translatedRanges, time, total);

  const chooseSubtitle = (track: SubtitleTrack | null) => {
    if (session) { rememberSubtitlesOff(session.mediaId, !track); saveSubtitle(session.episodeId, track); }
    subtitleChoice.current++;
    applyAbort.current?.abort();
    setOnline(state => ({ ...state, applying: undefined }));
    setNotice(null);
    pendingRevision.current = null;
    const live = translation.state.status === "active" ? translation.state.job : null;
    liveShown.current = track && live?.track?.id === track.id ? { id: track.id, ranges: live.translatedRanges } : null;
    setSubtitle(track && live?.track?.id === track.id ? live.track : track);
    // Turning subtitles off also stops a translation the player started on its own (it would only cost money).
    if (!track && autoJob) { void cancelTranslation(); setNotice("자막을 꺼서 자동 번역을 멈췄어요"); }
  };

  const addSubtitleFiles = async (files: File[], showMenu = true): Promise<boolean> => {
    if (!files.length || !canAddSubtitles) return false;
    const choice = ++subtitleChoice.current;
    uploadAbort.current?.abort();
    applyAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    const tracks: SubtitleTrack[] = [];
    setImporting(true);
    setNotice(null);
    try {
      if (files.length > 32) throw new Error('자막 파일은 한 번에 32개까지 선택해 주세요.');
      for (const file of files) {
        const imported = await importSubtitleFile(file, episodeId, controller.signal);
        tracks.push(...imported);
        if (tracks.length > 32) throw new Error('자막은 한 번에 32개까지 가져올 수 있어요.');
      }
      controller.signal.throwIfAborted();
      setExtraSubs(list => [...list.filter(item => !tracks.some(track => track.id === item.id)), ...tracks]);
      if (tracks.length === 1 && subtitleChoice.current === choice) chooseSubtitle(tracks[0]);
      else setNotice('가져온 자막 중 사용할 파일을 선택해 주세요.');
      if (showMenu) setPanel('subs');
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : '자막 파일을 읽지 못했어요.');
      return false;
    } finally { if (!controller.signal.aborted) setImporting(false); }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const nudgeSubs = (delta: number) => {
    manualSyncChoice.current = true;
    setAutoAlignment(null);
    const next = Math.max(-600, Math.min(600, Math.round((subOffset + delta) * 10) / 10));
    setSubOffset(next); subOffsetRef.current = next;
    subs.current?.setOffset(next);
    rememberSubtitleOffset(episodeId, next);
    return next;
  };

  useEffect(() => {
    if (!resumeChip) return;
    const timer = setTimeout(() => setResumeChip(false), 5000);
    return () => clearTimeout(timer);
  }, [resumeChip]);

  useEffect(() => {
    const onHide = () => saveProgress(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [saveProgress]);

  /* ---------- chrome visibility ---------- */
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // Hidden controls take the card out of remote navigation, so they stay while a card button is being chosen.
      if (!video.current?.paused && !root.current?.querySelector(".player-panel, dialog[open]") && !choosingNext()) {
        if (isRemoteMode() && root.current?.contains(active()) && !active()?.closest(".translate-offer")) (active() as HTMLElement).blur();
        setChrome(false);
      }
    }, isRemoteMode() ? 6000 : HIDE_AFTER);
  }, []);
  useLayoutEffect(() => { if (!playing || panel) { setChrome(true); window.clearTimeout(hideTimer.current); } else poke(); }, [playing, panel, poke]);
  useEffect(() => () => { window.clearTimeout(hideTimer.current); window.clearTimeout(nextHideTimer.current); nextPress.current?.abort(); }, []);

  /* ---------- actions ---------- */
  const togglePlay = useCallback(() => {
    resumeNextChecked.current = true;
    const v = video.current;
    if (!v) return;
    window.clearTimeout(playFeedbackTimer.current);
    if (v.paused) {
      setPlayFeedback(true);
      playFeedbackTimer.current = window.setTimeout(() => setPlayFeedback(false), 750);
      void v.play().catch(() => setPlayFeedback(false));
    } else { setPlayFeedback(false); v.pause(); }
  }, []);
  useEffect(() => () => { window.clearTimeout(playFeedbackTimer.current); setPlayFeedback(false); }, [session]);
  const seekBy = useCallback((delta: number, side?: "left" | "right", label?: string) => {
    resumeNextChecked.current = true;
    const v = video.current;
    if (!v || live) return;
    v.currentTime = Math.max(0, Math.min((v.duration || total) - 0.5, v.currentTime + delta));
    setFlash({ key: Date.now(), side: side ?? (delta < 0 ? "left" : "right"), label: label ?? `${delta > 0 ? "+" : ""}${delta}초` });
  }, [total, live]);
  const seekTo = (seconds: number) => { resumeNextChecked.current = true; const v = video.current; if (v && !live && Number.isFinite(seconds)) v.currentTime = seconds; };
  /* Remote seeking previews the target on the bar and seeks once the presses stop; holding the key speeds it up. */
  const [remoteSeek, setRemoteSeek] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const pendingTimer = useRef(0);
  const holdStart = useRef(0);
  const lastNudge = useRef(0);
  const nudgeSeek = (direction: 1 | -1, held: boolean) => {
    resumeNextChecked.current = true;
    const v = video.current;
    if (!v || live) return;
    // TVs repeat keys at different rates, so a held key steps by time: at most ~8 steps a second, 3x after 1.5s.
    const now = performance.now();
    if (!held) holdStart.current = now;
    else if (now - lastNudge.current < 120) return;
    lastNudge.current = now;
    const delta = direction * step * (now - holdStart.current > 1500 ? 3 : 1);
    const target = Math.max(0, Math.min((v.duration || total) - 0.5, (pendingSeek.current ?? v.currentTime) + delta));
    pendingSeek.current = target;
    setRemoteSeek(target);
    const offset = Math.round(target - v.currentTime);
    setFlash({ key: Date.now(), side: offset < 0 ? "left" : "right", label: `${offset > 0 ? "+" : ""}${offset}초` });
    window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => {
      if (pendingSeek.current !== null && video.current) video.current.currentTime = pendingSeek.current;
      pendingSeek.current = null; setRemoteSeek(null);
    }, 500);
  };
  useEffect(() => () => window.clearTimeout(pendingTimer.current), []);
  const changeVolume = (value: number) => {
    const v = video.current;
    const next = Math.max(0, Math.min(1, value));
    setVolume(next); setMuted(next === 0);
    if (v) { v.volume = next; v.muted = next === 0; }
    localStorage.setItem(VOLUME_KEY, String(next));
  };
  const toggleMute = () => { const v = video.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const changeSpeed = (value: number) => {
    setSpeed(value);
    if (boosting.current) boosting.current.rate = value;
    else if (video.current) video.current.playbackRate = value;
  };
  const toggleFullscreen = useCallback(async () => {
    if (pipWindow) return;
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
    if (fullscreenHost.current) await enterFullscreen(fullscreenHost.current).catch(() => {});
  }, [pipWindow]);
  const pip = async () => {
    const v = video.current;
    if (!v) return;
    if (pipWindow) { pipWindow.close(); return; }
    if (documentPipSupported() && !document.pictureInPictureElement) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      const width = Math.min(960, Math.max(400, Math.round(window.innerWidth / 3)));
      await documentPip.open(width, Math.round(width * (v.videoHeight || 9) / (v.videoWidth || 16))).catch(() => v.requestPictureInPicture().catch(() => {}));
      return;
    }
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
    else await v.requestPictureInPicture().catch(() => {});
  };
  const goNext = useCallback(() => {
    if (!session?.next) return;
    saveProgress();
    navigate(`/watch/${encodeURIComponent(session.next.episodeId)}`, { replace: true });
  }, [session, navigate, saveProgress]);
  const back = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(session ? `/title/${encodeURIComponent(session.mediaId)}` : "/");
  };
  const replay = () => {
    randomRequest.current?.abort();
    setRandomPending(false); setEndMessage("");
    seekTo(0);
    void video.current?.play().catch(() => setEndMessage("재생 버튼을 눌러 다시 시작해 주세요."));
  };
  const goHome = () => {
    randomRequest.current?.abort();
    saveProgress();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    navigate("/");
  };
  const recommendOther = useCallback(async (previous?: string) => {
    randomRequest.current?.abort();
    if (!previous) setRecommendation(null);
    const controller = new AbortController();
    randomRequest.current = controller;
    setRandomPending(true); setEndMessage("");
    try {
      const load = (page: number) => api<Page<MediaCard>>(`/media?sort=title&page=${page}`, { signal: controller.signal });
      const first = await load(1);
      const pages = Math.max(1, Math.ceil((first.total ?? first.items.length) / Math.max(1, first.items.length)));
      const start = Math.floor(Math.random() * pages);
      const excluded = new Set([session?.mediaId, previous, ...(media.data?.alternatives ?? []).map(item => item.id)]);
      for (let offset = 0; offset < pages; offset++) {
        const page = (start + offset) % pages + 1;
        const result = page === 1 ? first : await load(page);
        if (controller.signal.aborted) return;
        const items = result.items.filter(item => !excluded.has(item.id) && item.badge !== "LIVE");
        if (!items.length) continue;
        setRecommendation(items[Math.floor(Math.random() * items.length)]);
        return;
      }
      setEndMessage(previous ? "다른 추천 작품이 아직 없습니다." : "재생할 다른 작품이 아직 없습니다.");
    } catch {
      if (!controller.signal.aborted) setEndMessage("다른 작품을 불러오지 못했어요. 다시 시도해 주세요.");
    } finally {
      if (!controller.signal.aborted) setRandomPending(false);
    }
  }, [session?.mediaId, media.data?.alternatives]);

  /* ---------- next-up ---------- */
  const [remoteMarkerState, setRemoteMarkerState] = useState<{ sessionId: string; markers: PlaybackSession['markers'] }>();
  const [skipStatus, setSkipStatus] = useState('idle');
  const markerSessionId = session?.sessionId;
  // HLS metadata can refine duration after playback begins. Do not query using
  // a catalogue estimate, or reuse the previous stream's decoded duration.
  const markerDuration = Math.round(duration);
  // Local, source and saved playback all ask for markers bound to this playback session.
  const generalSkip = settings?.generalSkipEnabled !== false;
  const remoteSkip = Boolean(session && !live && (session.mediaType === 'anime' || generalSkip));
  const markerRequest = remoteSkip && markerDuration >= 60 && Number.isFinite(markerDuration);
  useEffect(() => {
    setSkipStatus('idle');
    if (!markerRequest || !markerSessionId) return;
    const controller = new AbortController();
    setSkipStatus('loading');
    void api<{markers:PlaybackSession['markers']|null;status:string}>(`/episodes/${encodeURIComponent(episodeId)}/markers?${new URLSearchParams({ duration: String(markerDuration), sessionId: markerSessionId })}`,{signal:controller.signal}).then(result=>{
      if (controller.signal.aborted) return;
      // AniSkip can return only OP or ED for a different episodeLength. A
      // partial/failed refresh is not a deletion of this session's known range.
      setRemoteMarkerState(previous => ({
        sessionId: markerSessionId,
        markers: result.markers ? mergePlaybackMarkers(result.markers,previous?.sessionId === markerSessionId ? previous.markers : undefined)
          : previous?.sessionId === markerSessionId ? previous.markers : undefined
      }));
      setSkipStatus(result.status);
    }).catch(()=>{if(!controller.signal.aborted)setSkipStatus('error');});
    return ()=>controller.abort();
  },[markerRequest,markerSessionId,episodeId,markerDuration]);
  const markers = mergePlaybackMarkers(session?.markers,remoteSkip && remoteMarkerState?.sessionId === markerSessionId ? remoteMarkerState?.markers : undefined);
  const skipRanges = total > 0 ? [
    { label: '오프닝', kind: 'intro', start: markers?.introStart ?? 0, end: markers?.introEnd },
    { label: '엔딩', kind: 'credits', start: markers?.creditsStart, end: markers?.creditsEnd ?? total }
  ].filter((range): range is { label: string; kind: string; start: number; end: number } => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map(range => ({ ...range, start: Math.max(0, Math.min(total, range.start)), end: Math.max(0, Math.min(total, range.end)) })).filter(range => range.end > range.start) : [];
  const { hasCredits, creditsAt, creditsEnd, inCredits, postCredits } = nextUpTiming(total, time, markers, settings?.nextEpisodeLeadSeconds);
  const autoplay = Boolean(settings && settings.autoplayNext !== false);
  const markersPending = markerRequest && ['idle', 'loading'].includes(skipStatus);
  const showNext = Boolean(session?.next && !nextDismissed && total && (ended ? autoplay : time >= creditsAt && (!postCredits || !inCredits)));
  const showEnd = !live && ended && !showNext;
  useEffect(() => {
    const v = video.current;
    if (resumeNextChecked.current || !session || !settings || !duration || waiting || !v || v.readyState < 2 || v.seeking || (markerRequest && ['idle', 'loading', 'error'].includes(skipStatus))) return;
    resumeNextChecked.current = true;
    if (hasCredits && session.resumeFromHistory && session.startPosition > 0 && session.startPosition >= creditsAt && v.currentTime >= creditsAt && autoplay && !nextCancelled && !nextDismissed && (!postCredits || !inCredits)) goNext();
  }, [session, settings, duration, waiting, hasCredits, markers?.creditsStart, markerRequest, skipStatus, creditsAt, autoplay, nextCancelled, nextDismissed, postCredits, inCredits, goNext]);
  useEffect(() => {
    if (!showEnd) return;
    void recommendOther();
    return () => randomRequest.current?.abort();
  }, [showEnd, recommendOther]);
  const delay = settings?.autoplayDelay ?? 5;
  // Crossing EOF must not restart a countdown that began just before the end.
  const atEnd = ended || video.current?.ended === true;
  const canCountDown = showNext && autoplay && (!markersPending || atEnd) && !nextCancelled && (playing || atEnd) && !waiting && !panel && !sourcePicker;
  useEffect(() => {
    if (!canCountDown) { setCountdown(null); return; }
    setCountdown(delay);
    const timer = setInterval(() => setCountdown(value => (value === null ? null : value - 1)), 1000);
    return () => clearInterval(timer);
  }, [canCountDown, delay]);
  useEffect(() => { if (countdown !== null && countdown <= 0) goNext(); }, [countdown, goNext]);
  // Mouse movement, a tap or a direction key stops the countdown for this playback session, even at EOF.
  // The card stays until five quiet seconds pass; it waits longer while focus is choosing one of its buttons.
  const armNextHide = () => {
    window.clearTimeout(nextHideTimer.current);
    nextHideTimer.current = window.setTimeout(() => { if (choosingNext() || nextPress.current?.signal.aborted === false) armNextHide(); else setNextDismissed(true); }, NEXT_IDLE_MS);
  };
  const cancelNextCountdown = () => {
    if (!showNext) return;
    setNextCancelled(true); setCountdown(null); armNextHide();
  };
  // Back, Escape and the card's close button close the card at once.
  const dismissNext = () => {
    if (!showNext) return;
    window.clearTimeout(nextHideTimer.current);
    setNextDismissed(true); setCountdown(null);
  };
  const onPlayerPointerDown = (event: React.PointerEvent) => {
    // Pressing a card button stops autoplay too, but the button still acts on click; the card waits until it is released.
    if ((event.target as Element).closest('.next-card button')) {
      nextPress.current?.abort();
      const press = nextPress.current = new AbortController(), view = (event.target as Element).ownerDocument.defaultView ?? window;
      for (const type of ['pointerup', 'pointercancel', 'blur']) view.addEventListener(type, () => press.abort(), { signal: press.signal });
    }
    cancelNextCountdown();
  };

  const intro = markers;
  const inIntro = Boolean(intro?.introStart !== undefined && intro?.introEnd && time >= intro.introStart && time < intro.introEnd - 1);

  // Markers are often a little off, so the skip button steps aside after a few seconds unless the controls are shown.
  const segment = inIntro ? "intro" : inCredits ? "credits" : null;
  const [skipFresh, setSkipFresh] = useState(false);
  useEffect(() => {
    if (!segment) { setSkipFresh(false); return; }
    setSkipFresh(true);
    const timer = window.setTimeout(() => setSkipFresh(false), SKIP_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [segment]);
  const showSkip = skipFresh || chrome;

  // Auto skip runs once per marker, so seeking back into an opening plays it.
  const skipped = useRef<{ intro?: boolean; credits?: boolean }>({});
  useEffect(() => {
    if (!prefs.autoSkip || !playing || waiting) return;
    if (inIntro && !skipped.current.intro) { skipped.current.intro = true; seekTo(intro!.introEnd!); setFlash({ key: Date.now(), side: "center", label: "오프닝 건너뜀" }); }
    else if (inCredits && !skipped.current.credits) { skipped.current.credits = true; seekTo(creditsEnd); setFlash({ key: Date.now(), side: "center", label: "엔딩 건너뜀" }); }
  }, [inIntro, inCredits, playing, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- TV remote ---------- */
  useLayoutEffect(() => {
    const onRemote = (raw: Event) => {
      const event = raw as RemotePlayerEvent, key = event.detail.key;
      if (event.defaultPrevented) return;
      const inOffer = Boolean(active()?.closest(".translate-offer"));
      const handled = () => event.preventDefault();
      // Enter on a focused card button is left to its click.
      if (showNext && !panel && !sourcePicker && !inOffer) {
        if (key === "Back") { dismissNext(); handled(); return; }
        if (key.startsWith("Arrow") || (key === "Enter" && !active()?.closest(".next-card"))) cancelNextCountdown();
        else if (nextCancelled) armNextHide();
      }
      if (key.startsWith("Media")) {
        const v=video.current;
        if (key === "MediaPlay") void v?.play().catch(()=>{});
        else if (key === "MediaPause") v?.pause();
        else if (key === "MediaPlayPause") togglePlay();
        else if (key === "MediaFastForward") nudgeSeek(1, event.detail.original.repeat);
        else if (key === "MediaRewind") nudgeSeek(-1, event.detail.original.repeat);
        else if (key === "MediaStop") back();
        else return;
        poke(); handled(); return;
      }
      if (key === "Back") {
        if (sourcePicker) setSourcePicker(false);
        else if (panel === "subs" && subsView !== "main") setSubsView("main");
        else if (panel) setPanel(null);
        else if (autopilot.offer && root.current?.querySelector(".translate-offer")) autopilot.dismiss();
        else if (chrome) { (active() as HTMLElement)?.blur(); setChrome(false); }
        else back();
        handled(); return;
      }
      if (panel || sourcePicker) return;
      const sideways = key === "ArrowLeft" || key === "ArrowRight";
      if (sideways && !live && !inOffer && (active()?.getAttribute("role") === "slider" || !chrome)) {
        nudgeSeek(key === "ArrowLeft" ? -1 : 1, event.detail.original.repeat); poke();
        if (!chrome) requestAnimationFrame(() => bar.current?.focus());
        handled(); return;
      }
      if (!chrome && !inOffer && (key.startsWith("Arrow") || key === "Enter") && !(key === "Enter" && active()?.closest(".next-card,.player-error,.player-end,.player-chip,.player-skip"))) {
        poke(); requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>(".center-play")?.focus());
        handled(); return;
      }
      if (key.startsWith("Arrow") || key === "Enter") poke();
    };
    window.addEventListener("moa:remote-key", onRemote);
    return () => window.removeEventListener("moa:remote-key", onRemote);
  });

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if(sourcePicker) { if(event.key === "Escape") {event.preventDefault();setSourcePicker(false);} return; }
      const target = event.target as HTMLElement;
      // A held Space on a card button clicks on release, and arrows on a player slider such as volume stay with it; both still stop autoplay.
      const playerSlider = target.matches("input[type='range']") && root.current?.contains(target);
      if (showNext && !panel) {
        if (event.key === "Escape" && playerSlider) { event.preventDefault(); dismissNext(); return; }
        if ((event.key === " " && target.closest(".next-card button")) || (event.key.startsWith("Arrow") && playerSlider)) cancelNextCountdown();
      }
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === " " && (panel || target.closest("button, a, summary, [role='button'], [role='slider']") || root.current?.querySelector("dialog[open]"))) return;
      const v = video.current;
      if (!v) return;
      const key = event.key.toLowerCase();
      if (root.current?.querySelector("dialog[open], [aria-modal='true']")) return;
      if (showNext && !panel) {
        if (key === 'escape') { event.preventDefault(); dismissNext(); return; }
        if (key.startsWith('arrow')) cancelNextCountdown();
      }
      if (panel && key !== 'escape') return;
      const binding = keyboardShortcutKey(event);
      const action = binding && Object.entries(prefs.playerShortcuts).find(([, value]) => value === binding)?.[0];
      if (key === " ") { if (!event.repeat) startPress('space'); }
      else if (key === "arrowleft") seekBy(-5);
      else if (key === "arrowright") seekBy(5);
      else if (key === "escape") { if (panel) setPanel(null); else if (!document.fullscreenElement && !pipWindow) back(); }
      else if (/^[0-9]$/.test(key)) seekTo((Number(key) / 10) * (v.duration || total));
      else if (action) {
        if (event.repeat && ['playPause', 'fullscreen', 'mute', 'nextEpisode', 'subtitles'].includes(action)) { event.preventDefault(); return; }
        if (action === 'playPause') togglePlay();
        else if (action === 'seekBackward') seekBy(-step);
        else if (action === 'seekForward') seekBy(step);
        else if (action === 'volumeUp') changeVolume(v.volume + 0.1);
        else if (action === 'volumeDown') changeVolume(v.volume - 0.1);
        else if (action === 'fullscreen') void toggleFullscreen();
        else if (action === 'mute') toggleMute();
        else if (action === 'nextEpisode') goNext();
        else if (action === 'subtitles') chooseSubtitle(subtitle ? null : allSubs[0] ?? null);
        else if (action === 'speedDown' || action === 'speedUp') {
          const current = boosting.current?.rate ?? v.playbackRate;
          const next = (action === 'speedUp' ? SPEEDS.find(value => value > current) : [...SPEEDS].reverse().find(value => value < current)) ?? current;
          changeSpeed(next);
          setFlash({ key: Date.now(), side: 'center', label: `${next}배속` });
        } else if (subtitle && (action === 'subtitleEarlier' || action === 'subtitleLater')) {
          const offset = nudgeSubs(action === 'subtitleEarlier' ? -0.5 : 0.5);
          setFlash({ key: Date.now(), side: 'center', label: `자막 ${offset > 0 ? '+' : ''}${offset.toFixed(1)}초` });
        }
      } else return;
      event.preventDefault(); poke();
      if (showNext && nextCancelled) armNextHide();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ' || holdOrigin.current !== 'space') return;
      event.preventDefault();
      const wasBoosting = endPress();
      if (!wasBoosting && !panel && !sourcePicker && !root.current?.querySelector("dialog[open]")) togglePlay();
      poke();
    };
    window.addEventListener("keydown", onKey);
    pipWindow?.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    pipWindow?.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKey); pipWindow?.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); pipWindow?.removeEventListener("keyup", onKeyUp); };
  });

  // Observers created by this window do not follow the player into the PiP window's rendering loop.
  useEffect(() => {
    if (!pipWindow) return;
    const relayout = () => subs.current?.refreshLayout();
    pipWindow.addEventListener("resize", relayout);
    relayout();
    return () => { pipWindow.removeEventListener("resize", relayout); requestAnimationFrame(() => subs.current?.refreshLayout()); };
  }, [pipWindow]);

  useEffect(() => {
    const onFs = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreen(active);
      if (!active) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---------- touch gestures ---------- */
  // One tap toggles the controls; double-tap a side seeks 10s and further taps
  // on that side keep adding 10s (YouTube style); hold for 2x; pinch to fill.
  const lastSurfacePointer = useRef("mouse");
  const lastTap = useRef<{ at: number; side: "left" | "center" | "right" } | null>(null);
  const streak = useRef<{ side: "left" | "right"; until: number; total: number } | null>(null);
  const tapTimer = useRef<number>(0);
  const pressTimer = useRef<number>(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const suppressGestureClick = useRef(false);
  const boosting = useRef<{ video: HTMLVideoElement; rate: number } | null>(null);
  const holdOrigin = useRef<number | 'space' | null>(null);
  const mouseClicks = useRef(0);
  const pinch = useRef<{ start: number; done: boolean } | null>(null);
  const fill = prefs.videoFill;
  const changeFill = (value: boolean) => {
    setDevicePref("videoFill", value);
    setFlash({ key: Date.now(), side: "center", label: value ? "화면 채우기" : "원본 비율" });
  };
  const [fillScale, setFillScale] = useState(1);
  const [videoHeight, setVideoHeight] = useState<number>();
  useEffect(() => { subs.current?.setHeight(subHeight); }, [videoHeight, subHeight, subSize]);
  useEffect(() => {
    const v = video.current, r = root.current;
    if (!v || !r) return;
    const update = () => {
      if (!v.videoWidth || !v.videoHeight) { setFillScale(1); setVideoHeight(undefined); return; }
      setVideoHeight(Math.min(r.clientHeight, r.clientWidth * v.videoHeight / v.videoWidth));
      if (!fill) { setFillScale(1); return; }
      const screenRatio = r.clientWidth / r.clientHeight, videoRatio = v.videoWidth / v.videoHeight;
      setFillScale(Math.max(screenRatio / videoRatio, videoRatio / screenRatio));
    };
    update();
    const observer = new ((r.ownerDocument.defaultView ?? window) as typeof window).ResizeObserver(update);
    observer.observe(r);
    v.addEventListener("loadedmetadata", update);
    return () => { observer.disconnect(); v.removeEventListener("loadedmetadata", update); };
  }, [fill, session, pipWindow]);
  const distance = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const endPress = useCallback((cancelled = false) => {
    window.clearTimeout(pressTimer.current);
    if (boosting.current || (cancelled && holdOrigin.current !== null)) { suppressGestureClick.current = true; mouseClicks.current = 0; }
    holdOrigin.current = null;
    const previous = boosting.current;
    if (!previous) return false;
    boosting.current = null;
    previous.video.playbackRate = previous.rate;
    setBoost(false);
    return true;
  }, []);
  // A single owner keeps keyboard and pointer holds from restoring each other's speed.
  const startPress = (origin: number | 'space') => {
    if (holdOrigin.current !== null) return;
    holdOrigin.current = origin;
    pressTimer.current = window.setTimeout(() => {
      const v = video.current;
      if (v && !v.paused && !pinch.current) { boosting.current = { video: v, rate: v.playbackRate }; setBoost(true); v.playbackRate = prefs.holdSpeed; }
    }, 450);
  };
  useEffect(() => { if (panel || sourcePicker) endPress(true); }, [panel, sourcePicker, endPress]);
  useEffect(() => {
    const cancel = () => { window.clearTimeout(tapTimer.current); pointers.current.clear(); pinch.current = null; lastTap.current = null; suppressGestureClick.current = true; mouseClicks.current = 0; endPress(); };
    const ownerDocument = pipWindow?.document ?? document;
    const onVisibility = () => { if (ownerDocument.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    pipWindow?.addEventListener('blur', cancel);
    ownerDocument.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('blur', cancel); pipWindow?.removeEventListener('blur', cancel); ownerDocument.removeEventListener('visibilitychange', onVisibility); cancel(); };
  }, [endPress, pipWindow, session]);

  const onSurfacePointerDown = (event: React.PointerEvent) => {
    if (holdOrigin.current === 'space') return;
    lastSurfacePointer.current = event.pointerType;
    if (!pointers.current.size) suppressGestureClick.current = false;
    const surface = (event.currentTarget as HTMLElement).classList.contains("player-surface");
    if (event.pointerType !== "touch" && (!['mouse', 'pen'].includes(event.pointerType) || event.button !== 0 || !surface)) return;
    if (event.pointerType !== "touch") event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      endPress();
      window.clearTimeout(tapTimer.current);
      window.clearTimeout(hideTimer.current);
      lastTap.current = null;
      streak.current = null;
      suppressGestureClick.current = true;
      pinch.current = { start: distance(), done: false };
      return;
    }
    // Buttons retain their normal single-tap click. Only the video surface
    // starts a hold; both layers contribute pointers to the same pinch.
    if (pointers.current.size !== 1 || !surface || panel) return;
    startPress(event.pointerId);
  };
  const onSurfacePointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const p = pinch.current;
    if (!p || p.done || pointers.current.size !== 2) return;
    const scale = distance() / Math.max(1, p.start);
    if (scale > 1.2) { p.done = true; if (!fill) changeFill(true); }
    else if (scale < 0.83) { p.done = true; if (fill) changeFill(false); }
  };
  const seekStep = (side: "left" | "right") => {
    const delta = side === "left" ? -step : step;
    const now = Date.now();
    const total = streak.current && streak.current.side === side && now < streak.current.until ? streak.current.total + delta : delta;
    streak.current = { side, until: now + 900, total };
    seekBy(delta, side, `${total > 0 ? "+" : ""}${total}초`);
  };
  const onSurfacePointerUp = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pinch.current) { if (!pointers.current.size) { pinch.current = null; poke(); } return; }
    if (endPress()) return;
    if (suppressGestureClick.current) return;
    if (!(event.currentTarget as HTMLElement).classList.contains("player-surface")) return;
    if (panel) { setPanel(null); return; }
    if (event.pointerType !== "touch") { mouseClicks.current = event.pointerType === 'mouse' ? Math.min(2, mouseClicks.current + 1) : 0; togglePlay(); poke(); return; }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const side = x < 0.35 ? "left" : x > 0.65 ? "right" : "center";
    const now = Date.now();
    if (side === "center" && lastTap.current?.side === "center" && now - lastTap.current.at < 280) {
      window.clearTimeout(tapTimer.current); lastTap.current = null;
      void toggleFullscreen(); return;
    }
    if (side !== "center" && !live) {
      if (streak.current?.side === side && now < streak.current.until) { window.clearTimeout(tapTimer.current); lastTap.current = null; seekStep(side); return; }
      if (lastTap.current?.side === side && now - lastTap.current.at < 280) { window.clearTimeout(tapTimer.current); lastTap.current = null; seekStep(side); return; }
    }
    lastTap.current = { at: now, side };
    window.clearTimeout(tapTimer.current);
    const toggle = () => { lastTap.current = null; setChrome(visible => { if (!visible) window.setTimeout(poke, 0); return !visible; }); };
    // Wait briefly to distinguish center double-tap fullscreen from a tap.
    if (live && side !== "center") toggle(); else tapTimer.current = window.setTimeout(toggle, 280);
  };
  const onSurfacePointerCancel = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (!pointers.current.size) { pinch.current = null; poke(); }
    suppressGestureClick.current = true;
    mouseClicks.current = 0;
    window.clearTimeout(tapTimer.current);
    lastTap.current = null;
    endPress();
  };

  /* ---------- seek bar ---------- */
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const previewPosition = useRef<number | null>(null);
  if (hover !== null) previewPosition.current = hover;
  const [scrub, setScrub] = useState<number | null>(null);
  const ratioAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const onBarDown = (event: React.PointerEvent) => {
    resumeNextChecked.current = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setScrub(ratioAt(event.clientX));
  };
  const onBarMove = (event: React.PointerEvent) => {
    const r = ratioAt(event.clientX);
    setHover(r);
    if (scrub !== null) setScrub(r);
    poke();
  };
  const onBarUp = (event: React.PointerEvent) => {
    if (scrub === null) return;
    seekTo(ratioAt(event.clientX) * total);
    setScrub(null);
  };
  const shown = scrub !== null ? scrub * total : remoteSeek ?? time;

  const episodes = useMemo(() => media.data?.seasons.flatMap(season => season.episodes) ?? [], [media.data]);
  const switchServer = (id: string) => { setPanel(null); switchStream(id, live ? 0 : video.current?.currentTime || 0); };
  const playbackSource = [session?.saved ? '저장한 영상' : media.data?.provider?.name, session?.streams?.find(stream => stream.id === session.streamId)?.label].filter(Boolean).join(' · ');
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const error = sessionError ?? fatal;
  const pluginPlayer = {
    episodeId, title: titleLine.join(' · '), getTime: () => video.current?.currentTime || 0, onImport: (files: File[]) => addSubtitleFiles(files, false),
    control: async (action: string, seconds?: number) => {
      const v = video.current;
      if (!v) throw new Error('재생을 준비하는 중이에요.');
      if (action === 'play') await v.play();
      else if (action === 'pause') v.pause();
      else if (action === 'seek') {
        if (live || !Number.isFinite(v.duration)) throw new Error('이 영상은 탐색할 수 없어요.');
        seekTo(Math.max(0, Math.min(v.duration, seconds!)));
      }
    }
  };

  return (
    <div
      ref={root}
      className={cx("player", chrome ? "is-chrome" : "is-idle", playing && "is-playing", fill && "is-fill", !originalSubAppearance && "cue-custom", `cue-${subSize}`, `cue-bg-${subBackground}`)}
      style={{ "--video-height": videoHeight ? `${videoHeight}px` : undefined, "--subtitle-font-size": subScale ? `max(10px, calc(${videoHeight || 360}px * .046 * ${subScale / 100}))` : undefined } as React.CSSProperties}
      onDragOver={event => { if (canAddSubtitles && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDraggingSubtitle(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingSubtitle(false); }}
      onDrop={event => { event.preventDefault(); setDraggingSubtitle(false); void addSubtitleFiles(Array.from(event.dataTransfer.files)); }}
      onPointerDownCapture={onPlayerPointerDown}
      onPointerMove={event => { if (event.pointerType !== "touch") { poke(); cancelNextCountdown(); } }}
    >
      {session && <PluginScripts player={pluginPlayer} />}
      <input ref={subtitleInput} type="file" accept={SUBTITLE_FILES} multiple hidden aria-label="자막 파일 선택" onChange={event => { void addSubtitleFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      {draggingSubtitle && <div className="subtitle-drop-hint" role="status"><FileUp size={32} /><b>자막 파일을 놓아 주세요</b><span>SRT · VTT · ASS · SMI · ZIP · 7z · RAR</span></div>}
      <video
        ref={video}
        className="player-video"
        style={fillScale !== 1 ? { transform: `scale(${fillScale})` } : undefined}
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        onPlay={event => { setPlaying(!event.currentTarget.paused); setEnded(false); }}
        onPause={event => { setPlayFeedback(false); setPlaying(!event.currentTarget.paused); if (event.currentTarget.paused) endPress(true); saveProgress(); swapRevision(); }}
        onSeeked={event => { setTime(event.currentTarget.currentTime); setEnded(event.currentTarget.ended || event.currentTarget.currentTime >= event.currentTarget.duration); setWaiting(false); swapRevision(); if (translation.busy) translation.prioritize(event.currentTarget.currentTime); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={event => { if (session) setMediaDuration({ sessionId: session.sessionId, seconds: event.currentTarget.duration }); setLevels(engine.current?.levels() ?? []); setLevel(engine.current?.level() ?? -1); }}
        onTimeUpdate={event => {
          const v = event.currentTarget;
          setTime(v.currentTime);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          if (Math.abs(v.currentTime - lastSaved.current) >= 10) saveProgress();
          if (pendingRevision.current) swapRevision();
        }}
        onEnded={() => {
          setEnded(true); setPlaying(false); saveProgress();
        }}
      />

      <div className="player-surface" onPointerDown={onSurfacePointerDown} onPointerMove={onSurfacePointerMove} onPointerUp={onSurfacePointerUp} onPointerCancel={onSurfacePointerCancel} onLostPointerCapture={event => { if (pointers.current.has(event.pointerId)) onSurfacePointerCancel(event); }} onContextMenu={event => event.preventDefault()} onDoubleClick={event => {
        const native = event.nativeEvent as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
        // dblclick is a MouseEvent even when synthesized from touch input.
        if (lastSurfacePointer.current === "mouse" && mouseClicks.current === 2 && !native.sourceCapabilities?.firesTouchEvents) void toggleFullscreen();
      }} />

      {(waiting || !session) && !error && <div className={cx("player-loading", session && !ended && !panel && chrome && "has-center-control")} role="status" aria-label="영상 불러오는 중"><Spinner size={52} /></div>}
      {flash && <div key={flash.key} className={cx("player-flash", `flash-${flash.side}`)} aria-hidden="true"><div>{flash.side === "left" ? <Rewind size={26} fill="currentColor" /> : flash.side === "right" ? <FastForward size={26} fill="currentColor" /> : null}<span>{flash.label}</span></div></div>}
      {boost && <div className="player-boost" role="status"><FastForward size={18} />{prefs.holdSpeed}배속</div>}

      <header className="player-top">
        <button className="icon-btn icon-btn-l" aria-label="뒤로" onClick={back}><ArrowLeft size={28} /></button>
        <div className="player-title">
          {titleLine[0] && <b>{titleLine[0]}</b>}
          {titleLine[1] && <span>{titleLine[1]}</span>}
          {playbackSource && <span>소스: {playbackSource}</span>}
        </div>
      </header>

      <button className={cx("player-bigplay", (!playing || playFeedback) && session && !waiting && !error && !ended && "is-visible", playing && "is-feedback")} aria-label="재생" aria-hidden={!!(playing || !session || waiting || error || ended)} tabIndex={playing || !session || waiting || error || ended ? -1 : 0} onClick={togglePlay}>{playing ? <Pause size={44} fill="currentColor" /> : <Play size={44} fill="currentColor" />}</button>

      {session && !error && !ended && !panel && (
        <div className="player-center" aria-hidden={!chrome}
          onPointerDown={onSurfacePointerDown} onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp} onPointerCancel={onSurfacePointerCancel}
          onClickCapture={event => {
            // Touch browsers may synthesize a button click after a pinch.
            if (suppressGestureClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
          }}>
          {!live && <button className="center-btn" aria-label={`${step}초 뒤로`} data-remote tabIndex={-1} onClick={() => { seekBy(-step); poke(); }}><RotateCcw size={30} /><small>{step}</small></button>}
          <button className="center-btn center-play" aria-label={playing ? "일시정지" : "재생"} data-remote tabIndex={-1} onClick={() => { togglePlay(); poke(); }}>
            {waiting ? <Spinner size={40} /> : playing ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" />}
          </button>
          {!live && <button className="center-btn" aria-label={`${step}초 앞으로`} data-remote tabIndex={-1} onClick={() => { seekBy(step); poke(); }}><RotateCw size={30} /><small>{step}</small></button>}
        </div>
      )}

      {resumeChip && session && (
        <div className="player-chip" role="status">
          <span>{clock(session.startPosition)}부터 이어서 재생</span>
          <button onClick={() => {
            // A loading media fragment/HLS engine can reapply its original resume offset after a seek.
            // Recreate the session with an explicit zero, including the server's playlist start hint.
            setResumeChip(false); runtimeRecoveries.current = 0; resumePlaying.current = null; retry(0);
          }}>처음부터</button>
        </div>
      )}

      {autopilot.offer && !panel && !showNext && !error && !ended && (
        <TranslationOfferCard offer={autopilot.offer} onAccept={() => { if (!autopilot.accept()) { setPanelState("subs"); setSubsView("translate"); } }} onDismiss={autopilot.dismiss}
          onChoose={() => { autopilot.hide(); setPanelState("subs"); setSubsView("translate"); }} />
      )}
      {translatingHere && !panel && <div className="translate-gap" role="status"><Spinner size={14} /><span>이 구간은 번역 중이에요</span></div>}

      {inIntro && !showNext && showSkip && (
        <Button className="player-skip" variant="secondary" data-remote-initial icon={<SkipForward size={18} />} onClick={() => seekTo(intro!.introEnd!)}>오프닝 건너뛰기</Button>
      )}
      {inCredits && !showNext && showSkip && (
        <Button className="player-skip" variant="secondary" data-remote-initial icon={<SkipForward size={18} />} onClick={() => seekTo(creditsEnd)}>엔딩 건너뛰기</Button>
      )}



      {showEnd && (
        <div className="player-end">
          <b>{session?.next ? "다음 화를 볼까요?" : "다음으로 무엇을 볼까요?"}</b>
          <div className="player-end-actions">
            {session?.next && <Button variant="primary" size="l" icon={<Play size={20} fill="currentColor" />} onClick={goNext}>다음 화 재생</Button>}
            <Button variant={session?.next ? "secondary" : "primary"} size="l" icon={<RotateCcw size={20} />} onClick={replay}>다시 보기</Button>
            <Button variant="secondary" size="l" icon={<House size={20} />} onClick={goHome}>홈으로</Button>
          </div>
          {recommendation && <Link className="player-recommendation" to={`/play/${encodeURIComponent(recommendation.id)}`} aria-label={`${recommendation.title} 재생`}>
            <Artwork src={recommendation.backdrop ?? recommendation.poster} title={recommendation.title} ratio="landscape" width={480} labelFallback={false} />
            <span><small>추천 작품</small><strong>{recommendation.title}</strong><span><Play size={16} fill="currentColor" />재생</span></span>
          </Link>}
          <Button variant="ghost" icon={<Shuffle size={18} />} disabled={randomPending} onClick={() => void recommendOther(recommendation?.id)}>{randomPending ? "추천 찾는 중…" : recommendation ? "다른 추천" : "추천 다시 찾기"}</Button>
          {endMessage && <p role="status">{endMessage}</p>}
        </div>
      )}

      {error && (
        <div className="player-error" role="alert">
          <b>{error}</b>
          {error === KIDS_RESTRICTED ? <><p>12세 이하 등급이거나 가족·키즈 장르인 작품만 볼 수 있어요. 다른 프로필로 바꿔서 보세요.</p>
          <div className="hero-actions"><Button variant="primary" onClick={back}>나가기</Button></div></> : <>
          <p>잠시 후 다시 시도하거나, 다른 회차를 선택해 주세요.</p>
          <div className="hero-actions">
            <Button variant="primary" onClick={() => { runtimeRecoveries.current = 0; resumePlaying.current = null; setFatal(null); retry(live ? 0 : video.current?.currentTime || time || session?.startPosition || 0); }}>다시 시도</Button>
            <Button variant="secondary" onClick={()=>setSourcePicker(true)}>다른 소스 선택</Button>
            <Button variant="secondary" onClick={back}>나가기</Button>
          </div></>}
        </div>
      )}

      {sourcePicker && <PlaybackSources episodeId={episodeId} position={live?0:video.current?.currentTime || time || session?.startPosition || 0} onClose={()=>setSourcePicker(false)} onPlay={(id,at,sameEpisode)=>{saveProgress(true); handingOff.current = sameEpisode && isTranslationTrack(subtitle) && translation.handoff(id); const carry = sameEpisode && (isTranslationTrack(subtitle) || subtitle?.source === 'upload'); const remembered = subtitlePreference(episodeId); if (carry) saveSubtitle(id, subtitle, remembered?.episodeId ?? episodeId); else if (sameEpisode && remembered === null) saveSubtitle(id, null); navigate(`/watch/${encodeURIComponent(id)}?t=${Math.max(0,Math.floor(at))}`, { state: carry ? { subtitle } : null });}}/>}
      <footer className="player-bottom">
        {showNext && session?.next && (
          <div className="next-card" role="dialog" aria-label="다음 화" onBlur={event => { if (nextCancelled && !event.currentTarget.contains(event.relatedTarget as Node | null)) armNextHide(); }}>
            <Artwork src={session.next.thumb} title={session.next.title} ratio="landscape" width={480} labelFallback={false} />
            <div className="next-card-body">
              <small>다음 화 · {session.next.label}</small>
              <b>{session.next.title}</b>
              <div className="next-card-actions">
                <Button variant="primary" icon={<Play size={18} fill="currentColor" />} onClick={goNext} className="next-play">
                  {countdown !== null ? `${countdown}초 후 재생` : "다음 화 재생"}
                  {countdown !== null && <i className="next-countdown" style={{ animationDuration: `${delay}s` }} />}
                </Button>
                {inCredits && <Button variant="ghost" onClick={() => seekTo(creditsEnd)}>엔딩 건너뛰기</Button>}
                {/* Name what dismissing leads to: the ending only when it is known, otherwise the rest of the video. */}
                <Button variant="ghost" onClick={dismissNext}>{ended ? "닫기" : inCredits ? "엔딩 보기" : "계속 보기"}</Button>
              </div>
            </div>
          </div>
        )}
        {notice && <div className="player-notice" role="status">
          <Captions size={16} /><span>{typeof notice === "string" ? notice : notice.text}</span>
          {typeof notice === "string"
            ? <button onClick={() => { setNotice(null); setPanel("subs"); }}>변경</button>
            : <button onClick={() => { setNotice(null); notice.action.run(); }}>{notice.action.label}</button>}
        </div>}
        <div className="player-controls-chrome">
        {!live && <div className="seek" ref={bar} onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerLeave={() => setHover(null)}
          role="slider" aria-label="재생 위치" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(shown)} aria-valuetext={clock(shown)} tabIndex={0}>
          <div className="seek-rail">
            <i className="seek-buffer" style={{ width: `${total ? (buffered / total) * 100 : 0}%` }} />
            <i className="seek-fill" style={{ width: `${total ? (shown / total) * 100 : 0}%` }} />
            {skipRanges.map(range => <i key={range.kind} className={`seek-marker seek-${range.kind}`} title={`${range.label} ${clock(range.start)}–${clock(range.end)}`} style={{ left: `${range.start / total * 100}%`, width: `${(range.end - range.start) / total * 100}%` }} />)}
          </div>
          <i className="seek-thumb" style={{ left: `${total ? (shown / total) * 100 : 0}%` }} />
          {previewPosition.current !== null && total > 0 && <span className="seek-tip" hidden={hover === null} style={{ left: `clamp(84px, ${previewPosition.current * 100}%, calc(100% - 84px))` }}>{session && <SeekPreview key={session.sessionId} session={session} seconds={previewPosition.current * total} />}<span>{skipRanges.find(range => previewPosition.current! * total >= range.start && previewPosition.current! * total < range.end)?.label} {clock(previewPosition.current * total)}</span></span>}
        </div>}

        <div className="player-controls" data-remote-group>
          <div className="controls-left">
            <button className="icon-btn icon-btn-l" data-remote-entry aria-label={shortcutLabel('playPause', playing ? '일시정지' : '재생')} title={shortcutLabel('playPause', playing ? '일시정지' : '재생')} onClick={togglePlay}>
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </button>
            {!live && <><button className="icon-btn icon-btn-l" aria-label={shortcutLabel('seekBackward', `${step}초 뒤로`)} title={shortcutLabel('seekBackward', `${step}초 뒤로`)} onClick={() => seekBy(-step)}><RotateCcw size={26} /></button>
            <button className="icon-btn icon-btn-l" aria-label={shortcutLabel('seekForward', `${step}초 앞으로`)} title={shortcutLabel('seekForward', `${step}초 앞으로`)} onClick={() => seekBy(step)}><RotateCw size={26} /></button></>}
            <div className="volume">
              <button className="icon-btn icon-btn-l" aria-label={shortcutLabel('mute', '음소거')} title={shortcutLabel('mute', '음소거')} onClick={toggleMute}><VolumeIcon size={26} /></button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="볼륨" onChange={event => changeVolume(Number(event.target.value))} style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} />
            </div>
            <span className="player-time">{live ? <b className="live-label">● LIVE</b> : <>{clock(shown)} <span>/ {clock(total)}</span></>}</span>
          </div>
          <div className="controls-right">
            {session && <CastButton key={session.sessionId} session={session} subtitle={subtitle} offset={subOffset} video={video} onProgress={value => { castProgress.current = value; }} onAirPlay={async target => {
              const v = video.current;
              if (!v) return;
              const position = v.currentTime, playing = !v.paused;
              engine.current?.destroy(); engine.current = null;
              engine.current = await attach(v, target ? { ...session, url: target.url, mime: target.mime as PlaybackSession['mime'] } : session, position, message => setNotice(message), Boolean(target), { preferredHeight: defaultHeightRef.current });
              setAirplayMedia(target);
              if (playing) await v.play().catch(() => {});
            }} />}
            {session?.next && <button className="icon-btn icon-btn-l" aria-label={shortcutLabel('nextEpisode', '다음 화')} title={shortcutLabel('nextEpisode', '다음 화')} onClick={goNext}><SkipForward size={26} /></button>}
            {episodes.length > 1 && <button className={cx("icon-btn icon-btn-l", panel === "episodes" && "is-active")} aria-label="회차 목록" title="회차 목록" onClick={() => setPanel(panel === "episodes" ? null : "episodes")}><ListVideo size={26} /></button>}
            {session && (
              <button className={cx("icon-btn icon-btn-l", panel === "subs" && "is-active")} aria-label="자막 및 음성" title="자막 및 음성" onClick={() => setPanel(panel === "subs" ? null : "subs")}><Captions size={26} /></button>
            )}
            <button className={cx("icon-btn icon-btn-l", panel === "settings" && "is-active")} aria-label="재생 설정" title="재생 설정" onClick={() => setPanel(panel === "settings" ? null : "settings")}><Settings size={26} /></button>
            {("pictureInPictureEnabled" in document || documentPipSupported()) && <button className={cx("icon-btn icon-btn-l hide-mobile", pipWindow && "is-active")} aria-label={pipWindow ? "PIP 닫기" : "PIP"} title={pipWindow ? "PIP 닫기" : "PIP"} onClick={() => void pip()}><PictureInPicture2 size={26} /></button>}
            {!pipWindow && <button className="icon-btn icon-btn-l" aria-label={shortcutLabel('fullscreen', '전체 화면')} title={shortcutLabel('fullscreen', '전체 화면')} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={26} /> : <Maximize size={26} />}</button>}
          </div>
        </div>

        </div>
      </footer>

      {panel && session && (
        <div className={cx("player-panel", `panel-${panel}`, panel === "subs" && subsView === "main" && session.audioTracks.length > 1 && "panel-split")} role="dialog" aria-label={panel === "episodes" ? "회차 목록" : panel === "subs" ? "자막 및 음성" : "재생 설정"}>
          <header className="panel-head">
            {panel === "subs" && subsView !== "main"
              ? <button className="panel-back" onClick={() => setSubsView("main")}><ChevronLeft size={22} /><b>{subsView === "style" ? "자막 설정" : subsView === "translate" ? "한국어로 번역" : "자막 검색 조건"}</b></button>
              : <b>{panel === "episodes" ? `회차 · ${episodes.length}개` : panel === "subs" ? "자막 및 음성" : "재생 설정"}</b>}
            <button className="icon-btn" aria-label="닫기" onClick={() => setPanel(null)}><X size={20} /></button>
          </header>
          {panel === "subs" && subsView === "main" && (
            <div className="panel-body panel-cols">
              {session.audioTracks.length > 1 && (
                <section className="panel-col">
                  <h3>음성</h3>
                  {session.audioTracks.map(track => {
                    const active = (audioTrackId ?? session.audioTracks.find(item => item.default)?.id ?? session.audioTracks[0].id) === track.id;
                    return (
                      <button key={track.id} className={cx("opt", active && "is-active")} onClick={() => { if (!active) { setPanel(null); switchAudio(track.id, video.current?.currentTime ?? 0); } }}>
                        <Check size={18} className="opt-check" /><span>{trackName(track)}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              <section className="panel-col">
                <h3>자막</h3>
                {canAddSubtitles && <button className="opt opt-action subtitle-upload" disabled={importing} onClick={() => subtitleInput.current?.click()}>{importing ? <Spinner size={18} /> : <FileUp size={18} />}<span>{importing ? '자막을 읽는 중…' : '자막 파일 선택'}<small>파일을 여기에 끌어 놓아도 돼요</small></span></button>}
                <button className={cx("opt", !subtitle && "is-active")} onClick={() => chooseSubtitle(null)}><Check size={18} className="opt-check" /><span>끄기</span></button>
                {allSubs.map(track => (
                  <button key={track.id} className={cx("opt", subtitle?.id === track.id && "is-active")} onClick={() => chooseSubtitle(track)}>
                    <Check size={18} className="opt-check" />
                    {isTranslationTrack(track)
                      ? <><span>{track.label.replace(/\s*·\s*AI 번역$/, "") || "한국어"}{track.provenance ? ` · ${track.provenance.creatorName} 원문` : ""}</span><small className="tag-ai">AI 번역</small>{liveJob?.track?.id === track.id ? <small>번역 중</small> : translation.state.status === "failed" && translation.state.job?.track?.id === track.id ? <small className="warn">일부</small> : null}</>
                      : <><span>{trackName(track)}</span>{track.format === "ass" && <small>ASS</small>}</>}
                  </button>
                ))}
                {isTranslationTrack(subtitle) && <button className="opt opt-action" onClick={() => void exportSubtitle(subtitle!, titleLine.join(' · ')).catch(() => setNotice('번역 자막을 내보내지 못했어요. 다시 시도해 주세요.'))}><Download size={18} /><span>AI 번역 자막 내보내기</span></button>}
                {canTranslate && <TranslationEntry config={translationConfig} admin={admin} state={translation.state} tracks={allSubs} onOpen={() => { autopilot.hide(); setSubsView("translate"); }} />}
                {canAddSubtitles && <div className="online-subs">
                  {online.status === "idle" && (
                    <button className="opt opt-action" onClick={() => void searchOnline(undefined, true)}><CloudDownload size={18} /><span>온라인에서 한국어 자막 찾기</span></button>
                  )}
                  {online.status === "searching" && (
                    <div className="online-searching" role="status"><Spinner size={16} /><span>한국어 자막을 찾는 중…</span></div>
                  )}
                  {online.status === "error" && (
                    <button className="opt opt-action" onClick={() => void searchOnline(undefined, true)}><RotateCw size={18} /><span>찾지 못했어요 · 다시 시도</span></button>
                  )}
                  {online.status === "done" && online.result && (
                    <>
                      <h4>온라인 한국어 자막{online.result.partial ? <small> · 일부 응답 없음</small> : null}</h4>
                      {online.result.query && (
                        <button className="online-query" onClick={() => { setSubQuery(online.result!.query!); setSubsView("search"); }} aria-label="검색 조건 바꾸기">
                          <Search size={15} aria-hidden="true" />
                          <span>{online.result.query.title} · {online.result.query.season}기 {online.result.query.episode}화{online.result.query.episodeOffset ? <small> (전체 {online.result.query.episode + online.result.query.episodeOffset}화)</small> : null}</span>
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      )}
                      {online.result.autoApply === false && online.result.candidates.length > 0 && <p className="panel-note note-warn">회차 번호가 확실하지 않아 자동으로 적용하지 않았어요. 맞는 자막을 골라 주세요.</p>}
                      {online.result.candidates.length === 0 && <p className="panel-note">‘{online.result.resolvedTitle}’ 자막을 가져오지 못했어요.{online.result.issues?.some(issue => issue.kind === 'access-denied') ? " 제작자 사이트에서 접속을 차단했어요. 자막이 없는 것은 아닐 수 있어요." : online.result.issues?.some(issue => issue.kind === 'timeout') ? " 검색 시간이 초과됐어요. 잠시 후 다시 시도해 주세요." : online.result.query ? " 제목이나 시즌·화수를 바꿔서 다시 찾아보세요." : ""}</p>}
                      {online.result.candidates.map(candidate => {
                        const applied = subtitle?.provenance?.creatorName === candidate.creatorName && extraSubs.some(track => track.id === subtitle?.id);
                        const q = online.result!.query;
                        const mismatch = q ? candidate.matchedEpisode !== q.episode && candidate.matchedEpisode !== q.episode + q.episodeOffset : session.episodeLabel && candidate.matchedEpisode !== Number(session.episodeLabel.split("E")[1]);
                        return (
                          <div key={candidate.id} className="online-candidate">
                            <button className={cx("opt", applied && "is-active")} disabled={Boolean(online.applying)} onClick={() => void applyOnline(online.result!, candidate.id)}>
                              {online.applying === candidate.id ? <Spinner size={16} /> : <Check size={18} className="opt-check" />}
                              <span>{candidate.creatorName}</span>
                              <small>{candidate.format.toUpperCase()}</small>
                              {mismatch && <small className="warn">{candidate.matchedEpisode}화</small>}
                              {candidate.confidence < 0.5 && <small className="warn">확인 필요</small>}
                            </button>
                            <a className="icon-btn icon-btn-s" href={candidate.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label={`${candidate.creatorName} 블로그 열기`} title="출처 열기"><ExternalLink size={15} /></a>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>}
              </section>
            </div>
          )}
          {panel === "subs" && subsView === "main" && (
            <footer className="panel-foot">
              <button className="panel-link" onClick={() => setSubsView("style")}>
                <SlidersHorizontal size={18} /><span>자막 설정</span>
                <small>{[subScale ? `${subScale}%` : { small: "작게", medium: "보통", large: "크게", xlarge: "더 크게" }[subSize], subOffset ? `싱크 ${subOffset > 0 ? "+" : ""}${subOffset.toFixed(1)}초` : null].filter(Boolean).join(" · ")}</small>
                <ChevronRight size={18} />
              </button>
            </footer>
          )}
          {panel === "subs" && subsView === "style" && (
            <div className="panel-body panel-form">
              <div className="pf-block">
                <span className="pf-label">싱크</span>
                <div className="sync-row">
                  <button className="seg-btn" aria-label="-0.5" onClick={() => nudgeSubs(-0.5)}>−0.5</button>
                  <button className="seg-btn" aria-label="-0.1" onClick={() => nudgeSubs(-0.1)}>−0.1</button>
                  <button className={cx("sync-value", subOffset !== 0 && "is-shifted")} onClick={() => nudgeSubs(-subOffset)} title="초기화">{subOffset > 0 ? "+" : ""}{subOffset.toFixed(1)}초</button>
                  <button className="seg-btn" aria-label="+0.1" onClick={() => nudgeSubs(0.1)}>+0.1</button>
                  <button className="seg-btn" aria-label="+0.5" onClick={() => nudgeSubs(0.5)}>+0.5</button>
                </div>
                <p className="panel-note">자막이 늦게 나오면 −, 빨리 나오면 +. 이 영상과 기기에만 저장돼요.</p>
              </div>
              <div className="pf-block">
                <span className="pf-label">모양</span>
                {settings && <SubtitleStyleControls variant="player" format={subtitle?.format} settings={settings} save={patch => void saveSettings(patch).catch(() => setNotice('자막 설정을 저장하지 못했어요. 다시 시도해 주세요.'))} />}
              </div>
            </div>
          )}
          {panel === "subs" && subsView === "translate" && (
            <TranslationView tracks={allSubs} current={subtitle} state={translation.state} appliedId={subtitle?.id} jimaku={jimaku.state} onSearch={query => void jimaku.search(query)}
              time={time} duration={total}
              onStart={source => void startTranslation(source)} onCancel={() => void cancelTranslation()}
              onApply={track => { chooseSubtitle(track); setSubsView("main"); }} />
          )}
          {panel === "subs" && subsView === "search" && subQuery && (
            <form className="panel-body panel-form sub-search" onSubmit={event => { event.preventDefault(); if (!subQuery.title.trim()) return; setSubsView("main"); void searchOnline({ ...subQuery, mapping: "manual" }); }}>
              <label className="pf-block">
                <span className="pf-label">작품 제목</span>
                <input className="pf-input" value={subQuery.title} maxLength={500} placeholder="예: 주술회전" onChange={e => setSubQuery({ ...subQuery, title: e.target.value })} />
              </label>
              <div className="sub-search-nums">
                <Stepper label="시즌" unit="기" value={subQuery.season} min={1} max={99} onChange={season => setSubQuery({ ...subQuery, season })} />
                <Stepper label="화수" unit="화" value={subQuery.episode} min={0} max={10000} onChange={episode => setSubQuery({ ...subQuery, episode })} />
              </div>
              <Stepper label="이전 시즌까지의 화수" unit="화" value={subQuery.episodeOffset} min={0} max={10000} onChange={episodeOffset => setSubQuery({ ...subQuery, episodeOffset })} />
              <p className="panel-note">영어 사이트는 화수를 처음부터 이어 세는 경우가 많아요. 예를 들어 ‘25화’가 실제로는 주술회전 2기 1화라면 시즌 2, 화수 1, 이전 시즌까지 24화로 맞춰 주세요. 자막 블로그에 ‘25화’로 올라온 자막도 함께 찾아요.</p>
              <div className="sub-search-actions">
                <button type="button" className="pf-reset" onClick={() => { setSubsView("main"); void searchOnline(undefined, true); }}>자동으로 다시 찾기</button>
                <Button type="submit" variant="primary" icon={<Search size={16} />} disabled={!subQuery.title.trim()}>이 조건으로 찾기</Button>
              </div>
            </form>
          )}
          {panel === "settings" && (
            <div className="panel-body panel-form">
              <PluginTools {...pluginPlayer} />
              <div className="pf-block">
                <span className="pf-label">재생 속도</span>
                <div className="seg seg-fill" role="group" aria-label="재생 속도" style={{ "--segments": SPEEDS.length, "--selected": SPEEDS.indexOf(speed) } as React.CSSProperties}>
                  {SPEEDS.map(value => (
                    <button key={value} className={cx(speed === value && "is-active")} aria-pressed={speed === value} onClick={() => changeSpeed(value)}>{value === 1 ? "1x" : `${value}x`}</button>
                  ))}
                </div>
              </div>
              <QualityControl levels={levels} level={level} onLevel={index => { setLevel(index); engine.current?.setLevel(index); }}
                streams={session.streams} streamId={session.streamId} onStream={switchServer}
                playingHeight={playingHeight} transcode={session.mode === "transcode"} />
              <ServerControl streams={session.streams} streamId={session.streamId} onStream={switchServer} />
              {!!session.streams?.length && (
                <button className="panel-link" onClick={() => { setPanel(null); setSourcePicker(true); }}><Shuffle size={18} /><span>다른 소스 선택</span><ChevronRight size={18} /></button>
              )}
              <div className="pf-row pf-switch">
                <div><b>화면 채우기</b><small>화면 비율에 맞춰 영상을 꽉 채워요. 가장자리가 조금 잘릴 수 있어요.</small></div>
                <button role="switch" aria-checked={fill} aria-label="화면 채우기" className={cx("switch", fill && "is-on")} onClick={() => changeFill(!fill)}><i /></button>
              </div>
              {!session.streams?.length && (
                <div className="pf-row pf-switch">
                  <div><b>호환 재생</b><small>영상이 검게 보이거나 자막만 나올 때 켜세요.</small></div>
                  <button role="switch" aria-checked={compatible} aria-label="호환 재생" className={cx("switch", compatible && "is-on")} onClick={() => { setPanel(null); switchCompatibility(!compatible, video.current?.currentTime || 0); }}><i /></button>
                </div>
              )}
              {(session.saved || playbackLocation === "source" && savedCopy) && (
                <div className="pf-row pf-location">
                  <div><b>{session.saved ? "서버 저장본으로 재생 중" : "원본 소스로 재생 중"}</b><small>{session.saved ? "소스 사이트와 관계없이 서버에 저장된 영상을 재생해요." : "이 회차는 서버에 저장본이 있어요."}</small></div>
                  <Button onClick={() => changeLocation(session.saved ? "source" : "auto")}>{session.saved ? "원본 소스로" : "저장본으로"}</Button>
                </div>
              )}
              {!live && (remoteSkip || Boolean(session.markers)) && <p className="panel-note" role="status">{markers ? `${session.mediaType === "anime" ? "오프닝·엔딩" : "오프닝·크레딧"} 건너뛰기 사용 가능` : skipStatus === "loading" ? "건너뛰기 구간 확인 중…" : skipStatus === "error" ? "건너뛰기 구간을 불러오지 못했어요" : session.mediaType === "anime" ? "이 회차는 건너뛰기 구간 정보가 없어요" : "이 영상은 건너뛰기 구간 정보가 없어요"}</p>}
            </div>
          )}
          {panel === "episodes" && (
            <ol className="panel-episodes">
              {episodes.map(episode => {
                const current = episode.id === session.episodeId;
                return (
                  <li key={episode.id}>
                    <Link to={`/watch/${encodeURIComponent(episode.id)}`} replace className={cx("panel-episode", current && "is-current")} aria-current={current ? "true" : undefined}>
                      <span className="panel-episode-thumb"><Artwork src={episode.thumb} title={episode.title} ratio="landscape" width={240} labelFallback={false} />{episode.progress && !episode.progress.completed && episode.duration ? <ProgressBar ratio={episode.progress.position / episode.duration} className="card-progress" /> : null}</span>
                      <span className="panel-episode-body"><b>{episode.name ? `${episode.number}. ${episode.name}` : /^\d+화$/.test(episodeTitle(episode.title)) ? episodeTitle(episode.title) : `${episode.number}. ${episodeTitle(episode.title)}`}</b><small>{current ? "재생 중" : episode.progress?.completed ? "시청 완료" : episode.duration ? clock(episode.duration) : ""}</small></span>
                      {current ? <span className="eq" aria-hidden="true"><i /><i /><i /></span> : episode.progress?.completed ? <Check size={18} className="panel-episode-done" /> : null}
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
