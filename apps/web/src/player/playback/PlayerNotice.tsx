import { Captions } from "lucide-react";

export type PlayerNoticeValue = string | { text: string; action: { label: string; run: () => void } };

export function PlayerNotice({ notice, onDismiss }: { notice: PlayerNoticeValue; onDismiss: () => void }) {
  return (
    <div className="player-notice" role="status">
      {typeof notice === "string" ? <span>{notice}</span> : <>
        <Captions size={16} aria-hidden="true" /><span>{notice.text}</span>
        <button type="button" onClick={() => { onDismiss(); notice.action.run(); }}>{notice.action.label}</button>
      </>}
    </div>
  );
}
