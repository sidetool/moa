import tmdbLogo from '../assets/tmdb.svg';

export function AboutPage({ embedded = false }: { embedded?: boolean }) {
  return <div className={embedded ? "settings-embedded" : "page-pad narrow"}>
    {!embedded && <header className="page-head"><h1>정보/크레딧</h1></header>}
    <section className="settings-group">
      <h2>작품 정보</h2>
      <div className="settings-card about-credit">
        {/* Unmodified official asset: https://www.themoviedb.org/about/logos-attribution */}
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer"><img className="tmdb-credit-logo" src={tmdbLogo} alt="TMDB" /></a>
        <p lang="en">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p>이 제품은 TMDB API를 사용하지만 TMDB의 보증이나 인증을 받지 않았습니다.</p>
      </div>
    </section>
    <section className="settings-group">
      <h2>오픈소스 라이선스</h2>
      <div className="settings-card about-credit"><a className="text-btn" href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">GNU General Public License v3.0 (GPL-3.0)</a></div>
    </section>
  </div>;
}
