import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FranchiseSeason, MediaDetail, RelatedWork, RelatedWorks } from "@moa/shared";
import { keys } from "../../api/queries";
import { Artwork } from "../../components/Artwork";
import { api, currentProfileId } from "../../lib/api";

const relationLabels: Record<RelatedWork["relation"], string> = {
  prequel: "전편", sequel: "후속편", sideStory: "외전", collection: "같은 컬렉션",
};

function PosterSection({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return <section className="title-section" aria-labelledby={heading}>
    <h2 id={heading}>{title}</h2>
    <div className="similar-grid">{children}</div>
  </section>;
}

function WorkCard({ title, poster, to, label, subtitle }: {
  title: string; poster?: string; to: string; label: string; subtitle?: string;
}) {
  return <Link to={to} className="card poster-card" aria-label={label}>
    <div className="card-frame"><Artwork src={poster} title={title} ratio="poster" width={342} /></div>
    <span className="card-title">{title}</span>
    {subtitle && <span className="card-sub">{subtitle}</span>}
  </Link>;
}

export function RelatedWorkSection({ items }: { items: RelatedWork[] }) {
  if (!items.length) return null;
  return <PosterSection title="관련 작품">
    {items.map(item => {
      const action = item.mediaId ? "상세 보기" : "제목 검색";
      const to = item.mediaId ? `/title/${encodeURIComponent(item.mediaId)}` : `/search?q=${encodeURIComponent(item.query)}`;
      const context = [relationLabels[item.relation], item.year].filter(Boolean).join(" · ");
      return <WorkCard key={item.key} title={item.title} poster={item.poster} to={to}
        label={`${item.title}, ${context}, ${action}`} subtitle={item.mediaId ? context : `${context} · ${action}`} />;
    })}
  </PosterSection>;
}

export function TitleWorks({ media, seasons }: { media: MediaDetail; seasons: FranchiseSeason[] }) {
  const link = media.metadata;
  const enabled = media.badge !== "LIVE" && Boolean(link?.id && link.kind && (link.status === "auto" || link.status === "manual"));
  const identity = `${link?.kind}:${link?.id}:${link?.season}`;
  const relations = useQuery({
    queryKey: [...keys.titleRelations, currentProfileId(), media.id, identity],
    queryFn: ({ signal }) => api<RelatedWorks>(`/media/${encodeURIComponent(media.id)}/relations`, { signal }),
    enabled, retry: false,
  });
  const items = enabled && relations.isSuccess ? relations.data.items ?? [] : [];
  // Late metadata can move a focused recommendation above its row or into the season menu.
  // Apply that rearrangement after the user leaves these links.
  const [browsing, setBrowsing] = useState<{ identity: string; keys: Set<string>; seasons: FranchiseSeason[] } | null>(null);
  const shownItems = browsing ? items.filter(item => browsing.identity === identity && browsing.keys.has(item.key)) : items;
  const shownSeasons = browsing?.seasons ?? seasons;
  // A regular season already reachable in the episode picker needs no second link.
  const seasonIds = new Set(shownSeasons.length > 1 ? shownSeasons.map(season => season.mediaId) : []);
  const related = shownItems.filter(item => !item.mediaId || (item.mediaId !== media.id && !seasonIds.has(item.mediaId)));
  const tmdbIds = new Set(shownItems.flatMap(item => item.tmdb ? [`${item.tmdb.kind}-${item.tmdb.id}`] : []));
  const similar = media.similar?.filter(item => !tmdbIds.has(`${item.kind}-${item.id}`)).slice(0, 12);

  if (!related.length && !similar?.length) return null;
  return <div onFocus={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setBrowsing({ identity, keys: new Set(items.map(item => item.key)), seasons });
  }} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setBrowsing(null);
  }}>
    <RelatedWorkSection items={related} />
    {!!similar?.length && <PosterSection title="비슷한 콘텐츠">
      {similar.map(item => <WorkCard key={`${item.kind}-${item.id}`} title={item.title} poster={item.poster}
        to={`/search?q=${encodeURIComponent(item.title)}`} label={`${item.title} 검색`} subtitle={item.year?.toString()} />)}
    </PosterSection>}
  </div>;
}
