import { SubtitleStyleControls } from '../components/SubtitleStyleControls';
import { WebsitePlugins } from '../components/WebsitePlugins';
import { SubtitleLibrarySettings } from '../components/SubtitleLibrarySettings';
import { remotePreference, setRemotePreference, type RemotePreference } from "../lib/remote";
import { NavigationSettings } from "../components/NavigationSettings";
import { devicePrefs, setDevicePref, type DevicePrefs } from "../lib/device-prefs";
import { Globe, Info, ChevronRight, Folder, FolderOpen, FolderPlus, Puzzle, RefreshCw, Subtitles, Trash2, Tv, X } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryFolder, MediaType, ScanStatus, Settings } from "@moa/shared";
import { NetworkSettings } from "../components/NetworkSettings";
import { TmdbSettings } from "../components/TmdbSettings";
import { TranslationSettings } from "../components/TranslationSettings";
import { UpdateSettings } from "../components/UpdateSettings";
import { SystemInfo } from "../components/SystemInfo";
import { SubtitleAdvancedSettings } from "../components/SubtitleAdvancedSettings";
import { translationModeOf, useTranslationConfig, type TranslationMode } from "../api/translation";
import { keys, useFolders, useMe, useScanStatus, useSettings, useSaveSettings } from "../api/queries";
import { AccountSection } from "./AccountsPage";
import { Button, ConfirmDialog, EmptyState, IconButton, Select, Skeleton, Spinner, Toggle } from "../components/ui";
import { api, hasLoginGate } from "../lib/api";
import { TYPE_LABEL, cx } from "../lib/format";

