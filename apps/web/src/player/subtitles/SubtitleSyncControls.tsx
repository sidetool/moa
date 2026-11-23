import { useRef } from 'react';
import { Button } from '../../components/ui';
import { cx } from '../../lib/format';

interface Props {
  offset: number;
  manual: boolean;
  automatic: boolean;
  onNudge: (delta: number) => void;
  onRestore: () => void;
  saveFailed?: boolean;
  onRetry?: () => void;
}

export function SubtitleSyncControls({ offset, manual, automatic, onNudge, onRestore, saveFailed, onRetry }: Props) {
  const value = useRef<HTMLButtonElement>(null);
  const timing = `${offset > 0 ? '+' : ''}${offset.toFixed(1)}초`;
  return (
    <div className="pf-block">
      <span className="pf-label">싱크</span>
      <div className="sync-row">
        <button className="seg-btn" aria-label="-0.5" onClick={() => onNudge(-0.5)}>−0.5</button>
        <button className="seg-btn" aria-label="-0.1" onClick={() => onNudge(-0.1)}>−0.1</button>
        <button ref={value} className={cx('sync-value', offset !== 0 && 'is-shifted')} onClick={() => onNudge(-offset)}
          title="수동으로 0초 맞추기" aria-label={`${timing}, 수동으로 0초 맞추기`}>{timing}</button>
        <button className="seg-btn" aria-label="+0.1" onClick={() => onNudge(0.1)}>+0.1</button>
        <button className="seg-btn" aria-label="+0.5" onClick={() => onNudge(0.5)}>+0.5</button>
      </div>
      <p className="panel-note">자막이 늦게 나오면 −, 빨리 나오면 +. 이 영상과 기기에만 저장돼요.</p>
      {manual && <Button onClick={() => { value.current?.focus(); onRestore(); }}>
        {automatic ? '자동 싱크로 복원' : '수동 보정 해제'}
      </Button>}
      {saveFailed && <>
        <p className="panel-note note-warn" role="status">싱크를 이 기기에 저장하지 못했어요. 이번 재생에는 적용돼요.</p>
        <Button onClick={() => { value.current?.focus(); onRetry?.(); }}>다시 저장</Button>
      </>}
    </div>
  );
}
