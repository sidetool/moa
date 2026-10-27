import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubtitleMemory } from '@moa/shared';
import { api } from '../../lib/api';
import { Button, ConfirmDialog, Select } from '../../components/ui';

const key = ['admin', 'subtitle-memory'];
export function SubtitleMemorySettings() {
  const client = useQueryClient();
  const memory = useQuery({ queryKey: key, queryFn: () => api<SubtitleMemory>('/admin/subtitle-memory') });
  const [amount, setAmount] = useState<string | null>(null);
  const [unit, setUnit] = useState('1');
  const [confirm, setConfirm] = useState(false);
  const change = useMutation({
    mutationFn: (days: number | null) => api<SubtitleMemory>('/admin/subtitle-memory', days === null ? { method: 'DELETE' } : { method: 'PATCH', body: { retentionDays: days } }),
    onSuccess: data => { client.setQueryData(key, data); setAmount(null); setConfirm(false); }
  });
  const value = amount ?? String((memory.data?.retentionDays ?? 90) / Number(unit));
  const days = Number(value) * Number(unit);
  return <section className="settings-group"><h2>자막 선택 기억</h2><div className="settings-card">
    <div className="setting setting-stack"><div><b>보관 기간</b><small>프로필별 선택과 끄기를 {memory.data?.count ?? 0}개 기억하고 있어요. 마지막 선택부터 기간이 지나면 자동으로 지워져요. 추천은 남아 있는 프로필별 선택을 집계해요.</small></div>
      <div className="network-actions retention-controls"><div className="input-unit"><input type="number" className="setting-input" aria-label="자막 선택 보관 기간" min="1" max={Math.floor(3650 / Number(unit))} step="1" value={value} onChange={event => setAmount(event.target.value)} />
        <Select aria-label="자막 선택 보관 단위" value={unit} onChange={next => { setAmount(String(Math.max(1, Math.round(days / Number(next))))); setUnit(next); }} options={[{ value: '1', label: '일' }, { value: '30', label: '개월 (30일)' }]} /></div>
        <Button disabled={change.isPending || !memory.data || !Number.isInteger(Number(value)) || days < 1 || days > 3650 || days === memory.data.retentionDays} onClick={() => change.mutate(days)}>저장</Button>
      </div>
    </div>
    <div className="setting"><div><b>선택 기억 모두 삭제</b><small>모든 프로필의 자막 선택과 추천 집계만 지워요. 자막 파일과 기기별 모양은 유지돼요.</small></div><Button disabled={change.isPending || !memory.data?.count} onClick={() => setConfirm(true)}>모두 삭제</Button></div>
    {(memory.isError || change.isError) && <p className="settings-error" role="alert">자막 기억 설정을 처리하지 못했어요. 다시 시도해 주세요.</p>}
  </div>{confirm && <ConfirmDialog title="자막 선택 기억 모두 삭제" confirmLabel="모두 삭제" busy={change.isPending} onClose={() => setConfirm(false)} onConfirm={() => change.mutate(null)}>모든 프로필의 자막 선택 기억을 삭제할까요? 삭제한 기억은 복구할 수 없어요.</ConfirmDialog>}</section>;
}
