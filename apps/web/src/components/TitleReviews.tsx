import {useEffect,useState} from 'react';
import {ChevronDown,ExternalLink} from 'lucide-react';
import type {ReviewResponse,ReviewProvider,ReviewItem} from '@moa/shared';
import {useReviewSource} from '../lib/review-hooks';
import {Button} from './ui';
import tmdbLogo from '../assets/tmdb.svg';
const names={naver:'네이버 블로그',kakao:'다음 블로그',tmdb:'해외 사용자 리뷰'};
const statuses=['ready','unconfigured','unlinked','restricted','unavailable'];
export function safeReviewLink(value:unknown):value is string {
  try{const u=new URL(String(value));return typeof value==='string'&&value.length<=2048&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.hostname.includes('.');}catch{return false;}
}
export function parseReviews(raw:any,mediaId:string,provider:ReviewProvider):ReviewResponse {
  if(!raw||raw.mediaId!==mediaId||raw.provider!==provider||!statuses.includes(raw.status)||typeof raw.query!=='string'||raw.query.length>250||!Array.isArray(raw.items))throw Error('invalid-reviews');
  const items:ReviewItem[]=[],seen=new Set<string>();
  if(raw.status==='ready')for(const x of raw.items.slice(0,8)){
    if(!x||!safeReviewLink(x.url)||seen.has(x.url)||!['article','review'].includes(x.kind)||!['title','excerpt','author','date'].every(k=>typeof x[k]==='string'))continue;
    if(provider==='tmdb'&&!/^https:\/\/(?:www\.)?themoviedb\.org\/review\/[a-zA-Z0-9]+$/.test(x.url))continue;
    seen.add(x.url);items.push({url:x.url,title:x.title.slice(0,200),excerpt:x.excerpt.slice(0,600),author:x.author.slice(0,100),date:x.date.slice(0,40),kind:x.kind,language:'unknown'});
  }
  return {mediaId,provider,status:raw.status,query:raw.query,items};
}
function ReviewPanel({mediaId}:{mediaId:string}){
  const source=useReviewSource();
  const [open,setOpen]=useState(false),[provider,setProvider]=useState<ReviewProvider>('naver'),[retry,setRetry]=useState(0);
  const [result,setResult]=useState<ReviewResponse|null>(null),[error,setError]=useState(false);
  useEffect(()=>{
    setResult(null);setError(false);if(!open||!source)return;
    const controller=new AbortController();
    source.request({mediaId,provider},controller.signal).then(x=>parseReviews(x,mediaId,provider)).then(x=>{if(!controller.signal.aborted)setResult(x);}).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[source,mediaId,provider,open,retry]);
  if(!source)return null;
  const search=result?.query||'',naver=`https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(search)}`,daum=`https://search.daum.net/search?w=blog&q=${encodeURIComponent(search)}`;
  return <section className="title-reviews" aria-label="리뷰 모아보기">
    <button className="review-heading" aria-expanded={open} onClick={()=>setOpen(!open)}><span>리뷰 모아보기</span><span className="review-heading-aside">한국어 리뷰 · 해외 반응 <ChevronDown size={18} style={{transform:open?'rotate(180deg)':undefined}}/></span></button>
    {!open&&<p className="review-hint">다른 사람들은 어떻게 봤을까요? 펼치면 스포일러가 포함된 제목이 보일 수 있어요.</p>}
    {open&&<div className="review-body">
      <div className="review-toolbar"><div className="review-filters" role="group" aria-label="리뷰 출처">{(Object.keys(names) as ReviewProvider[]).map(p=><button key={p} aria-pressed={provider===p} onClick={()=>{setResult(null);setProvider(p);}}>{names[p]}</button>)}</div><Button variant="ghost" onClick={()=>setRetry(x=>x+1)}>다시 확인</Button></div>
      <p className="review-hint">{provider==='tmdb'?'TMDB에 작성된 리뷰예요. 한국 이용자의 평가나 국내 순위를 뜻하지 않아요.':'제목으로 찾은 블로그 글이에요. 다른 작품이나 광고성 글이 섞일 수 있어요.'} 내용은 펼쳐서 확인하세요.</p>
      <div aria-live="polite">{error?<p role="alert">리뷰를 불러오지 못했어요. 다시 확인해 주세요.</p>:!result?<p>리뷰를 찾고 있어요…</p>:result.status==='restricted'?<p>이 프로필에서는 외부 리뷰를 표시하지 않아요.</p>:<>
        {result.status==='unconfigured'&&<p className="review-empty">{provider==='tmdb'?'TMDB가 연결되지 않았어요.':'블로그 검색이 아직 연결되지 않았어요. 아래에서 이 작품의 한국어 리뷰를 바로 검색할 수 있어요.'}</p>}
        {result.status==='unlinked'&&<p>작품의 메타데이터를 연결하면 사용자 리뷰를 볼 수 있어요.</p>}
        {result.status==='unavailable'&&<p>지금은 리뷰를 가져올 수 없어요. 잠시 후 다시 확인해 주세요.</p>}
        {result.status==='ready'&&!result.items.length&&<p>이 출처에서 찾은 리뷰가 없어요. 다른 출처도 확인해 보세요.</p>}
        <div className="review-list">{result.items.map(x=><article key={`${provider}:${x.url}`} className="review-entry"><div className="review-byline">{x.kind==='article'?'블로그 글':'사용자 리뷰'}{x.author&&` · ${x.author}`}</div><a className="review-title" href={x.url} target="_blank" rel="noopener noreferrer">{x.title} <ExternalLink size={14}/></a>{x.excerpt&&<details><summary>내용 일부 보기 · 스포일러 주의</summary><p>{x.excerpt}</p><a href={x.url} target="_blank" rel="noopener noreferrer">원문 전체 읽기 ↗</a>{provider==='tmdb'&&<a className="review-translate" href={`https://translate.google.com/translate?sl=auto&tl=ko&u=${encodeURIComponent(x.url)}`} target="_blank" rel="noopener noreferrer">Google 번역으로 원문 열기 ↗</a>}</details>}</article>)}</div>
        {search&&provider!=='tmdb'&&<div className="review-search-links"><a href={naver} target="_blank" rel="noopener noreferrer">네이버에서 한국어 리뷰 검색 ↗</a><a href={daum} target="_blank" rel="noopener noreferrer">다음에서 검색 ↗</a></div>}
      </>}</div>
      {provider==='tmdb'&&<footer className="review-attribution"><img src={tmdbLogo} alt="TMDB" width="64"/><span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span></footer>}
    </div>}
  </section>;
}
export function TitleReviews({mediaId}:{mediaId:string}){
  const source=useReviewSource();
  return source?<ReviewPanel key={`${mediaId}:${source.id}`} mediaId={mediaId}/>:null;
}
