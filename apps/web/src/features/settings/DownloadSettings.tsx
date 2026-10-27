import { Check, ChevronDown, ChevronUp, Download, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DownloadJob, DownloadQuality, DownloadStatus } from "@moa/shared";
import { ACTIVE_DOWNLOAD, DOWNLOAD_QUALITY_OPTIONS, DOWNLOAD_STATE_LABEL, GIB, RETRYABLE_DOWNLOAD, downloadErrorText, downloadRatio, useDownloadActions, useDownloadStatus, useRemoveDownloads } from "../../api/downloads";
import { ApiError } from "../../lib/api";
import { cx, fileSize } from "../../lib/format";
import { Button, ConfirmDialog, EmptyState, IconButton, ProgressBar, Select, Skeleton, Toggle } from "../../components/ui";

const gib = (bytes: number) => Number((bytes / GIB).toFixed(bytes % GIB ? 1 : 0));

/** Readiness items that must all pass before downloads can be turned on. */
function DownloadReadiness({ data }: { data: DownloadStatus }) {
  const items = [
    { ok: data.allowed, label: "서버 허용", hint: "서버 환경 설정(MOA_DOWNLOADS_ENABLED)에서 다운로드를 막아 두었어요." },
    { ok: data.storageReady, label: "저장 폴더", hint: "/downloads 볼륨을 연결하고 다시 시작해 주세요." },
    { ok: data.quotaBytes > 0, label: "저장 한도", hint: "아래에서 저장 한도를 정해 주세요." }
  ];
  return <ul className="download-readiness" aria-label="다운로드 준비 상태">
    {items.map(item => <li key={item.label} className={item.ok ? "is-ok" : "is-missing"}>
      <span className="download-readiness-mark" aria-hidden="true">{item.ok ? <Check size={14} /> : <X size={14} />}</span>
      <span><b>{item.label}</b><small>{item.ok ? "준비됨" : item.hint}</small></span>
    </li>)}
  </ul>;
}

const configError = (cause: unknown, fallback: string) => cause instanceof ApiError && cause.code.startsWith("download-") ? downloadErrorText(cause.code)! : fallback;

