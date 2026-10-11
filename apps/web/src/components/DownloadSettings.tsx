import { HardDriveDownload, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DownloadJob } from "@moa/shared";
import { ACTIVE_DOWNLOAD, DOWNLOAD_STATE_LABEL, GIB, RETRYABLE_DOWNLOAD, downloadErrorText, downloadRatio, useDownloadActions, useDownloadStatus } from "../api/downloads";
import { ApiError } from "../lib/api";
import { cx, fileSize } from "../lib/format";
import { Button, ConfirmDialog, EmptyState, IconButton, ProgressBar, Skeleton } from "./ui";

const gib = (bytes: number) => Number((bytes / GIB).toFixed(bytes % GIB ? 1 : 0));

/** Admin: storage quota and the queue of episodes saved on the server. */
export function DownloadSettings() {
  const status = useDownloadStatus();
  const actions = useDownloadActions();
  const [quota, setQuota] = useState("");
  const [quotaState, setQuotaState] = useState<"idle" | "saving" | "error">("idle");
  const [removing, setRemoving] = useState<DownloadJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  useEffect(() => { if (data && quota === "") setQuota(data.quotaBytes > 0 ? String(gib(data.quotaBytes)) : ""); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status.isPending) return <><Skeleton className="settings-sk" /><Skeleton className="settings-sk" /></>;
  if (!data) return <EmptyState title="저장 상태를 불러오지 못했습니다" action={<Button onClick={() => void status.refetch()}>다시 시도</Button>} />;

  const quotaValue = Number(quota);
  const quotaBytes = Math.round(quotaValue * GIB);
  const quotaValid = quota.trim() !== "" && Number.isFinite(quotaValue) && quotaBytes >= 1;
  const saveQuota = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quotaValid) return;
    setQuotaState("saving");
    try { await actions.setQuota(quotaBytes); setQuotaState("idle"); } catch { setQuotaState("error"); }
  };
  const act = async (job: DownloadJob, action: "cancel" | "retry" | "remove") => {
    setBusy(job.id); setError(null);
    try { await actions[action](job); if (action === "remove") setRemoving(null); }
    catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 && action === "remove" ? "지금 재생 중인 저장본은 지울 수 없어요. 재생이 끝난 뒤 다시 시도해 주세요." : action === "remove" ? "저장본을 지우지 못했어요." : action === "cancel" ? "취소하지 못했어요." : "다시 시도하지 못했어요.");
      if (action === "remove") setRemoving(null);
    } finally { setBusy(null); }
  };
  const usage = data.quotaBytes > 0 ? data.usedBytes / data.quotaBytes : 0;
  const jobs = [...data.jobs].sort((a, b) => Number(ACTIVE_DOWNLOAD.includes(b.state)) - Number(ACTIVE_DOWNLOAD.includes(a.state)) || b.updatedAt.localeCompare(a.updatedAt));

  return <>
    <section className="settings-group">
      <h2>저장 공간</h2>
      <div className="settings-card">
        {!data.configured && <div className="setting download-unavailable" role="status">
          <div><b>서버 저장을 사용할 수 없어요</b><small>{data.reason || "저장 폴더와 저장 한도를 설정하면 사용할 수 있어요."}</small></div>
        </div>}
        {data.quotaBytes > 0 && <div className="setting download-usage">
          <div><b>사용량</b><small>{fileSize(data.usedBytes)} / {fileSize(data.quotaBytes)} · 남은 한도 {fileSize(Math.max(0, data.quotaBytes - data.usedBytes))}</small></div>
          <ProgressBar ratio={usage} className={cx("download-usage-bar", usage > .9 && "is-full")} />
        </div>}
        <form className="setting download-quota" onSubmit={event => void saveQuota(event)}>
          <div>
            <b>저장 한도</b>
            <small>{quotaValid ? `${quotaValue.toLocaleString("ko-KR")} GiB = ${quotaBytes.toLocaleString("ko-KR")}바이트. ` : ""}한도를 넘는 저장은 시작하지 않아요. 저장된 영상은 자동으로 지우지 않아요.</small>
            {quotaState === "error" && <small className="settings-error" role="alert">한도를 저장하지 못했어요.</small>}
          </div>
          <span className="download-quota-input">
            <input type="number" inputMode="decimal" min={0.1} step="any" aria-label="저장 한도 (GiB)" value={quota} onChange={event => { setQuota(event.target.value); setQuotaState("idle"); }} />
            <span>GiB</span>
            <Button type="submit" disabled={!quotaValid || quotaBytes === data.quotaBytes || quotaState === "saving"}>{quotaState === "saving" ? "저장 중…" : "적용"}</Button>
          </span>
        </form>
      </div>
      <p className="settings-hint">저장 영상은 <code>/downloads</code> 볼륨에 따로 보관하며 업데이트 백업에는 포함되지 않아요. 앱 밖으로 내보내거나 오프라인으로 보는 기능은 아니에요.</p>
    </section>
    <section className="settings-group">
      <h2>저장 목록</h2>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!jobs.length ? <div className="settings-card"><div className="setting download-empty">
        <span className="setting-icon"><HardDriveDownload size={20} /></span>
        <div><b>아직 저장한 영상이 없어요</b><small>{data.configured ? "작품 상세의 회차 옆 저장 버튼으로 소스 영상을 서버에 저장해요." : "저장 공간을 사용할 수 있게 되면 작품 상세에서 저장할 수 있어요."}</small></div>
      </div></div>
      : <ul className="settings-card download-list">{jobs.map(job => <DownloadRow key={job.id} job={job} busy={busy === job.id} onAction={action => action === "remove" && job.state === "ready" ? setRemoving(job) : void act(job, action)} />)}</ul>}
      <p className="settings-hint">저장본은 이 회차를 볼 수 있는 모든 프로필에서 먼저 재생돼요. 원본 소스로 보려면 재생 화면의 설정에서 바꿀 수 있어요. 지워도 작품과 시청 기록은 그대로예요.</p>
    </section>
    {removing && <ConfirmDialog title="저장본 삭제" confirmLabel="삭제" busy={busy === removing.id} onClose={() => setRemoving(null)} onConfirm={() => void act(removing, "remove")}>
      ‘{[removing.title, removing.episodeTitle].filter(Boolean).join(" · ")}’ 저장본{removing.totalBytes ? `(${fileSize(removing.totalBytes)})` : ""}을 서버에서 지울까요? 이후에는 원본 소스로 재생해요.
    </ConfirmDialog>}
  </>;
}

