import { ArrowLeft, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import tmdbLogo from "../assets/tmdb.svg";
import type { PeopleSource, PersonIdentity } from "../lib/people-hooks";
import { cx } from "../lib/format";
import { Artwork } from "./Artwork";
import { Button, IconButton } from "./ui";

/*
 * Full credits and per-person works supplied by an opt-in `title.people` plugin, rendered natively.
 * Every answer is validated here: only TMDB is supported (attribution and image rules exist only for it),
 * identities stay opaque strings, images must be fixed TMDB sizes, and the answer must be about this title.
 * Nothing is cached; each open asks again, and stale or cancelled answers are dropped.
 */

const STATUSES = ["ready", "unlinked", "unconfigured", "restricted", "unavailable"] as const;
type Status = typeof STATUSES[number];
export const PEOPLE_PROVIDERS = ["tmdb"];

interface Title { provider: string; kind: "movie" | "tv"; id: string; name?: string; scope: "movie" | "series" }
interface Credit { key: string; provider: string; id: string; name: string; photo?: string; roles: string[] }
interface Work { key: string; kind: "movie" | "tv"; title: string; originalTitle?: string; year?: number; poster?: string }
interface Credits { status: Status; title: Title | null; cast: Credit[]; crew: Credit[]; truncated: boolean }
interface Works { status: Status; title: Title | null; person: Credit | null; items: Work[]; truncated: boolean }
type Load<T> = { state: "idle" | "loading" } | { state: "done"; data: T } | { state: "error"; message: string };

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const opaque = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 256;
const image = (size: string) => (value: unknown) =>
  typeof value === "string" && new RegExp(`^https://image\\.tmdb\\.org/t/p/${size}/[A-Za-z0-9_-]+\\.(?:jpg|png|webp)$`).test(value) ? value : undefined;
const photoUrl = image("w185"), posterUrl = image("w342");
const keyOf = (person: PersonIdentity) => JSON.stringify([person.provider, person.id]);
class Unsupported extends Error {}

/** Native cast entries become links only with a stored, supported identity — never by matching names. */
export function linkableIdentity(identity: unknown): PersonIdentity | null {
  const value = identity as Partial<PersonIdentity> | null | undefined;
  return value && typeof value === "object" && typeof value.provider === "string" && PEOPLE_PROVIDERS.includes(value.provider) && opaque(value.id) ? { provider: value.provider, id: value.id } : null;
}

function envelope(raw: any, mediaId: string) {
  if (!raw || typeof raw !== "object" || !STATUSES.includes(raw.status)) throw new Error("invalid");
  if (!PEOPLE_PROVIDERS.includes(raw.provider)) throw new Unsupported();
  if (raw.status !== "ready") return { status: raw.status as Status, title: null, truncated: false };
  const t = raw.title;
  if (!t || typeof t !== "object" || t.mediaId !== mediaId || t.provider !== raw.provider || !opaque(t.id)
    || !(t.kind === "movie" && t.scope === "movie" || t.kind === "tv" && t.scope === "series")) throw new Error("invalid title");
  return { status: "ready" as const, title: { provider: t.provider, kind: t.kind, id: t.id, name: text(t.name, 300), scope: t.scope } as Title, truncated: raw.truncated === true };
}

const roleList = (value: unknown, max: number) => Array.isArray(value) ? [...new Set(value.map(role => text(role, 200)).filter((role): role is string => !!role))].slice(0, max) : [];

function credit(value: any, provider: string, maxRoles: number): Credit | null {
  if (!value || typeof value !== "object" || value.provider !== provider || !opaque(value.id)) return null;
  const name = text(value.name, 200);
  return name ? { key: keyOf(value), provider, id: value.id, name, photo: photoUrl(value.photo), roles: roleList(value.roles, maxRoles) } : null;
}

function creditList(list: unknown, provider: string) {
  if (!Array.isArray(list)) throw new Error("invalid credits");
  const found = new Map<string, Credit>();
  for (const value of list) {
    const entry = credit(value, provider, 8);
    if (!entry) continue;
    const existing = found.get(entry.key);
    if (existing) existing.roles = [...new Set([...existing.roles, ...entry.roles])].slice(0, 8);
    else found.set(entry.key, entry);
    if (found.size >= 60) break;
  }
  return [...found.values()];
}

function parseCredits(raw: any, mediaId: string): Credits {
  const base = envelope(raw, mediaId);
  if (base.status !== "ready") return { ...base, cast: [], crew: [] };
  return { ...base, cast: creditList(raw.cast, raw.provider), crew: creditList(raw.crew, raw.provider) };
}

function parseWorks(raw: any, mediaId: string, wanted: PersonIdentity): Works {
  const base = envelope(raw, mediaId);
  if (base.status !== "ready" || !base.title) return { ...base, person: null, items: [] };
  const person = raw.person == null ? null : credit(raw.person, raw.provider, 16);
  if (raw.person != null && (!person || person.id !== wanted.id || person.provider !== wanted.provider)) throw new Error("person mismatch");
  if (!Array.isArray(raw.items)) throw new Error("invalid works");
  const here = JSON.stringify([base.title.provider, base.title.kind, base.title.id]), seen = new Set([here]), items: Work[] = [];
  for (const item of raw.items) {
    const title = text(item?.title, 300);
    if (!title || (item.kind !== "movie" && item.kind !== "tv") || item.provider !== raw.provider || !opaque(item.id)) continue;
    const key = JSON.stringify([item.provider, item.kind, item.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const originalTitle = text(item.originalTitle, 300);
    items.push({ key, kind: item.kind, title, originalTitle: originalTitle !== title ? originalTitle : undefined,
      year: Number.isInteger(item.year) && item.year > 1800 && item.year < 3000 ? item.year : undefined, poster: posterUrl(item.poster) });
    if (items.length >= 40) break;
  }
  return { ...base, person, items };
}

const failure = (error: unknown) => error instanceof Unsupported ? "이 정보 제공처는 아직 지원하지 않아요." : "정보를 불러오지 못했어요.";
const STATUS_TEXT: Record<Exclude<Status, "ready">, string> = {
  unlinked: "TMDB 작품과 연결되지 않아 출연·제작진을 볼 수 없어요.",
  unconfigured: "관리자가 설정에서 TMDB를 연결하면 볼 수 있어요.",
  restricted: "이 프로필에서는 출연·제작진 정보를 볼 수 없어요.",
  unavailable: "TMDB에서 정보를 가져오지 못했어요.",
};
const retryable = (status: Status) => status === "unconfigured" || status === "unavailable";

function ScopeNote({ title }: { title: Title }) {
  return <p className="people-scope">
    {title.scope === "series"
      ? <><b>시리즈 전체 기준</b>특정 시즌이나 회차의 출연을 뜻하지 않아요.</>
      : <><b>영화 기준</b></>}
  </p>;
}

function Photo({ person, size }: { person: { name: string; photo?: string }; size?: "l" }) {
  const [failed, setFailed] = useState(false);
  return <span className={cx("person-photo", size === "l" && "is-large")} aria-hidden="true">
    {person.photo && !failed ? <img src={person.photo} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} /> : <span>{Array.from(person.name)[0]}</span>}
  </span>;
}

function Notice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="people-notice" role="status"><p>{message}</p>{onRetry && <Button variant="secondary" onClick={onRetry}>다시 시도</Button>}</div>;
}

type View = { mode: "list" } | { mode: "person"; who: PersonIdentity & { name: string }; fromList: boolean };

export function PeopleSheet({ mediaId, source, start, onClose }: {
  mediaId: string; source: PeopleSource; start?: PersonIdentity & { name: string }; onClose: () => void;
}) {
  const [view, setView] = useState<View>(start ? { mode: "person", who: start, fromList: false } : { mode: "list" });
  const [group, setGroup] = useState<"cast" | "crew">("cast");
  const [credits, setCredits] = useState<Load<Credits>>({ state: "idle" });
  const [works, setWorks] = useState<Load<Works>>({ state: "idle" });
  const [attempt, setAttempt] = useState(0), [creditsRun, setCreditsRun] = useState(0);
  const creditsNow = useRef(credits);
  creditsNow.current = credits;
  const reloadCredits = () => { setCredits({ state: "idle" }); setCreditsRun(n => n + 1); };
  const heading = useRef<HTMLHeadingElement>(null), body = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ key: string; scroll: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Escape closes like other MOA sheets; focus returns to whatever opened the sheet. The opener is captured during
  // the first render, before the layout effect below moves focus to the heading.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("keydown", esc); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);

  // Credits: requested whenever the list is shown without valid data (first open, retry, or after a person request
  // failed). The trigger is the view and an explicit counter, not the result state, so storing results never
  // re-runs this effect and cancels its own request.
  useEffect(() => {
    if (view.mode !== "list" || creditsNow.current.state === "done") return;
    const controller = new AbortController();
    setCredits({ state: "loading" });
    // Parsing runs inside the chain so malformed or unsupported answers reach the same catch as failed requests.
    source.request({ action: "credits", mediaId }, controller.signal)
      .then(raw => parseCredits(raw, mediaId))
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.status === "ready" && !data.cast.length && data.crew.length) setGroup("crew");
        setCredits({ state: "done", data });
      })
      .catch(error => { if (!controller.signal.aborted) setCredits({ state: "error", message: failure(error) }); });
    return () => controller.abort();
  }, [view.mode, creditsRun, source, mediaId]);

  // Works: a new request for every person view; leaving the view cancels it.
  const who = view.mode === "person" ? view.who : null;
  useEffect(() => {
    if (!who) return;
    const controller = new AbortController();
    setWorks({ state: "loading" });
    source.request({ action: "person", mediaId, person: { provider: who.provider, id: who.id } }, controller.signal)
      .then(raw => parseWorks(raw, mediaId, who))
      .then(data => {
        if (controller.signal.aborted) return;
        // Denials may mean access or linking changed: discard earlier credits so nothing stale is shown again.
        if (data.status !== "ready" || !data.person) setCredits({ state: "idle" });
        setWorks({ state: "done", data });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setCredits({ state: "idle" });
        setWorks({ state: "error", message: failure(error) });
      });
    return () => controller.abort();
  }, [who?.provider, who?.id, attempt, source, mediaId]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (view.mode === "person") { body.current?.scrollTo?.(0, 0); heading.current?.focus({ preventScroll: true }); return; }
    const back = returnTo.current;
    if (!back || credits.state !== "done") { heading.current?.focus({ preventScroll: true }); return; }
    if (body.current) body.current.scrollTop = back.scroll;
    const target = [...(body.current?.querySelectorAll<HTMLElement>("[data-person]") ?? [])].find(node => node.dataset.person === back.key);
    (target ?? heading.current)?.focus({ preventScroll: true });
    returnTo.current = null;
  }, [view, credits.state]);

  const openPerson = (person: Credit) => {
    returnTo.current = { key: person.key, scroll: body.current?.scrollTop ?? 0 };
    setView({ mode: "person", who: { provider: person.provider, id: person.id, name: person.name }, fromList: true });
  };
  const toList = () => { setWorks({ state: "idle" }); setView({ mode: "list" }); };

  const list = credits.state === "done" && credits.data.status === "ready" ? credits.data : null;
  const shown = list ? list[group] : [];

  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet people-sheet" role="dialog" aria-modal="true" aria-labelledby="people-sheet-title" onClick={event => event.stopPropagation()}>
      <header className="sheet-head people-sheet-head">
        {view.mode === "person" && <IconButton label="출연·제작진 목록" onClick={toList}><ArrowLeft size={20} /></IconButton>}
        <h2 id="people-sheet-title" ref={heading} tabIndex={-1}>{view.mode === "list" ? "출연·제작진" : personTitle(view.who.name, works)}</h2>
        <IconButton label="닫기" onClick={onClose}><X size={20} /></IconButton>
      </header>
      <div className="people-sheet-body" ref={body}>
        {view.mode === "list" ? <>
          {list?.title && <ScopeNote title={list.title} />}
          {list && <div className="people-tabs" role="group" aria-label="구분">
            {(["cast", "crew"] as const).map(key => <button key={key} type="button" className={cx("chip", group === key && "is-active")} aria-pressed={group === key} onClick={() => { setGroup(key); body.current?.scrollTo?.(0, 0); }}>
              {key === "cast" ? "출연" : "제작"}<small>{list[key].length}</small>
            </button>)}
          </div>}
          {credits.state !== "done" && credits.state !== "error" && <p className="metadata-note" role="status">불러오는 중…</p>}
          {credits.state === "error" && <Notice message={credits.message} onRetry={reloadCredits} />}
          {credits.state === "done" && credits.data.status !== "ready" && <Notice message={STATUS_TEXT[credits.data.status]} onRetry={retryable(credits.data.status) ? reloadCredits : undefined} />}
          {list && !shown.length && <p className="metadata-note">TMDB에 등록된 {group === "cast" ? "출연진" : "제작진"}이 없어요.</p>}
          {!!shown.length && <ul className="credit-list" aria-label={group === "cast" ? "출연진" : "제작진"}>
            {shown.map(person => <li key={person.key}>
              <button type="button" className="credit-person" data-person={person.key} onClick={() => openPerson(person)}
                aria-label={`${person.name}${person.roles.length ? `, ${person.roles.join(", ")}` : ""}. 참여 작품 보기`}>
                <Photo person={person} />
                <span className="credit-text"><b>{person.name}</b><small className={cx(!person.roles.length && "is-empty")}>{person.roles.join(" · ") || (group === "cast" ? "배역 정보 없음" : "직무 정보 없음")}</small></span>
              </button>
            </li>)}
          </ul>}
          {list && <p className="people-fine">{list.truncated && "TMDB 목록 중 일부만 보여요. "}배역·직무는 TMDB 표기 그대로이며, 더빙 언어나 성우 여부를 따로 판단하지 않아요.</p>}
        </> : <PersonView works={works} credits={list} who={view.who} onRetry={() => setAttempt(n => n + 1)} onClose={onClose} />}
      </div>
      <footer className="people-sheet-foot">
        <img src={tmdbLogo} alt="TMDB" />
        <p><span lang="en">This product uses the TMDB API but is not endorsed or certified by TMDB.</span></p>
      </footer>
    </div>
  </div>;
}