function FolderPicker({ onPick, onClose }: { onPick: (path: string, type: MediaType, label: string) => void; onClose: () => void }) {
  const [path, setPath] = useState("/media");
  const [type, setType] = useState<MediaType>("anime");
  const [label, setLabel] = useState("");
  const browse = useQuery({ queryKey: ["browse", path], queryFn: () => api<{ path: string; dirs: string[] }>(`/library/browse?path=${encodeURIComponent(path)}`) });
  const crumbs = path.split("/").filter(Boolean);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="폴더 추가" onClick={event => event.stopPropagation()}>
        <header className="sheet-head"><h2>폴더 추가</h2><IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
        <nav className="crumbs" aria-label="현재 위치">
          {crumbs.map((crumb, i) => (
            <button key={i} className="crumb" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join("/")}`)}>{crumb}</button>
          ))}
        </nav>
        <ul className="dir-list">
          {browse.isPending && Array.from({ length: 4 }, (_, i) => <li key={i}><Skeleton className="dir-sk" /></li>)}
          {browse.data?.dirs.map(dir => (
            <li key={dir}><button className="dir" onClick={() => setPath(dir.startsWith("/") ? dir : `${browse.data!.path.replace(/\/$/, "")}/${dir}`)}><Folder size={18} /><span>{dir.split("/").filter(Boolean).at(-1)}</span><ChevronRight size={16} /></button></li>
          ))}
          {browse.data && !browse.data.dirs.length && <li className="dir-empty">하위 폴더가 없습니다</li>}
        </ul>
        <div className="field-row">
          <label className="field"><span>종류</span>
            <div className="segmented" role="radiogroup">
              {(["anime", "series", "movie"] as MediaType[]).map(item => (
                <button key={item} type="button" role="radio" aria-checked={type === item} className={cx(type === item && "is-active")} onClick={() => setType(item)}>{TYPE_LABEL[item]}</button>
              ))}
            </div>
          </label>
          <label className="field"><span>이름 (선택)</span><input value={label} placeholder={crumbs.at(-1)} onChange={event => setLabel(event.target.value)} /></label>
        </div>
        <footer className="sheet-foot">
          <span className="sheet-path">{path}</span>
          <Button variant="primary" onClick={() => onPick(path, type, label)}>이 폴더 추가</Button>
        </footer>
      </div>
    </div>
  );
}

function ScanBanner({ status }: { status?: ScanStatus }) {
  if (!status?.running) return null;
  const phase = { listing: "파일 찾는 중", probing: "영상 정보 읽는 중", thumbnails: "썸네일 만드는 중" }[status.phase ?? "listing"];
  return (
    <div className="scan-banner" role="status">
      <Spinner size={18} />
      <span>{phase}</span>
      {status.total > 0 && <><span className="scan-count">{status.done}/{status.total}</span><span className="scan-bar"><i style={{ width: `${(status.done / status.total) * 100}%` }} /></span></>}
    </div>
  );
}

export function LibraryPage() {
  const folders = useFolders();
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState<LibraryFolder[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const status = useScanStatus(scanning);
  useEffect(() => {
    if (!scanning || !status.data || status.data.running) return;
    setScanning(false);
    void client.invalidateQueries({ queryKey: keys.folders });
    void client.invalidateQueries({ queryKey: ["home"] });
  }, [scanning, status.data, client]);
  const scan = async () => { client.setQueryData(keys.scan, await api<ScanStatus>("/library/scan", { method: "POST" })); setScanning(true); };
  const add = async (path: string, type: MediaType, label: string) => {
    setPicking(false);
    await api<LibraryFolder>("/library/folders", { method: "POST", body: { path, type, label: label || undefined } });
    void client.invalidateQueries({ queryKey: keys.folders });
    void scan();
  };
  const remove = async (rows: LibraryFolder[]) => {
    setRemoving(true); setRemoveError(false);
    const failed: LibraryFolder[] = [];
    for (const folder of rows) {
      try { await api(`/library/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }); setSelected(current => current.filter(id => id !== folder.id)); }
      catch { failed.push(folder); }
    }
    setDeleting(failed.length ? failed : null); setRemoveError(Boolean(failed.length)); setRemoving(false);
    void client.invalidateQueries({ queryKey: keys.folders });
    void client.invalidateQueries({ queryKey: ["home"] });
  };
  const selectedFolders = folders.data?.filter(folder => selected.includes(folder.id)) ?? [];
  return (
    <div className="page-pad narrow">
      <header className="page-head page-head-row">
        <h1>라이브러리</h1>
        <div className="page-head-actions">
          <Button icon={<RefreshCw size={18} />} onClick={() => void scan()} disabled={status.data?.running}>다시 스캔</Button>
          <Button variant="primary" icon={<FolderPlus size={18} />} onClick={() => setPicking(true)}>폴더 추가</Button>
        </div>
      </header>
      <ScanBanner status={status.data} />
      {folders.isPending && <Skeleton className="folder-sk" />}
      {folders.data?.length === 0 && <EmptyState icon={<FolderPlus size={40} />} title="등록된 폴더가 없습니다" body="영상이 있는 폴더를 추가하면 자동으로 정리해 줍니다." action={<Button variant="primary" onClick={() => setPicking(true)}>폴더 추가</Button>} />}
      {!!folders.data?.length && <div className="list-selection"><label><input type="checkbox" aria-label="라이브러리 폴더 모두 선택" checked={selectedFolders.length === folders.data.length} ref={input => { if (input) input.indeterminate = selectedFolders.length > 0 && selectedFolders.length < (folders.data?.length ?? 0); }} disabled={removing} onChange={event => setSelected(event.target.checked ? folders.data!.map(folder => folder.id) : [])} />전체 선택</label><span>{selectedFolders.length}개 선택</span><Button icon={<Trash2 size={16} />} disabled={!selectedFolders.length || removing} onClick={() => { setRemoveError(false); setDeleting(selectedFolders); }}>선택 제거</Button></div>}
      <ul className="folder-list">
        {folders.data?.map(folder => (
          <li key={folder.id} className="folder">
            <input className="selection-checkbox" type="checkbox" aria-label={`${folder.label} 선택`} checked={selected.includes(folder.id)} disabled={removing} onChange={event => setSelected(current => event.target.checked ? [...current, folder.id] : current.filter(id => id !== folder.id))} />
            <span className="folder-icon"><Folder size={22} /></span>
            <div className="folder-body">
              <b>{folder.label}</b>
              <span>{TYPE_LABEL[folder.type]} · 작품 {folder.itemCount}개{folder.lastScanAt ? ` · ${new Date(folder.lastScanAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 스캔` : ""}</span>
              <small>{folder.path}</small>
            </div>
            <IconButton label="폴더 빼기" disabled={removing} onClick={() => { setRemoveError(false); setDeleting([folder]); }}><Trash2 size={18} /></IconButton>
          </li>
        ))}
      </ul>
      {picking && <FolderPicker onPick={(path, type, label) => void add(path, type, label)} onClose={() => setPicking(false)} />}
      {deleting && <ConfirmDialog title="라이브러리 폴더 제거" confirmLabel="제거" busy={removing} onClose={() => setDeleting(null)} onConfirm={() => void remove(deleting)}>{deleting.length === 1 ? `‘${deleting[0].label}’ 폴더를` : `선택한 폴더 ${deleting.length}개를`} 라이브러리에서 뺄까요? 파일은 삭제되지 않습니다.{removeError && <p className="settings-error" role="alert">일부 폴더를 빼지 못했어요. 남은 폴더만 다시 시도해 주세요.</p>}</ConfirmDialog>}
    </div>
  );
}