/** Admin: the on/off switch, preferred quality, storage quota and the list of episodes saved on the server. */
export function DownloadSettings() {
  const status = useDownloadStatus();
  const actions = useDownloadActions();
  const [quota, setQuota] = useState("");
  const [quotaState, setQuotaState] = useState<"idle" | "saving" | "error">("idle");
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ busy: "enabled" | "quality" | null; error: string | null }>({ busy: null, error: null });
  const [confirmOff, setConfirmOff] = useState(false);
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
    try { await actions.configure({ quotaBytes }); setQuotaState("idle"); }
    catch (cause) { setQuotaError(configError(cause, "한도를 저장하지 못했어요.")); setQuotaState("error"); }
  };
  const ready = data.allowed && data.storageReady && data.quotaBytes > 0;
  const runningCount = data.activeJobs ?? data.jobs.filter(job => ACTIVE_DOWNLOAD.includes(job.state)).length;
  const patch = async (key: "enabled" | "quality", body: { enabled?: boolean; quality?: DownloadQuality }) => {
    setConfig({ busy: key, error: null });
    try { await actions.configure(body); setConfig({ busy: null, error: null }); setConfirmOff(false); }
    catch (cause) { setConfig({ busy: null, error: configError(cause, key === "enabled" ? "다운로드 설정을 바꾸지 못했어요." : "화질을 저장하지 못했어요.") }); setConfirmOff(false); }
  };
  const setEnabled = (value: boolean) => value || !runningCount ? void patch("enabled", { enabled: value }) : setConfirmOff(true);
  const switchHint = !data.allowed ? "서버 설정에서 다운로드를 허용해야 켤 수 있어요."
    : data.enabled ? (ready ? "작품·회차의 다운로드 버튼을 누르면 아래 화질로 바로 받아요." : "준비가 끝나지 않아 지금은 다운로드 버튼을 숨겼어요.")
    : ready ? "켜면 작품·회차에 다운로드 버튼이 생겨요. 끄면 버튼을 숨기고 받아 둔 영상은 그대로 재생해요." : "저장 폴더와 저장 한도를 준비하면 켤 수 있어요.";
  const act = async (job: DownloadJob, action: "cancel" | "retry" | "remove") => {
    setBusy(job.id); setError(null);
    try { await actions[action](job); if (action === "remove") setRemoving(null); }
    catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 && action === "remove" ? "지금 재생 중인 저장본은 지울 수 없어요. 재생이 끝난 뒤 다시 시도해 주세요." : action === "remove" ? "저장본을 지우지 못했어요." : action === "cancel" ? "취소하지 못했어요." : "다시 시도하지 못했어요.");
      if (action === "remove") setRemoving(null);
    } finally { setBusy(null); }
  };
  const usage = data.quotaBytes > 0 ? data.usedBytes / data.quotaBytes : 0;
  const jobs = data.jobs;

  return <>
    <section className="settings-group">
      <h2>사용 설정</h2>
      <div className="settings-card">
        <div className={cx("setting download-switch", data.configured && "is-on")}>
          <div><b>서버 다운로드 사용</b><small>{switchHint}</small>
            {config.error && <small className="settings-error" role="alert">{config.error}</small>}</div>
          <Toggle label="서버 다운로드 사용" checked={data.enabled} disabled={config.busy === "enabled" || (!data.enabled && !ready)} onChange={setEnabled} />
        </div>
        {!ready && <div className="setting"><DownloadReadiness data={data} /></div>}
        <div className="setting">
          <div><b>다운로드 화질</b><small>이 화질 이하에서 가장 높은 화질로 받고, 없으면 제공되는 가장 낮은 화질로 받아요. 새로 시작하는 다운로드부터 적용돼요.</small></div>
          <Select className="setting-select" aria-label="다운로드 화질" value={data.quality} options={DOWNLOAD_QUALITY_OPTIONS} disabled={config.busy === "quality"}
            onChange={value => value !== data.quality && void patch("quality", { quality: value as DownloadQuality })} />
        </div>
        {data.quotaBytes > 0 && <div className="setting download-usage">
          <div><b>사용량</b><small>{fileSize(data.usedBytes)} / {fileSize(data.quotaBytes)} · 남은 한도 {fileSize(Math.max(0, data.quotaBytes - data.usedBytes))}</small></div>
          <ProgressBar ratio={usage} className={cx("download-usage-bar", usage > .9 && "is-full")} />
        </div>}
        <form className="setting download-quota" onSubmit={event => void saveQuota(event)}>
          <div>
            <b>저장 한도</b>
            <small>{quotaValid ? `${quotaValue.toLocaleString("ko-KR")} GiB = ${quotaBytes.toLocaleString("ko-KR")}바이트. ` : ""}한도를 넘는 저장은 시작하지 않아요. 저장된 영상은 자동으로 지우지 않아요.</small>
            {quotaState === "error" && <small className="settings-error" role="alert">{quotaError}</small>}
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
      <h2>다운로드 목록</h2>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!jobs.length ? <div className="settings-card"><div className="setting download-empty">
        <span className="setting-icon"><Download size={20} /></span>
        <div><b>아직 다운로드한 영상이 없어요</b><small>{data.configured ? "작품 상세의 회차 옆 다운로드 버튼을 누르면 서버에 바로 받아요." : "다운로드를 켜면 작품 상세에서 회차를 받을 수 있어요."}</small></div>
      </div></div>
      : <DownloadLibrary jobs={jobs} total={data.totalJobs} busy={busy} canRetry={data.configured} onAction={(job, action) => action === "remove" && job.state === "ready" ? setRemoving(job) : void act(job, action)}
          more={status.hasNextPage ? <Button className="download-more" disabled={status.isFetchingNextPage} onClick={() => void status.fetchNextPage()}>{status.isFetchingNextPage ? "불러오는 중…" : status.isFetchNextPageError ? "다시 불러오기" : `이전 항목 더 보기 (${jobs.length.toLocaleString("ko-KR")}/${data.totalJobs.toLocaleString("ko-KR")})`}</Button> : null} />}
      <p className="settings-hint">저장본은 이 회차를 볼 수 있는 모든 프로필에서 먼저 재생돼요. 원본 소스로 보려면 재생 화면의 설정에서 바꿀 수 있어요. 지워도 작품과 시청 기록은 그대로예요.</p>
    </section>
    {confirmOff && <ConfirmDialog title="다운로드 끄기" confirmLabel="끄기" busy={config.busy === "enabled"} onClose={() => setConfirmOff(false)} onConfirm={() => void patch("enabled", { enabled: false })}>
      진행·대기 중인 {runningCount.toLocaleString("ko-KR")}개는 중단돼요. 받아 둔 영상은 그대로 재생하고 이 목록에서 지울 수 있어요.
    </ConfirmDialog>}
    {removing && <ConfirmDialog title="저장본 삭제" confirmLabel="삭제" busy={busy === removing.id} onClose={() => setRemoving(null)} onConfirm={() => void act(removing, "remove")}>
      ‘{[removing.title, removing.episodeTitle].filter(Boolean).join(" · ")}’ 저장본{removing.totalBytes ? `(${fileSize(removing.totalBytes)})` : ""}을 서버에서 지울까요? 이후에는 원본 소스로 재생해요.
    </ConfirmDialog>}
  </>;
}

