// Unmodified official TMDB logo (https://www.themoviedb.org/about/logos-attribution), the same asset as MOA's About page.
const TMDB_LOGO = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20viewBox%3D%220%200%20273.42%2035.52%22%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfill%3Aurl(%23linear-gradient)%3B%7D%3C%2Fstyle%3E%3ClinearGradient%20id%3D%22linear-gradient%22%20y1%3D%2217.76%22%20x2%3D%22273.42%22%20y2%3D%2217.76%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2390cea1%22%2F%3E%3Cstop%20offset%3D%220.56%22%20stop-color%3D%22%233cbec9%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2300b3e5%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ctitle%3EAsset%203%3C%2Ftitle%3E%3Cg%20id%3D%22Layer_2%22%20data-name%3D%22Layer%202%22%3E%3Cg%20id%3D%22Layer_1-2%22%20data-name%3D%22Layer%201%22%3E%3Cpath%20class%3D%22cls-1%22%20d%3D%22M191.85%2C35.37h63.9A17.67%2C17.67%2C0%2C0%2C0%2C273.42%2C17.7h0A17.67%2C17.67%2C0%2C0%2C0%2C255.75%2C0h-63.9A17.67%2C17.67%2C0%2C0%2C0%2C174.18%2C17.7h0A17.67%2C17.67%2C0%2C0%2C0%2C191.85%2C35.37ZM10.1%2C35.42h7.8V6.92H28V0H0v6.9H10.1Zm28.1%2C0H46V8.25h.1L55.05%2C35.4h6L70.3%2C8.25h.1V35.4h7.8V0H66.45l-8.2%2C23.1h-.1L50%2C0H38.2ZM89.14.12h11.7a33.56%2C33.56%2C0%2C0%2C1%2C8.08%2C1%2C18.52%2C18.52%2C0%2C0%2C1%2C6.67%2C3.08%2C15.09%2C15.09%2C0%2C0%2C1%2C4.53%2C5.52%2C18.5%2C18.5%2C0%2C0%2C1%2C1.67%2C8.25%2C16.91%2C16.91%2C0%2C0%2C1-1.62%2C7.58%2C16.3%2C16.3%2C0%2C0%2C1-4.38%2C5.5%2C19.24%2C19.24%2C0%2C0%2C1-6.35%2C3.37%2C24.53%2C24.53%2C0%2C0%2C1-7.55%2C1.15H89.14Zm7.8%2C28.2h4a21.66%2C21.66%2C0%2C0%2C0%2C5-.55A10.58%2C10.58%2C0%2C0%2C0%2C110%2C26a8.73%2C8.73%2C0%2C0%2C0%2C2.68-3.35%2C11.9%2C11.9%2C0%2C0%2C0%2C1-5.08%2C9.87%2C9.87%2C0%2C0%2C0-1-4.52%2C9.17%2C9.17%2C0%2C0%2C0-2.63-3.18A11.61%2C11.61%2C0%2C0%2C0%2C106.22%2C8a17.06%2C17.06%2C0%2C0%2C0-4.68-.63h-4.6ZM133.09.12h13.2a32.87%2C32.87%2C0%2C0%2C1%2C4.63.33%2C12.66%2C12.66%2C0%2C0%2C1%2C4.17%2C1.3%2C7.94%2C7.94%2C0%2C0%2C1%2C3%2C2.72%2C8.34%2C8.34%2C0%2C0%2C1%2C1.15%2C4.65%2C7.48%2C7.48%2C0%2C0%2C1-1.67%2C5%2C9.13%2C9.13%2C0%2C0%2C1-4.43%2C2.82V17a10.28%2C10.28%2C0%2C0%2C1%2C3.18%2C1%2C8.51%2C8.51%2C0%2C0%2C1%2C2.45%2C1.85%2C7.79%2C7.79%2C0%2C0%2C1%2C1.57%2C2.62%2C9.16%2C9.16%2C0%2C0%2C1%2C.55%2C3.2%2C8.52%2C8.52%2C0%2C0%2C1-1.2%2C4.68%2C9.32%2C9.32%2C0%2C0%2C1-3.1%2C3A13.38%2C13.38%2C0%2C0%2C1%2C152.32%2C35a22.5%2C22.5%2C0%2C0%2C1-4.73.5h-14.5Zm7.8%2C14.15h5.65a7.65%2C7.65%2C0%2C0%2C0%2C1.78-.2%2C4.78%2C4.78%2C0%2C0%2C0%2C1.57-.65%2C3.43%2C3.43%2C0%2C0%2C0%2C1.13-1.2%2C3.63%2C3.63%2C0%2C0%2C0%2C.42-1.8A3.3%2C3.3%2C0%2C0%2C0%2C151%2C8.6a3.42%2C3.42%2C0%2C0%2C0-1.23-1.13A6.07%2C6.07%2C0%2C0%2C0%2C148%2C6.9a9.9%2C9.9%2C0%2C0%2C0-1.85-.18h-5.3Zm0%2C14.65h7a8.27%2C8.27%2C0%2C0%2C0%2C1.83-.2%2C4.67%2C4.67%2C0%2C0%2C0%2C1.67-.7%2C3.93%2C3.93%2C0%2C0%2C0%2C1.23-1.3%2C3.8%2C3.8%2C0%2C0%2C0%2C.47-1.95%2C3.16%2C3.16%2C0%2C0%2C0-.62-2%2C4%2C4%2C0%2C0%2C0-1.58-1.18%2C8.23%2C8.23%2C0%2C0%2C0-2-.55%2C15.12%2C15.12%2C0%2C0%2C0-2.05-.15h-5.9Z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E';

