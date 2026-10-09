import { TitleSources } from '../components/TitleSources';
import { InlinePlugins } from '../components/WebsitePlugins';
import { ArrowDownUp, ArrowLeft, Check, Clapperboard, Play, Plus, RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Episode, MediaDetail } from "@moa/shared";
import { useMedia, useWatchlistToggle } from "../api/queries";
import { Artwork, TitleLogo } from "../components/Artwork";
import { MetaLine } from "../components/Hero";
import { MetadataCredit, PeopleRow, SimilarRow, TrailerDialog } from "../components/TitleExtras";
import { Button, ButtonLink, EmptyState, ProgressBar, Skeleton } from "../components/ui";
import { ApiError } from "../lib/api";
import { foreignCode, foreignLang, langLabel, seasonInfo, type SeasonInfo } from "../lib/card-meta";
import { useFranchise, type FranchiseSeason } from "../lib/franchise";
import { devicePrefs } from "../lib/device-prefs";
import { SeasonPicker, type SeasonChoice } from "../components/SeasonPicker";
import { TYPE_LABEL, cx, fileSize, humanDuration, episodeTitle } from "../lib/format";

const watchPath = (episodeId: string, position?: number) =>
  `/watch/${encodeURIComponent(episodeId)}${position !== undefined ? `?t=${Math.floor(position)}` : ""}`;

function EpisodeItem({ episode, highlight }: { episode: Episode; highlight?: boolean }) {
  const progress = episode.progress;
  const ratio = progress ? progress.position / Math.max(1, progress.duration) : 0;
  return (
    <li data-episode={episode.id}>
      <Link to={watchPath(episode.id)} className={cx("episode", progress?.completed && "is-watched", highlight && "is-highlight")}>
        <span className="episode-number">{episode.number}</span>
        <span className="episode-thumb">
          <Artwork src={episode.thumb} title={episode.title} ratio="landscape" width={400} labelFallback={false} />
          <span className="episode-play" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
          {progress && !progress.completed && <ProgressBar ratio={ratio} className="card-progress" />}
        </span>
        <span className="episode-body">
          <span className="episode-title">
            <b>{episode.name ? <><span className="episode-no">{episode.number}화 · </span>{episode.name}</> : episodeTitle(episode.title)}</b>
            {episode.duration ? <small>{humanDuration(episode.duration)}</small> : null}
            {progress?.completed && <Check size={16} className="episode-check" aria-label="시청 완료" />}
          </span>
          {episode.overview && <span className="episode-overview">{episode.overview}</span>}
        </span>
      </Link>
    </li>
  );
}

const RANGE = 50;

