import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/format";

export function ProgressBar({ ratio, className }: { ratio: number; className?: string }) {
  return <span className={cx("progress", className)} aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} /></span>;
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cx("sk", className)} style={style} aria-hidden="true" />;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 28 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="불러오는 중" />;
}