document.body.innerHTML = `
  <style>
    html,body{margin:0;background:transparent;color:var(--moa-text,#f4f4f5);font:14px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}h2,p{margin:0}h2{font-size:22px;font-weight:700;letter-spacing:-.5px}
    button{font:inherit;color:inherit;cursor:pointer;border:1px solid #34343a;border-radius:10px;background:#202024;touch-action:manipulation}
    button:focus-visible{outline:2px solid #a1a1aa;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
    header{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:12px}#refresh,#retry{padding:8px 12px;white-space:nowrap;min-height:40px}
    .scope{color:var(--moa-muted,#a1a1aa);font-size:12px;margin:-6px 0 12px}
    .controls{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:4px}
    .segment{display:inline-grid;grid-auto-flow:column;grid-auto-columns:minmax(64px,auto);gap:4px;padding:3px;border-radius:12px;background:#18181b}
    .segment button{min-height:38px;padding:6px 14px;border-color:transparent;background:transparent;color:#a1a1aa}
    .segment button[aria-pressed=true]{background:#f4f4f5;color:#18181b;font-weight:700}
    #status{padding:12px 0 10px;color:var(--moa-muted,#a1a1aa);font-size:13px}#status.warn{color:#fbbf24}#retry{margin-bottom:12px}
    #list{display:grid;grid-auto-flow:column;grid-auto-columns:132px;gap:12px;list-style:none;padding:2px 2px 10px;margin:0;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;scrollbar-width:thin}
    #list[hidden],#retry[hidden]{display:none}#list li{min-width:0;scroll-snap-align:start}
    .card{display:grid;gap:6px;width:100%;padding:0;border:0;border-radius:10px;background:transparent;text-align:left}
    .poster{position:relative;display:block;width:100%;aspect-ratio:2/3;overflow:hidden;border-radius:10px;border:1px solid #27272a;background:#18181b}
    .poster img{display:block;width:100%;height:100%;object-fit:cover}
    .fallback{display:flex;align-items:center;justify-content:center;height:100%;padding:10px;color:#71717a;font-size:13px;text-align:center;overflow-wrap:anywhere}
    .rank{position:absolute;left:6px;top:6px;min-width:24px;padding:1px 6px;border-radius:6px;background:rgba(9,9,11,.82);color:#f4f4f5;font-size:12px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums}
    .card:hover .poster{border-color:#52525b}.card:focus-visible{outline-offset:2px}
    .name{font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .meta{color:var(--moa-muted,#a1a1aa);font-size:12px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:10px;color:#85858f;font-size:12px}footer img{width:80px;height:auto;flex:none}footer p{flex:1 1 260px}
    @media(max-width:600px){h2{font-size:20px}#list{grid-auto-columns:112px;gap:10px}}
  </style>
  <section id="trending" aria-labelledby="trending-title">
    <header><h2 id="trending-title">요즘 인기 영화·TV</h2><button id="refresh" type="button">새로고침</button></header>
    <p class="scope" id="scope"></p>
    <div class="controls">
      <div class="segment" role="group" aria-label="분류"><button type="button" data-kind="movie">영화</button><button type="button" data-kind="tv">TV</button></div>
      <div class="segment" role="group" aria-label="기간"><button type="button" data-window="day">일간</button><button type="button" data-window="week">주간</button></div>
    </div>
    <div id="panel" aria-live="polite">
      <p id="status" role="status">인기 작품 불러오는 중</p>
      <button id="retry" type="button" hidden>다시 시도</button>
      <ul id="list" aria-labelledby="trending-title" hidden></ul>
    </div>
    <footer><img alt="TMDB" src="${TMDB_LOGO}"><p><span lang="en">This product uses the TMDB API but is not endorsed or certified by TMDB.</span> 작품 정보와 포스터 출처 TMDB.</p></footer>
  </section>
`;

