import { Check, ChevronRight, Copy, KeyRound, Link2, Plus, Share2, ShieldCheck, Trash2, UserRound, Users, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ACCOUNT_PERMISSIONS, type AccountSummary, type AccountPermission, type Invite } from "@moa/shared";
import { useMe } from "../api/queries";
import { Button, ConfirmDialog, EmptyState, IconButton, Skeleton } from "../components/ui";
import { ApiError, api, authApi } from "../lib/api";
import { cx } from "../lib/format";

const INVITES = ["auth-invites"] as const;
const ACCOUNTS = ["auth-accounts"] as const;
const PERMISSION_LABELS: Record<AccountPermission, string> = { "video.watch": "영상 보기", "subtitles.add": "자막 추가", "subtitles.translate": "자막 번역" };

const day = (iso: string) => new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
const ago = (iso: string | null) => {
  if (!iso) return "접속 기록 없음";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 2) return "방금 접속";
  if (min < 60) return `${min}분 전 접속`;
  if (min < 1440) return `${Math.round(min / 60)}시간 전 접속`;
  if (min < 43200) return `${Math.round(min / 1440)}일 전 접속`;
  return `${day(iso)} 접속`;
};
const STATUS: Record<Invite["status"], string> = { active: "사용 가능", expired: "만료됨", "used-up": "모두 사용됨", revoked: "취소됨" };
const ERRORS: Record<string, string> = {
  "self-protected": "내 계정은 비활성화하거나 삭제할 수 없어요.",
  "last-admin": "관리자가 한 명은 남아 있어야 해요."
};
const errorText = (e: unknown) => (e instanceof ApiError && ERRORS[e.code]) || "처리하지 못했어요. 다시 시도해 주세요.";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
}

function CopyButton({ text, label, icon = <Copy size={16} /> }: { text: string; label: string; icon?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1600);
  };
  return <Button size="m" variant="secondary" icon={done ? <Check size={16} /> : icon} onClick={() => void copy()}>{done ? "복사됨" : label}</Button>;
}

function ShareInvite({ invite }: { invite: Invite }) {
  const canShare = typeof navigator.share === "function";
  return <div className="invite-share">
    <CopyButton text={invite.url} label="링크 복사" icon={<Link2 size={16} />} />
    <CopyButton text={invite.code} label="코드 복사" />
    {canShare && <Button icon={<Share2 size={16} />} onClick={() => void navigator.share({ title: "MOA 초대", text: `MOA 초대 코드: ${invite.code}`, url: invite.url }).catch(() => undefined)}>공유</Button>}
  </div>;
}

const USES: Array<[number | null, string]> = [[1, "1명"], [3, "3명"], [5, "5명"], [10, "10명"], [null, "제한 없음"]];
const DAYS: Array<[number | null, string]> = [[1, "1일"], [7, "7일"], [30, "30일"], [null, "무기한"]];