/** While loading only the chosen name is shown; denials and failures show no earlier name, portrait or roles. */
const personTitle = (name: string, works: Load<Works>) =>
  works.state === "done" ? works.data.person?.name ?? "인물 정보" : works.state === "error" ? "인물 정보" : name;

function PersonView({ works, credits, who, onRetry, onClose }: { works: Load<Works>; credits: Credits | null; who: PersonIdentity; onRetry: () => void; onClose: () => void }) {
  if (works.state === "error") return <Notice message={works.message} onRetry={onRetry} />;
  if (works.state !== "done") return <p className="metadata-note" role="status">참여 작품을 불러오는 중…</p>;
  const data = works.data;
  if (data.status !== "ready") return <Notice message={data.status === "restricted" ? "이 프로필에서는 인물 정보를 볼 수 없어요." : STATUS_TEXT[data.status]} onRetry={retryable(data.status) ? onRetry : undefined} />;
  if (!data.person || !data.title) return <Notice message="TMDB에서 이 인물 정보를 찾지 못했어요." onRetry={onRetry} />;
  const person = data.person, key = keyOf(who);
  // Roles in this title come from the credits lists, which keep characters and jobs apart; without them the
  // person's combined roles from this answer are shown under one neutral label.
  const cast = credits?.cast.find(entry => entry.key === key), crew = credits?.crew.find(entry => entry.key === key);
  const lines: [string, string[]][] = cast || crew ? [...(cast ? [["배역", cast.roles] as [string, string[]]] : []), ...(crew ? [["직무", crew.roles] as [string, string[]]] : [])] : [["참여", person.roles]];
  return <>
    <div className="person-profile">
      <Photo person={person} size="l" />
      <div>
        <dl className="person-roles">{lines.map(([label, roles]) => <div key={label}><dt>{label}</dt><dd>{roles.join(" · ") || "정보 없음"}</dd></div>)}</dl>
        <ScopeNote title={data.title} />
      </div>
    </div>
    <h3 className="person-works-title">다른 참여 작품{data.items.length ? <small>{data.items.length}</small> : null}</h3>
    {data.items.length ? <>
      <p className="people-fine">TMDB에 등록된 작품이에요. 선택하면 MOA에서 제목을 검색하며, 바로 재생하지는 않아요.{data.truncated && " 일부만 보여요."}</p>
      <div className="similar-grid person-works">
        {data.items.map(item => <Link key={item.key} to={`/search?q=${encodeURIComponent(item.title)}`} className="card poster-card" title={item.originalTitle} onClick={onClose}
          aria-label={`${item.title}${item.year ? ` (${item.year})` : ""} MOA에서 검색`}>
          <div className="card-frame"><Artwork src={item.poster} title={item.title} ratio="poster" width={342} /></div>
          <span className="card-title">{item.title}</span>
          <span className="card-sub">{[item.kind === "movie" ? "영화" : "TV", item.year].filter(Boolean).join(" · ")}</span>
        </Link>)}
      </div>
    </> : <p className="metadata-note">TMDB에 등록된 다른 참여 작품이 없어요.</p>}
  </>;
}
