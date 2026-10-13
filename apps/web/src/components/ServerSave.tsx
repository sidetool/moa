import { AlertCircle, CircleCheck, Clock3, Download, HardDriveDownload } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DownloadBatchResult, DownloadJob, DownloadQuality } from "@moa/shared";
import { DOWNLOAD_QUALITY_OPTIONS, DOWNLOAD_STATE_LABEL, downloadErrorText, downloadRatio, useBatchDownload, useBatchDownloadPreview, useDownloadActions } from "../api/downloads";
import { ApiError } from "../lib/api";
import { cx, fileSize } from "../lib/format";
import { Button, ConfirmDialog, IconButton, ProgressBar } from "./ui";

const SETTINGS_PATH = "/settings#downloads";

/** What one episode shows. `pending` covers the tap until the server answers with a job. */
type View =
  | { kind: "idle"; cancelled?: boolean }
  | { kind: "pending" }
  | { kind: "queued" | "resolving" | "finalizing"; job: DownloadJob }
  | { kind: "downloading"; job: DownloadJob; ratio: number | null }
  | { kind: "ready"; job: DownloadJob }
  | { kind: "failed"; message: string };

export type DownloadEntry = { job?: DownloadJob; pending: boolean; error?: string };

export function downloadView({ job, pending, error }: DownloadEntry): View {
  if (job?.state === "ready") return { kind: "ready", job };
  if (job?.state === "downloading") return { kind: "downloading", job, ratio: downloadRatio(job) };
  if (job && (job.state === "queued" || job.state === "resolving" || job.state === "finalizing")) return { kind: job.state, job };
  if (pending) return { kind: "pending" };
  if (error) return { kind: "failed", message: error };
  if (job && (job.state === "failed" || job.state === "interrupted")) return { kind: "failed", message: downloadErrorText(job.error) ?? "다운로드하지 못했어요." };
  return { kind: "idle", cancelled: job?.state === "cancelled" };
}

function startError(error: unknown) {
  if (!(error instanceof ApiError)) return "다운로드를 시작하지 못했어요. 다시 시도해 주세요.";
  if (error.code.startsWith("download-")) return downloadErrorText(error.code)!;
  if (error.status === 422) return downloadErrorText("download-stream-unsupported")!;
  return "다운로드를 시작하지 못했어요. 다시 시도해 주세요.";
}

/** One-tap starts for a title page: per-episode pending marks and the last start error. */
export function useOneTapDownload() {
  const actions = useDownloadActions();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const inFlight = useRef(new Set<string>()); // synchronous guard against double taps before the re-render
  const start = async (episodeId: string) => {
    if (inFlight.current.has(episodeId)) return;
    inFlight.current.add(episodeId);
    setPending(old => new Set(old).add(episodeId));
    setErrors(old => { if (!old.has(episodeId)) return old; const next = new Map(old); next.delete(episodeId); return next; });
    try { await actions.enqueue(episodeId); }
    catch (cause) {
      // Already running or saved elsewhere: the refreshed list shows that state, no error needed.
      if (!(cause instanceof ApiError && cause.code === "download-already-exists")) setErrors(old => new Map(old).set(episodeId, startError(cause)));
    } finally { inFlight.current.delete(episodeId); setPending(old => { const next = new Set(old); next.delete(episodeId); return next; }); }
  };
  return { entry: (episodeId: string, job?: DownloadJob): DownloadEntry => ({ job, pending: pending.has(episodeId), error: errors.get(episodeId) }), start };
}

const percent = (ratio: number | null) => ratio === null ? "" : ` ${Math.round(ratio * 100)}%`;

/** Short spoken/visible state, shared by the icon label and the status line. */
function stateText(view: View) {
  switch (view.kind) {
    case "idle": return "다운로드";
    case "pending": return "다운로드 요청 중";
    case "queued": return "다운로드 대기 중";
    case "resolving": return "영상 확인 중";
    case "finalizing": return "마무리 중";
    case "downloading": return `다운로드 중${percent(view.ratio)}`;
    case "ready": return "다운로드됨";
    case "failed": return "다운로드 실패";
  }
}

function StateIcon({ view, size }: { view: View; size: number }) {
  if (view.kind === "ready") return <CircleCheck size={size} />;
  if (view.kind === "failed") return <AlertCircle size={size} />;
  if (view.kind === "queued") return <Clock3 size={size} />;
  if (view.kind === "downloading" && view.ratio !== null) return <span className="save-ring" style={{ "--ratio": view.ratio, "--size": `${size}px` } as React.CSSProperties} aria-hidden="true" />;
  if (view.kind === "idle") return <Download size={size} />;
  return <span className="save-ring is-spin" style={{ "--size": `${size}px` } as React.CSSProperties} aria-hidden="true" />;
}

const opensList = (view: View) => view.kind !== "idle" && view.kind !== "failed" && view.kind !== "pending";

/** Per-episode icon: tap downloads (or retries); while running or done it opens the download list. */
export function EpisodeDownloadButton({ entry, title, onStart }: { entry: DownloadEntry; title: string; onStart: () => void }) {
  const view = downloadView(entry);
  const className = cx("icon-btn icon-btn-s episode-save", `is-${view.kind}`);
  if (opensList(view)) {
    const label = `${title} ${stateText(view)} · 다운로드 목록 보기`;
    return <Link to={SETTINGS_PATH} className={className} data-remote-secondary aria-label={label} title={label}><StateIcon view={view} size={20} /></Link>;
  }
  const label = view.kind === "failed" ? `${title} 다시 다운로드` : view.kind === "pending" ? `${title} 다운로드 요청 중` : `${title} 다운로드`;
  return <button type="button" className={className} data-remote-secondary aria-label={label} title={label} aria-busy={view.kind === "pending"} disabled={view.kind === "pending"} onClick={onStart}>
    <StateIcon view={view} size={20} />
  </button>;
}

