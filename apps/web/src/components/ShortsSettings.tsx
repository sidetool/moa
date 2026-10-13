import type { Settings } from "@moa/shared";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SHORTS_CATEGORIES, shortsCategories, useShortsNative } from "../api/shorts";
import { cx } from "../lib/format";
import { Select, Toggle } from "./ui";

const MODES: Array<[NonNullable<Settings["shortsMode"]>, string]> = [["mixed", "섞어서"], ["personal", "내 취향"], ["popular", "인기작"]];
const QUALITY: Array<[NonNullable<Settings["shortsQuality"]>, string]> = [["auto", "자동"], ["720p", "720p"], ["480p", "480p"], ["360p", "360p"]];
const REPEAT: Array<[NonNullable<Settings["shortsRepeatDays"]>, string]> = [[0, "안 함"], [1, "하루"], [7, "일주일"], [30, "한 달"]];

/** Profile-owned trailer feed. Off by default; child profiles can't turn it on. */
export function ShortsSettings({ settings, kids, save }: { settings: Settings; kids: boolean; save: (patch: Partial<Settings>) => void }) {
  const on = settings.shortsEnabled === true && !kids;
  const categories = shortsCategories(settings);
  const nativeOn = settings.shortsPlayback === "native";
  const nativeReady = useShortsNative(on).data?.available === true;
  const flip = (value: (typeof categories)[number]) => {
    const next = categories.includes(value) ? categories.filter(item => item !== value) : SHORTS_CATEGORIES.map(([item]) => item).filter(item => item === value || categories.includes(item));
    if (next.length) save({ shortsCategories: next });
  };
  const [open, setOpen] = useState(false); // details stay folded until asked for
  const row = (title: string, desc: React.ReactNode, control: React.ReactNode, className?: string) => <div className={cx("setting", className)}><div><b>{title}</b>{desc && <small>{desc}</small>}</div>{control}</div>;
  return <section className="settings-group"><h2>이 프로필</h2><div className="settings-card">
    {row("쇼츠", kids ? "어린이 프로필에서는 쓸 수 없어요." : on ? <>작품 예고편을 세로로 넘겨 봐요. <Link className="setting-inline-link" to="/shorts">열기</Link></> : "작품 예고편을 세로로 넘겨 봐요.",
      <Toggle label="쇼츠" checked={on} disabled={kids} onChange={value => save({ shortsEnabled: value })} />)}
    {on && <button type="button" className="setting setting-disclosure" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <div><b>세부 설정</b></div>
      <ChevronDown size={18} className={cx("disclosure-chevron", open && "is-open")} aria-hidden="true" />
    </button>}
    {on && open && <div className="settings-advanced" role="region" aria-label="쇼츠 세부 설정">
      {row("고르는 방식", "", <Select className="setting-select" aria-label="고르는 방식" value={settings.shortsMode ?? "mixed"} onChange={value => save({ shortsMode: value as Settings["shortsMode"] })} options={MODES.map(([value, label]) => ({ value, label }))} />)}
      {row("종류", "여러 개 고를 수 있어요.", <div className="choice-chips" role="group" aria-label="종류">
        {SHORTS_CATEGORIES.map(([value, label]) => {
          const picked = categories.includes(value);
          return <button key={value} type="button" aria-pressed={picked} className={cx("choice-chip", picked && "is-active")} disabled={picked && categories.length === 1} onClick={() => flip(value)}>
            <span className="choice-chip-box" aria-hidden="true">{picked && <Check size={13} strokeWidth={3} />}</span>{label}
          </button>;
        })}
      </div>, "shorts-kinds")}
      {row("직접 재생", nativeReady || nativeOn ? <>실험 · YouTube 대신 MOA 플레이어로 화면 가득 재생해요.{!nativeReady && " 지금은 이 서버에서 쓸 수 없어요."}</> : "실험 · 이 서버에서는 쓸 수 없어요.",
        <Toggle label="직접 재생" checked={nativeOn} disabled={!nativeOn && !nativeReady} onChange={value => save({ shortsPlayback: value ? "native" : "embed" })} />)}
      {nativeOn && row("화질", "", <Select className="setting-select" aria-label="화질" value={settings.shortsQuality ?? "auto"} onChange={value => save({ shortsQuality: value as Settings["shortsQuality"] })} options={QUALITY.map(([value, label]) => ({ value, label }))} />)}
      {row("화면 맞춤", "화면을 꽉 채워요. 이 기기에만 적용돼요.", <Toggle label="화면 맞춤" checked={settings.shortsScreenFit !== false} onChange={value => save({ shortsScreenFit: value })} />)}
      {row("본 작품 숨기기", "5초 넘게 봤거나 직접 넘긴 작품을 이 기간 동안 빼요.", <Select className="setting-select" aria-label="본 작품 숨기기" value={String(settings.shortsRepeatDays ?? 7)} onChange={value => save({ shortsRepeatDays: Number(value) as Settings["shortsRepeatDays"] })} options={REPEAT.map(([value, label]) => ({ value: String(value), label }))} />)}
    </div>}
  </div></section>;
}
