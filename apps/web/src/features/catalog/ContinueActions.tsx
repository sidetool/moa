import { EyeOff, Info, MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MediaCard } from '@moa/shared';
import { Button } from '../../components/ui';
import { keepTabInDialog } from '../../lib/dialog-focus';
import { ApiError } from '../../lib/api';

export type HideContinue = (card: MediaCard) => Promise<void>;

export function ContinueActions({ card, onHide }: { card: MediaCard; onHide: HideContinue }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const dismissed = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const element = dialog.current!, trigger = opener.current;
    element.showModal();
    return () => {
      element.close();
      if (dismissed.current && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  const close = () => {
    dismissed.current = true;
    setOpen(false);
  };

  const hide = async () => {
    if (saving.current) return;
    const element = dialog.current!, cardNode = opener.current?.closest('.card');
    const row = cardNode?.closest('.row');
    const next = cardNode?.nextElementSibling?.querySelector<HTMLElement>('.card-frame')
      ?? cardNode?.previousElementSibling?.querySelector<HTMLElement>('.card-frame');
    const rows = [...(row?.closest('.rows')?.querySelectorAll('.row') ?? [])];
    const nextRow = row && rows.slice(rows.indexOf(row) + 1).find(item => item.querySelector('.row-track a'))?.querySelector<HTMLElement>('.row-track a');
    const home = row?.closest('.home');
    const tab = home?.querySelector<HTMLElement>('.section-chips .is-active') ?? home?.querySelector<HTMLElement>('.section-chips a');
    const main = row?.closest('main');
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onHide(card);
      if (dismissed.current) return;
      element.close();
      setOpen(false);
      // The query cache can remove the whole row. Keep the remote in the same browsing area.
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        const target = [next, nextRow, tab, main?.querySelector<HTMLElement>('a[href],button:not(:disabled)')].find(node => node?.isConnected);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'continue-group-changed'
        ? '작품 묶음이 바뀌었어요. 카드를 다시 선택해 주세요.'
        : '숨기지 못했어요. 다시 시도해 주세요.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <>
    <button ref={opener} type="button" className="icon-btn" data-remote-secondary aria-label={`${card.title} 더 보기`} title="더 보기" aria-haspopup="dialog"
      onClick={() => { dismissed.current = false; setError(''); setOpen(true); }}><MoreHorizontal size={18} /></button>
    {open && <dialog ref={dialog} className="confirm-dialog continue-actions-dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={keepTabInDialog} onCancel={close}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
      }}>
      <header className="sheet-head"><h2 id={titleId}>{card.title}</h2></header>
      <div className="confirm-dialog-body continue-actions">
        <Link className="btn btn-secondary btn-m" to={`/title/${encodeURIComponent(card.id)}`} onClick={close}><Info size={18} /><span>상세 정보</span></Link>
        <Button icon={<EyeOff size={18} />} aria-disabled={pending} aria-busy={pending} onClick={() => void hide()}>홈 이어보기에서 숨기기</Button>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet-foot"><Button onClick={close}>닫기</Button></footer>
    </dialog>}
  </>;
}
