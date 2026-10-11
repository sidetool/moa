import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Row as RowData } from "@moa/shared";
import { CardSkeleton, LandscapeCard, PosterCard, RankCard } from "./Cards";
import { Skeleton } from "./ui";
import { cx } from "../lib/format";

export function Row({ row, index = 0, rank = false }: { row: RowData; index?: number; rank?: boolean }) {
  const Card = row.layout === "landscape" ? LandscapeCard : PosterCard;
  return (
    <RowShell id={row.id} title={row.title} layout={row.layout} className={cx(rank && "row-rank")} count={row.items.length}
      more={row.more && <Link to={row.more.path} className="row-more">모두 보기<ChevronRight size={16} /></Link>}>
      {row.items.map((card, i) => rank
        ? <RankCard key={card.id} card={card} rank={i + 1} eager={index < 2 && i < 6} />
        : <Card key={card.id} card={card} eager={index < 2 && i < 6} />)}
    </RowShell>
  );
}

/** Scrolling row frame shared by catalogue rows and rows with their own cards. */
export function RowShell({ id, title, layout, className, count, more, note, children }: { id: string; title: string; layout: "poster" | "landscape"; className?: string; count: number; more?: ReactNode; note?: ReactNode; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const update = () => setEdges({ start: node.scrollLeft < 8, end: node.scrollLeft + node.clientWidth > node.scrollWidth - 8 });
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { node.removeEventListener("scroll", update); observer.disconnect(); };
  }, [count]);

  const page = (direction: 1 | -1) => {
    const node = track.current;
    if (node) node.scrollBy({ left: direction * node.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className={cx("row", `row-${layout}`, className)} aria-labelledby={`row-${id}`}>
      <header className="row-head">
        <h2 id={`row-${id}`}>{title}</h2>
        {note}
        {more}
      </header>
      <div className="row-body">
        <button className={cx("row-arrow row-arrow-prev", edges.start && "is-hidden")} onClick={() => page(-1)} aria-label="이전" tabIndex={-1}><ChevronLeft size={30} /></button>
        <div ref={track} className="row-track no-scrollbar">{children}</div>
        <button className={cx("row-arrow row-arrow-next", edges.end && "is-hidden")} onClick={() => page(1)} aria-label="다음" tabIndex={-1}><ChevronRight size={30} /></button>
      </div>
    </section>
  );
}

export function RowSkeleton({ layout = "poster" }: { layout?: "poster" | "landscape" }) {
  return (
    <section className={cx("row", `row-${layout}`)} aria-hidden="true">
      <header className="row-head"><Skeleton className="sk-heading" /></header>
      <div className="row-body"><div className="row-track no-scrollbar">
        {Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} layout={layout} />)}
      </div></div>
    </section>
  );
}