function Episodes({ media }: { media: MediaDetail }) {
  const target = media.playTarget?.episodeId;
  const navigate = useNavigate();
  const location = useLocation();
  const switched = location.state as { episodes?: boolean; season?: number } | null;
  const initialSeason = useMemo(() =>
    (switched?.season !== undefined && media.seasons.some(season => season.number === switched.season) ? switched.season : undefined)
    ?? media.seasons.find(season => season.episodes.some(episode => episode.id === target))?.number ?? media.seasons[0]?.number,
  [media, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const [seasonNumber, setSeasonNumber] = useState(initialSeason);
  const [descending, setDescending] = useState(false);
  const season = media.seasons.find(item => item.number === seasonNumber) ?? media.seasons[0];
  const episodes = season?.episodes ?? [];
  const long = episodes.length > RANGE;
  const targetIndex = Math.max(0, episodes.findIndex(episode => episode.id === target));
  const [range, setRange] = useState(Math.floor(targetIndex / RANGE));
  const [jump, setJump] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const section = useRef<HTMLElement>(null);
  const franchise = useFranchise(media.id, devicePrefs().seasonSwitcher);

  // Switching seasons opens another title; land on its episode list, not the top of the page.
  useEffect(() => { if (switched?.episodes) section.current?.scrollIntoView({ block: "start" }); }, [media.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setRange(Math.floor(Math.max(0, episodes.findIndex(episode => episode.id === target)) / RANGE)); }, [seasonNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!season) return null;
  const rangeCount = long ? Math.ceil(episodes.length / RANGE) : 0;
  // Newest-first also flips the ranges: 1–49 · 50–99 becomes 50–99 · 1–49 and starts at the newest.
  const ranges = Array.from({ length: rangeCount }, (_, i) => descending ? rangeCount - 1 - i : i);
  const slice = long ? episodes.slice(range * RANGE, range * RANGE + RANGE) : episodes;
  const shown = descending ? [...slice].reverse() : slice;

  const goTo = (event: React.FormEvent) => {
    event.preventDefault();
    const number = Number(jump);
    const index = episodes.findIndex(episode => episode.number === number);
    if (index < 0) return;
    setRange(Math.floor(index / RANGE));
    setHighlight(episodes[index].id);
    setJump("");
    requestAnimationFrame(() => list.current?.querySelector(`[data-episode="${CSS.escape(episodes[index].id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const regular = franchise.data?.seasons ?? [];
  const choices: (SeasonChoice & { season?: FranchiseSeason })[] = regular.length > 1
    ? regular.map(item => {
      const here = item.mediaId === media.id && (item.seasonNumber === undefined || item.seasonNumber === season.number);
      const code = foreignCode(item.provider.lang);
      return { key: item.key, label: item.label, count: here ? episodes.length : item.episodeCount, current: here, season: item,
        note: item.provider.id !== media.provider.id ? `${item.provider.name}${code ? ` · ${code.toUpperCase()}` : ""}` : undefined };
    })
    : media.seasons.length > 1
      ? media.seasons.map(item => ({ key: `n${item.number}`, label: item.title, count: item.episodes.length, current: item.number === season.number }))
      : [{ key: "only", label: seasonInfo(media)?.label ?? season.title, current: true }];
  const pick = (choice: SeasonChoice & { season?: FranchiseSeason }) => {
    const next = choice.season;
    if (!next) return setSeasonNumber(Number(choice.key.slice(1)));
    if (next.mediaId === media.id) { if (next.seasonNumber !== undefined) setSeasonNumber(next.seasonNumber); return; }
    navigate(`/title/${encodeURIComponent(next.mediaId)}`, { replace: true, state: { episodes: true, season: next.seasonNumber } });
  };

  return (
    <section className="episodes" aria-labelledby="episodes-title" ref={section}>
      <header className="episodes-head">
        <h2 id="episodes-title">회차</h2>
        <div className="episodes-tools">
          {long && (
            <form className="episode-jump" onSubmit={goTo}>
              <input inputMode="numeric" pattern="[0-9]*" value={jump} placeholder="회차 번호" aria-label="회차 번호로 이동" onChange={event => setJump(event.target.value.replace(/\D/g, ""))} />
            </form>
          )}
          {episodes.length > 1 && (
            <button className="icon-btn" aria-label={descending ? "1화부터 보기" : "최신화부터 보기"} title={descending ? "1화부터" : "최신화부터"} onClick={() => { const next = !descending; setDescending(next); if (long) setRange(next ? rangeCount - 1 : 0); }}><ArrowDownUp size={18} /></button>
          )}
          <SeasonPicker choices={choices} count={episodes.length} onPick={pick} />
        </div>
      </header>
      {long && (
        <div className="range-tabs no-scrollbar" role="tablist" aria-label="회차 구간">
          {ranges.map(i => {
            const first = episodes[i * RANGE]?.number;
            const last = episodes[Math.min(episodes.length, (i + 1) * RANGE) - 1]?.number;
            return <button key={i} role="tab" aria-selected={i === range} className={cx("chip", i === range && "is-active")} onClick={() => setRange(i)}>{descending ? `${last}–${first}` : `${first}–${last}`}</button>;
          })}
        </div>
      )}
      <ol className="episode-list" ref={list}>
        {shown.map(episode => <EpisodeItem key={episode.id} episode={episode} highlight={episode.id === highlight} />)}
      </ol>
    </section>
  );
}

function TitleSkeleton({ back }: { back: React.ReactNode }) {
  return (
    <div className="title-page title-skeleton" aria-busy="true" aria-label="작품 정보를 불러오는 중">
      <section className="title-hero">
        <div className="title-backdrop"><Skeleton className="sk-backdrop" /></div>
        {back}
        <div className="title-hero-copy" aria-hidden="true">
          <Skeleton className="sk-text sk-kicker" />
          <Skeleton className="sk-title" />
          <Skeleton className="sk-text sk-meta" />
          <div className="hero-actions"><Skeleton className="sk-btn sk-btn-primary" /><Skeleton className="sk-btn" /></div>
          <div className="sk-lines"><Skeleton className="sk-text" /><Skeleton className="sk-text" /><Skeleton className="sk-text sk-short" /></div>
        </div>
      </section>
      <div className="title-body" aria-hidden="true">
        <Skeleton className="sk-text sk-section" />
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="sk-episode"><Skeleton className="sk-episode-thumb" /><div><Skeleton className="sk-text" /><Skeleton className="sk-text sk-short" /></div></div>)}
      </div>
    </div>
  );
}

/** TMDB logos are shared by every season, so the season sits under the logo as its own tag. */
function SeasonTag({ info, lang }: { info?: SeasonInfo; lang?: string }) {
  const [main, ...rest] = info?.label.split(" · ") ?? [];
  return <p className="title-season">
    {main && <b>{main}</b>}{rest.map(part => <span key={part}>{part}</span>)}
    {/* Mobile hides the source kicker, so the language rides along here. */}
    {lang && <i className="lang-tag title-lang" title={`${langLabel(lang)} 소스`}>{lang.toUpperCase()}</i>}
  </p>;
}

export function TitlePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const media = useMedia(id);
  const toggle = useWatchlistToggle();
  const [expanded, setExpanded] = useState(false);
  const [trailer, setTrailer] = useState(false);

  const backButton = <button className="title-back" aria-label="이전 화면" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate("/")}><ArrowLeft size={16} /><span>뒤로</span></button>;
  if (media.isPending || (!media.data && media.isFetching)) return <TitleSkeleton back={backButton} />;
  if (media.error instanceof ApiError && media.error.code === "kids-restricted") {
    return <div className="title-page page-pad">{backButton}<EmptyState icon={<ShieldCheck size={40} />} title="어린이 프로필에서는 볼 수 없는 작품이에요" body="12세 이하 등급이거나 가족·키즈 장르인 작품만 볼 수 있어요. 다른 프로필로 바꿔서 보세요." action={<ButtonLink to="/profiles">프로필 바꾸기</ButtonLink>} /></div>;
  }
  if (!media.data) {
    return <div className="title-page page-pad">{backButton}<EmptyState title="작품 정보를 불러오지 못했습니다" body="소스 연결을 다시 시도하거나 다른 재생 소스를 선택해 주세요." action={<Button onClick={() => void media.refetch()}>다시 시도</Button>} /><TitleSources key={id} id={id} title=""/></div>;
  }

  const m = media.data;
  const isMovie = m.type === "movie";
  const lang = foreignLang(m), season = seasonInfo(m);
  const episodes = m.seasons.flatMap(season => season.episodes);
  const target = m.playTarget;
  const targetEpisode = episodes.find(episode => episode.id === target?.episodeId);
  const resuming = Boolean(target && target.position > 30);
  const ratio = resuming && targetEpisode?.duration ? target!.position / targetEpisode.duration : 0;
  const meta = [
    m.year,
    TYPE_LABEL[m.type],
    isMovie ? humanDuration(m.runtime ?? episodes[0]?.duration) : `${episodes.length}화`,
    ...(m.genres ?? []).slice(0, 3)
  ].filter(Boolean);

  return (
    <div className="title-page">
      <section className="title-hero">
        <div className="title-backdrop">
          <Artwork src={m.backdrop} fallbackSrc={m.poster} title={m.title} ratio="wide" width={1600} eager labelFallback={false} />
        </div>
        {backButton}
        <div className="title-hero-copy">
          <p className="hero-kicker">{m.provider.kind === "local" ? "내 라이브러리" : m.provider.name}{lang && <span className="lang-tag" title={`${langLabel(lang)} 소스`}>{lang.toUpperCase()}</span>}</p>
          <TitleLogo className="title-name" logo={m.logo} title={m.title} />
          {(season || lang) && <SeasonTag info={season} lang={lang} />}
          {m.originalTitle && m.originalTitle !== m.title && <p className="title-original" lang="en">{m.originalTitle}</p>}
          <MetaLine card={m} meta={meta} />
          {resuming && targetEpisode && (
            <div className="hero-progress">
              <ProgressBar ratio={ratio} />
              <span>{isMovie ? `${humanDuration((targetEpisode.duration ?? 0) - target!.position)} 남음` : `${targetEpisode.title} · ${humanDuration((targetEpisode.duration ?? 0) - target!.position)} 남음`}</span>
            </div>
          )}
          <div className="hero-actions">
            {target ? (
              <Button variant="primary" size="l" icon={<Play size={22} fill="currentColor" />} onClick={() => navigate(watchPath(target.episodeId))}>
                {target.label}
              </Button>
            ) : <Button variant="primary" size="l" disabled>재생할 수 없음</Button>}
            {resuming && (
              <Button variant="secondary" size="l" icon={<RotateCcw size={20} />} onClick={() => navigate(watchPath(target!.episodeId, 0))}>처음부터</Button>
            )}
            <Button
              variant="secondary" size="l"
              icon={m.inWatchlist ? <Check size={22} /> : <Plus size={22} />}
              aria-pressed={Boolean(m.inWatchlist)}
              onClick={() => toggle.mutate({ id: m.id, add: !m.inWatchlist })}
            >{m.inWatchlist ? "내 목록에 있음" : "내 목록"}</Button>
            {m.trailer && <Button variant="secondary" size="l" icon={<Clapperboard size={20} />} onClick={() => setTrailer(true)}>예고편</Button>}
          </div>
          {m.tagline && <p className="title-tagline">{m.tagline}</p>}
          {m.overview && (
            <p className={cx("title-overview", expanded && "is-expanded")} onClick={() => setExpanded(true)}>{m.overview}</p>
          )}
          {m.cast?.length ? <p className="title-cast"><span>출연</span>{m.cast.slice(0, 4).join(", ")}{m.cast.length > 4 ? " 외" : ""}</p> : null}
        </div>
      </section>

      <div className="title-body">
        <InlinePlugins key={`plugins:${m.id}`} placement="detail" />
        <TitleSources key={m.id} id={m.id} title={m.title}/>
        {!isMovie && <Episodes media={m} />}
        {!!m.people?.length && <PeopleRow people={m.people} />}
        {!!m.similar?.length && <SimilarRow items={m.similar} />}
        {m.fileInfo && (
          <section className="file-info" aria-label="파일 정보">
            <h2>파일 정보</h2>
            <dl>
              <div><dt>해상도</dt><dd>{m.fileInfo.resolution}</dd></div>
              <div><dt>영상</dt><dd>{m.fileInfo.video}</dd></div>
              <div><dt>오디오</dt><dd>{m.fileInfo.audio}</dd></div>
              <div><dt>컨테이너</dt><dd>{m.fileInfo.container}</dd></div>
              <div><dt>용량</dt><dd>{fileSize(m.fileInfo.size)}</dd></div>
            </dl>
          </section>
        )}
        <MetadataCredit media={m} />
      </div>
      {trailer && m.trailer && <TrailerDialog videoKey={m.trailer} title={m.title} onClose={() => setTrailer(false)} />}
    </div>
  );
}

/** /play/:mediaId — resolve the play target, then hand over to the player. */
export function PlayRedirect() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const media = useMedia(id);
  useEffect(() => {
    if (media.data?.playTarget) navigate(watchPath(media.data.playTarget.episodeId), { replace: true });
    else if (media.data || (media.isError && !media.isFetching)) navigate(`/title/${encodeURIComponent(id)}`, { replace: true });
  }, [media.data, media.isError, id, navigate]);
  return <div className="player-boot" />;
}
