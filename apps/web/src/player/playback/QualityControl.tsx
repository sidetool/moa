import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import type { PlaybackSession, Settings } from "@moa/shared";
import { cx } from "../../lib/format";

type Stream = NonNullable<PlaybackSession["streams"]>[number];
export type QualityLevel = { index: number; height: number };

/** Profile default as a target height; "auto" leaves the choice to the player. */
export function preferredHeight(value?: Settings["preferredQuality"]) {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/** Resolution tag for a server row, unless its own label already says it. Server names are never read as resolutions. */
function streamHeightTag(stream: Stream) {
  return stream.height && !stream.label.toLowerCase().includes(`${stream.height}p`) ? `${stream.height}p` : null;
}

/** One entry per known height, tallest first; the first of equal heights wins. Unknown heights are left out. */
function byHeight<T>(items: readonly T[], height: (item: T) => number | undefined) {
  const seen = new Map<number, T>();
  for (const item of items) { const h = height(item); if (h && h > 0 && !seen.has(h)) seen.set(h, item); }
  return [...seen].sort((a, b) => b[0] - a[0]);
}

/**
 * Player quality choice. HLS variants of the current stream come first (with adaptive "자동");
 * otherwise sources that report different resolutions; otherwise the resolution being played.
 */
export function QualityControl({ levels, level, onLevel, streams, streamId, onStream, playingHeight, transcode }: {
  levels: readonly QualityLevel[];
  /** Manual HLS level, -1 for adaptive. */
  level: number;
  onLevel: (index: number) => void;
  streams?: readonly Stream[];
  streamId?: string;
  onStream: (id: string) => void;
  /** Decoded frame height of the video element, 0 when unknown. */
  playingHeight: number;
  transcode: boolean;
}) {
  const variants = byHeight(levels, item => item.height);
  const sources = byHeight(streams ?? [], item => item.height);
  const current = streams?.find(item => item.id === streamId);
  const playing = playingHeight > 0 ? `${playingHeight}p` : "";
  const options = variants.length > 1
    ? [
        { key: "auto", label: "자동", active: level === -1, pick: () => onLevel(-1) },
        ...variants.map(([height, item]) => ({ key: String(height), label: `${height}p`, active: level !== -1 && levels.find(entry => entry.index === level)?.height === height, pick: () => onLevel(item.index) }))
      ]
    : sources.length > 1
      ? sources.map(([height, item]) => ({ key: String(height), label: `${height}p`, active: current?.height === height, pick: () => { if (current?.height !== height) onStream(item.id); } }))
      : null;
  const selected = options?.findIndex(option => option.active) ?? -1;
  return (
    <div className="pf-block">
      <span className="pf-label">화질{options && playing && ` · 지금 ${playing}`}</span>
      {options ? (
        <div className="seg seg-fill" role="group" aria-label="화질" style={{ "--segments": options.length, "--selected": Math.max(0, selected) } as CSSProperties}>
          {options.map(option => <button key={option.key} className={cx(option.active && "is-active")} aria-pressed={option.active} onClick={option.pick}>{option.label}</button>)}
        </div>
      ) : <p className="pf-value">{[transcode ? "서버 변환" : "원본 화질", playing || (transcode ? "기기에 맞춰 재생 중" : "")].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

/** Source servers as the extension named them, with the resolution the server reported when it is known. */
export function ServerControl({ streams, streamId, onStream }: { streams?: readonly Stream[]; streamId?: string; onStream: (id: string) => void }) {
  if (!streams || streams.length < 2) return null;
  return (
    <div className="pf-block">
      <span className="pf-label">재생 서버</span>
      <div className="pf-list">
        {streams.map(stream => {
          const tag = streamHeightTag(stream);
          return <button className={cx("opt", streamId === stream.id && "is-active")} key={stream.id} onClick={() => { if (streamId !== stream.id) onStream(stream.id); }}><Check size={18} className="opt-check" /><span>{stream.label}</span>{tag && <small>{tag}</small>}</button>;
        })}
      </div>
    </div>
  );
}
