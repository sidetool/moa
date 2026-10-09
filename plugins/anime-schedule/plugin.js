document.body.innerHTML = `
  <style>
    html,body{margin:0;background:transparent;color:#f4f4f5;font:14px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}h2,p{margin:0}h2{font-size:22px;font-weight:700;letter-spacing:-.5px}
    button,a{touch-action:manipulation}button{font:inherit;color:inherit;cursor:pointer;border:1px solid #34343a;border-radius:10px;background:#202024}
    button:focus-visible,a:focus-visible{outline:2px solid #a1a1aa;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
    header{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:16px}header button,#retry{padding:8px 12px;white-space:nowrap}
    [role=tablist]{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
    [role=tab]{min-height:42px;padding:8px 0;border-color:transparent;color:#a1a1aa;background:#18181b}
    [role=tab][aria-selected=true]{background:#f4f4f5;color:#18181b;font-weight:700}
    #status{padding:16px 0 12px;color:#a1a1aa;font-size:13px}#retry{margin-bottom:12px}
    #schedule-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;list-style:none;padding:0;margin:0;max-height:520px;overflow:auto}
    #schedule-list[hidden],#retry[hidden]{display:none}li{min-width:0}
    .anime{display:flex;align-items:center;gap:14px;width:100%;height:100%;min-height:72px;padding:14px;text-align:left;background:#18181b;border-color:#27272a}
    .anime:hover{background:#242428;border-color:#52525b}.time{color:#a1a1aa;font-variant-numeric:tabular-nums;flex:0 0 44px}
    .detail{display:grid;gap:4px;min-width:0}.title{font-weight:600;overflow-wrap:anywhere}.note{font-size:12px;color:#a1a1aa}.off{color:#fbbf24}
    footer{margin-top:14px;color:#85858f;font-size:12px}
    @media(max-width:600px){h2{font-size:20px}#schedule-list{grid-template-columns:1fr}header{gap:8px}.anime{padding:12px}}
  </style>
  <section id="schedule" aria-labelledby="schedule-title">
    <header><h2 id="schedule-title">요일별 신작</h2><button id="refresh" type="button">새로고침</button></header>
    <div role="tablist" aria-label="방영 요일"></div>
    <div id="schedule-panel" role="tabpanel">
      <p id="status" role="status">편성표 불러오는 중</p>
      <button id="retry" type="button" hidden>다시 시도</button>
      <ul id="schedule-list" hidden></ul>
    </div>
    <footer>한국 시간 기준 방영 편성표 · 서비스별 업로드 시각과 다를 수 있음 · 출처 Anissia</footer>
  </section>
`;

const days = [{ id: 1, name: '월' }, { id: 2, name: '화' }, { id: 3, name: '수' }, { id: 4, name: '목' }, { id: 5, name: '금' }, { id: 6, name: '토' }, { id: 0, name: '일' }];
const currentDay = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date());
let selected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(currentDay), running = false, height = 0, resizing = false;
const cache = new Map(), tabs = document.querySelector('[role=tablist]'), panel = document.querySelector('#schedule-panel');
const list = document.querySelector('#schedule-list'), status = document.querySelector('#status'), retry = document.querySelector('#retry'), refresh = document.querySelector('#refresh');
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
  retry.hidden = true; list.replaceChildren();
  const entries = cache.get(selected);
  list.hidden = !entries?.length;
  panel.setAttribute('aria-busy', String(!entries));
  status.textContent = entries ? entries.length ? `${entries.length}개 작품 · 작품을 선택하면 MOA에서 검색` : '방영 예정인 작품이 없음' : '편성표 불러오는 중';
  for (const entry of entries || []) {
    const item = document.createElement('li'), button = document.createElement('button'), time = document.createElement('span'), detail = document.createElement('span'), title = document.createElement('span');
    button.type = 'button'; button.className = 'anime'; time.className = 'time'; detail.className = 'detail'; title.className = 'title';
    time.textContent = /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : '미정'; title.textContent = entry.subject;
    button.setAttribute('aria-label', `${time.textContent} ${entry.subject} MOA에서 검색`);
    detail.append(title);
    if (entry.status === 'OFF' || entry.startDate > today()) {
      const note = document.createElement('span');
      note.className = entry.status === 'OFF' ? 'note off' : 'note';
      note.textContent = entry.status === 'OFF' ? '결방' : `${entry.startDate} 첫 방송`;
      detail.append(note);
    }
    button.append(time, detail); item.append(button); list.append(item);
    button.onclick = async () => {
      try { await moa.app.navigate(`/search?q=${encodeURIComponent(entry.subject)}`); }
      catch { status.textContent = '작품 검색 화면으로 이동할 수 없음'; }
    };
  }
}

async function load() {
  if (running || cache.has(selected)) return;
  running = true; refresh.disabled = true;
  while (!cache.has(selected)) {
    const day = selected;
    try {
      const result = await (await moa.fetch(`https://api.anissia.net/anime/schedule/${day}`)).json();
      if (result.code !== 'ok' || !Array.isArray(result.data)) throw new Error('Invalid schedule');
      cache.set(day, result.data.filter(entry => entry && typeof entry.subject === 'string' && entry.subject.trim() && (!entry.endDate || entry.endDate >= today())).sort((a, b) => String(a.time || '').localeCompare(String(b.time || ''))));
      if (day === selected) render();
    } catch {
      if (day === selected) {
        panel.setAttribute('aria-busy', 'false'); status.textContent = '편성표를 불러올 수 없음'; retry.hidden = false;
        break;
      }
    }
  }
  running = false; refresh.disabled = false;
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

refresh.onclick = () => { cache.delete(selected); render(); void load(); };
retry.onclick = () => { render(); void load(); };
new ResizeObserver(async () => {
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
moa.on('ready', () => select(selected));