type Action = "cancel" | "retry" | "remove";
type RemoveFailure = { inUse: boolean };

const removable = (job: DownloadJob) => !ACTIVE_DOWNLOAD.includes(job.state);
const savedBytes = (jobs: DownloadJob[]) => jobs.reduce((sum, job) => sum + (job.state === "ready" ? job.totalBytes ?? job.bytes : 0), 0);
const removeQuestion = (saved: DownloadJob[], records: number) => {
  const copies = saved.length ? `저장본 ${saved.length.toLocaleString("ko-KR")}개(${fileSize(savedBytes(saved))})를 서버에서 지` : "";
  const logs = records ? `실패·취소 기록 ${records.toLocaleString("ko-KR")}개를 목록에서 지` : "";
  return copies && logs ? `${copies}우고 ${logs}울까요?` : `${copies || logs}울까요?`;
};
const byEpisode = (a: DownloadJob, b: DownloadJob) => a.episodeTitle.localeCompare(b.episodeTitle, "ko", { numeric: true }) || b.createdAt.localeCompare(a.createdAt);

/** Loaded entries grouped by title. Selection only ever covers rows loaded on this screen. */
function DownloadLibrary({ jobs, total, busy, canRetry, more, onAction }: { jobs: DownloadJob[]; total: number; busy: string | null; canRetry: boolean; more: React.ReactNode; onAction: (job: DownloadJob, action: Action) => void }) {
  const removeMany = useRemoveDownloads();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // The batch is frozen when the dialog opens, so polling can't change its text or progress total.
  const [batch, setBatch] = useState<DownloadJob[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failures, setFailures] = useState<Map<string, RemoveFailure>>(() => new Map());
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);

  // Groups keep server order (newest first) by their newest entry; rows inside read in episode order.
  const groups = useMemo(() => {
    const map = new Map<string, DownloadJob[]>();
    for (const job of jobs) map.set(job.mediaId, [...(map.get(job.mediaId) ?? []), job]);
    return [...map.entries()].map(([mediaId, items]) => ({ mediaId, title: items[0].title, jobs: [...items].sort(byEpisode) }));
  }, [jobs]);
  // Rows that disappeared or started running drop out of the selection instead of being counted.
  const selectable = useMemo(() => new Set(jobs.filter(removable).map(job => job.id)), [jobs]);
  useEffect(() => setSelected(old => { const next = new Set([...old].filter(id => selectable.has(id))); return next.size === old.size ? old : next; }), [selectable]);
  const chosen = jobs.filter(job => selected.has(job.id) && selectable.has(job.id));
  const chosenSaved = chosen.filter(job => job.state === "ready");
  const toggle = (ids: string[], on: boolean) => setSelected(old => { const next = new Set(old); ids.forEach(id => on ? next.add(id) : next.delete(id)); return next; });
  const isOpen = (group: { mediaId: string; jobs: DownloadJob[] }) => open[group.mediaId] ?? group.jobs.some(job => ACTIVE_DOWNLOAD.includes(job.state) || failures.has(job.id));
  const anyOpen = groups.some(group => group.jobs.length > 1 && isOpen(group));

  const removeChosen = async (targets: DownloadJob[]) => {
    setProgress(0); setNotice(null);
    const result = await removeMany(targets, setProgress);
    const failed = new Map(result.failed.map(item => [item.job.id, { inUse: item.inUse }]));
    setFailures(failed);
    setSelected(new Set(failed.keys()));
    setProgress(null); setBatch(null);
    const inUse = result.failed.filter(item => item.inUse).length;
    setNotice(!result.failed.length
      ? { text: `${result.removed.length.toLocaleString("ko-KR")}개를 지웠어요.`, warn: false }
      : { text: `${result.removed.length.toLocaleString("ko-KR")}개를 지웠고 ${result.failed.length.toLocaleString("ko-KR")}개는 지우지 못했어요${inUse ? `(재생 중 ${inUse}개)` : ""}. 남은 항목은 선택해 두었어요.`, warn: true });
  };

  const titles = [...new Set((batch ?? []).map(job => job.title))];
  const batchSaved = (batch ?? []).filter(job => job.state === "ready");
  return <>
    <div className="settings-card download-library">
      <div className="list-selection download-toolbar">
        <label><input type="checkbox" aria-label="불러온 항목 모두 선택" checked={selectable.size > 0 && chosen.length === selectable.size} disabled={!selectable.size || progress !== null}
          ref={input => { if (input) input.indeterminate = chosen.length > 0 && chosen.length < selectable.size; }}
          onChange={event => setSelected(event.target.checked ? new Set(selectable) : new Set())} />모두 선택</label>
        <span>{chosen.length ? `${chosen.length.toLocaleString("ko-KR")}개 선택${chosenSaved.length ? ` · ${fileSize(savedBytes(chosenSaved))}` : ""}` : total > jobs.length ? `${jobs.length.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}개 표시` : `${groups.length.toLocaleString("ko-KR")}개 작품 · ${jobs.length.toLocaleString("ko-KR")}개 항목`}</span>
        {groups.some(group => group.jobs.length > 1) && <button type="button" className="text-btn" onClick={() => setOpen(Object.fromEntries(groups.map(group => [group.mediaId, !anyOpen])))}>{anyOpen ? "모두 접기" : "모두 펼치기"}</button>}
        <Button icon={<Trash2 size={16} />} disabled={!chosen.length || progress !== null} onClick={() => { setNotice(null); setBatch(chosen); }}>선택 삭제</Button>
      </div>
      {notice && <p className={cx("download-notice", notice.warn && "is-warn")} role="status">{notice.text}</p>}
      <ul className="download-groups">
        {groups.map(group => <DownloadGroup key={group.mediaId} group={group} canRetry={canRetry} open={isOpen(group)} selected={selected} failures={failures} busy={busy} locked={progress !== null}
          onOpen={value => setOpen(old => ({ ...old, [group.mediaId]: value }))} onSelect={toggle} onAction={onAction} />)}
      </ul>
    </div>
    {more && <div className="download-more-row">{more}<small>모두 선택은 불러온 항목에만 적용돼요.</small></div>}
    {batch && <ConfirmDialog title="선택 항목 삭제" confirmLabel={`${batch.length.toLocaleString("ko-KR")}개 삭제`} busy={progress !== null} onClose={() => setBatch(null)} onConfirm={() => void removeChosen(batch)}>
      <p>{removeQuestion(batchSaved, batch.length - batchSaved.length)}</p>
      <p className="settings-hint">{titles.slice(0, 3).join(", ")}{titles.length > 3 ? ` 외 ${titles.length - 3}개 작품` : ""} · 작품과 시청 기록은 그대로예요. 재생 중인 저장본은 건너뛰어요.</p>
      {progress !== null && <p className="download-batch-progress" role="status">{progress}/{batch.length} 처리 중…</p>}
    </ConfirmDialog>}
  </>;
}

