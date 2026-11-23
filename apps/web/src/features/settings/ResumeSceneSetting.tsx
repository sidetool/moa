import { useState } from 'react';
import { Toggle } from '../../components/ui';

const label = '이어보기에 마지막 장면 표시';

export function ResumeSceneSetting({ checked, save }: { checked: boolean; save: (enabled: boolean) => Promise<void> }) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const change = async (enabled: boolean) => {
    setStatus('saving');
    try {
      await save(enabled);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };
  return <div className="settings-card">
    <div className="setting">
      <div><b>{label}</b>{status === 'error' && <small className="settings-error" role="alert">저장하지 못했어요. 다시 시도해 주세요.</small>}</div>
      <Toggle label={label} checked={checked} aria-disabled={status === 'saving'} onChange={value => void change(value)} />
    </div>
  </div>;
}
