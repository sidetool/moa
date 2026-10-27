document.body.innerHTML = `
  <style>
    html,body{margin:0;background:transparent;color:#f4f4f5;font:14px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}h2,p{margin:0}h2{font-size:22px;font-weight:700;letter-spacing:-.5px}
    button,a{touch-action:manipulation}button{font:inherit;color:inherit;cursor:pointer;border:1px solid #34343a;border-radius:10px;background:#202024}
    button:focus-visible,a:focus-visible{outline:2px solid #a1a1aa;outline-offset:3px}button:disabled{opacity:.4;cursor:default}
    header{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:16px}header button,#retry{padding:8px 12px;white-space:nowrap}
    [role=tablist]{display:flex;flex-wrap:wrap;gap:8px}
    [role=tab]{width:52px;flex-shrink:0;aspect-ratio:1;padding:0;border-radius:50%;border-color:transparent;color:#a1a1aa;background:#18181b;font-size:17px;transition:background .2s,color .2s,transform .2s}[role=tab]:hover{transform:translateY(-2px)}
    [role=tab][aria-selected=true]{background:#f4f4f5;color:#18181b;font-weight:700}
    #status{padding:16px 0 12px;color:#a1a1aa;font-size:13px}.carousel{position:relative}.pages{position:absolute;top:4px;left:0;right:0;height:calc(var(--card-width,180px)*1.5);z-index:1;display:flex;justify-content:space-between;pointer-events:none}.pages button{display:grid;place-items:center;width:48px;height:100%;padding:0;border:0;background:rgba(24,24,27,.65);pointer-events:auto;transition:opacity .24s ease,visibility 0s linear}.pages button:disabled{opacity:0;visibility:hidden;pointer-events:none;transition-delay:0s,.24s}#previous{border-radius:0 12px 12px 0}#next{border-radius:12px 0 0 12px}.pages svg{width:32px;height:32px}#retry{margin-bottom:12px}
    #schedule-list{display:grid;grid-auto-flow:column;grid-auto-columns:var(--card-width,180px);gap:16px;list-style:none;padding:4px 0 12px;margin:0;overflow-x:hidden;overscroll-behavior-x:contain;scrollbar-width:none}
    #schedule-list[hidden],#retry[hidden],.pages[hidden]{display:none}#schedule-list::-webkit-scrollbar{display:none}li{min-width:0}
    .anime{display:grid;align-content:start;gap:10px;width:100%;height:100%;padding:0;text-align:left;background:transparent;border:0}
    .anime:focus-visible,.pages button:focus-visible{outline-offset:-2px}
    .poster{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:2/3;overflow:hidden;border-radius:12px;background:#202024;color:#71717a;font-size:12px;transition:filter .2s}.poster img{width:100%;height:100%;object-fit:cover}.anime:hover .poster{filter:brightness(1.12)}
    .poster[data-loading]{background:linear-gradient(100deg,#202024 25%,#34343a 50%,#202024 75%);background-size:200% 100%;animation:shimmer 1.6s ease-in-out infinite}
    .detail{display:grid;align-content:start;gap:4px;min-width:0;padding:0 4px}.time{color:#a1a1aa;font-variant-numeric:tabular-nums}.title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-weight:600;overflow-wrap:anywhere}.note{font-size:12px;color:#a1a1aa}.off{color:#fbbf24}
    @keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
    @media(max-width:600px){h2{font-size:20px}#schedule-list{gap:12px}header{gap:8px}}
    @media(max-width:380px){[role=tablist]{gap:12px;max-width:240px}[role=tab]{width:48px}}
    @media(hover:hover) and (pointer:fine){.pages button:not(:disabled){opacity:0;pointer-events:none}.carousel:hover .pages button:not(:disabled),.carousel:has(:focus-visible) .pages button:not(:disabled){opacity:1;pointer-events:auto}}
    @media(prefers-reduced-motion:reduce){.poster,[role=tab],.pages button{transition:none}[role=tab]:hover{transform:none}.poster[data-loading]{animation:none}}
  </style>
  <section id="schedule" aria-labelledby="schedule-title">
    <header><h2 id="schedule-title">요일별 신작</h2><button id="refresh" type="button">새로고침</button></header>
    <div role="tablist" aria-label="방영 요일"></div>
    <div id="schedule-panel" role="tabpanel">
      <p id="status" role="status">작품 불러오는 중</p>
      <button id="retry" type="button" hidden>다시 시도</button>
      <div class="carousel"><nav class="pages" aria-label="작품 페이지" hidden>
        <button id="previous" type="button" aria-label="이전 작품" aria-controls="schedule-list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <button id="next" type="button" aria-label="다음 작품" aria-controls="schedule-list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
      </nav><ul id="schedule-list" hidden></ul></div>
    </div>
  </section>
`;

