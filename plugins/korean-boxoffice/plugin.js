// Fixed host contract; all provider text is rendered as text nodes. Only the constant icons below use markup.
const svg=body=>`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON={refresh:svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),search:svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),info:svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>')};
// Visual tokens mirror MOA's base.css; the outlined rank numeral echoes the native TOP 10 row.
document.body.innerHTML=`<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent}
body{color:var(--moa-text,#f5f5f7);font:15px/1.5 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;letter-spacing:-.012em;-webkit-font-smoothing:antialiased}
h2,p{margin:0}[hidden]{display:none!important}svg{display:block;flex:none}
button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0;-webkit-tap-highlight-color:transparent}
button:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:6px}
.head{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px 16px;margin-bottom:12px}
h2{font-size:clamp(1.08rem,1.6vw,1.32rem);font-weight:750;letter-spacing:-.035em;word-break:keep-all}
#range{margin-top:2px;color:#8e8e99;font-size:.82rem;font-variant-numeric:tabular-nums}
.tools{display:flex;align-items:center;gap:6px}
.segment{display:inline-flex;padding:3px;border-radius:8px;background:#202025}
.segment button{height:34px;padding:0 16px;border-radius:6px;color:#8e8e99;font-weight:600;font-size:.9rem;white-space:nowrap}
.segment button[aria-pressed=true]{background:#fff;color:#0b0b0d}
.icon{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;color:#c7c7cf;transition:background-color .15s,color .15s}
.icon:hover{background:rgba(255,255,255,.1);color:#fff}
.scope{display:flex;align-items:flex-start;gap:7px;margin-bottom:16px;color:#8e8e99;font-size:.8rem;line-height:1.55;word-break:keep-all;overflow-wrap:anywhere}
.scope svg{width:15px;height:15px;margin-top:2px}
#list:empty{display:none}
#list,.skel{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(5,auto);grid-auto-flow:column;gap:8px}
.item{display:grid;grid-template-columns:52px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:68px;padding:10px 14px 10px 10px;border-radius:10px;background:#17171b;text-align:left;transition:background-color .15s}
.item:hover{background:#202025}
.rank{justify-self:center;font-size:2.35rem;font-weight:900;line-height:1;letter-spacing:-.08em;color:#0b0b0d;-webkit-text-stroke:1.5px rgba(255,255,255,.55);paint-order:stroke;font-variant-numeric:lining-nums tabular-nums;transition:-webkit-text-stroke-color .15s}
.item:hover .rank{-webkit-text-stroke-color:rgba(255,255,255,.85)}
.top .rank{color:#f5f5f7;-webkit-text-stroke:0}
.body{display:grid;gap:2px;min-width:0}
.body strong{font-size:.95rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body small{color:#8e8e99;font-size:.8rem;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body small b{color:#c7c7cf;font-weight:650}
.side{display:flex;align-items:center;gap:8px}
.change{min-width:34px;font-size:.78rem;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;color:#6b6b75}
.change.up{color:#ff6b6b}.change.down{color:#5aa9ff}
.change.new{min-width:0;padding:2px 6px;border-radius:5px;background:rgba(123,97,255,.22);color:#c2b6ff;font-size:.68rem;letter-spacing:.02em}
.go{color:#8e8e99;opacity:0;transition:opacity .15s}.item:hover .go,.item:focus-visible .go{opacity:1;color:#fff}
@media (hover:none){.go{display:none}}
.skel span{height:68px;border-radius:10px;background:linear-gradient(100deg,#17171b 30%,#222227 45%,#17171b 60%) 0 0/300% 100%;animation:shimmer 1.5s linear infinite}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-50% 0}}
#state{display:grid;justify-items:center;gap:6px;padding:28px 20px;border-radius:10px;background:#17171b;text-align:center}
#state-title{font-size:.95rem;font-weight:700;word-break:keep-all}
#state-body{max-width:460px;color:#8e8e99;font-size:.84rem;line-height:1.55;word-break:keep-all}
#retry{margin-top:8px;height:36px;padding:0 16px;border-radius:6px;background:rgba(120,120,128,.38);font-size:.9rem;font-weight:650}
#retry:hover{background:rgba(120,120,128,.54)}
footer{margin-top:14px;color:#8e8e99;font-size:.74rem;line-height:1.5;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:640px){.tools{width:100%}.segment{flex:1}.segment button{flex:1}#list,.skel{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-auto-flow:row}.skel span:nth-child(n+5){display:none}.item{grid-template-columns:44px minmax(0,1fr) auto;gap:10px;min-height:62px}.rank{font-size:2rem}}
</style><section id="boxoffice" aria-labelledby="heading">
<header class="head"><div><h2 id="heading">국내 박스오피스</h2><p id="range"></p></div><div class="tools"><div class="segment" role="group" aria-label="집계 기간"><button type="button" data-period="day">일간</button><button type="button" data-period="week">주간</button></div><button type="button" id="refresh" class="icon" aria-label="다시 확인" title="다시 확인">${ICON.refresh}</button></div></header>
<p class="scope">${ICON.info}<span>국내 극장에서 상영된 한국·외국 영화의 관객 수 순위예요. OTT 시청 순위가 아니며, 선택하면 MOA에서 같은 제목을 검색해요.</span></p>
<div id="panel" aria-live="polite">
<div id="skel" class="skel" aria-hidden="true" hidden><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
<div id="state" hidden><p id="state-title"></p><p id="state-body"></p><button type="button" id="retry" hidden>다시 시도</button></div>
<ol id="list" aria-label="관객 수 순위"></ol></div>
<footer><p>자료: 영화진흥위원회 영화관입장권 통합전산망(KOBIS) · 관객 수는 집계 시점 기준이며 이후 바뀔 수 있어요.</p></footer></section>`;
const $=s=>document.querySelector(s),DATE=/^\d{4}-\d{2}-\d{2}$/,STATUSES=['ready','restricted','unconfigured','unavailable'];
const kst=(date,options)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',...options}).format(new Date(date+'T12:00:00+09:00'));
const validDate=d=>typeof d==='string'&&DATE.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const count=n=>Number.isSafeInteger(n)&&n>=0;
const compact=new Intl.NumberFormat('ko-KR',{notation:'compact',maximumFractionDigits:1}),full=new Intl.NumberFormat('ko-KR');
const setText=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
let period='day',generation=0;
function state(title,body,retry){$('#state').hidden=false;$('#state-title').textContent=title;$('#state-body').textContent=body;$('#state-body').hidden=!body;$('#retry').hidden=!retry;}
function change(x){
 if(x.isNew)return[setText('span','NEW','change new'),'신규 진입'];
 if(x.change===null)return[setText('span','','change'),''];
 if(x.change===0)return[setText('span','–','change'),'순위 변동 없음'];
 return x.change>0?[setText('span',`▲${x.change}`,'change up'),`${x.change}계단 상승`]:[setText('span',`▼${-x.change}`,'change down'),`${-x.change}계단 하락`];
}
function render(items){
 const list=$('#list');list.replaceChildren();
 for(const x of items){
  const li=document.createElement('li'),b=document.createElement('button'),body=setText('span','','body'),meta=document.createElement('small'),side=setText('span','','side'),go=document.createElement('span'),[mark,spoken]=change(x);
  meta.append(setText('b',`${compact.format(x.audience)}명`),` · 누적 ${compact.format(x.totalAudience)}명`);body.append(setText('strong',x.title),meta);
  go.className='go';go.innerHTML=ICON.search;side.append(mark,go);mark.setAttribute('aria-hidden','true');
  b.type='button';b.className='item'+(x.rank<=3?' top':'');b.append(setText('span',String(x.rank),'rank'),body,side);
  b.setAttribute('aria-label',`${x.rank}위 ${x.title} MOA에서 검색`);
  b.setAttribute('aria-description',[`${period==='day'?'일간':'주간'} 관객 ${full.format(x.audience)}명`,`누적 ${full.format(x.totalAudience)}명`,spoken].filter(Boolean).join(', '));
  b.onclick=()=>moa.app.navigate('/search?q='+encodeURIComponent(x.title)).catch(()=>state('검색 화면을 열지 못했어요.','',false));li.append(b);list.append(li);
 }
}
async function load(){
 const seq=++generation,requested=period;
 document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.period===requested)));
 render([]);$('#state').hidden=true;$('#range').textContent=requested==='day'?'어제 · 한국 시간(KST)':'지난주 월–일 · 한국 시간(KST)';$('#skel').hidden=false;$('#panel').setAttribute('aria-busy','true');
 try{
  if(typeof moa.discovery?.boxOffice!=='function')throw Error('host-update');
  const r=await moa.discovery.boxOffice({period:requested});if(seq!==generation)return;
  if(!r||r.provider!=='kobis'||r.period!==requested||!STATUSES.includes(r.status)||!validDate(r.from)||!validDate(r.through)||r.from>r.through||requested==='day'&&r.from!==r.through||!Array.isArray(r.items))throw Error('invalid');
  if(r.status!=='ready'){state(...{restricted:['이 프로필에서는 박스오피스를 표시하지 않아요.','키즈 프로필 등 제한된 프로필에서는 극장 순위를 숨겨요.',false],unconfigured:['박스오피스는 관리자 설정 후 이용할 수 있어요.','MOA 관리자가 영화진흥위원회 자료 연결을 설정하면 순위가 표시돼요.',false],unavailable:['지금은 박스오피스를 가져올 수 없어요.','영화진흥위원회 서비스 응답이 없어요. 잠시 후 다시 시도해 주세요.',true]}[r.status]);return;}
  const ids=new Set(),ranks=new Set(),items=r.items.slice(0,10).filter(x=>x&&typeof x.id==='string'&&/^\d{1,12}$/.test(x.id)&&!ids.has(x.id)&&Number.isSafeInteger(x.rank)&&x.rank>=1&&x.rank<=10&&!ranks.has(x.rank)&&typeof x.title==='string'&&x.title.trim()&&x.title.length<=200&&count(x.audience)&&count(x.totalAudience)&&(x.change===null||Number.isSafeInteger(x.change))&&typeof x.isNew==='boolean'&&ids.add(x.id)&&ranks.add(x.rank)).sort((a,b)=>a.rank-b.rank);
  if(!items.length){state('이 기간의 순위가 아직 없어요.','집계가 끝나면 영화진흥위원회 자료로 순위를 보여 드릴게요.',true);return;}
  render(items);$('#range').textContent=requested==='day'?`${kst(r.through,{month:'long',day:'numeric',weekday:'short'})} 하루 · 한국 시간(KST)`:`${kst(r.from,{month:'long',day:'numeric'})} – ${kst(r.through,{month:'long',day:'numeric'})} 주간 · 한국 시간(KST)`;
 }catch{if(seq!==generation)return;render([]);state('박스오피스를 불러오지 못했어요.','플러그인 지원 버전과 연결 상태를 확인한 뒤 다시 시도해 주세요.',true);}
 finally{if(seq===generation){$('#skel').hidden=true;$('#panel').removeAttribute('aria-busy');}}
}
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{if(period===b.dataset.period)return;period=b.dataset.period;void load();});
$('#refresh').onclick=$('#retry').onclick=()=>void load();
let resizePending=false,lastHeight=0;new ResizeObserver(()=>{if(resizePending)return;resizePending=true;requestAnimationFrame(()=>{resizePending=false;const h=Math.max(120,Math.min(1200,Math.ceil($('#boxoffice').getBoundingClientRect().height)));if(h!==lastHeight){lastHeight=h;moa.ui.resize(h).catch(()=>{});}});}).observe($('#boxoffice'));void load();
