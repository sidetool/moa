const TMDB_LOGO = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20viewBox%3D%220%200%20273.42%2035.52%22%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfill%3Aurl(%23linear-gradient)%3B%7D%3C%2Fstyle%3E%3ClinearGradient%20id%3D%22linear-gradient%22%20y1%3D%2217.76%22%20x2%3D%22273.42%22%20y2%3D%2217.76%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2390cea1%22%2F%3E%3Cstop%20offset%3D%220.56%22%20stop-color%3D%22%233cbec9%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2300b3e5%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ctitle%3EAsset%203%3C%2Ftitle%3E%3Cg%20id%3D%22Layer_2%22%20data-name%3D%22Layer%202%22%3E%3Cg%20id%3D%22Layer_1-2%22%20data-name%3D%22Layer%201%22%3E%3Cpath%20class%3D%22cls-1%22%20d%3D%22M191.85%2C35.37h63.9A17.67%2C17.67%2C0%2C0%2C0%2C273.42%2C17.7h0A17.67%2C17.67%2C0%2C0%2C0%2C255.75%2C0h-63.9A17.67%2C17.67%2C0%2C0%2C0%2C174.18%2C17.7h0A17.67%2C17.67%2C0%2C0%2C0%2C191.85%2C35.37ZM10.1%2C35.42h7.8V6.92H28V0H0v6.9H10.1Zm28.1%2C0H46V8.25h.1L55.05%2C35.4h6L70.3%2C8.25h.1V35.4h7.8V0H66.45l-8.2%2C23.1h-.1L50%2C0H38.2ZM89.14.12h11.7a33.56%2C33.56%2C0%2C0%2C1%2C8.08%2C1%2C18.52%2C18.52%2C0%2C0%2C1%2C6.67%2C3.08%2C15.09%2C15.09%2C0%2C0%2C1%2C4.53%2C5.52%2C18.5%2C18.5%2C0%2C0%2C1%2C1.67%2C8.25%2C16.91%2C16.91%2C0%2C0%2C1-1.62%2C7.58%2C16.3%2C16.3%2C0%2C0%2C1-4.38%2C5.5%2C19.24%2C19.24%2C0%2C0%2C1-6.35%2C3.37%2C24.53%2C24.53%2C0%2C0%2C1-7.55%2C1.15H89.14Zm7.8%2C28.2h4a21.66%2C21.66%2C0%2C0%2C0%2C5-.55A10.58%2C10.58%2C0%2C0%2C0%2C110%2C26a8.73%2C8.73%2C0%2C0%2C0%2C2.68-3.35%2C11.9%2C11.9%2C0%2C0%2C0%2C1-5.08%2C9.87%2C9.87%2C0%2C0%2C0-1-4.52%2C9.17%2C9.17%2C0%2C0%2C0-2.63-3.18A11.61%2C11.61%2C0%2C0%2C0%2C106.22%2C8a17.06%2C17.06%2C0%2C0%2C0-4.68-.63h-4.6ZM133.09.12h13.2a32.87%2C32.87%2C0%2C0%2C1%2C4.63.33%2C12.66%2C12.66%2C0%2C0%2C1%2C4.17%2C1.3%2C7.94%2C7.94%2C0%2C0%2C1%2C3%2C2.72%2C8.34%2C8.34%2C0%2C0%2C1%2C1.15%2C4.65%2C7.48%2C7.48%2C0%2C0%2C1-1.67%2C5%2C9.13%2C9.13%2C0%2C0%2C1-4.43%2C2.82V17a10.28%2C10.28%2C0%2C0%2C1%2C3.18%2C1%2C8.51%2C8.51%2C0%2C0%2C1%2C2.45%2C1.85%2C7.79%2C7.79%2C0%2C0%2C1%2C1.57%2C2.62%2C9.16%2C9.16%2C0%2C0%2C1%2C.55%2C3.2%2C8.52%2C8.52%2C0%2C0%2C1-1.2%2C4.68%2C9.32%2C9.32%2C0%2C0%2C1-3.1%2C3A13.38%2C13.38%2C0%2C0%2C1%2C152.32%2C35a22.5%2C22.5%2C0%2C0%2C1-4.73.5h-14.5Zm7.8%2C14.15h5.65a7.65%2C7.65%2C0%2C0%2C0%2C1.78-.2%2C4.78%2C4.78%2C0%2C0%2C0%2C1.57-.65%2C3.43%2C3.43%2C0%2C0%2C0%2C1.13-1.2%2C3.63%2C3.63%2C0%2C0%2C0%2C.42-1.8A3.3%2C3.3%2C0%2C0%2C0%2C151%2C8.6a3.42%2C3.42%2C0%2C0%2C0-1.23-1.13A6.07%2C6.07%2C0%2C0%2C0%2C148%2C6.9a9.9%2C9.9%2C0%2C0%2C0-1.85-.18h-5.3Zm0%2C14.65h7a8.27%2C8.27%2C0%2C0%2C0%2C1.83-.2%2C4.67%2C4.67%2C0%2C0%2C0%2C1.67-.7%2C3.93%2C3.93%2C0%2C0%2C0%2C1.23-1.3%2C3.8%2C3.8%2C0%2C0%2C0%2C.47-1.95%2C3.16%2C3.16%2C0%2C0%2C0-.62-2%2C4%2C4%2C0%2C0%2C0-1.58-1.18%2C8.23%2C8.23%2C0%2C0%2C0-2-.55%2C15.12%2C15.12%2C0%2C0%2C0-2.05-.15h-5.9Z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E';
// Fixed host contract; all provider and profile text is rendered as text nodes. Only the constant icons below use markup.
const svg=body=>`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON={refresh:svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),next:svg('<path d="m9 18 6-6-6-6"/>'),info:svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>')};
// Visual tokens mirror MOA's base.css so the panel reads as a native home row.
document.body.innerHTML=`<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent}
body{color:var(--moa-text,#f5f5f7);font:15px/1.5 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;letter-spacing:-.012em;-webkit-font-smoothing:antialiased}
h2,p{margin:0}[hidden]{display:none!important}svg{display:block;flex:none}
button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0;-webkit-tap-highlight-color:transparent}
button:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:6px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 16px;margin-bottom:12px}
h2{font-size:clamp(1.08rem,1.6vw,1.32rem);font-weight:750;letter-spacing:-.035em;word-break:keep-all}
#range{margin-top:2px;color:#8e8e99;font-size:.82rem;font-variant-numeric:tabular-nums}
.icon{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;color:#c7c7cf;transition:background-color .15s,color .15s}
.icon:hover{background:rgba(255,255,255,.1);color:#fff}
.scope{display:flex;align-items:flex-start;gap:7px;margin-bottom:16px;color:#8e8e99;font-size:.8rem;line-height:1.55;word-break:keep-all;overflow-wrap:anywhere}
.scope svg{width:15px;height:15px;margin-top:2px}
.summary{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin-bottom:10px}
#status{font-size:.92rem;font-weight:700}#status:empty{display:none}
#note{color:#8e8e99;font-size:.8rem}#note:empty{display:none}
#badge{align-self:center;padding:2px 8px;border-radius:6px;background:#2a2a30;color:#c7c7cf;font-size:.74rem;font-weight:600}
#list,.skel{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
#list.expanded{max-height:560px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#33333a transparent}
.item{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;gap:14px;width:100%;min-height:68px;padding:12px 14px 12px 12px;border-radius:10px;background:#17171b;text-align:left;transition:background-color .15s}
.item:hover{background:#202025}
.when{display:grid;place-items:center;align-content:center;gap:1px;height:46px;border-radius:8px;background:#202025;font-variant-numeric:tabular-nums;transition:background-color .15s}
.when strong{font-size:.95rem;font-weight:700;line-height:1.15}
.when small{color:#8e8e99;font-size:.68rem;font-weight:650;line-height:1.2}
.when.soon{background:#fff;color:#0b0b0d}.when.soon small{color:#56565f}
.item:hover .when:not(.soon){background:#2a2a30}
.body{display:grid;gap:3px;min-width:0}
.body strong{font-size:.95rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;align-items:center;gap:6px;min-width:0}
.kind{flex:none;padding:1px 6px;border-radius:5px;background:#2a2a30;color:#c7c7cf;font-size:.7rem;font-weight:700}
.kind.release{background:rgba(123,97,255,.2);color:#c2b6ff}
.meta small{color:#8e8e99;font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.go{color:#8e8e99;opacity:0;transition:opacity .15s}.item:hover .go,.item:focus-visible .go{opacity:1;color:#fff}
@media (hover:none){.go{opacity:1}}
#more{width:100%;height:40px;margin-top:8px;border-radius:8px;background:#17171b;color:#c7c7cf;font-size:.9rem;font-weight:650}
#more:hover{background:#202025;color:#fff}
.skel span{height:68px;border-radius:10px;background:linear-gradient(100deg,#17171b 30%,#222227 45%,#17171b 60%) 0 0/300% 100%;animation:shimmer 1.5s linear infinite}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-50% 0}}
#state{display:grid;justify-items:center;gap:6px;padding:28px 20px;border-radius:10px;background:#17171b;text-align:center}
#state-title{font-size:.95rem;font-weight:700;word-break:keep-all}
#state-body{max-width:460px;color:#8e8e99;font-size:.84rem;line-height:1.55;word-break:keep-all}
#retry{margin-top:8px;height:36px;padding:0 16px;border-radius:6px;background:rgba(120,120,128,.38);font-size:.9rem;font-weight:650}
#retry:hover{background:rgba(120,120,128,.54)}
footer{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-top:14px;color:#8e8e99;font-size:.74rem;line-height:1.5;overflow-wrap:anywhere}
footer img{width:56px;height:auto}footer p{flex:1 1 240px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:640px){#list,.skel{grid-template-columns:minmax(0,1fr)}.item{gap:12px}}
</style><section id="news" aria-labelledby="heading">
<header class="head"><div><h2 id="heading">찜한 작품 소식</h2><p id="range"></p></div><button type="button" id="refresh" class="icon" aria-label="다시 확인" title="다시 확인">${ICON.refresh}</button></header>
<p class="scope">${ICON.info}<span>최근 찜한 작품 중 TMDB에 연결된 최대 12편의 한국 극장 개봉일과 다음 회차 원방영일이에요. 국내 방영·OTT 공개나 MOA 재생 가능 시점과는 다를 수 있어요.</span></p>
<div id="panel" aria-live="polite"><div class="summary"><p id="status" role="status"></p><span id="note"></span><span id="badge" hidden title="찜 목록 범위, 일부 조회 실패나 조회 중 변경으로 빠진 소식이 있을 수 있어요.">일부만 확인</span></div>
<div id="skel" class="skel" aria-hidden="true" hidden><span></span><span></span><span></span><span></span></div>
<div id="state" hidden><p id="state-title"></p><p id="state-body"></p><button type="button" id="retry" hidden>다시 시도</button></div>
<ul id="list" aria-label="다가오는 소식"></ul><button type="button" id="more" hidden></button></div>
<footer><img alt="TMDB" src="${TMDB_LOGO}"><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p></footer></section>`;
const $=s=>document.querySelector(s),DATE=/^\d{4}-\d{2}-\d{2}$/,STATUSES=['ready','restricted','unconfigured','unavailable'];
const today=()=>new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
const kst=(date,options)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',...options}).format(new Date(date+'T12:00:00+09:00'));
const validDate=d=>typeof d==='string'&&DATE.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const count=n=>Number.isSafeInteger(n)&&n>=0;
const setText=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
let generation=0,shown=[],expanded=false;
function state(title,body,retry){$('#state').hidden=false;$('#state-title').textContent=title;$('#state-body').textContent=body;$('#state-body').hidden=!body;$('#retry').hidden=!retry;}
function relative(date){const d=Math.round((Date.parse(date)-Date.parse(today()))/86400e3);return d<=0?'오늘':d===1?'내일':`D-${d}`;}
function render(){
 const limit=matchMedia('(max-width:640px)').matches?4:6,list=$('#list');
 list.replaceChildren();list.classList.toggle('expanded',expanded);
 for(const x of expanded?shown:shown.slice(0,limit)){
  const li=document.createElement('li'),b=document.createElement('button'),when=setText('span','','when'),body=setText('span','','body'),meta=setText('span','','meta'),go=document.createElement('span'),rel=relative(x.date);
  when.append(setText('strong',kst(x.date,{month:'numeric',day:'numeric'}).replace(/\.\s*$/,'').replace(/\.\s*/,'.')),setText('small',rel));if(rel==='오늘'||rel==='내일')when.classList.add('soon');
  meta.append(setText('span',x.kind==='release'?'개봉':'새 회차','kind '+x.kind));if(x.detail)meta.append(setText('small',x.detail));
  body.append(setText('strong',x.title),meta);go.className='go';go.innerHTML=ICON.next;b.type='button';b.className='item';b.append(when,body,go);
  b.setAttribute('aria-label',`${x.title}, ${kst(x.date,{month:'long',day:'numeric',weekday:'long'})} ${x.kind==='release'?'개봉':'새 회차'}, 작품 정보 열기`);
  b.onclick=()=>moa.app.navigate('/title/'+encodeURIComponent(x.mediaId)).catch(()=>{});li.append(b);list.append(li);
 }
 $('#more').hidden=shown.length<=limit;$('#more').textContent=expanded?'접기':`소식 ${shown.length}건 모두 보기`;
}
function clear(){shown=[];expanded=false;render();$('#state').hidden=true;$('#status').textContent='';$('#note').textContent='';$('#badge').hidden=true;}
async function load(){
 const seq=++generation,base=today();
 // Drop the previous profile's items before the request so a slow or failed answer never shows stale personal data.
 clear();$('#range').textContent=`${kst(base,{month:'long',day:'numeric'})}부터 30일 · 한국 시간(KST)`;$('#skel').hidden=false;$('#panel').setAttribute('aria-busy','true');
 try{
  if(typeof moa.watchlist?.news!=='function')throw Error('host-update');
  const r=await moa.watchlist.news();if(seq!==generation)return;
  if(!r||r.provider!=='tmdb'||!STATUSES.includes(r.status)||!validDate(r.from)||!validDate(r.through)||r.from>r.through||!Array.isArray(r.items)||!count(r.unlinked)||!count(r.checked)||r.checked>12||typeof r.truncated!=='boolean')throw Error('invalid');
  if(r.status!=='ready'){state(...{restricted:['이 프로필에서는 작품 소식을 표시하지 않아요.','키즈 프로필 등 제한된 프로필에서는 외부 일정 정보를 숨겨요.'],unconfigured:['작품 소식을 보려면 TMDB 연결이 필요해요.','MOA 설정에서 TMDB 메타데이터를 연결하면 찜한 작품의 개봉·방영일을 확인할 수 있어요.'],unavailable:['지금은 작품 소식을 가져올 수 없어요.','일정 정보를 준비하는 데 시간이 걸리고 있어요. 잠시 후 다시 시도해 주세요.']}[r.status],r.status==='unavailable');return;}
  $('#range').textContent=`${kst(r.from,{month:'long',day:'numeric'})} – ${kst(r.through,{month:'long',day:'numeric'})} · 한국 시간(KST)`;
  const seen=new Set(),items=r.items.slice(0,60).filter(x=>x&&typeof x.mediaId==='string'&&x.mediaId&&x.mediaId.length<=200&&typeof x.title==='string'&&x.title.trim()&&x.title.length<=200&&validDate(x.date)&&x.date>=r.from&&x.date<=r.through&&['release','episode'].includes(x.kind)&&typeof x.detail==='string'&&x.detail.length<=200&&!seen.has(x.mediaId+x.date+x.kind)&&seen.add(x.mediaId+x.date+x.kind)).sort((a,b)=>a.date.localeCompare(b.date));
  $('#badge').hidden=!r.truncated;$('#note').textContent=r.unlinked?`최근 찜 중 TMDB 미연결 ${r.unlinked}편 제외`:'';
  if(!r.checked){state('최근 찜한 작품 중 확인할 수 있는 작품이 없어요.',r.unlinked?'최근 찜한 작품이 아직 TMDB 정보와 연결되지 않았어요. 작품 정보가 연결되면 개봉·방영 소식을 보여 드릴게요.':'마음에 드는 영화나 시리즈를 내 목록에 담으면 다가오는 개봉·방영일을 알려 드릴게요.',false);return;}
  if(!items.length){$('#note').textContent=[`확인 대상 ${r.checked}편`,$('#note').textContent].filter(Boolean).join(' · ');state('30일 안에 찾은 소식이 없어요.',(r.truncated?'일부 작품은 확인하지 못했을 수 있어요. ':'')+'등록된 개봉일이나 다음 회차 정보가 없으면 표시되지 않아요. 일정은 TMDB에 등록되는 대로 반영돼요.',false);return;}
  $("#status").textContent=`다가오는 소식 ${items.length}건`;$("#note").textContent=[`확인 대상 ${r.checked}편`,$("#note").textContent].filter(Boolean).join(" · ");shown=items;render();
 }catch{if(seq!==generation)return;clear();state('작품 소식을 불러오지 못했어요.','플러그인 지원 버전과 연결 상태를 확인한 뒤 다시 시도해 주세요.',true);}
 finally{if(seq===generation){$('#skel').hidden=true;$('#panel').removeAttribute('aria-busy');}}
}
$('#refresh').onclick=$('#retry').onclick=()=>void load();
$('#more').onclick=()=>{expanded=!expanded;render();if(!expanded)$('#list').scrollTop=0;};
let resizePending=false,lastHeight=0;new ResizeObserver(()=>{if(resizePending)return;resizePending=true;requestAnimationFrame(()=>{resizePending=false;const h=Math.max(120,Math.min(1200,Math.ceil($('#news').getBoundingClientRect().height)));if(h!==lastHeight){lastHeight=h;moa.ui.resize(h).catch(()=>{});}});}).observe($('#news'));void load();