function DownloadGroup({ group, canRetry, open, selected, failures, busy, locked, onOpen, onSelect, onAction }: {
  group: { mediaId: string; title: string; jobs: DownloadJob[] }; canRetry: boolean; open: boolean; selected: Set<string>; failures: Map<string, RemoveFailure>; busy: string | null; locked: boolean;
  onOpen: (open: boolean) => void; onSelect: (ids: string[], on: boolean) => void; onAction: (job: DownloadJob, action: Action) => void;
}) {
  const row = (job: DownloadJob, full: boolean) => <DownloadRow key={job.id} job={job} full={full} canRetry={canRetry} checked={selected.has(job.id)} failure={failures.get(job.id)} busy={busy === job.id} locked={locked}
    onCheck={value => onSelect([job.id], value)} onAction={action => onAction(job, action)} />;
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (group.jobs.length === 1) return <li className="download-group is-single"><ul>{row(group.jobs[0], true)}</ul></li>;
  const ids = group.jobs.filter(removable).map(job => job.id), picked = ids.filter(id => selected.has(id)).length;
  const count = (states: DownloadJob["state"][]) => group.jobs.filter(job => states.includes(job.state)).length;
  const active = group.jobs.filter(job => ACTIVE_DOWNLOAD.includes(job.state));
  const parts = [
    count(["ready"]) && `저장됨 ${count(["ready"])}`,
    active.length && `진행 중 ${active.length}`,
    count(["failed", "interrupted"]) && `실패 ${count(["failed", "interrupted"])}`,
    count(["cancelled"]) && `취소 ${count(["cancelled"])}`
  ].filter(Boolean).join(" · ");
  const ratio = active.length ? active.reduce((sum, job) => sum + (downloadRatio(job) ?? 0), 0) / active.length : null;
  const panel = `download-group-${group.mediaId}`;
  return <li className={cx("download-group", open && "is-open")}>
    <div className="download-group-head">
      <input type="checkbox" className="selection-checkbox" aria-label={`${group.title} 항목 모두 선택`} checked={ids.length > 0 && picked === ids.length} disabled={!ids.length || locked}
        ref={input => { if (input) input.indeterminate = picked > 0 && picked < ids.length; }} onChange={event => onSelect(ids, event.target.checked)} />
      <button ref={toggleRef} type="button" className="download-group-toggle" aria-expanded={open} aria-controls={panel} onClick={() => onOpen(!open)}>
        <span className="download-group-text">
          <b>{group.title}</b>
          <small>{parts}{savedBytes(group.jobs) ? ` · ${fileSize(savedBytes(group.jobs))}` : ""}{picked ? <em> · {picked}개 선택</em> : null}</small>
          {!open && ratio !== null && <ProgressBar ratio={ratio} className="download-progress" />}
        </span>
        <ChevronDown size={18} className="download-group-chevron" aria-hidden="true" />
      </button>
    </div>
    {open && <ul id={panel} className="download-group-items">{group.jobs.map(job => row(job, false))}</ul>}
    {open && group.jobs.length > 5 && <button type="button" className="text-btn download-group-close" aria-controls={panel} aria-label={`${group.title} 접기`} onClick={() => {
      onOpen(false);
      // Bring the folded header back so the list doesn't jump past it.
      requestAnimationFrame(() => { toggleRef.current?.scrollIntoView({ block: "nearest" }); toggleRef.current?.focus({ preventScroll: true }); });
    }}><ChevronUp size={16} />목록 접기</button>}
  </li>;
}

