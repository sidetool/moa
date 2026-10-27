import { EyeOff, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { RecommendationItem } from "@moa/shared";
import { useSettings } from "../../api/queries";
import { dismissRecommendation, recommendationTarget, undoDismissRecommendation, useRecommendations } from "../../api/recommendations";
import { Artwork } from "../../components/Artwork";
import { RowShell } from "../../components/Row";
import { cx } from "../../lib/format";

type Hidden = "pending" | "hidden" | "failed";

/** Home row of picks from this profile's history and watchlist. Hidden entirely unless the server has real picks. */
export function RecommendationRow() {
  const settings = useSettings().data;
  const enabled = Boolean(settings) && settings?.recommendationsEnabled !== false;
  const recommendations = useRecommendations(enabled);
  // Dismissed cards stay in place as an undo tile until the next refresh drops them.
  const [hidden, setHidden] = useState<Record<string, Hidden>>({});
  const items = recommendations.data?.status === "ready" ? recommendations.data.items : [];
  if (!enabled || !items.length) return null;

  const dismiss = (key: string) => {
    setHidden(old => ({ ...old, [key]: "pending" }));
    dismissRecommendation(key).then(() => setHidden(old => ({ ...old, [key]: "hidden" })), () => setHidden(old => ({ ...old, [key]: "failed" })));
  };
  const undo = (key: string) => {
    const previous = hidden[key];
    setHidden(({ [key]: _, ...rest }) => rest);
    if (previous === "hidden") undoDismissRecommendation(key).catch(() => setHidden(old => ({ ...old, [key]: "hidden" })));
  };

  return (
    <RowShell id="recommendations" title="취향 기반 추천" layout="poster" className="row-recommend" count={items.length}>
      {items.map(item => hidden[item.key]
        ? <HiddenCard key={item.key} item={item} state={hidden[item.key]} onUndo={() => undo(item.key)} onRetry={() => dismiss(item.key)} />
        : <RecommendationCard key={item.key} item={item} onDismiss={() => dismiss(item.key)} />)}
    </RowShell>
  );
}

function RecommendationCard({ item, onDismiss }: { item: RecommendationItem; onDismiss: () => void }) {
  return (
    <div className="card poster-card recommend-card">
      <Link to={recommendationTarget(item.href, item.title)} className="card-frame" aria-label={`${item.title} · ${item.reason}`}>
        <Artwork src={item.poster} title={item.title} ratio="poster" width={342} />
        {item.year && <div className="card-hover" aria-hidden="true"><span className="card-hover-meta">{[item.year, item.kind === "movie" ? "영화" : "시리즈"].join(" · ")}</span></div>}
      </Link>
      <div className="recommend-meta">
        <div>
          <span className="card-title" title={item.title}>{item.title}</span>
          <span className="card-sub recommend-reason" title={item.reason}>{item.reason}</span>
        </div>
        <button className="icon-btn icon-btn-s" data-remote-secondary aria-label={`${item.title} 관심 없음`} title="관심 없음" onClick={onDismiss}><EyeOff size={16} /></button>
      </div>
    </div>
  );
}

function HiddenCard({ item, state, onUndo, onRetry }: { item: RecommendationItem; state: Hidden; onUndo: () => void; onRetry: () => void }) {
  return (
    <div className={cx("card poster-card recommend-hidden", state === "failed" && "is-failed")} role="status">
      <div className="recommend-hidden-body">
        <b>{state === "failed" ? "숨기지 못했어요" : "추천에서 숨겼어요"}</b>
        <span>{item.title}</span>
        {state === "failed"
          ? <div className="recommend-hidden-actions"><button className="text-btn" onClick={onRetry}>다시 시도</button><button className="text-btn" onClick={onUndo}>취소</button></div>
          : <button className="text-btn" disabled={state === "pending"} onClick={onUndo}><Undo2 size={14} />되돌리기</button>}
      </div>
    </div>
  );
}