const MODE_TEXT: Record<TranslationMode, string> = {
  manual: "재생 중 자막 메뉴에서 ‘한국어로 번역’을 누를 때만 번역해요.",
  ask: "번역할 자막을 찾아 물어봐요. 영상에 외국어 자막이 없으면 외부 사이트 Jimaku에서 일본어 자막을 찾아요. ‘번역하기’를 누를 때만 자막 내용과 작품 정보가 설정한 AI 서비스로 전송되고 사용료가 발생해요.",
  auto: "확실한 영어·일본어 자막을 바로 번역해요. 필요하면 외부 사이트 Jimaku에서 일본어 자막을 찾고, 자막 내용과 작품 정보가 설정한 AI 서비스로 전송돼 사용료가 발생해요. 확실하지 않은 자막은 물어봐요."
};

/** Per profile; the admin switch and keys live in the translation section below. */
function TranslationModeRow({ mode, available, korean, onChange }: { mode: TranslationMode; available: boolean; korean: boolean; onChange: (mode: TranslationMode) => void }) {
  return (
    <div className="setting setting-translation-mode">
      <div>
        <b>한국어 자막이 없을 때</b>
        <small>{available ? MODE_TEXT[mode] : "관리자가 AI 자막 번역을 켜면 고를 수 있어요."}</small>
        {available && mode !== "manual" && !korean && <small className="is-warn">기본 자막 언어가 한국어일 때만 동작해요.</small>}
      </div>
      <Select className="setting-select" aria-label="AI 자막 번역 방식" value={mode} disabled={!available} onChange={value => onChange(value as TranslationMode)} options={[{ value: "manual", label: "직접 번역" }, { value: "ask", label: "번역할지 묻기" }, { value: "auto", label: "자동 번역" }]} />
    </div>
  );
}

