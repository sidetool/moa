import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, CircleAlert, ExternalLink, FileUp, Languages, Pencil, RotateCw, Search, X } from "lucide-react";
import type { SubtitleTrack } from "@moa/shared";
import { isTranslationTrack, type JimakuCandidate, type JimakuQuery, type JimakuSearch, type TranslatedRange, type TranslationConfig } from "../../api/translation";
import { Button, Spinner } from "../../components/ui";
import { cx } from "../../lib/format";
import { isRemoteMode, type RemotePlayerEvent } from "../../lib/remote";
import { jimakuSource, type JimakuState } from "./jimaku";
import { Stepper } from "../Stepper";
import { LANG_NAME, trackName } from "../subtitles/track-name";
import type { TranslationOffer } from "./translation-autopilot";
import { contentSource, readSubtitleFile, readTrack, type TranslationSource, type TranslationState } from "./subtitle-translation";

import { isKorean, subtitleLanguage } from "../subtitles/subtitle-language";
export { isKorean } from "../subtitles/subtitle-language";
const PREFERRED = new Set(["en", "ja"]);

/** Foreign tracks that can be translated; English and Japanese first. */
export function translatableTracks(tracks: SubtitleTrack[]) {
  return tracks
    .filter(track => !isTranslationTrack(track) && !isKorean(track))
    .sort((a, b) => Number(PREFERRED.has(subtitleLanguage(b) ?? "")) - Number(PREFERRED.has(subtitleLanguage(a) ?? "")));
}

export const trackSource = (track: SubtitleTrack) => contentSource(trackName(track), subtitleLanguage(track), signal => readTrack(track, signal));
const available = (config?: TranslationConfig) => Boolean(config?.configured && config.enabled);
const percent = (done: number, total: number) => total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
const queryLabel = (query: JimakuQuery) => `${query.title} · 시즌 ${query.season} · ${query.episode}화`;

/** Compact row in the subtitle list; opens the translation view. */
export function TranslationEntry({ config, admin, state, tracks, onOpen }: { config?: TranslationConfig; admin: boolean; state: TranslationState; tracks: SubtitleTrack[]; onOpen: () => void }) {
  if (!config) return null;
  if (!available(config)) {
    if (!admin) return null;
    return <Link className="opt opt-action translate-entry" to="/settings#translation"><Languages size={18} /><span>한국어로 번역</span><small>설정 필요</small><ChevronRight size={16} className="translate-chevron" /></Link>;
  }
  if (state.status === "reading" || state.status === "active") {
    const p = state.status === "active" ? percent(state.job.done, state.job.total) : 0;
    return (
      <button className="opt opt-action translate-entry is-busy" onClick={onOpen} aria-label={`번역 진행 중 ${p}%`}>
        <Spinner size={16} /><span>한국어로 번역 중{p ? ` · ${p}%` : "…"}</span>
        <i className="translate-mini" aria-hidden="true"><i style={{ width: `${p}%` }} /></i>
      </button>
    );
  }
  if (state.status === "failed") return <button className="opt opt-action translate-entry is-failed" onClick={onOpen}><CircleAlert size={18} /><span>번역하지 못했어요 · 다시 시도</span></button>;
  // Only a hint inside the menu: nothing is searched or translated until the viewer asks.
  const noKorean = !tracks.some(isKorean);
  const hint = noKorean ? translatableTracks(tracks).length ? "한국어 자막이 없어요 · 이 영상의 자막을 번역할 수 있어요" : "한국어 자막이 없어요 · 일본어 자막을 찾아 번역할 수 있어요" : null;
  return (
    <button className={cx("opt opt-action translate-entry", hint && "has-hint")} onClick={onOpen}>
      <Languages size={18} />
      <span>한국어로 번역{hint && <em>{hint}</em>}</span>
      <small>AI</small><ChevronRight size={16} className="translate-chevron" />
    </button>
  );
}