const days = [{ id: 1, name: '월' }, { id: 2, name: '화' }, { id: 3, name: '수' }, { id: 4, name: '목' }, { id: 5, name: '금' }, { id: 6, name: '토' }, { id: 0, name: '일' }];
const currentDay = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date());
let selected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(currentDay), height = 0, resizing = false;
const cache = new Map(), tabs = document.querySelector('[role=tablist]'), panel = document.querySelector('#schedule-panel');
const list = document.querySelector('#schedule-list'), status = document.querySelector('#status'), retry = document.querySelector('#retry'), refresh = document.querySelector('#refresh');
const previous = document.querySelector('#previous'), next = document.querySelector('#next'), pages = document.querySelector('.pages');
let generation = 0, active = 0, concurrency = 3, closed = false;
const jobs = [], lookups = new Map(), images = new Map(), loading = new Map(), blobs = new Set();

// Reserve one SDK slot for resize while preloading the week.
function drain() {
  while (!closed && active < concurrency && jobs.length) {
    const job = jobs.shift(); active++;
    Promise.resolve().then(job.run).then(job.resolve, error => {
      if (error.message === 'plugin-busy' && !job.retried && !closed && job.generation === generation) {
        concurrency = 1; job.retried = true; jobs.unshift(job);
      } else job.reject(error);
    }).finally(() => { active--; drain(); });
  }
}
const request = (run, priority = false) => new Promise((resolve, reject) => {
  jobs[priority ? 'unshift' : 'push']({ run, resolve, reject, generation }); drain();
});

async function lookup(title) {
  if (typeof moa.metadata?.lookup !== 'function') return {};
  if (!lookups.has(title)) {
    const owner = generation;
    const pending = request(() => moa.metadata.lookup({ title, type: 'anime' })).then(result => {
      if (!result || result.provider !== 'tmdb' || !['ready', 'unconfigured', 'restricted', 'unavailable'].includes(result.status)) throw new Error('Invalid title lookup');
      if (owner === generation && result.status === 'unavailable') lookups.delete(title);
      return result;
    }).catch(() => { if (owner === generation) lookups.delete(title); return {}; });
    lookups.set(title, pending);
  }
  return lookups.get(title);
}

function imageFor(poster) {
  if (typeof poster !== 'string' || !/^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(poster)) return Promise.resolve(null);
  if (!images.has(poster)) {
    const owner = generation;
    const pending = (async () => {
      let url;
      try {
        const blob = await (await request(() => moa.fetch(poster), true)).blob();
        if (owner !== generation || closed || !blob.size || blob.size > 2 * 1024 * 1024) return null;
        url = URL.createObjectURL(blob); blobs.add(url);
        const img = new Image(); img.src = url; await img.decode();
        if (owner !== generation || closed) return null;
        return url;
      } catch {
        if (url) { URL.revokeObjectURL(url); blobs.delete(url); }
        return null;
      }
    })();
    images.set(poster, pending);
  }
  return images.get(poster);
}

async function artwork(title, button) {
  const owner = generation, result = await lookup(title);
  if (owner !== generation || closed) return;
  const url = await imageFor(result.poster);
  if (owner !== generation || !button?.isConnected) return;
  const poster = button.querySelector('.poster');
  if (result.mediaId) button.setAttribute('aria-label', `${button.dataset.time} ${title} 상세 보기`);
  if (url) {
    const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = url;
    poster.replaceChildren(img);
  } else poster.textContent = '이미지 없음';
  delete poster.dataset.loading;
}

function resetArtwork() {
  generation++;
  for (const job of jobs.splice(0)) job.reject(new Error('Cancelled'));
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs.clear(); lookups.clear(); images.clear(); cache.clear(); loading.clear();
}