const $ = selector => document.querySelector(selector);
const section = $('#trending'), panel = $('#panel'), status = $('#status'), retry = $('#retry'), list = $('#list'), refresh = $('#refresh'), scope = $('#scope');
const kindButtons = [...document.querySelectorAll('[data-kind]')], windowButtons = [...document.querySelectorAll('[data-window]')];
const KINDS = { movie: '영화', tv: 'TV' }, WINDOWS = { day: '일간', week: '주간' };
const STATUSES = ['ready', 'unconfigured', 'restricted', 'unavailable'];
// The host caches responses; the panel keeps only the latest answer for the visible selection.
let kind = 'movie', period = 'day', request = 0, loading = false, problem = null, result = null;

const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const posterUrl = value => typeof value === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(value) ? value : undefined;

// The iframe CSP only allows data:/blob: images, so posters are downloaded through moa.fetch one at a time
// (the host allows one pending fetch per plugin) and shown as blob URLs. Each render starts a new generation;
// queued or in-flight posters from an older generation are dropped and their blob URLs revoked.
let generation = 0, fetching = false;
const queue = [], blobs = new Set();
const posters = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    posters.unobserve(entry.target);
    queue.push({ target: entry.target, generation });
  }
  void drain();
}, { root: list, rootMargin: '0px 400px' });

function resetPosters() {
  generation++; queue.length = 0; posters.disconnect();
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs.clear();
}

async function drain() {
  if (fetching) return;
  fetching = true;
  try {
    while (queue.length) {
      const { target, generation: owner } = queue.shift();
      if (owner !== generation || !target.isConnected) continue;
      let blob;
      try {
        const response = await moa.fetch(target.dataset.poster);
        blob = await response.blob();
      } catch { continue; }
      if (owner !== generation || !target.isConnected || !blob.size || blob.size > 2 * 1024 * 1024) continue;
      const url = URL.createObjectURL(blob), img = document.createElement('img');
      blobs.add(url);
      img.alt = ''; img.decoding = 'async';
      img.onload = () => { if (target.isConnected) target.querySelector('.fallback')?.replaceWith(img); };
      img.src = url;
    }
  } finally { fetching = false; }
}

/** Accept only the documented discovery contract; anything else is treated as a failed request. */
function normalize(result) {
  if (!result || typeof result !== 'object' || !STATUSES.includes(result.status) || !Array.isArray(result.items)) throw new Error('Invalid discovery result');
  if (result.provider !== 'tmdb') throw Object.assign(new Error('unsupported provider'), { providerUnsupported: true });
  const seen = new Set(), items = [];
  for (const item of result.items) {
    const title = text(item?.title, 300);
    if (!title || (item.kind !== 'movie' && item.kind !== 'tv') || item.provider !== result.provider || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256) continue;
    const id = JSON.stringify([item.provider, item.kind, item.id]);
    if (seen.has(id)) continue;
    seen.add(id);
    const originalTitle = text(item.originalTitle, 300), year = Number(item.year) > 1800 && Number(item.year) < 3000 && Number.isInteger(Number(item.year)) ? Number(item.year) : undefined;
    items.push({ kind: item.kind, id, title, originalTitle: originalTitle !== title ? originalTitle : undefined, year, poster: posterUrl(item.poster), overview: text(item.overview, 400) });
    if (items.length >= 20) break;
  }
  const time = typeof result.updatedAt === 'string' ? new Date(result.updatedAt) : null;
  return { status: result.status, items, updatedAt: time && !Number.isNaN(time.getTime()) ? time : null, stale: result.stale === true };
}

const updated = date => date ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : null;

function card(item, index) {
  const li = document.createElement('li'), button = document.createElement('button'), poster = document.createElement('span'), rank = document.createElement('span'), name = document.createElement('span'), meta = document.createElement('span');
  button.type = 'button'; button.className = 'card'; poster.className = 'poster'; rank.className = 'rank'; name.className = 'name'; meta.className = 'meta';
  const box = document.createElement('span'); box.className = 'fallback'; box.textContent = item.title;
  poster.append(box, rank);
  if (item.poster) { poster.dataset.poster = item.poster; posters.observe(poster); }
  rank.textContent = String(index + 1); rank.setAttribute('aria-hidden', 'true');
  name.textContent = item.title;
  const details = [item.year, item.originalTitle].filter(Boolean).join(' · ');
  meta.textContent = details || KINDS[item.kind];
  button.setAttribute('aria-label', `${index + 1}위 ${item.title}${item.year ? ` (${item.year})` : ''}, MOA에서 검색`);
  if (item.overview) button.title = item.overview;
  button.append(poster, name, meta); li.append(button);
  button.onclick = async () => {
    try { await moa.app.navigate(`/search?q=${encodeURIComponent(item.title)}`); }
    catch { status.className = 'warn'; status.textContent = '작품 검색 화면으로 이동할 수 없음'; }
  };
  return li;
}