function DownloadRow({ job, full, canRetry, checked, failure, busy, locked, onCheck, onAction }: { job: DownloadJob; full: boolean; canRetry: boolean; checked: boolean; failure?: RemoveFailure; busy: boolean; locked: boolean; onCheck: (value: boolean) => void; onAction: (action: Action) => void }) {
  const active = ACTIVE_DOWNLOAD.includes(job.state), ratio = downloadRatio(job);
  const name = [job.title, job.episodeTitle].filter(Boolean).join(" · ");
  const size = job.state === "ready" ? fileSize(job.totalBytes ?? job.bytes) : job.state === "downloading" ? `${fileSize(job.bytes)}${job.totalBytes ? ` / ${fileSize(job.totalBytes)}` : ""}` : null;
  return <li className={cx("download-job", `is-${job.state}`, failure && "is-remove-failed")}>
    <input type="checkbox" className="selection-checkbox" aria-label={`${name} 선택`} checked={checked && !active} disabled={active || locked} title={active ? "진행 중인 저장은 먼저 취소해 주세요" : undefined} onChange={event => onCheck(event.target.checked)} />
    <div className="download-job-body">
      <Link to={`/title/${encodeURIComponent(job.mediaId)}`} className="download-job-title"><b>{full ? name : job.episodeTitle || job.title}</b></Link>
      <small><span className={cx("download-state", `is-${job.state}`)}>{DOWNLOAD_STATE_LABEL[job.state]}{active && ratio !== null ? ` ${Math.round(ratio * 100)}%` : ""}</span>{[job.quality, size].filter(Boolean).map(part => ` · ${part}`).join("")}</small>
      {active && <ProgressBar ratio={ratio ?? 0} className={cx("download-progress", ratio === null && "is-indeterminate")} />}
      {job.error && job.state !== "cancelled" && <small className={cx("download-error", job.state === "ready" && "is-partial")}>{downloadErrorText(job.error)}</small>}
      {failure && <small className="download-error">{failure.inUse ? "재생 중이라 지우지 못했어요." : "지우지 못했어요."}</small>}
    </div>
    <span className="download-actions">
      {active && <IconButton label={`${name} 다운로드 취소`} disabled={busy} onClick={() => onAction("cancel")}><X size={18} /></IconButton>}
      {canRetry && RETRYABLE_DOWNLOAD.includes(job.state) && <IconButton label={`${name} 다시 시도`} disabled={busy || locked} onClick={() => onAction("retry")}><RotateCw size={18} /></IconButton>}
      {!active && <IconButton label={job.state === "ready" ? `${name} 저장본 삭제` : `${name} 목록에서 지우기`} disabled={busy || locked} onClick={() => onAction("remove")}><Trash2 size={18} /></IconButton>}
    </span>
  </li>;
}