function updatePages() {
  const width = list.getBoundingClientRect().width, gap = parseFloat(getComputedStyle(list).gap) || 16;
  if (width > 0) {
    const count = Math.max(1, Math.floor((width + gap) / ((innerWidth <= 600 ? 148 : 180) + gap)));
    list.parentElement.style.setProperty('--card-width', `${(width - gap * (count - 1)) / count}px`);
  }
  pages.hidden = list.hidden || list.scrollWidth <= list.clientWidth + 1;
  previous.disabled = list.scrollLeft <= 1;
  next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
}
function movePage(direction) {
  const gap = parseFloat(getComputedStyle(list).gap) || 16;
  list.scrollBy({ left: direction * (list.getBoundingClientRect().width + gap), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
previous.onclick = () => movePage(-1); next.onclick = () => movePage(1);
list.addEventListener('scroll', updatePages, { passive: true });

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

for (const { id, name } of days) {
  const tab = document.createElement('button');
  tab.type = 'button'; tab.id = `day-${id}`; tab.textContent = name; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'schedule-panel');
  tab.onclick = () => select(id);
  tab.onkeydown = event => {
    const index = days.findIndex(day => day.id === id);
    const next = { ArrowRight: (index + 1) % 7, ArrowLeft: (index + 6) % 7, Home: 0, End: 6 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); tabs.children[next].focus(); select(days[next].id);
  };
  tabs.append(tab);
}

function render() {
  retry.hidden = true; list.replaceChildren(); list.scrollLeft = 0;
  const entries = cache.get(selected);
  list.hidden = !entries?.length;
  panel.setAttribute('aria-busy', String(!entries));
  status.textContent = entries ? entries.length ? `${entries.length}개 작품` : '방영 예정인 작품이 없음' : '작품 불러오는 중';
  for (const entry of entries || []) {
    const item = document.createElement('li'), button = document.createElement('button'), time = document.createElement('span'), detail = document.createElement('span'), title = document.createElement('span');
    button.type = 'button'; button.className = 'anime'; time.className = 'time'; detail.className = 'detail'; title.className = 'title';
    time.textContent = /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : '미정'; title.textContent = entry.subject;
    button.setAttribute('aria-label', `${time.textContent} ${entry.subject} MOA에서 검색`);
    const poster = document.createElement('span'); poster.className = 'poster'; poster.dataset.loading = ''; poster.setAttribute('aria-hidden', 'true');
    button.dataset.title = entry.subject; button.dataset.time = time.textContent;
    detail.append(time, title);
    if (entry.status === 'OFF' || entry.startDate > today()) {
      const note = document.createElement('span');
      note.className = entry.status === 'OFF' ? 'note off' : 'note';
      note.textContent = entry.status === 'OFF' ? '결방' : `${entry.startDate} 첫 방송`;
      detail.append(note);
    }
    button.append(poster, detail); item.append(button); list.append(item); void artwork(entry.subject, button);
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await lookup(entry.subject);
        if (!button.isConnected) return;
        await request(() => button.isConnected && moa.app.navigate(typeof result.mediaId === 'string' && result.mediaId ? `/title/${encodeURIComponent(result.mediaId)}` : `/search?q=${encodeURIComponent(entry.subject)}`), true);
      } catch { if (button.isConnected) status.textContent = '작품 화면으로 이동할 수 없어요.'; }
      finally { button.disabled = false; }
    };
  }
  updatePages();
}

async function load(day = selected) {
  if (cache.has(day) || loading.has(day)) return;
  const owner = generation;
  const pending = (async () => {
    try {
      const result = await (await request(() => moa.fetch(`https://api.anissia.net/anime/schedule/${day}`))).json();
      if (result.code !== 'ok' || !Array.isArray(result.data)) throw new Error('Invalid schedule');
      if (owner !== generation || closed) return;
      const entries = result.data.filter(entry => entry && typeof entry.subject === 'string' && entry.subject.trim() && entry.subject.length <= 200 && (!entry.endDate || entry.endDate >= today())).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      cache.set(day, entries);
      if (day === selected) render();
      else for (const entry of entries) void artwork(entry.subject);
    } catch {
      if (owner === generation && day === selected && !closed) {
        panel.setAttribute('aria-busy', 'false'); status.textContent = '작품을 불러올 수 없음'; retry.hidden = false;
      }
    } finally { if (owner === generation) loading.delete(day); }
  })();
  loading.set(day, pending);
  return pending;
}
function preload() {
  void load();
  for (const { id } of days) if (id !== selected) void load(id);
}

function select(day) {
  selected = day;
  for (const tab of tabs.children) {
    const active = tab.id === `day-${day}`;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', `day-${day}`);
  render(); void load();
}

refresh.onclick = () => { resetArtwork(); render(); preload(); };
retry.onclick = () => { render(); void load(); };
new ResizeObserver(async () => {
  updatePages();
  const next = Math.ceil(document.querySelector('#schedule').getBoundingClientRect().height);
  if (next === height) return;
  height = next;
  if (resizing) return;
  resizing = true;
  try {
    let sent;
    do { sent = height; await moa.ui.resize(sent); } while (sent !== height);
  } catch {} finally { resizing = false; }
}).observe(document.querySelector('#schedule'));
moa.on('ready', () => { select(selected); preload(); });

addEventListener('pagehide', () => { closed = true; resetArtwork(); });