type Picked =
  | { kind: "track"; track: SubtitleTrack }
  | { kind: "file"; name: string; source: TranslationSource }
  | { kind: "jimaku"; search: JimakuSearch; candidate: JimakuCandidate };

/** Source picker (session tracks, a file, Jimaku), progress, cancel, error and retry for one translation. */
export function TranslationView({ tracks, current, state, appliedId, jimaku, time, duration, onSearch, onStart, onCancel, onApply }: {
  tracks: SubtitleTrack[];
  time: number;
  duration: number;
  current: SubtitleTrack | null;
  state: TranslationState;
  appliedId?: string;
  jimaku: JimakuState;
  onSearch: (query?: JimakuQuery) => void;
  onStart: (source: TranslationSource) => void;
  onCancel: () => void;
  onApply: (track: SubtitleTrack) => void;
}) {
  const candidates = translatableTracks(tracks);
  const initial = candidates.find(track => track.id === current?.id) ?? candidates[0];
  const [picked, setPicked] = useState<Picked | null>(initial ? { kind: "track", track: initial } : null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Without a foreign track to translate, Jimaku is the likely source; searching is free, so start it right away.
  useEffect(() => {
    if (!candidates.length && jimaku.status === "idle") onSearch();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Preselect the best Jimaku match when nothing else is chosen; translating still needs a press.
  useEffect(() => {
    if (picked || jimaku.status !== "done") return;
    const best = jimaku.result.candidates.find(item => item.match !== "unverified");
    if (best) setPicked({ kind: "jimaku", search: jimaku.result, candidate: best });
  }, [jimaku]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = async (file?: File) => {
    if (!file) return;
    setFileError(null); setReading(true);
    try {
      const loaded = await readSubtitleFile(file);
      setPicked({ kind: "file", name: file.name, source: contentSource(file.name, undefined, async () => loaded) });
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "자막 파일을 읽지 못했어요.");
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  };

  if (state.status === "reading" || state.status === "active") {
    const job = state.status === "active" ? state.job : null;
    const p = job ? percent(job.done, job.total) : 0;
    const label = state.status === "active" ? state.label : state.source.label;
    const live = Boolean(job?.track && appliedId === job.track.id);
    return (
      <div className="panel-body panel-form translate-view">
        <div className="translate-progress" role="status" aria-live="polite">
          <div className="translate-progress-head"><b>{label}</b><span>→ 한국어</span></div>
          {job && job.total && duration > 0
            ? <Timeline ranges={job.translatedRanges} time={time} duration={duration} percent={p} />
            : <div className="translate-bar" role="progressbar" aria-label="번역 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}><i style={{ width: `${Math.max(job && job.total ? 2 : 0, p)}%` }} className={cx(!job?.total && "is-indeterminate")} /></div>}
          <small>{!job ? "원문 자막을 준비하는 중…" : job.state === "queued" ? "번역 대기 중…" : job.total ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()}줄 · ${p}%` : "번역 준비 중…"}</small>
        </div>
        <p className="panel-note">{live
          ? "번역된 부분은 지금 자막에 바로 나와요. 다른 장면으로 이동하면 그 부분부터 번역해요."
          : job?.track ? "번역된 부분부터 볼 수 있어요. 패널을 닫아도 번역은 계속돼요."
          : "지금 보는 장면 근처부터 번역해요. 첫 부분이 끝나면 바로 자막에 나와요."}</p>
        <div className="translate-actions">
          {job?.track && !live && <Button variant="primary" onClick={() => onApply(job.track!)}>번역된 부분 보기</Button>}
          <Button variant="secondary" icon={<X size={16} />} onClick={onCancel}>번역 취소</Button>
        </div>
      </div>
    );
  }

  const done = state.status === "completed" ? state.job : null;
  const start = () => {
    if (picked?.kind === "track") onStart(trackSource(picked.track));
    else if (picked?.kind === "file") onStart(picked.source);
    else if (picked?.kind === "jimaku") onStart(jimakuSource(picked.search, picked.candidate));
  };

  const own = (
    <div className="pf-block">
      <span className="pf-label">{candidates.length ? "이 영상의 자막" : "자막 파일"}</span>
      <div className="pf-list" role="radiogroup" aria-label="원문 자막">
        {candidates.map(track => {
          const lang = subtitleLanguage(track);
          const active = picked?.kind === "track" && picked.track.id === track.id;
          return (
            <button key={track.id} role="radio" aria-checked={active} className={cx("opt", active && "is-active")} onClick={() => setPicked({ kind: "track", track })}>
              <Check size={18} className="opt-check" /><span>{trackName(track)}</span>
              {lang && !PREFERRED.has(lang) && <small>{LANG_NAME[lang] ?? lang}</small>}
              {track.id === current?.id && <small>보는 중</small>}
            </button>
          );
        })}
        <button role="radio" aria-checked={picked?.kind === "file"} className={cx("opt", picked?.kind === "file" && "is-active")} disabled={reading} onClick={() => input.current?.click()}>
          {reading ? <Spinner size={16} /> : picked?.kind === "file" ? <Check size={18} className="opt-check" /> : <FileUp size={18} className="translate-file-icon" />}
          <span>{picked?.kind === "file" ? picked.name : "자막 파일 불러오기"}</span>
          {picked?.kind === "file" ? <small>바꾸기</small> : <small>ASS·SRT·VTT·SMI</small>}
        </button>
        <input ref={input} type="file" hidden accept=".ass,.ssa,.srt,.vtt,.smi,.sami,text/vtt" onChange={event => void pickFile(event.target.files?.[0])} />
      </div>
      {fileError && <p className="panel-note note-warn" role="alert">{fileError}</p>}
    </div>
  );
  const jimakuBlock = <JimakuBlock state={jimaku} picked={picked?.kind === "jimaku" ? picked.candidate.id : undefined} onSearch={onSearch}
    onPick={(search, candidate) => setPicked({ kind: "jimaku", search, candidate })} />;

  return (
    <div className="panel-body panel-form translate-view">
      {done?.track && (
        <div className="translate-done" role="status">
          <Check size={18} /><span>번역을 마쳤어요{done.cached ? " · 저장된 번역" : ""}</span>
          {appliedId !== done.track.id && <button className="pf-reset" onClick={() => onApply(done.track!)}>적용</button>}
        </div>
      )}
      {state.status === "failed" && <p className="panel-note note-warn translate-error" role="alert"><CircleAlert size={16} /><span>{state.message}{state.job?.track ? " 번역된 부분은 그대로 볼 수 있어요." : ""}</span></p>}
      {candidates.length ? <>{own}{jimakuBlock}</> : <>{jimakuBlock}{own}</>}
      <p className="panel-note">설정한 AI 서비스로 번역하며 API 사용료가 발생할 수 있어요. 번역한 자막은 저장돼 다시 열 때 비용이 들지 않아요.</p>
      <div className="translate-actions">
        <Button variant="primary" icon={<Languages size={16} />} disabled={!picked || reading} onClick={start}>{state.status === "failed" ? "다시 시도" : "번역 시작"}</Button>
      </div>
    </div>
  );
}

function JimakuBlock({ state, picked, onSearch, onPick }: { state: JimakuState; picked?: string; onSearch: (query?: JimakuQuery) => void; onPick: (search: JimakuSearch, candidate: JimakuCandidate) => void }) {
  const [editing, setEditing] = useState<JimakuQuery | null>(null);
  const [showAll, setShowAll] = useState(false);
  const result = state.status === "done" ? state.result : null;
  const verified = result?.candidates.filter(item => item.match !== "unverified") ?? [];
  const unverified = result?.candidates.filter(item => item.match === "unverified") ?? [];
  const shown = showAll || !verified.length ? [...verified, ...unverified] : verified;

  return (
    <div className="pf-block jimaku">
      <span className="pf-label">Jimaku 일본어 자막</span>
      {editing ? (
        <form className="jimaku-query-form" onSubmit={event => { event.preventDefault(); if (!editing.title.trim()) return; setEditing(null); setShowAll(false); onSearch(editing); }}>
          <label className="pf-block">
            <span className="pf-label">작품 제목</span>
            <input className="pf-input" value={editing.title} maxLength={300} placeholder="일본어·영어 제목이 잘 찾아져요" onChange={e => setEditing({ ...editing, title: e.target.value })} />
          </label>
          <div className="sub-search-nums">
            <Stepper label="시즌" unit="" value={editing.season} min={1} max={99} onChange={season => setEditing({ ...editing, season })} />
            <Stepper label="화수" unit="화" value={editing.episode} min={0} max={10000} onChange={episode => setEditing({ ...editing, episode })} />
          </div>
          <div className="sub-search-actions">
            <button type="button" className="pf-reset" onClick={() => setEditing(null)}>취소</button>
            <Button type="submit" variant="primary" icon={<Search size={16} />} disabled={!editing.title.trim()}>이 조건으로 찾기</Button>
          </div>
        </form>
      ) : <>
        {result && (
          <button className="online-query" onClick={() => setEditing(result.query)} aria-label="Jimaku 검색 조건 바꾸기">
            <Search size={15} aria-hidden="true" /><span>{queryLabel(result.query)}</span><Pencil size={14} aria-hidden="true" />
          </button>
        )}
        <div className="pf-list" role="radiogroup" aria-label="Jimaku 자막">
          {state.status === "idle" && <button className="opt opt-action" onClick={() => onSearch()}><Search size={18} /><span>Jimaku에서 일본어 자막 찾기</span></button>}
          {state.status === "searching" && <div className="online-searching" role="status"><Spinner size={16} /><span>Jimaku에서 찾는 중…</span></div>}
          {state.status === "error" && <button className="opt opt-action" onClick={() => onSearch()}><RotateCw size={18} /><span>{state.message}</span></button>}
          {result && shown.map(candidate => (
            <div key={candidate.id} className="online-candidate">
              <button role="radio" aria-checked={picked === candidate.id} className={cx("opt jimaku-candidate", picked === candidate.id && "is-active")} onClick={() => onPick(result, candidate)}>
                <Check size={18} className="opt-check" />
                <span><b>{candidate.filename}</b><em>{candidate.title}</em></span>
                <small>{candidate.format.toUpperCase()}</small>
                {candidate.match === "unverified" ? <small className="warn">회차 확인 안 됨</small> : candidate.match === "movie" ? <small>영화</small> : candidate.episode !== undefined ? <small>{candidate.episode}화</small> : null}
              </button>
              <a className="icon-btn icon-btn-s" href={candidate.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label={`${candidate.filename} Jimaku에서 보기`} title="출처 열기"><ExternalLink size={15} /></a>
            </div>
          ))}
        </div>
        {result?.warning && <p className="panel-note note-warn">{result.warning}</p>}
        {result && !verified.length && unverified.length > 0 && <p className="panel-note note-warn">회차가 확인된 파일이 없어요. 파일 이름을 보고 맞는 자막을 골라 주세요.</p>}
        {result && verified.length > 0 && unverified.length > 0 && (
          <button className="pf-reset jimaku-more" onClick={() => setShowAll(value => !value)}>{showAll ? "회차 확인된 파일만 보기" : `회차 확인 안 된 파일 ${unverified.length}개 더 보기`}</button>
        )}
        {result && !result.candidates.length && <p className="panel-note">‘{result.query.title}’ 자막을 찾지 못했어요. 제목이나 회차를 바꿔 보세요.</p>}
      </>}
    </div>
  );
}

/** Episode timeline with the stretches that already have translated cues, and the playhead. */
function Timeline({ ranges, time, duration, percent }: { ranges: TranslatedRange[]; time: number; duration: number; percent: number }) {
  const at = (seconds: number) => `${Math.max(0, Math.min(100, seconds / duration * 100))}%`;
  // Ranges are per translated cue; pauses between lines would draw a dotted bar, so join short gaps for display.
  const blocks = ranges.slice().sort((a, b) => a.start - b.start).reduce<TranslatedRange[]>((list, range) => {
    const last = list.at(-1);
    if (last && range.start - last.end < 20) last.end = Math.max(last.end, range.end); else list.push({ ...range });
    return list;
  }, []);
  return (
    <div className="translate-bar translate-timeline" role="progressbar" aria-label="번역 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      {blocks.map(range => <i key={`${range.start}-${range.end}`} style={{ left: at(range.start), width: `max(2px, ${(range.end - range.start) / duration * 100}%)` }} />)}
      <b className="translate-playhead" style={{ left: at(time) }} aria-hidden="true" />
    </div>
  );
}

/**
 * Suggestion shown once when an episode has no Korean subtitle (ask mode, or anything uncertain in auto mode).
 * Remote: never takes focus by itself (OK must not start a paid translation by accident); arrows reach it,
 * entering lands on the main action, and Back closes it before leaving the player.
 */
export function TranslationOfferCard({ offer, onAccept, onChoose, onDismiss }: { offer: TranslationOffer; onAccept: () => void; onChoose: () => void; onDismiss: () => void }) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  // Layout effect: registered before the player's own remote handler, so Back is handled here first.
  useLayoutEffect(() => {
    const blocked = () => Boolean(document.querySelector('[aria-modal="true"],.player-panel'));
    const onRemote = (raw: Event) => {
      const event = raw as RemotePlayerEvent;
      if (event.detail.key !== "Back" || event.defaultPrevented || blocked()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isRemoteMode() || blocked()) return;
      event.preventDefault();
      dismiss.current();
    };
    window.addEventListener("moa:remote-key", onRemote);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("moa:remote-key", onRemote); window.removeEventListener("keydown", onKey, true); };
  }, []);

  const text = offer.kind === "choose" ? "어느 자막이 이 회차에 맞는지 확실하지 않아요. 번역할 자막을 골라 주세요."
    : offer.kind === "jimaku" ? "Jimaku에서 일본어 자막을 찾았어요. AI로 번역할까요?"
    : `${offer.label} 자막을 AI로 번역할까요?`;
  return (
    <div className="translate-offer" role="dialog" aria-label="한국어 자막 번역 제안" data-remote-group>
      <span className="translate-offer-icon" aria-hidden="true"><Languages size={20} /></span>
      <div className="translate-offer-body">
        <b>한국어 자막이 없어요</b>
        <p>{text}</p>
        {offer.kind === "jimaku" && <small className="translate-offer-file">{offer.source.label}</small>}
        {offer.kind !== "choose" && <small>자막 내용이 설정한 AI 서비스로 전송되고 사용료가 발생할 수 있어요</small>}
        <div className="translate-offer-actions">
          {offer.kind !== "choose"
            ? <><Button variant="primary" icon={<Languages size={16} />} data-remote-entry onClick={onAccept}>번역하기</Button><Button variant="ghost" onClick={onChoose}>다른 자막</Button></>
            : <Button variant="primary" data-remote-entry onClick={onChoose}>자막 고르기</Button>}
        </div>
        {isRemoteMode() && <small className="translate-offer-keys">방향키로 선택 · 뒤로 버튼으로 닫기</small>}
      </div>
      <button className="icon-btn translate-offer-close" aria-label="번역 제안 닫기" onClick={onDismiss}><X size={18} /></button>
    </div>
  );
}
