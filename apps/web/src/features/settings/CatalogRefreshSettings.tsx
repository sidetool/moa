import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Select } from '../../components/ui';
import { api } from '../../lib/api';

const configKey = ['catalog-refresh'] as const;
type RefreshSettings = { intervalMinutes: number };
export const refreshOptions = [
  { value: '15', label: '자주' }, { value: '60', label: '기본' }, { value: '360', label: '드물게' },
];

export function CatalogRefreshSettings() {
  const client = useQueryClient();
  const config = useQuery({ queryKey: configKey, queryFn: ({ signal }) => api<RefreshSettings>('/admin/catalog-refresh', { signal }) });
  const save = useMutation({
    mutationFn: (intervalMinutes: number) => api<RefreshSettings>('/admin/catalog-refresh', { method: 'PATCH', body: { intervalMinutes } }),
    onSuccess: value => client.setQueryData(configKey, value),
  });
  const value = String((save.isPending ? save.variables : config.data?.intervalMinutes) ?? 60);
  const options = refreshOptions.some(option => option.value === value) ? refreshOptions : [...refreshOptions, { value, label: '사용자 지정' }];
  return <>
    <div className="setting"><span className="setting-icon"><RefreshCw size={20} /></span><div><b>정보 갱신 빈도</b></div>
      <Select aria-label="정보 갱신 빈도" value={value} options={options} disabled={!config.data || save.isPending} onChange={next => save.mutate(Number(next))} />
    </div>
    {config.isError && <p className="settings-error" role="alert">갱신 설정을 불러오지 못했어요. <button className="text-btn" onClick={() => void config.refetch()}>다시 시도</button></p>}
    {save.isError && <p className="settings-error" role="alert">갱신 설정을 저장하지 못했어요. <button className="text-btn" onClick={() => save.mutate(save.variables)}>다시 시도</button></p>}
  </>;
}
