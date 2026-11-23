import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../../lib/format";
import { remoteKey } from "../../lib/remote";
import { keepTabInDialog } from "../../lib/dialog-focus";
import { Button } from "./Button";

export function ConfirmDialog({ title, children, confirmLabel = "확인", busy = false, confirmDisabled = false, className, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel?: string; busy?: boolean; confirmDisabled?: boolean; className?: string; onConfirm?: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className={cx("confirm-dialog", className)} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      keepTabInDialog(event);
      if (remoteKey(event.nativeEvent) === "Back") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
    }}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (!busy && event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    <header className="sheet-head"><h2 id={`${id}-title`}>{title}</h2></header>
    <div className="confirm-dialog-body" id={`${id}-body`}>{children}</div>
    <footer className="sheet-foot"><Button type="button" autoFocus disabled={busy} onClick={onClose}>{onConfirm ? "취소" : "닫기"}</Button>{onConfirm && <Button type="button" variant="primary" disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "처리 중…" : confirmLabel}</Button>}</footer>
  </dialog>;
}
