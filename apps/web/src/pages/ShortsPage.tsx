import { Check, ChevronDown, ChevronUp, Clapperboard, Play, Plus, RotateCcw, Search, Volume2, VolumeX } from "lucide-react";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MediaCard, ShortsItem } from "@moa/shared";
import { keys, useMe, useProfiles, useSaveSettings, useSettings, useWatchlistToggle } from "../api/queries";
import { recommendationTarget } from "../api/recommendations";
import { useShortsNative, markShortSkipped, SHORTS_CATEGORIES, shortsAvailable, shortsFeedKey, uniqueItems, useShortsFeed } from "../api/shorts";
import { ShortsNativePlayer } from "../components/ShortsNativePlayer";
import { NativePool } from "../lib/shorts-native-pool";
import { ShortsPlayer, type ShortsControl, type ShortsSession } from "../components/ShortsPlayer";
import { Button, ButtonLink, EmptyState, IconButton, Spinner } from "../components/ui";
import { api, currentProfileId, sized } from "../lib/api";
import { cx } from "../lib/format";

const SETTLE_MS = 250;
const AUTO_SKIP_LIMIT = 3;
const INTENT_MS = 4_000; // a flick and its momentum settle well within this
const CATEGORY_LABEL = Object.fromEntries(SHORTS_CATEGORIES) as Record<string, string>;

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="shorts shorts-state">{children}</div>;
}

export function ShortsPage() {
  const settings = useSettings();
  const profiles = useProfiles();
  const save = useSaveSettings();
  const admin = useMe().data?.role === "admin";
  const kids = profiles.data?.find(item => item.id === currentProfileId())?.kids;
  const on = shortsAvailable(settings.data, kids);
  const [replay, setReplay] = useState(false);
  const feed = useShortsFeed(settings.data, on, replay);
  const nativeWanted = on && settings.data?.shortsPlayback === "native";
  const nativeCap = useShortsNative(nativeWanted);
  const native = nativeWanted && nativeCap.data?.available === true;

  if (settings.isPending || profiles.isPending || (nativeWanted && nativeCap.isPending)) return <Centered><Spinner /></Centered>;
  if (kids) return <Centered><EmptyState icon={<Clapperboard size={32} />} title="어린이 프로필에서는 쓸 수 없어요" /></Centered>;
  const status = feed.data?.pages[0]?.status;
  if (!on || status === "disabled") return <Centered><EmptyState icon={<Clapperboard size={32} />} title="쇼츠가 꺼져 있어요"
    body="작품 예고편을 세로로 넘겨 보는 실험 기능이에요. 이 프로필에만 적용돼요."
    action={<Button variant="primary" disabled={!settings.data} onClick={() => void save({ shortsEnabled: true }).catch(() => {})}>켜기</Button>} /></Centered>;
  if (status === "restricted") return <Centered><EmptyState icon={<Clapperboard size={32} />} title="이 프로필에서는 쓸 수 없어요" /></Centered>;
  if (status === "unconfigured") return <Centered><EmptyState title="작품 정보 연결이 필요해요" body={admin ? "설정에서 TMDB를 연결하면 쓸 수 있어요." : "관리자가 TMDB를 연결하면 쓸 수 있어요."}
    action={admin ? <ButtonLink to="/settings#library">설정 열기</ButtonLink> : undefined} /></Centered>;
  if (feed.isError || status === "unavailable") return <Centered><EmptyState title="예고편 목록을 불러오지 못했어요" action={<Button onClick={() => void feed.refetch()}>다시 시도</Button>} /></Centered>;
  if (feed.isPending) return <Centered><Spinner /></Centered>;
  const items = uniqueItems(feed.data.pages);
  if (!items.length && !feed.hasNextPage) return <Centered><EmptyState icon={<Clapperboard size={32} />} title="새로 볼 예고편이 없어요"
    body={replay ? undefined : "본 작품은 설정한 기간 동안 빼고 보여줘요."}
    action={<span className="shorts-state-actions">{!replay && <Button onClick={() => setReplay(true)}>본 것도 보기</Button>}<ButtonLink to="/settings#experimental" variant="ghost">설정</ButtonLink></span>} /></Centered>;
  return <ShortsReel key={JSON.stringify(shortsFeedKey(settings.data, replay))} items={items} feed={feed} replay={replay} fit={settings.data?.shortsScreenFit !== false} native={native} onReplay={() => setReplay(true)} />;
}

