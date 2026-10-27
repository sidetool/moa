import { useEffect, useRef } from "react";
import { Spinner } from "./Feedback";

export function ScrollLoader({ hasMore, loading, failed, onLoad }: { hasMore: boolean; loading: boolean; failed: boolean; onLoad: () => unknown }) {
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more.current || !hasMore || loading || failed) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      onLoad();
    }, { rootMargin: '240px' });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [hasMore, loading, failed, onLoad]);
  return hasMore ? <div className="source-more" ref={more} role="status" aria-live="polite">{loading && <><Spinner size={20} /><span>불러오는 중…</span></>}</div> : null;
}