function InviteSheet({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const client = useQueryClient();
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState<number | null>(1);
  const [custom, setCustom] = useState("");
  const [days, setDays] = useState<number | null>(7);
  const uses = custom ? Math.min(100, Math.max(1, Number(custom) || 1)) : maxUses;
  const create = useMutation({
    mutationFn: () => authApi<Invite>("/invites", { method: "POST", body: { label: label.trim(), maxUses: uses, expiresInDays: days } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: INVITES })
  });
  const made = create.data;
  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet invite-sheet" role="dialog" aria-modal="true" aria-label="초대 만들기" onClick={e => e.stopPropagation()}>
      <header className="sheet-head"><h2>{made ? "초대 코드가 만들어졌어요" : "초대 만들기"}</h2><IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
      {made ? <div className="invite-body">
        <p className="invite-code" aria-label="초대 코드">{made.code}</p>
        <p className="settings-hint invite-made-meta">{inviteMeta(made)}</p>
        <ShareInvite invite={made} />
        <p className="settings-hint">받은 사람은 링크를 열거나 로그인 화면의 ‘초대 코드로 가입’에서 코드를 입력하면 돼요. 코드는 이 화면의 초대 목록에서 다시 복사할 수 있어요.</p>
      </div> : <div className="invite-body">
        <label className="field"><span>메모 <small>선택</small></span><input value={label} maxLength={40} placeholder="예: 동생, 친구들" onChange={e => setLabel(e.target.value)} /></label>
        <div className="field"><span>가입할 수 있는 인원</span>
          <div className="choice-row" role="radiogroup" aria-label="가입할 수 있는 인원">
            {USES.map(([v, t]) => <button key={t} type="button" role="radio" aria-checked={!custom && maxUses === v} className={cx("chip", !custom && maxUses === v && "is-active")} onClick={() => { setCustom(""); setMaxUses(v); }}>{t}</button>)}
            <input className={cx("chip choice-input", custom && "is-active")} inputMode="numeric" placeholder="직접" aria-label="인원 직접 입력 (최대 100명)" value={custom} onChange={e => setCustom(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </div>
          <small>{uses == null ? "코드를 아는 사람은 누구나 가입할 수 있어요. 필요 없어지면 취소하세요." : `${uses}명이 가입하면 코드가 자동으로 막혀요.`}</small>
        </div>
        <div className="field"><span>유효 기간</span>
          <div className="choice-row" role="radiogroup" aria-label="유효 기간">
            {DAYS.map(([v, t]) => <button key={t} type="button" role="radio" aria-checked={days === v} className={cx("chip", days === v && "is-active")} onClick={() => setDays(v)}>{t}</button>)}
          </div>
        </div>
        {create.isError && <p className="settings-error" role="alert">초대를 만들지 못했어요. 다시 시도해 주세요.</p>}
      </div>}
      <footer className="sheet-foot">
        <span />
        {made ? <Button variant="primary" onClick={onClose}>완료</Button> : <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>초대 코드 만들기</Button>}
      </footer>
    </div>
  </div>;
}

function inviteMeta(invite: Invite) {
  const uses = invite.maxUses == null ? `${invite.uses}명 가입 · 인원 제한 없음` : `${invite.uses}/${invite.maxUses}명 가입`;
  const until = invite.expiresAt ? `${day(invite.expiresAt)}까지` : "기한 없음";
  return `${uses} · ${until}`;
}

function InviteRow({ invite }: { invite: Invite }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const revoke = useMutation({ mutationFn: () => authApi(`/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: INVITES }) });
  const active = invite.status === "active";
  return <li className={cx("invite-row", !active && "is-inactive")}>
    <button className="invite-main" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="invite-title"><b>{invite.label || "초대"}</b><code>{invite.code}</code></span>
      <small>{inviteMeta(invite)}</small>
      <span className={cx("status-pill", active && "is-ok")}>{STATUS[invite.status]}</span>
    </button>
    {open && <div className="invite-actions">
      {active && <ShareInvite invite={invite} />}
      {active && <Button variant="ghost" className="btn-danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>초대 취소</Button>}
      {!active && <p className="settings-hint">더 이상 이 코드로 가입할 수 없어요.</p>}
    </div>}
  </li>;
}

function AccountRow({ account, me }: { account: AccountSummary; me: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmRole, setConfirmRole] = useState(false);
  const [temp, setTemp] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ACCOUNTS });
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => authApi(`/accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", body }), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => authApi<{ temporaryPassword: string }>(`/accounts/${encodeURIComponent(account.id)}/reset-password`, { method: "POST" }), onSuccess: r => setTemp(r.temporaryPassword) });
  const remove = useMutation({
    mutationFn: async () => {
      await authApi(`/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      await api(`/admin/accounts/${encodeURIComponent(account.id)}/data`, { method: "DELETE" });
    },
    onSettled: refresh
  });
  const self = account.id === me;
  const error = patch.error ?? reset.error ?? remove.error;
  return <li className={cx("account-row", account.disabled && "is-inactive")}>
    <button className="account-main" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="account-icon" aria-hidden="true">{account.role === "admin" ? <ShieldCheck size={20} /> : <UserRound size={20} />}</span>
      <span className="account-name"><b>{account.username}{self && <small> · 나</small>}</b><small>{[ago(account.lastLoginAt), account.inviteLabel && `초대: ${account.inviteLabel}`].filter(Boolean).join(" · ")}</small></span>
      {account.disabled ? <span className="status-pill">사용 중지</span> : account.role === "admin" && <span className="status-pill is-ok">관리자</span>}
    </button>
    {open && <div className="account-actions">
      {temp ? <div className="temp-password">
        <p>임시 비밀번호예요. 지금만 볼 수 있으니 전달해 주세요. 로그인 후 설정에서 바꾸면 돼요.</p>
        <p className="invite-code">{temp}</p>
        <CopyButton text={temp} label="복사" />
      </div> : <>
        <Button disabled={patch.isPending} onClick={() => { patch.reset(); setConfirmRole(true); }}>{account.role === "admin" ? "관리자 해제" : "관리자로 지정"}</Button>
        {account.role === "member" && <div className="choice-row" role="group" aria-label={`${account.username} 권한`}>
          {ACCOUNT_PERMISSIONS.map(permission => <label key={permission} className="chip"><input type="checkbox" checked={account.permissions.includes(permission)} disabled={patch.isPending} onChange={event => patch.mutate({ permissions: event.target.checked ? [...account.permissions, permission] : account.permissions.filter(value => value !== permission) })} />{PERMISSION_LABELS[permission]}</label>)}
        </div>}
        {!self && <Button disabled={patch.isPending} onClick={() => patch.mutate({ disabled: !account.disabled })}>{account.disabled ? "다시 사용" : "사용 중지"}</Button>}
        {!self && <Button icon={<KeyRound size={16} />} disabled={reset.isPending} onClick={() => reset.mutate()}>비밀번호 초기화</Button>}
        {!self && (confirm
          ? <span className="account-confirm">프로필과 시청 기록도 모두 지워져요. <Button variant="ghost" className="btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>삭제</Button><Button variant="ghost" onClick={() => setConfirm(false)}>취소</Button></span>
          : <Button variant="ghost" className="btn-danger" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>계정 삭제</Button>)}
      </>}
      {error && <p className="settings-error" role="alert">{errorText(error)}</p>}
    </div>}
    {confirmRole && <ConfirmDialog title={account.role === "admin" ? "관리자 해제" : "관리자로 지정"} confirmLabel={account.role === "admin" ? "해제" : "지정"} busy={patch.isPending} onClose={() => setConfirmRole(false)} onConfirm={() => patch.mutate({ role: account.role === "admin" ? "member" : "admin" }, { onSuccess: () => setConfirmRole(false) })}>
      <p>{account.role === "admin" ? `${account.username} 님의 관리자 권한을 해제할까요?` : `${account.username} 님을 관리자로 지정할까요? 계정, 플러그인과 서버 설정을 변경할 수 있어요.`}</p>
      {patch.error && <p className="settings-error" role="alert">{errorText(patch.error)}</p>}
    </ConfirmDialog>}
  </li>;
}

export function AccountsPage() {
  const me = useMe();
  const admin = me.data?.role === "admin";
  const invites = useQuery({ queryKey: INVITES, queryFn: () => authApi<Invite[]>("/invites"), enabled: admin });
  const accounts = useQuery({ queryKey: ACCOUNTS, queryFn: () => authApi<AccountSummary[]>("/accounts"), enabled: admin });
  const [creating, setCreating] = useState(false);
  const [showOld, setShowOld] = useState(false);
  if (me.isPending) return <div className="page-pad narrow"><Skeleton className="settings-sk" /></div>;
  if (!admin) return <div className="page-pad narrow"><EmptyState title="관리자만 볼 수 있어요" /></div>;
  const list = invites.data ?? [];
  const active = list.filter(i => i.status === "active");
  const old = list.filter(i => i.status !== "active");
  return <div className="page-pad narrow settings-page accounts-page">
    <header className="page-head"><h1>계정과 초대</h1></header>
    <section className="settings-group">
      <div className="settings-group-head"><h2>초대</h2></div>
      <div className="invite-hero">
        <div><b>함께 볼 사람을 초대하세요</b><small>초대받은 사람은 자기 계정과 프로필을 따로 가져요. 소스·라이브러리 관리는 관리자만 할 수 있어요.</small></div>
        <Button variant="primary" icon={<Plus size={18} />} onClick={() => setCreating(true)}>초대 만들기</Button>
      </div>
      {invites.isPending ? <Skeleton className="settings-sk" /> : active.length > 0 && <ul className="settings-card invite-list">{active.map(i => <InviteRow key={i.id} invite={i} />)}</ul>}
      {old.length > 0 && <button className="text-btn invite-old-toggle" onClick={() => setShowOld(v => !v)}>{showOld ? "지난 초대 숨기기" : `지난 초대 ${old.length}개 보기`}</button>}
      {showOld && <ul className="settings-card invite-list">{old.map(i => <InviteRow key={i.id} invite={i} />)}</ul>}
    </section>
    <section className="settings-group">
      <div className="settings-group-head"><h2>계정 {accounts.data && <small>{accounts.data.length}</small>}</h2></div>
      {accounts.isPending ? <Skeleton className="settings-sk" /> : accounts.isError ? <p className="settings-error">계정 목록을 불러오지 못했어요.</p> :
        <ul className="settings-card account-list">{accounts.data!.map(a => <AccountRow key={a.id} account={a} me={me.data!.id} />)}</ul>}
    </section>
    {creating && <InviteSheet onClose={() => setCreating(false)} />}
  </div>;
}

function PasswordSheet({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: () => authApi("/password", { method: "POST", body: { current, next } }),
    onSuccess: () => window.location.assign("/__moa/login")
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  const valid = current && next.length >= 8 && next === confirm;
  const error = change.error instanceof ApiError && change.error.code === "incorrect-password" ? "지금 비밀번호가 맞지 않아요." : change.isError ? "바꾸지 못했어요. 다시 시도해 주세요." : "";
  return <div className="sheet-backdrop" onClick={onClose}>
    <form className="sheet invite-sheet" role="dialog" aria-modal="true" aria-label="비밀번호 변경" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (valid) change.mutate(); }}>
      <header className="sheet-head"><h2>비밀번호 변경</h2><IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
      <div className="invite-body">
        <label className="field"><span>지금 비밀번호</span><input type="password" autoComplete="current-password" autoFocus value={current} onChange={e => setCurrent(e.target.value)} /></label>
        <label className="field"><span>새 비밀번호</span><input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /><small>8자 이상</small></label>
        <label className="field"><span>새 비밀번호 확인</span><input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />{mismatch && <small className="field-error">새 비밀번호와 달라요.</small>}</label>
        <p className="settings-hint">바꾸면 모든 기기에서 로그아웃돼요. 새 비밀번호로 다시 로그인하세요.</p>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet-foot"><span /><Button type="submit" variant="primary" disabled={!valid || change.isPending}>변경</Button></footer>
    </form>
  </div>;
}

export async function logout() {
  try { await authApi("/logout", { method: "POST" }); } finally { window.location.assign("/__moa/login"); }
}

/** Shown at the top of Settings when the app sits behind the login gateway. */
export function AccountSection() {
  const me = useMe();
  const [password, setPassword] = useState(false);
  if (!me.data) return null;
  const admin = me.data.role === "admin";
  return <section className="settings-group">
    <h2>계정</h2>
    <div className="settings-card">
      <div className="setting"><span className="setting-icon">{admin ? <ShieldCheck size={20} /> : <UserRound size={20} />}</span><div><b>{me.data.username}</b><small>{admin ? "관리자" : "일반 계정"} · 프로필 최대 5개</small></div>
        <Button variant="ghost" onClick={() => void logout()}>로그아웃</Button></div>
      <button className="setting setting-link" onClick={() => setPassword(true)}><span className="setting-icon"><KeyRound size={20} /></span><div><b>비밀번호 변경</b><small>모든 기기에서 다시 로그인해야 해요.</small></div><ChevronRight size={18} /></button>
      {admin && <Link to="/accounts" className="setting setting-link"><span className="setting-icon"><Users size={20} /></span><div><b>계정과 초대</b><small>초대 코드 만들기, 계정 관리</small></div><ChevronRight size={18} /></Link>}
    </div>
    {password && <PasswordSheet onClose={() => setPassword(false)} />}
  </section>;
}