function render() {
  for (const button of kindButtons) button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
  for (const button of windowButtons) button.setAttribute('aria-pressed', String(button.dataset.window === period));
  scope.textContent = `TMDB 전 세계 이용자 관심도 기준 ${WINDOWS[period]} 트렌드 · 국내·OTT 시청 순위가 아님${kind === 'tv' ? ' · 드라마 외 예능·애니메이션·다큐 포함' : ''}`;
  refresh.disabled = loading;
  panel.setAttribute('aria-busy', String(loading && !result));
  status.className = ''; retry.hidden = true;
  const items = result?.status === 'ready' || result?.status === 'unavailable' ? result.items : [];
  list.hidden = !items.length;
  resetPosters();
  list.replaceChildren(...items.map(card));
  list.scrollLeft = 0;
  if (loading && !result) status.textContent = '인기 작품 불러오는 중';
  else if (problem) { status.className = 'warn'; status.textContent = problem; retry.hidden = false; }
  else if (!result) status.textContent = '인기 작품 불러오는 중';
  else if (result.status === 'unconfigured') { status.textContent = '관리자가 MOA 설정에서 TMDB를 연결하면 표시됨'; retry.hidden = false; }
  else if (result.status === 'restricted') status.textContent = '이 프로필에서는 인기 작품 목록을 볼 수 없음';
  else if (result.status === 'unavailable' && !items.length) { status.className = 'warn'; status.textContent = 'TMDB에서 목록을 가져올 수 없음'; retry.hidden = false; }
  else if (!items.length) status.textContent = '표시할 작품이 없음';
  else {
    const time = updated(result.updatedAt);
    const stale = result.stale || result.status === 'unavailable';
    if (stale) { status.className = 'warn'; retry.hidden = false; }
    status.textContent = `${KINDS[kind]} ${items.length}편${time ? ` · ${time} 갱신` : ''}${stale ? ' · 최신 정보가 아닐 수 있음' : ''} · 작품을 선택하면 MOA에서 검색`;
  }
}

async function load() {
  const id = ++request, options = { kind, window: period };
  loading = true; problem = null; result = null; render();
  try {
    if (typeof moa.discovery?.trending !== 'function') throw Object.assign(new Error('unsupported'), { unsupported: true });
    const next = normalize(await moa.discovery.trending(options));
    if (id !== request) return;
    result = next;
  } catch (error) {
    if (id !== request) return;
    problem = error?.providerUnsupported ? '이 플러그인은 현재 TMDB 목록만 표시할 수 있음' : error?.unsupported ? '이 MOA 버전은 인기 작품 목록을 지원하지 않음' : '인기 작품 목록을 불러올 수 없음';
  }
  loading = false; render();
}

const choose = (nextKind, nextPeriod) => {
  if (nextKind === kind && nextPeriod === period) return;
  kind = nextKind; period = nextPeriod; void load();
};
for (const button of kindButtons) button.onclick = () => choose(button.dataset.kind, period);
for (const button of windowButtons) button.onclick = () => choose(kind, button.dataset.window);
refresh.onclick = () => void load();
retry.onclick = () => void load();

// Arrow keys move between cards; Home/End jump to the ends of the row.
list.addEventListener('keydown', event => {
  const cards = [...list.querySelectorAll('.card')], index = cards.indexOf(document.activeElement);
  if (index < 0) return;
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: cards.length - 1 }[event.key];
  if (next === undefined || !cards[next]) return;
  event.preventDefault(); cards[next].focus(); cards[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

let height = 0, resizing = false;
async function syncHeight() {
  height = Math.min(1200, Math.max(120, Math.ceil(section.getBoundingClientRect().height)));
  if (resizing) return;
  resizing = true;
  try {
    let sent;
    do { sent = height; await moa.ui.resize(sent); } while (sent !== height);
  } catch {} finally { resizing = false; }
}

render();
addEventListener('pagehide', resetPosters);
moa.on('ready', () => {
  new ResizeObserver(() => void syncHeight()).observe(section);
  void load();
});