function DownloadRow({ job, busy, onAction }: { job: DownloadJob; busy: boolean; onAction: (action: "cancel" | "retry" | "remove") => void }) {
  const active = ACTIVE_DOWNLOAD.includes(job.state), ratio = downloadRatio(job);
  const name = [job.title, job.episodeTitle].filter(Boolean).join(" · ");
  const size = job.state === "ready" ? fileSize(job.totalBytes ?? job.bytes) : job.state === "downloading" ? `${fileSize(job.bytes)}${job.totalBytes ? ` / ${fileSize(job.totalBytes)}` : ""}` : null;
  return <li className={cx("setting download-job", `is-${job.state}`)}>
    <div>
      <Link to={`/title/${encodeURIComponent(job.mediaId)}`} className="download-job-title"><b>{name}</b></Link>
      <small><span className={cx("download-state", `is-${job.state}`)}>{DOWNLOAD_STATE_LABEL[job.state]}{active && ratio !== null ? ` ${Math.round(ratio * 100)}%` : ""}</span>{[job.quality, size].filter(Boolean).map(part => ` · ${part}`).join("")}</small>
      {active && <ProgressBar ratio={ratio ?? 0} className={cx("download-progress", ratio === null && "is-indeterminate")} />}
      {job.error && job.state !== "cancelled" && <small className={cx("download-error", job.state === "ready" && "is-partial")}>{downloadErrorText(job.error)}</small>}
    </div>
    <span className="download-actions">
      {active && <IconButton label={`${name} 저장 취소`} disabled={busy} onClick={() => onAction("cancel")}><X size={18} /></IconButton>}
      {RETRYABLE_DOWNLOAD.includes(job.state) && <IconButton label={`${name} 다시 시도`} disabled={busy} onClick={() => onAction("retry")}><RotateCw size={18} /></IconButton>}
      {!active && <IconButton label={job.state === "ready" ? `${name} 저장본 삭제` : `${name} 목록에서 지우기`} disabled={busy} onClick={() => onAction("remove")}><Trash2 size={18} /></IconButton>}
    </span>
  </li>;
}
