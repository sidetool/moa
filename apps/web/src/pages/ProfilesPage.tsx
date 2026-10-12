import { Check, LockKeyhole, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Profile } from "@moa/shared";
import { keys, useProfiles } from "../api/queries";
import { Avatar, Logo } from "../components/AppShell";
import { AVATAR_GROUPS, AvatarArt, avatarSpec, randomAvatar } from "../components/avatars";
import { Button, PasswordInput, Skeleton } from "../components/ui";
import { api, ApiError, currentProfileId, setCurrentProfileId } from "../lib/api";
import { cx } from "../lib/format";

const MAX_PROFILES = 5;

function AvatarPicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  return <div className="avatar-picker">
    {AVATAR_GROUPS.map(group => <section key={group.label} aria-label={group.label}>
      <h3>{group.label}</h3>
      <div className="avatar-picker-grid" role="radiogroup" aria-label={group.label}>
        {group.ids.map(id => <button type="button" key={id} role="radio" aria-checked={id === value} aria-label={avatarSpec(id)?.label} className={cx("avatar-choice", id === value && "is-active")} onClick={() => onPick(id)}>
          <AvatarArt id={id} />
          {id === value && <Check size={18} className="avatar-choice-check" aria-hidden="true" />}
        </button>)}
      </div>
    </section>)}
  </div>;
}