/** One-line state under the episode (or below the movie actions), readable without hovering. */
export function DownloadStatusLine({ entry, className }: { entry: DownloadEntry; className?: string }) {
  const view = downloadView(entry);
  if (view.kind === "idle" && !view.cancelled) return null;
  const detail = view.kind === "failed" ? view.message
    : view.kind === "downloading" ? (view.job.totalBytes ? `${fileSize(view.job.bytes)} / ${fileSize(view.job.totalBytes)}` : view.job.bytes ? fileSize(view.job.bytes) : "")
    : view.kind === "ready" ? [view.job.quality, fileSize(view.job.totalBytes ?? view.job.bytes)].filter(Boolean).join(" · ")
    : view.kind === "queued" ? "곧 시작해요" : "";
  const text = view.kind === "idle" ? `다운로드 ${DOWNLOAD_STATE_LABEL.cancelled}` : stateText(view);
  return <span className={cx("download-status", `is-${view.kind}`, className)}>
    <span className="download-status-text"><b>{text}</b>{detail && <span> · {detail}</span>}</span>
    {view.kind === "downloading" && <ProgressBar ratio={view.ratio ?? 0} className={cx("download-progress", view.ratio === null && "is-indeterminate")} />}
  </span>;
}

/** Hero action for a movie (single episode). */
export function MovieDownloadButton({ entry, onStart }: { entry: DownloadEntry; onStart: () => void }) {
  const view = downloadView(entry);
  const className = cx("movie-download", `is-${view.kind}`);
  if (opensList(view)) return <Link to={SETTINGS_PATH} className={cx("btn btn-secondary btn-l", className)} aria-label={`${stateText(view)} · 다운로드 목록 보기`}>
    <StateIcon view={view} size={20} /><span>{stateText(view)}</span>
  </Link>;
  return <Button variant="secondary" size="l" className={className} icon={<StateIcon view={view} size={20} />} aria-busy={view.kind === "pending"} disabled={view.kind === "pending"} onClick={onStart}>
    {view.kind === "failed" ? "다시 다운로드" : view.kind === "pending" ? "요청 중…" : "다운로드"}
  </Button>;
}

/** Queues every episode of the shown season (or the whole title when it has no seasons) in one server request.
 *  A short count check comes first; the parent shows the result with `BatchDownloadResultLine`. */
export function BatchDownload({ mediaId, season, label, quality, onDone }: { mediaId: string; season?: number; label: string; quality?: DownloadQuality; onDone: (result: DownloadBatchResult | null) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // a second tap before the re-render must not send another POST
  const preview = useBatchDownloadPreview(mediaId, season, open);
  const queue = useBatchDownload();
  const eligible = preview.data?.eligible ?? 0;
  const qualityLabel = DOWNLOAD_QUALITY_OPTIONS.find(item => item.value === quality)?.label;
  const close = () => { if (!busy) { setOpen(false); setError(null); } };
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { onDone(await queue(mediaId, season)); setOpen(false); }
    catch (cause) { setError(cause instanceof ApiError && cause.code.startsWith("download-") ? downloadErrorText(cause.code) : "다운로드를 추가하지 못했어요. 다시 시도해 주세요."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    <IconButton label={`${label} 다운로드`} className="batch-save" data-remote-secondary disabled={busy} onClick={() => { onDone(null); setOpen(true); }}><HardDriveDownload size={18} /></IconButton>
    {open && <ConfirmDialog title={`${label} 다운로드`} className="batch-dialog" busy={busy} confirmDisabled={!eligible || preview.isFetching}
      confirmLabel={eligible ? `${eligible}화 받기` : "받기"} onConfirm={() => void confirm()} onClose={close}>
      {preview.isPending ? <p>회차를 확인하는 중…</p>
        : preview.isError ? <p className="settings-error">회차를 확인하지 못했어요. 닫고 다시 시도해 주세요.</p>
        : !eligible ? <p>받을 회차가 없어요. 모두 받았거나 받는 중이에요.</p>
        : <>
          <p><b>{eligible}화</b>를 다운로드 대기열에 넣어요.</p>
          <ul className="batch-facts">
            {preview.data.skipped > 0 && <li>이미 받았거나 받는 중인 {preview.data.skipped}화는 빼요</li>}
            {qualityLabel && <li>화질 {qualityLabel} · 다운로드 설정 기준</li>}
          </ul>
        </>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </ConfirmDialog>}
  </>;
}

export function BatchDownloadResultLine({ result }: { result: DownloadBatchResult }) {
  return <p className="batch-result" role="status">
    <span>{result.added ? <><b>{result.added}화</b>를 다운로드 대기열에 넣었어요{result.skipped ? ` · ${result.skipped}화는 이미 있어요` : ""}</> : "새로 받을 회차가 없어요. 모두 받았거나 받는 중이에요."}</span>
    <Link to={SETTINGS_PATH}>목록 보기</Link>
  </p>;
}
