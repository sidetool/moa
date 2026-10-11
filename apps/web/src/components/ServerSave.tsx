import { AlertCircle, Check, HardDriveDownload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { DownloadJob } from "@moa/shared";
import { ACTIVE_DOWNLOAD, DOWNLOAD_STATE_LABEL, downloadErrorText, downloadRatio, fetchDownloadChoices, useDownloadActions } from "../api/downloads";
import { ApiError } from "../lib/api";
import { cx } from "../lib/format";
import { Button, ConfirmDialog, Spinner } from "./ui";

const SETTINGS_PATH = "/settings#downloads";

function startError(error: unknown) {
  if (!(error instanceof ApiError)) return "저장을 시작하지 못했어요.";
  if (error.code.startsWith("download-") && error.code !== "download-failed") return downloadErrorText(error.code)!;
  if (error.status === 422) return downloadErrorText("download-stream-unsupported")!;
  if (error.status === 409) return "이 회차는 이미 저장 중이거나 저장돼 있어요.";
  if (error.status === 507 || /quota|space|storage/.test(error.code)) return "저장 한도나 디스크 공간이 부족해요.";
  if (error.status === 410 || /selection|token|expired/.test(error.code)) return "선택 시간이 지났어요. 목록을 새로 불러왔으니 다시 골라 주세요.";
  return error.message && error.message !== error.code ? error.message : "저장을 시작하지 못했어요.";
}

/** Pick a quality/server for one episode. Choices are short-lived; nothing but their opaque id goes back. */
export function SaveDialog({ episodeId, title, onClose }: { episodeId: string; title: string; onClose: () => void }) {
  const actions = useDownloadActions();
  const choices = useQuery({ queryKey: ["download-choices", episodeId], queryFn: ({ signal }) => fetchDownloadChoices(episodeId, signal), retry: false, staleTime: 0, gcTime: 0 });
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = choices.data?.choices ?? [];
  useEffect(() => { if (!list.some(choice => choice.id === picked)) setPicked(list[0]?.id); }, [choices.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!picked || !choices.data) return;
    setBusy(true); setError(undefined);
    try { await actions.start(episodeId, choices.data.selectionToken, picked); onClose(); }
    catch (cause) { setError(startError(cause)); void choices.refetch(); }
    finally { setBusy(false); }
  };
  const loadError = !(choices.error instanceof ApiError) ? "저장할 영상을 확인하지 못했어요."
    : choices.error.status === 422 || choices.error.code.startsWith("download-") ? downloadErrorText(choices.error.status === 422 && !choices.error.code.startsWith("download-") ? "download-stream-unsupported" : choices.error.code)!
    : choices.error.message !== choices.error.code ? choices.error.message : "저장할 영상을 확인하지 못했어요.";
  const unsupported = choices.error instanceof ApiError && choices.error.status === 422;

  return <ConfirmDialog className="save-dialog" title="서버에 저장" confirmLabel="저장 시작" busy={busy} confirmDisabled={!picked || choices.isFetching || choices.isError} onConfirm={() => void start()} onClose={onClose}>
    <p className="save-dialog-title">{title}</p>
    {choices.isPending ? <div className="save-dialog-state"><Spinner size={20} /><span>저장할 수 있는 영상을 찾는 중…</span></div>
      : choices.isError ? <p className={unsupported ? "settings-hint" : "settings-error"}>{loadError}{!unsupported && <> <button className="text-btn" onClick={() => void choices.refetch()}>다시 시도</button></>}</p>
      : !list.length ? <p className="settings-hint">이 회차는 서버에 저장할 수 있는 영상 형식이 없어요. 기존 재생은 그대로 사용할 수 있어요.</p>
      : <div className="save-choices" role="radiogroup" aria-label="저장할 영상">
          {list.map(choice => <button key={choice.id} type="button" role="radio" aria-checked={picked === choice.id} className={cx("save-choice", picked === choice.id && "is-active")} onClick={() => setPicked(choice.id)}>
            <span className="save-choice-dot" aria-hidden="true" /><span>{choice.label}</span>
          </button>)}
        </div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <p className="settings-hint">저장이 끝나면 이 회차를 볼 수 있는 모든 프로필에서 저장본을 먼저 재생해요.</p>
  </ConfirmDialog>;
}

/** Compact per-episode control for admins: save, progress, or done. */
export function EpisodeSaveButton({ job, title, onSave }: { job?: DownloadJob; title: string; onSave: () => void }) {
  if (job && (ACTIVE_DOWNLOAD.includes(job.state) || job.state === "ready")) {
    const ratio = downloadRatio(job), ready = job.state === "ready";
    const label = `${title} ${ready ? "서버에 저장됨" : `${DOWNLOAD_STATE_LABEL[job.state]}${ratio !== null ? ` ${Math.round(ratio * 100)}%` : ""}`} · 저장 목록 보기`;
    return <Link to={SETTINGS_PATH} className={cx("icon-btn icon-btn-s episode-save", ready ? "is-ready" : "is-active")} data-remote-secondary aria-label={label} title={label}>
      {ready ? <Check size={16} /> : <span className="save-ring" style={{ "--ratio": ratio ?? 0.15 } as React.CSSProperties} aria-hidden="true" />}
    </Link>;
  }
  const failed = job && job.state === "failed";
  const label = failed ? `${title} 저장 실패 · 다시 저장` : `${title} 서버에 저장`;
  return <button className={cx("icon-btn icon-btn-s episode-save", failed && "is-failed")} data-remote-secondary aria-label={label} title={failed && job.error ? `${label}: ${downloadErrorText(job.error)}` : label} onClick={onSave}>
    {failed ? <AlertCircle size={16} /> : <HardDriveDownload size={16} />}
  </button>;
}

/** Hero action for a movie (single episode). */
export function MovieSaveButton({ job, onSave }: { job?: DownloadJob; onSave: () => void }) {
  if (job && (ACTIVE_DOWNLOAD.includes(job.state) || job.state === "ready")) {
    const ratio = downloadRatio(job);
    return <Link to={SETTINGS_PATH} className="btn btn-secondary btn-l">
      {job.state === "ready" ? <Check size={20} /> : <Spinner size={18} />}
      <span>{job.state === "ready" ? "서버에 저장됨" : `${DOWNLOAD_STATE_LABEL[job.state]}${ratio !== null ? ` ${Math.round(ratio * 100)}%` : ""}`}</span>
    </Link>;
  }
  return <Button variant="secondary" size="l" icon={job?.state === "failed" ? <AlertCircle size={20} /> : <HardDriveDownload size={20} />} title={downloadErrorText(job?.error) ?? undefined} onClick={onSave}>{job?.state === "failed" ? "다시 저장" : "서버에 저장"}</Button>;
}
