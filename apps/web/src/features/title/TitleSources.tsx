import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MediaCard, TitleGroup } from '@moa/shared';
import { api } from '../../lib/api';
import { Button } from '../../components/ui';
import { TYPE_LABEL } from '../../lib/format';
export function TitleSources({id,title}:{id:string;title:string}) {
  const client=useQueryClient(), [editing,setEditing]=useState(false),[input,setInput]=useState(title),[term,setTerm]=useState(''),[target,setTarget]=useState<MediaCard|null>(null);
  const group=useQuery({queryKey:['title-group',id],queryFn:()=>api<TitleGroup>(`/media/${id}/group`)});
  const candidates=useQuery({queryKey:['group-candidates',term],queryFn:()=>api<MediaCard[]>(`/media/groups/candidates?q=${encodeURIComponent(term)}`),enabled:!!term});
  const save=useMutation({mutationFn:(body:{action:string;otherId?:string})=>api<TitleGroup>(`/media/${id}/group`,{method:'PATCH',body}),onSuccess:async data=>{client.setQueryData(['title-group',id],data);setTarget(null);await client.invalidateQueries({queryKey:['grouped-cards']});await client.invalidateQueries({queryKey:['title-group']});await client.invalidateQueries({queryKey:['home']});await client.invalidateQueries({queryKey:['watchlist']});}});
  return <section className="title-sources"><div className="source-toolbar"><h2>재생 소스</h2><button className="text-btn" onClick={()=>setEditing(v=>!v)} aria-expanded={editing}>같은 작품 묶기</button></div>
    {group.isError && <p role="alert">소스 정보를 불러오지 못했습니다.</p>}
    <div className="source-directory-links">{group.data?.members.map(m=><Link key={m.id} className={`chip ${m.id===id?'is-active':''}`} to={`/title/${m.id}`} aria-current={m.id===id?'page':undefined}>{m.provider.name}{m.id===id?' · 선택됨':''}</Link>)}</div>
    {(group.data?.members.length || 0)>1 && <p className="source-muted">소스를 바꾸면 해당 소스의 회차와 시청 위치를 보여줍니다.</p>}
    {editing && <div className="group-editor"><p>같은 작품인지 제목·시즌·판본을 확인해 주세요. 묶음은 현재 프로필에만 적용됩니다.</p>
      <ul>{group.data?.members.map(m=><li key={m.id}><span>{m.title} · {m.provider.name} · {m.year || '연도 미상'}</span>{m.id===id && (group.data.members.length>1 || !group.data.manual) && <Button disabled={save.isPending} onClick={()=>save.mutate({action:'separate'})}>이 작품 분리</Button>}</li>)}</ul>
      {group.data?.manual && <Button disabled={save.isPending} onClick={()=>save.mutate({action:'reset'})}>이 작품 자동 묶기로 복원</Button>}
      <form className="source-search-form" onSubmit={e=>{e.preventDefault();setTerm(input.trim());setTarget(null);}}><label className="field"><span>묶을 작품 찾기</span><input value={input} maxLength={200} onChange={e=>setInput(e.target.value)}/></label><Button type="submit">찾기</Button></form>
      <p className="source-muted">MOA에서 이미 둘러본 작품을 검색합니다. 원하는 작품이 없으면 먼저 통합 검색으로 찾아 주세요.</p>
      {candidates.isFetching && <p>검색 중…</p>}{candidates.isError && <p role="alert">검색하지 못했습니다.</p>}
      <ul>{candidates.data?.filter(m=>!group.data?.members.some(g=>g.id===m.id)).map(m=><li key={m.id}><span>{m.title}<small>{m.provider.name} · {TYPE_LABEL[m.type]} · {m.year || '연도 미상'}</small></span><Button onClick={()=>setTarget(m)}>선택</Button></li>)}</ul>
      {term && candidates.isSuccess && !candidates.data?.filter(m=>!group.data?.members.some(g=>g.id===m.id)).length && <p>추가로 묶을 작품을 찾지 못했습니다.</p>}
      {target && <div className="group-confirm"><p>“{target.title}” ({target.provider.name})의 묶음과 합칩니다. 회차와 시청 기록은 각 소스에 유지됩니다.</p><Button variant="primary" disabled={save.isPending} onClick={()=>save.mutate({action:'merge',otherId:target.id})}>같은 작품으로 묶기</Button><Button onClick={()=>setTarget(null)}>취소</Button></div>}
    </div>}
    {save.isError && <p role="alert">묶음을 변경하지 못했습니다.</p>}{save.isSuccess && <p role="status">묶음을 변경했습니다.</p>}
  </section>;
}