export function SettingsPage() {
  const [remote, setRemote] = useState(remotePreference);
  const [device, setDevice] = useState(devicePrefs);
  const setPref = <K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => { setDevicePref(key, value); setDevice(old => ({ ...old, [key]: value })); };
  const settings = useSettings();
  const client = useQueryClient();
  const admin = useMe().data?.role === "admin";
  const translation = useTranslationConfig().data;
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const categories = [
    ["playback", "재생"], ["subtitles", "자막"], ["device", "이 기기"], ["tabs", "홈 화면"], ["experimental", "실험 기능"],
    ...(hasLoginGate ? [["account", "내 계정"]] : []),
    ...(admin ? [["library", "소스와 라이브러리"], ["plugins", "플러그인과 자막"], ["translation", "번역 서비스"], ["network", "네트워크"]] : []),
    ["about", "정보"]
  ].map(([value, label]) => ({ value, label }));
  const requested = pathname === "/settings/tabs" ? "tabs" : hash === "#subtitle-advanced" ? "subtitles" : hash === "#updates" ? "about" : hash.slice(1);
  const category = categories.some(item => item.value === requested) ? requested : "playback";
  const categoryPath = (value: string) => value === "tabs" ? "/settings/tabs" : `/settings#${value}`;
  const saveSettings = useSaveSettings();
  const save = (patch: Partial<Settings>) => saveSettings(patch).catch(() => {});
  const s = settings.data;
  if (!s) return <div className="page-pad narrow"><header className="page-head"><h1>설정</h1></header>{settings.isError ? <EmptyState title="설정을 불러오지 못했습니다" action={<Button onClick={() => void settings.refetch()}>다시 시도</Button>} /> : <><Skeleton className="settings-sk" /><Skeleton className="settings-sk" /></>}</div>;
  const row = (title: string, desc: string, control: React.ReactNode) => (
    <div className="setting"><div><b>{title}</b><small>{desc}</small></div>{control}</div>
  );
  const select = <K extends keyof Settings>(key: K, options: Array<[Settings[K], string]>) => (
    <Select className="setting-select" aria-label={String(key)} value={String(s[key])} onChange={value => void save({ [key]: (typeof s[key] === "number" ? Number(value) : value) } as Partial<Settings>)} options={options.map(([value, label]) => ({ value: String(value), label }))} />
  );
  const link = (to: string, icon: React.ReactNode, title: string, desc: string) => (
    <Link to={to} className="setting setting-link"><span className="setting-icon">{icon}</span><div><b>{title}</b><small>{desc}</small></div><ChevronRight size={18} /></Link>
  );
  return (
    <div className="page-pad narrow settings-page">
      <header className="page-head"><h1>설정</h1></header>
      <Select className="settings-category" aria-label="설정 카테고리" value={category} options={categories} onChange={value => void navigate(categoryPath(value), { replace: true })} />
      <div className="settings-layout">
      <nav className="settings-nav" aria-label="설정 메뉴">{categories.map(item => <Link key={item.value} to={categoryPath(item.value)} replace aria-current={category === item.value ? "page" : undefined}>{item.label}</Link>)}</nav>
      <div className="settings-panel" key={category}>
      {category === "account" && hasLoginGate && <AccountSection />}
      {category === "playback" && <section className="settings-group">
        <h2>재생</h2>
        <div className="settings-card">
          {row("다음 화 자동 재생", "에피소드가 끝나면 다음 화를 이어서 재생합니다.", <Toggle label="다음 화 자동 재생" checked={s.autoplayNext} onChange={value => void save({ autoplayNext: value })} />)}
          {s.autoplayNext && row("자동 재생 대기 시간", "다음 화 카드가 나온 뒤 재생까지 기다리는 시간", select("autoplayDelay", [[3, "3초"], [5, "5초"], [10, "10초"], [15, "15초"]]))}
          {row("시청 기록 작품별로 보기", "시청 기록에서 작품마다 가장 최근 회차만 보여줘요. 끄면 회차별로 모두 보여줘요.", <Toggle label="시청 기록 작품별로 보기" checked={s.groupHistory} onChange={value => void save({ groupHistory: value }).then(() => client.invalidateQueries({ queryKey: keys.history }))} />)}
          {row("기본 화질", "네트워크가 느리면 낮은 화질이 끊김이 적어요.", select("preferredQuality", [["auto", "자동"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]]))}
          {row("하드웨어 변환", "브라우저가 재생할 수 없는 영상을 서버 GPU로 변환합니다.", <Toggle label="하드웨어 변환" checked={s.hardwareTranscoding} onChange={value => void save({ hardwareTranscoding: value })} />)}
        </div>
      </section>}
      {category === "subtitles" && <section className="settings-group">
        <h2>자막</h2>
        <div className="settings-card">
          {row("기본 자막 언어", "여러 자막이 있으면 이 언어를 먼저 고릅니다.", select("defaultSubtitleLang", [["ko", "한국어"], ["en", "영어"], ["ja", "일본어"], ["off", "끄기"]]))}
          {row("한국어 자막 자동 찾기", "애니에 한국어 자막이 없으면 애니시아·자막 블로그에서 찾아 적용합니다.", <Toggle label="한국어 자막 자동 찾기" checked={s.autoFetchSubtitles} onChange={value => void save({ autoFetchSubtitles: value })} />)}
          {translation && <TranslationModeRow mode={translationModeOf(s)} available={translation.configured && translation.enabled} korean={s.defaultSubtitleLang === "ko"} onChange={translationMode => void save({ translationMode })} />}
          <SubtitleStyleControls settings={s} save={patch => void save(patch)} />
          <p className="settings-hint">자막 모양은 프로필에 저장되어 다른 영상과 기기에도 적용돼요. 싱크는 조절한 영상과 이 기기에만 저장돼요.</p>
          <SubtitleAdvancedSettings settings={s} admin={admin} save={patch => void save(patch)} />
        </div>
      </section>}
      {category === "device" && <section className="settings-group"><h2>이 기기</h2><div className="settings-card">
        {row("재생 시 전체 화면", "작품을 누르면 바로 전체 화면으로 재생합니다. 끄면 재생 화면에서 직접 전환해요.", <Toggle label="재생 시 전체 화면" checked={device.fullscreenOnPlay} onChange={value => setPref("fullscreenOnPlay", value)} />)}
        {row("오프닝·엔딩 자동 건너뛰기", "구간 정보가 있는 회차에서 오프닝과 엔딩을 알아서 넘깁니다. 되감으면 다시 볼 수 있어요.", <Toggle label="오프닝·엔딩 자동 건너뛰기" checked={device.autoSkip} onChange={value => setPref("autoSkip", value)} />)}
        {row("빠른 탐색 간격", "두 번 탭, 앞으로·뒤로 버튼과 J·L 키로 이동하는 시간", <Select className="setting-select" aria-label="빠른 탐색 간격" value={String(device.seekStep)} onChange={value => setPref("seekStep", Number(value) as DevicePrefs["seekStep"])} options={[5, 10, 15, 30].map(value => ({ value: String(value), label: `${value}초` }))} />)}
        {row("화면 채우기", "영상을 화면 비율에 맞춰 꽉 채웁니다. 가장자리가 조금 잘릴 수 있어요.", <Toggle label="화면 채우기" checked={device.videoFill} onChange={value => setPref("videoFill", value)} />)}
        {row("TV 리모컨 모드", "방향키로 이동하고 확인 버튼으로 선택합니다. 자동 모드는 TV 감지 또는 탐색 화면의 방향키 입력으로 켜집니다.", <Select className="setting-select" aria-label="TV 리모컨 모드" value={remote} onChange={value => { setRemote(value as RemotePreference); setRemotePreference(value as RemotePreference); }} options={[{ value: "auto", label: "자동" }, { value: "on", label: "항상 켜기" }, { value: "off", label: "끄기" }]} />)}
      </div></section>}
      {category === "experimental" && <section className="settings-group"><h2>실험 기능</h2><div className="settings-card">
        {row("다른 소스 시즌 모아보기", "작품 상세의 시즌 메뉴에 다른 소스에 있는 정규 시즌까지 모아 순서대로 보여줘요. 시즌을 찾는 동안 목록이 늦게 채워질 수 있어요.", <Toggle label="다른 소스 시즌 모아보기" checked={device.seasonSwitcher} onChange={value => setPref("seasonSwitcher", value)} />)}
        {row("작품 묶기", "여러 소스의 같은 작품을 카드 하나로 합쳐 보여줘요. 끄면 소스별 결과를 그대로 보여줘요.", <Toggle label="작품 묶기" checked={device.titleGrouping} onChange={value => setPref("titleGrouping", value)} />)}
      </div></section>}
      {category === "about" && <>{admin && <><SystemInfo /><UpdateSettings /></>}<section className="settings-group"><h2>정보</h2><div className="settings-card">{link("/about", <Info size={20} />, "정보/크레딧", "작품 정보 제공 및 오픈소스 라이선스")}</div></section></>}
      {category === "tabs" && <NavigationSettings />}
      {admin && category === "plugins" && <section className="settings-group"><h2>플러그인과 자막</h2><div className="settings-card">
        {link("/plugins", <Puzzle size={20} />, "플러그인", "추가 기능 실행과 설치·업데이트")}
        {link("/subtitles", <Subtitles size={20} />, "저장한 자막", "AI 번역·온라인·직접 가져온 자막 관리")}
      </div></section>}
      {admin && category === "library" && <section className="settings-group">
        <h2>소스와 라이브러리</h2>
        <div className="settings-card">
          {link("/sources", <Tv size={20} />, "영상 소스", "확장 저장소, 소스 설치·업데이트·설정")}
          {link("/library", <FolderOpen size={20} />, "로컬 라이브러리", "영상 폴더 추가와 스캔")}
          <TmdbSettings />
          {link("/remote-access", <Globe size={20} />, "원격 접속", "집 밖에서도 MOA 열기 · 주소와 QR")}
        </div>
        <p className="settings-hint">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </section>}
      {admin && category === "translation" && <TranslationSettings />}
      {admin && category === "network" && <NetworkSettings />}
      </div>
      </div>
    </div>
  );
}

export function PluginsPage() {
  const me = useMe();
  return <div className="page-pad narrow"><header className="page-head"><h1>플러그인</h1></header>{me.isPending ? <Skeleton className="settings-sk" /> : me.data?.role === 'admin' ? <WebsitePlugins admin /> : <EmptyState title="관리자만 볼 수 있어요" />}</div>;
}

export function SubtitlesPage() {
  return <div className="page-pad narrow"><header className="page-head"><h1>자막 관리</h1></header><SubtitleLibrarySettings /></div>;
}