function ProfileEditor({ profile, onDone, onCancel, onDelete }: { profile?: Profile; onDone: (profile: Profile) => void; onCancel?: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState(() => profile?.avatar && avatarSpec(profile.avatar) ? profile.avatar : randomAvatar());
  const [kids, setKids] = useState(profile?.kids ?? false);
  const [pinEnabled, setPinEnabled] = useState(profile?.hasPin ?? false);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [picking, setPicking] = useState(!profile);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (pinEnabled && (pin || !profile?.hasPin) && (pin !== confirmation || !/^[0-9]{4,8}$/.test(pin))) { setError("4~8자리 숫자 PIN을 동일하게 두 번 입력해 주세요."); return; }
    setBusy(true); setError("");
    const body = { name: name.trim(), avatar, kids, ...(!pinEnabled && profile?.hasPin ? { pin: null } : pinEnabled && pin ? { pin } : {}) };
    try { onDone(await api<Profile>(profile ? `/profiles/${encodeURIComponent(profile.id)}` : "/profiles", { method: profile ? "PATCH" : "POST", body })); }
    catch (e) { setError(e instanceof ApiError && e.code === "profile-limit" ? `프로필은 계정당 ${MAX_PROFILES}개까지 만들 수 있어요.` : "저장하지 못했어요. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!profile) return;
    setBusy(true);
    try { await api(`/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" }); onDelete?.(); }
    catch { setError("삭제하지 못했어요. 다시 시도해 주세요."); setBusy(false); }
  };
  return (
    <form className="profile-editor" onSubmit={submit}>
      <button type="button" className="profile-editor-avatar" aria-expanded={picking} aria-label="프로필 이미지 바꾸기" onClick={() => setPicking(v => !v)}>
        <Avatar profile={{ name: name || "?", color: "violet", avatar }} size={120} />
        <span className="profile-editor-pencil" aria-hidden="true"><Pencil size={16} /></span>
      </button>
      {picking && <AvatarPicker value={avatar} onPick={id => setAvatar(id)} />}
      <input autoFocus={!!profile} value={name} maxLength={20} placeholder="이름" aria-label="프로필 이름" onChange={event => setName(event.target.value)} />
      <label className="profile-kids">
        <span><b>어린이 프로필</b><small>12세 이하 등급이거나 가족·키즈 장르인 작품만 보여요.</small></span>
        <button type="button" role="switch" aria-checked={kids} aria-label="어린이 프로필" className={cx("switch", kids && "is-on")} onClick={() => setKids(v => !v)}><i /></button>
      </label>
      <label className="profile-kids">
        <span><b>PIN 잠금</b><small>프로필을 선택하거나 편집할 때 PIN을 입력해요.</small></span>
        <button type="button" role="switch" aria-checked={pinEnabled} aria-label="PIN 잠금" className={cx("switch", pinEnabled && "is-on")} onClick={() => setPinEnabled(v => !v)}><i /></button>
      </label>
      {pinEnabled && <div className="profile-pin-fields">
        {profile?.hasPin && <small>PIN을 바꾸려면 새 번호를 입력해 주세요.</small>}
        <label><span>{profile?.hasPin ? "새 PIN" : "PIN"}</span><PasswordInput revealLabel="PIN" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" maxLength={8} required={!profile?.hasPin} value={pin} placeholder="4~8자리 숫자" onChange={event => setPin(event.target.value)} /></label>
        <label><span>PIN 확인</span><PasswordInput revealLabel="PIN 확인" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" maxLength={8} required={!!pin || !profile?.hasPin} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="profile-create-actions">
        {onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>}
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>{profile ? "저장" : "만들기"}</Button>
      </div>
      {profile && onDelete && (confirmDelete
        ? <p className="profile-delete-confirm">이어보기와 내 목록도 함께 지워져요. <button type="button" className="text-btn btn-danger" disabled={busy} onClick={remove}>삭제</button> <button type="button" className="text-btn" onClick={() => setConfirmDelete(false)}>취소</button></p>
        : <button type="button" className="text-btn btn-danger" onClick={() => setConfirmDelete(true)}>프로필 삭제</button>)}
    </form>
  );
}

export function ProfilesPage() {
  const profiles = useProfiles();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [unlocking, setUnlocking] = useState<Profile | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const initialLock = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    let active = true;
    setCurrentProfileId(null);
    client.removeQueries({ predicate: item => item.queryKey[0] !== keys.profiles[0] });
    initialLock.current ??= api("/profiles/lock", { method: "POST" });
    initialLock.current.then(() => { if (active) setBusy(false); }, () => { if (active) setError("프로필을 잠그지 못했어요. 새로고침 후 다시 시도해 주세요."); });
    return () => { active = false; };
  }, [client]);

  const enter = (profile: Profile) => {
    setCurrentProfileId(profile.id);
    client.clear();
    navigate("/", { replace: true });
  };
  const refresh = () => client.invalidateQueries({ queryKey: keys.profiles });
  const finishEditing = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await api("/profiles/lock", { method: "POST" }); await refresh(); setEditing(null); }
    catch { setError("프로필을 잠그지 못했어요. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  const select = (profile: Profile) => {
    setError("");
    if (profile.hasPin) { setPin(""); setUnlocking(profile); }
    else if (managing) setEditing(profile);
    else enter(profile);
  };
  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!unlocking || busy) return;
    setBusy(true); setError("");
    try {
      await api(`/profiles/${encodeURIComponent(unlocking.id)}/unlock`, { method: "POST", body: { pin } });
      if (managing) { setEditing(unlocking); setUnlocking(null); setPin(""); } else enter(unlocking);
    } catch (e) { setError(e instanceof ApiError && e.code === "profile-pin-rate-limit" ? "입력 횟수를 초과했어요. 15분 후 다시 시도해 주세요." : e instanceof ApiError && e.code === "profile-pin-invalid" ? "PIN이 일치하지 않아요." : "잠금을 해제하지 못했어요. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };

  const list = profiles.data ?? [];
  const showCreate = creating || (profiles.isSuccess && list.length === 0);

  if (editing) return (
    <div className="profiles">
      <div className="profiles-logo"><Logo /></div>
      <h1>프로필 편집</h1>
      <ProfileEditor key={editing.id} profile={editing}
        onDone={() => void finishEditing()}
        onCancel={() => void finishEditing()}
        onDelete={list.length > 1 ? () => { if (currentProfileId() === editing.id) setCurrentProfileId(null); void finishEditing(); } : undefined} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );

  if (unlocking) return <div className="profiles">
    <div className="profiles-logo"><Logo /></div>
    <Avatar profile={unlocking} size={88} />
    <h1>{unlocking.name} PIN 입력</h1>
    <p className="profiles-sub">{managing ? "프로필을 편집하려면 PIN을 입력해 주세요." : "프로필을 사용하려면 PIN을 입력해 주세요."}</p>
    <form className="profile-editor" onSubmit={unlock}>
      <PasswordInput revealLabel="PIN" autoFocus inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required aria-label="PIN" placeholder="4~8자리 숫자" value={pin} onChange={event => setPin(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="profile-create-actions"><Button type="button" variant="ghost" disabled={busy} onClick={() => { setUnlocking(null); setPin(""); setError(""); }}>취소</Button><Button type="submit" variant="primary" disabled={busy || !/^[0-9]{4,8}$/.test(pin)}>확인</Button></div>
    </form>
  </div>;

  return (
    <div className="profiles">
      <div className="profiles-logo"><Logo /></div>
      {showCreate && !busy ? (
        <>
          <h1>{list.length ? "새 프로필" : "MOA에 오신 것을 환영합니다"}</h1>
          <p className="profiles-sub">프로필마다 이어보기와 내 목록이 따로 저장됩니다.</p>
          <ProfileEditor onDone={profile => { void refresh(); enter(profile); }} onCancel={list.length ? () => setCreating(false) : undefined} />
        </>
      ) : (
        <>
          <h1>{managing ? "프로필 관리" : "누가 보나요?"}</h1>
          <ul className={cx("profile-grid", managing && "is-managing")}>
            {profiles.isPending && Array.from({ length: 2 }, (_, i) => <li key={i}><Skeleton className="profile-sk" /></li>)}
            {list.map(profile => (
              <li key={profile.id}>
                <button className="profile-tile" disabled={busy} aria-label={managing ? `${profile.name} 편집` : undefined} onClick={() => select(profile)}>
                  <span className="profile-tile-art">
                    <Avatar profile={profile} size={112} />
                    {managing && <span className="profile-tile-edit" aria-hidden="true"><Pencil size={30} /></span>}
                  </span>
                  <span className="profile-tile-name">{profile.name}{profile.hasPin && <LockKeyhole size={16} aria-label="PIN 잠금" />}</span>
                </button>
              </li>
            ))}
            {profiles.isSuccess && !managing && list.length < MAX_PROFILES && (
              <li>
                <button className="profile-tile profile-add" disabled={busy} onClick={() => setCreating(true)}>
                  <span className="avatar profile-add-icon"><Plus size={44} /></span>
                  <span>프로필 추가</span>
                </button>
              </li>
            )}
          </ul>
          {profiles.isSuccess && <Button variant={managing ? "primary" : "ghost"} className="profiles-manage" disabled={busy} onClick={() => setManaging(v => !v)}>{managing ? "완료" : "프로필 관리"}</Button>}
          {profiles.isError && <p className="form-error">서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
