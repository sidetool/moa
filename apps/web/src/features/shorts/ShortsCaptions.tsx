import { Captions, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMe, useSettings } from "../../api/queries";
import { translateShortSubtitle, type ShortsNativeSession, type ShortsNativeSubtitle } from "../../api/shorts";
import { cancelTranslationJob, fetchTranslationJob, terminalJob, translationModeOf, useTranslationConfig, type TranslationJob } from "../../api/translation";

const POLL_MS = 1_500;
const langOf = (track: ShortsNativeSubtitle, lang: string) => track.lang.toLowerCase().split(/[-_]/)[0] === lang;

/** Loads one WebVTT file into a hidden text track and returns the current cue lines as plain text. */
function useCueText(video: HTMLVideoElement, url: string | null, revision: number) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!url) return;
    const abort = new AbortController();
    let element: HTMLTrackElement | null = null, blob = "";
    const update = () => {
      const cues = element?.track.activeCues;
      // getCueAsHTML parses markup and entities safely; only its text is used.
      setLines(cues ? [...cues].flatMap(cue => ((cue as VTTCue).getCueAsHTML?.().textContent ?? (cue as VTTCue).text ?? "").split("\n")).filter(line => line.trim()) : []);
    };
    fetch(url, { signal: abort.signal, credentials: "same-origin", cache: "no-store" }).then(response => response.ok ? response.text() : Promise.reject(new Error("vtt"))).then(text => {
      if (abort.signal.aborted) return;
      blob = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      element = Object.assign(document.createElement("track"), { kind: "subtitles", src: blob });
      element.addEventListener("load", () => { if (element) element.track.mode = "hidden"; update(); });
      element.track.addEventListener("cuechange", update);
      video.append(element);
      element.track.mode = "hidden";
    }, () => {});
    return () => {
      abort.abort();
      if (element) { element.track.removeEventListener("cuechange", update); element.track.mode = "disabled"; element.remove(); }
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [video, url, revision]);
  return lines;
}

/** Captions for the playing direct-mode trailer: original tracks, optional translation through the existing
 *  queue, and a compact CC menu placed in the action rail. Everything stops with the player. */
