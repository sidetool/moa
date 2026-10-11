import { Check, ChevronRight, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MediaDetail, MetadataCandidate, MetadataLink, Person } from "@moa/shared";
import { api } from "../lib/api";
import { useMe } from "../api/queries";
import { usePeopleSource, type PersonIdentity } from "../lib/people-hooks";
import { PeopleSheet, linkableIdentity } from "./TitlePeople";
import { cx } from "../lib/format";
import { Artwork } from "./Artwork";
import { Button, IconButton } from "./ui";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
}

export function TrailerDialog({ videoKey, title, onClose }: { videoKey: string; title: string; onClose: () => void }) {
  useEscape(onClose);
  return <div className="sheet-backdrop trailer-backdrop" onClick={onClose}>
    <div className="trailer" role="dialog" aria-modal="true" aria-label={`${title} 예고편`} onClick={e => e.stopPropagation()}>
      <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoKey)}?autoplay=1&rel=0&playsinline=1`} title={`${title} 예고편`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      <IconButton className="trailer-close" label="닫기" onClick={onClose}><X size={22} /></IconButton>
    </div>
  </div>;
}

export function PeopleRow({ people, mediaId, linked }: { people: Person[]; mediaId: string; linked: boolean }) {
  // With an enabled `title.people` plugin the same row gains a full credits sheet; otherwise it stays as before.
  // Linked titles without native cast (crew-only works, older cached details) still get an entry to the sheet.
  const source = usePeopleSource();
  const [sheet, setSheet] = useState<{ start?: PersonIdentity & { name: string } } | null>(null);
  const close = useCallback(() => setSheet(null), []);
  // A sheet belongs to the source that opened it: disabling or replacing the plugin closes it for good.
  const [owner, setOwner] = useState(source);
  if (owner !== source) { setOwner(source); setSheet(null); }
  const entry = source && (people.length || linked);
  if (!people.length && !entry) return null;
  return <section className="title-section" aria-labelledby="people-title">
    <div className="title-section-head">
      <h2 id="people-title">{people.length ? "출연" : "출연·제작진"}</h2>
      {entry && <button type="button" className="text-btn" onClick={() => setSheet({})}>{people.length ? "출연·제작진 전체" : "목록 보기"}<ChevronRight size={16} aria-hidden="true" /></button>}
    </div>
    {!people.length && <p className="people-empty">이 화면에 표시할 출연 정보가 없어요. 목록에서 TMDB에 등록된 출연진과 제작진을 확인해 보세요.</p>}
    {!!people.length && <ul className="people no-scrollbar">
      {people.map((p, i) => {
        const identity = source ? linkableIdentity(p.identity) : null;
        const content = <>
          <span className="person-photo">{p.photo ? <img src={p.photo} alt="" loading="lazy" draggable={false} /> : <span aria-hidden="true">{p.name.slice(0, 1)}</span>}</span>
          <b>{p.name}</b>
          {p.role && <small>{p.role}</small>}
        </>;
        return <li key={`${p.name}-${i}`} className="person">
          {identity ? <button type="button" className="person-link" aria-label={`${p.name}${p.role ? `, ${p.role}` : ""}. 참여 작품 보기`} onClick={() => setSheet({ start: { ...identity, name: p.name } })}>{content}</button> : content}
        </li>;
      })}
    </ul>}
    {sheet && source && <PeopleSheet mediaId={mediaId} source={source} start={sheet.start} onClose={close} />}
  </section>;
}

/** Recommendations are not in any source yet; each one searches the installed sources. */
export function SimilarRow({ items }: { items: MetadataCandidate[] }) {
  return <section className="title-section" aria-labelledby="similar-title">
    <h2 id="similar-title">비슷한 콘텐츠</h2>
    <div className="similar-grid">
      {items.slice(0, 12).map(item => <Link key={`${item.kind}-${item.id}`} to={`/search?q=${encodeURIComponent(item.title)}`} className="card poster-card" aria-label={`${item.title} 검색`}>
        <div className="card-frame"><Artwork src={item.poster} title={item.title} ratio="poster" width={342} /></div>
        <span className="card-title">{item.title}</span>
        {item.year && <span className="card-sub">{item.year}</span>}
      </Link>)}
    </div>
  </section>;
}

const linkSummary = (link: MetadataLink) => {
  if (link.status === "off") return "작품 정보 사용 안 함";
  if (!link.id) return link.status === "pending" ? "작품 정보를 찾는 중이에요" : "연결된 작품 정보가 없어요";
  return `${link.title ?? ""} · ${link.kind === "movie" ? "영화" : link.season ? `시즌 ${link.season}` : "시리즈"}${link.status === "manual" ? " · 직접 선택" : ""}`;
};

export function MetadataCredit({ media }: { media: MediaDetail }) {
  const [open, setOpen] = useState(false);
  const admin = useMe().data?.role === "admin";
  const link = media.metadata;
  if (!link) return null;
  return <>
    <p className="title-credit">
      <span>{link.id ? <>작품 정보 <a href={`https://www.themoviedb.org/${link.kind}/${link.id}`} target="_blank" rel="noreferrer">TMDB</a></> : linkSummary(link)}</span>
      {admin && <button className="text-btn" onClick={() => setOpen(true)}>{link.id ? "다른 작품인가요?" : "직접 찾기"}</button>}
    </p>
    {open && <MetadataSheet media={media} onClose={() => setOpen(false)} />}
  </>;
}