function ShortsReel({ items, feed, replay, fit, native, onReplay }: { items: ShortsItem[]; feed: ReturnType<typeof useShortsFeed>; replay: boolean; fit: boolean; native: boolean; onReplay: () => void }) {
  const [embedded, setEmbedded] = useState<ReadonlySet<string>>(() => new Set()); // works switched to the YouTube player by hand
  const pool = useRef<NativePool | null>(null);
  pool.current ??= new NativePool();
  // The next two works that would play directly; YouTube-fallback works are not prepared.
  const aheadOf = (index: number) => items.slice(index + 1, index + 3).filter(item => !embedded.has(item.key)).map(item => item.key);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [shownKey, setShownKey] = useState<string | null>(null); // only this work has a mostly visible stage
  const activeKey = items[active]?.key;
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [blocked, setBlocked] = useState(false);
  const control = useRef<ShortsControl | null>(null);
  const [muted, setMuted] = useState(false);
  const [autoSkips, setAutoSkips] = useState(0);
  const session = useRef<ShortsSession>({ watched: new Map(), reported: new Set(), failed: new Set() }).current;
  // The work on screen at the last direct input (button, key, touch, wheel). Only a settled, visible,
  // mostly exposed work can carry it; automatic moves, resize and hiding the page clear it.
  const intent = useRef<{ key: string; at: number } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const exposed = useRef<string | null>(null);
  exposed.current = visible ? shownKey : null;
  const markIntent = useCallback(() => {
    const key = itemsRef.current[activeRef.current]?.key;
    if (key && exposed.current === key) intent.current = { key, at: performance.now() };
    else if (intent.current?.key !== key) intent.current = null; // a gesture already under way keeps its start
  }, []);
  const count = items.length + 1; // the closing slide
  const activeRef = useRef(active);
  activeRef.current = active;

  const goTo = useCallback((index: number, auto = false) => {
    const el = scroller.current;
    if (!el) return;
    if (auto) intent.current = null;
    const next = Math.max(0, Math.min(count - 1, index));
    el.scrollTo({ top: next * el.clientHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [count]);
  const step = useCallback((delta: number) => { setAutoSkips(0); markIntent(); goTo(activeRef.current + delta); }, [goTo, markIntent]);

  // The player follows the slide the scroll settled on, never one passing by.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer = 0;
    const slide = () => Math.round(el.scrollTop / Math.max(1, el.clientHeight));
    // Moving forward by hand from the settled work tells the server it was passed over. Works flicked
    // through mid-scroll, failed ones and ones already reported are left alone; one attempt, no retry.
    const settleAt = () => {
      const next = slide(), from = activeRef.current, leaving = itemsRef.current[from], held = intent.current;
      intent.current = null;
      const manual = held !== null && held.key === leaving?.key && performance.now() - held.at < INTENT_MS;
      if (manual && next > from && !session.reported.has(leaving.key) && !session.failed.has(leaving.key)) {
        session.reported.add(leaving.key);
        markShortSkipped(leaving.key).catch(() => {});
      }
      setActive(next);
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settleAt, SETTLE_MS);
    };
    const onInput = () => markIntent();
    // Hidden: drop intent and the pending settle; on return settle again without intent.
    const onHide = () => { intent.current = null; window.clearTimeout(timer); setVisible(false); };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return onHide();
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(settleAt, SETTLE_MS);
    };
    const onResize = () => { intent.current = null; el.scrollTo({ top: activeRef.current * el.clientHeight }); };
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const name of ["touchstart", "wheel"] as const) el.addEventListener(name, onInput, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onVisibility);
    return () => { window.clearTimeout(timer); el.removeEventListener("scroll", onScroll); el.removeEventListener("touchstart", onInput); el.removeEventListener("wheel", onInput); window.removeEventListener("resize", onResize); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", onHide); window.removeEventListener("pageshow", onVisibility); };
  }, [markIntent]); // eslint-disable-line react-hooks/exhaustive-deps

  // The prepared next work belongs to this feed while it is visible and in direct mode only.
  useEffect(() => { if (!visible || !native) pool.current?.release(); }, [visible, native]);
  useEffect(() => { pool.current?.open(); return () => pool.current?.dispose(); }, []);

  // Mid-scroll the player goes as soon as its stage is half off screen, before the slide itself is.
  useEffect(() => {
    const stage = scroller.current?.querySelector(".shorts-slide.is-active .shorts-stage");
    setShownKey(null);
    if (!stage || !activeKey) return;
    const observer = new IntersectionObserver(([entry]) => setShownKey(entry.intersectionRatio > .5 ? activeKey : null), { root: scroller.current, threshold: [.5, .51] });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [active, activeKey]);

  // Remote mode claims arrows first and offers them here; otherwise plain keys.
  useEffect(() => {
    const keyStep = (key: string) => key === "ArrowDown" || key === "PageDown" ? 1 : key === "ArrowUp" || key === "PageUp" ? -1 : 0;
    const onRemote = (event: Event) => {
      const delta = keyStep((event as CustomEvent<{ key: string }>).detail?.key);
      if (delta) { event.preventDefault(); step(delta); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).matches?.("input,textarea,select,[contenteditable='true']")) return;
      const delta = keyStep(event.key) || (event.key === "j" ? 1 : event.key === "k" ? -1 : 0);
      if (delta) { event.preventDefault(); step(delta); }
    };
    window.addEventListener("moa:remote-key", onRemote);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("moa:remote-key", onRemote); window.removeEventListener("keydown", onKey); };
  }, [step]);

  // Load ahead near the end; a finished cursor stops here.
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = feed;
  useEffect(() => {
    if (active >= items.length - 3 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [active, items.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const current = items[active];
  const watchlist = useQuery({ queryKey: keys.watchlist, queryFn: () => api<MediaCard[]>("/watchlist"), enabled: Boolean(current?.mediaId) });

  return <div className={cx("shorts", fit && "is-fit", native && "is-native")} ref={scroller} role="feed" aria-label="쇼츠" aria-busy={isFetchingNextPage} tabIndex={-1}>
    {items.map((item, index) => <ShortsSlide key={item.key} item={item} index={index} total={hasNextPage ? -1 : items.length}
      active={index === active} near={Math.abs(index - active) <= 2} muted={muted}
      inWatchlist={Boolean(item.mediaId && watchlist.data?.some(card => card.id === item.mediaId))}
      blocked={index === active && blocked} onPlay={() => control.current?.play()} native={native && !embedded.has(item.key)}
      onStep={step} onSound={() => setMuted(old => !old)}>
      {index === active && shownKey === item.key && visible && (native && !embedded.has(item.key)
        ? <ShortsNativePlayer itemKey={item.key} title={item.title} session={session} pool={pool.current!} ahead={aheadOf(index)} control={control} muted={muted} onMuted={setMuted} onBlocked={setBlocked}
            onPlaying={() => setAutoSkips(0)} onStarted={() => pool.current?.prefetch(aheadOf(index))} onEnded={() => goTo(index + 1, true)} onEmbed={() => setEmbedded(old => new Set(old).add(item.key))} />
        : <ShortsPlayer itemKey={item.key} title={item.title} session={session} control={control} muted={muted} onMuted={setMuted} onBlocked={setBlocked}
        onPlaying={() => setAutoSkips(0)} onEnded={() => goTo(index + 1, true)}
        autoNext={autoSkips < AUTO_SKIP_LIMIT} onAutoNext={() => { setAutoSkips(old => old + 1); goTo(index + 1, true); }} />)}
    </ShortsSlide>)}
    <section className="shorts-slide shorts-end" aria-label="끝">
      {hasNextPage || isFetchingNextPage
        ? isFetchNextPageError ? <EmptyState title="더 불러오지 못했어요" action={<Button onClick={() => void fetchNextPage()}>다시 시도</Button>} /> : <Spinner />
        : <EmptyState icon={<Clapperboard size={32} />} title={replay ? "끝까지 봤어요" : "새 예고편을 다 봤어요"}
            action={<span className="shorts-state-actions">
              {!replay && <Button onClick={onReplay}>본 것도 보기</Button>}
              <Button variant="ghost" icon={<RotateCcw size={16} />} onClick={() => goTo(0, true)}>처음으로</Button>
            </span>} />}
    </section>
    <div className="shorts-nav" data-remote-group>
      <IconButton label="이전 작품" disabled={active === 0} onClick={() => step(-1)}><ChevronUp size={24} /></IconButton>
      <IconButton label="다음 작품" disabled={active >= count - 1} onClick={() => step(1)}><ChevronDown size={24} /></IconButton>
    </div>
  </div>;
}

function RailButton({ label, caption, pressed, disabled, onClick, children }: { label: string; caption?: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className="shorts-rail-btn" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
    <span className="shorts-rail-icon">{children}</span>{caption && <small aria-hidden="true">{caption}</small>}
  </button>;
}

/** YouTube mode keeps title and actions outside the iframe; direct mode lays them over MOA’s own video. */
function ShortsSlide({ item, index, total, active, near, muted, blocked, native, inWatchlist, onPlay, onStep, onSound, children }: {
  item: ShortsItem; index: number; total: number; active: boolean; near: boolean; muted: boolean; blocked: boolean; native: boolean; inWatchlist: boolean;
  onPlay: () => void; onStep: (delta: number) => void; onSound: () => void; children: React.ReactNode;
}) {
  const toggle = useWatchlistToggle();
  const poster = sized(item.poster, 500);
  const meta = [item.year, item.category && CATEGORY_LABEL[item.category], item.reason === "personal" ? "취향" : "인기"].filter(Boolean).join(" · ");
  return <article className={cx("shorts-slide", active && "is-active", native && "is-native")} aria-posinset={index + 1} aria-setsize={total} aria-label={item.title}>
    <div className="shorts-frame">
      <div className="shorts-screen">
        <div className="shorts-stage">
          {near && poster && <img className="shorts-poster" src={poster} alt="" loading="lazy" />}
          {children}
        </div>
      </div>
      <div className="shorts-info">
        <h2>{item.title}</h2>
        {meta && <p className="shorts-sub">{meta}</p>}
        {item.overview && <p className="shorts-overview">{item.overview}</p>}
        <Link className="shorts-open" to={recommendationTarget(item.href, item.title)}>
          {item.mediaId ? <Play size={14} fill="currentColor" /> : <Search size={14} strokeWidth={2.6} />}{item.mediaId ? "작품 보기" : "MOA에서 찾기"}
        </Link>
      </div>
      <div className="shorts-rail">
        {blocked && <RailButton label="재생" caption="재생" onClick={onPlay}><Play size={24} fill="currentColor" /></RailButton>}
        {active && (muted || native) && <RailButton label={muted ? "소리 켜기" : "소리 끄기"} caption="소리" onClick={onSound}>{muted ? <VolumeX size={24} /> : <Volume2 size={24} />}</RailButton>}
        {native && active && <span className="shorts-rail-cc" />}
        {item.mediaId && <RailButton label={inWatchlist ? "내 목록에서 빼기" : "내 목록에 추가"} caption="내 목록" pressed={inWatchlist} disabled={toggle.isPending}
          onClick={() => toggle.mutate({ id: item.mediaId!, add: !inWatchlist })}>{inWatchlist ? <Check size={24} /> : <Plus size={26} />}</RailButton>}
        <span className="shorts-rail-steps">
          <RailButton label="이전 작품" disabled={index === 0} onClick={() => onStep(-1)}><ChevronUp size={24} /></RailButton>
          <RailButton label="다음 작품" onClick={() => onStep(1)}><ChevronDown size={24} /></RailButton>
        </span>
      </div>
    </div>
  </article>;
}