export function ShortsCaptions({ video, prepared, rail, info }: { video: HTMLVideoElement; prepared: ShortsNativeSession; rail: HTMLElement | null; info: HTMLElement | null }) {
  const settings = useSettings().data, me = useMe().data;
  const tracks = prepared.subtitles ?? [];
  const allowed = me?.role === "admin" || Boolean(me?.permissions?.includes("subtitles.translate"));
  const config = useTranslationConfig();
  const canTranslate = allowed && tracks.length > 0 && config.data?.enabled === true && config.data?.configured === true;
  // The translator writes Korean only. Any Korean track wins; otherwise the profile's language if present.
  const pref = (settings?.defaultSubtitleLang || "ko").toLowerCase().split(/[-_]/)[0];
  const korean = tracks.find(track => langOf(track, "ko") && !track.auto) ?? tracks.find(track => langOf(track, "ko"));
  const preferred = korean ?? tracks.find(track => langOf(track, pref) && !track.auto) ?? tracks.find(track => langOf(track, pref));
  const source = tracks.find(track => !track.auto && langOf(track, "en")) ?? tracks.find(track => !track.auto) ?? tracks[0];
  // Offered unless a proper Korean track exists (a Korean auto track can still be replaced on request).
  const offerTranslation = canTranslate && !(korean && !korean.auto);
  const [choice, setChoice] = useState<string>(() => preferred?.id ?? "off");
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [bottom, setBottom] = useState(0);
  const menu = useRef<HTMLDivElement>(null);
  const stopTranslation = useRef<() => void>(() => {});
  const autoTried = useRef(false);

  /** Stops polling and cancels a job that is still running; nothing restarts by itself. */
  const stop = () => { stopTranslation.current(); stopTranslation.current = () => {}; };
  const translate = () => {
    if (!source) return;
    stop();
    setFailed(false); setJob(null); setChoice("translation");
    let alive = true, current: TranslationJob | null = null, timer = 0;
    const abort = new AbortController();
    const cancel = (job: TranslationJob) => { if (!terminalJob(job)) cancelTranslationJob(job.id, true).catch(() => {}); };
    const back = () => setChoice(old => old === "translation" ? source.id : old);
    const settle = (next: TranslationJob) => {
      if (!alive) return cancel(next); // an answer after stopping still ends its job
      current = next; setJob(next);
      if (next.state === "failed" || next.state === "cancelled") { setFailed(true); back(); return; }
      if (!terminalJob(next)) timer = window.setTimeout(() => fetchTranslationJob(next.id, abort.signal).then(settle, fail), POLL_MS);
    };
    // Polling failure: end the known job too, so falling back to the original stops the paid work.
    const fail = () => {
      if (!alive) return;
      alive = false; abort.abort(); window.clearTimeout(timer);
      if (current) cancel(current);
      setFailed(true); back();
    };
    // The start request is not aborted: its answer carries the job id, and a late one is cancelled in settle.
    translateShortSubtitle(prepared.sessionId, source.id).then(settle, fail);
    stopTranslation.current = () => { alive = false; abort.abort(); window.clearTimeout(timer); if (current) cancel(current); };
  };
  useEffect(() => () => { stop(); autoTried.current = false; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto mode only, once, after settings/account/config are known, and only without any Korean track.
  const known = Boolean(settings && me && !config.isPending);
  useEffect(() => {
    if (!known || autoTried.current) return;
    autoTried.current = true;
    if (translationModeOf(settings) === "auto" && canTranslate && !korean) translate();
  }, [known]); // eslint-disable-line react-hooks/exhaustive-deps

  const translated = job?.track?.url && (job.partial || job.state === "completed") ? job.track.url : null;
  const shown = choice === "off" ? null : choice === "translation" ? translated ?? source?.url ?? null : tracks.find(track => track.id === choice)?.url ?? null;
  const lines = useCueText(video, shown, choice === "translation" ? job?.revision ?? 0 : 0);

  // Captions stay above the title block, whatever its height.
  useEffect(() => {
    if (!info) return;
    const observer = new ResizeObserver(() => setBottom(info.offsetHeight));
    observer.observe(info);
    return () => observer.disconnect();
  }, [info]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!(event.target instanceof Node && menu.current?.parentElement?.contains(event.target))) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  // Picking the translation again after a failure is the one explicit retry path.
  // Leaving the translation stops its paid work; choosing it again starts a new one.
  const pick = (value: string) => {
    setOpen(false);
    if (value === "translation") { if (choice !== "translation") translate(); return; }
    if (choice === "translation") { stop(); setJob(null); }
    setChoice(value);
  };
  const progress = job && !terminalJob(job) && job.total ? ` ${Math.round((job.done / job.total) * 100)}%` : "";
  const item = (value: string, label: string) => <button key={value} type="button" role="menuitemradio" aria-checked={choice === value} className="shorts-cc-item" onClick={() => pick(value)}>
    <span>{label}</span>{choice === value && <Check size={16} />}
  </button>;

  return <>
    {lines.length > 0 && <div className="shorts-captions" style={{ bottom: bottom + 40 }} aria-live="off">{lines.map((line, index) => <span key={index}>{line}</span>)}</div>}
    {rail && tracks.length > 0 && createPortal(<span className="shorts-cc">
      <button type="button" className="shorts-rail-btn" aria-label="자막" title="자막" aria-haspopup="menu" aria-expanded={open} aria-pressed={choice !== "off"} onClick={() => setOpen(value => !value)}>
        <span className="shorts-rail-icon"><Captions size={24} /></span><small aria-hidden="true">자막</small>
      </button>
      {open && <div className="shorts-cc-menu" role="menu" ref={menu}>
        {item("off", "끄기")}
        {tracks.map(track => item(track.id, track.auto ? `${track.label} · 자동` : track.label))}
        {(offerTranslation || choice === "translation") && item("translation", `한국어 번역${progress}`)}
        {failed && <small className="shorts-cc-note" role="status">번역하지 못했어요</small>}
      </div>}
    </span>, rail)}
  </>;
}