function MetadataSheet({ media, onClose }: { media: MediaDetail; onClose: () => void }) {
  useEscape(onClose);
  const client = useQueryClient();
  const [value, setValue] = useState(media.metadata?.title || media.title.replace(/\s*(?:\d+\s*기|시즌\s*\d+)\s*$/, ""));
  const [q, setQ] = useState(value);
  useEffect(() => { const t = setTimeout(() => setQ(value.trim()), 300); return () => clearTimeout(t); }, [value]);
  const results = useQuery({ queryKey: ["metadata-search", media.id, q], queryFn: ({ signal }) => api<MetadataCandidate[]>(`/media/${encodeURIComponent(media.id)}/metadata/search?q=${encodeURIComponent(q)}`, { signal }), enabled: q.length > 0, staleTime: 60_000 });
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<MetadataLink>(`/media/${encodeURIComponent(media.id)}/metadata`, { method: "PATCH", body }),
    onSuccess: () => { void client.invalidateQueries(); onClose(); }
  });
  const link = media.metadata!;
  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet metadata-sheet" role="dialog" aria-modal="true" aria-label="작품 정보 수정" onClick={e => e.stopPropagation()}>
      <header className="sheet-head"><h2>작품 정보 수정</h2><IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
      <div className="metadata-body">
        <p className="metadata-current"><span>현재</span>{linkSummary(link)}</p>
        <label className="metadata-search">
          <Search size={18} aria-hidden="true" />
          <input autoFocus value={value} placeholder="작품 제목으로 검색" aria-label="TMDB에서 작품 검색" onChange={e => setValue(e.target.value)} />
        </label>
        <ul className="metadata-results" aria-busy={results.isFetching}>
          {results.data?.map(c => {
            const current = link.kind === c.kind && link.id === c.id;
            return <li key={`${c.kind}-${c.id}`}>
              <button className={cx("metadata-result", current && "is-current")} disabled={change.isPending} onClick={() => change.mutate({ action: "link", kind: c.kind, tmdbId: c.id })}>
                <span className="metadata-poster"><Artwork src={c.poster} title={c.title} ratio="poster" width={154} labelFallback={false} /></span>
                <span className="metadata-info">
                  <b>{c.title}</b>
                  <small>{[c.kind === "movie" ? "영화" : "시리즈", c.year, c.originalTitle].filter(Boolean).join(" · ")}</small>
                  {c.overview && <span>{c.overview}</span>}
                </span>
                {current && <Check size={18} className="metadata-check" aria-label="현재 연결됨" />}
              </button>
            </li>;
          })}
          {results.isFetching && !results.data && <li className="metadata-note">검색 중…</li>}
          {results.data?.length === 0 && <li className="metadata-note">‘{q}’ 검색 결과가 없어요. 원제나 다른 표기로 찾아보세요.</li>}
          {results.isError && <li className="metadata-note">TMDB에 연결하지 못했어요.</li>}
        </ul>
        {change.isError && <p className="settings-error" role="alert">저장하지 못했어요. 다시 시도해 주세요.</p>}
      </div>
      <footer className="sheet-foot">
        {link.status !== "off" ? <Button variant="ghost" className="btn-danger" disabled={change.isPending} onClick={() => change.mutate({ action: "off" })}>정보 사용 안 함</Button> : <span />}
        <Button disabled={change.isPending} onClick={() => change.mutate({ action: "auto" })}>자동으로 다시 찾기</Button>
      </footer>
    </div>
  </div>;
}
