import type { Settings } from '@moa/shared';
import { useEffect, useState } from 'react';
import { Select } from './ui';

function SubtitleNumber({ id, value, min, max, step, save }: { id: string; value: number | null; min: number; max: number; step: number; save: (value: number) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => { setDraft(value === null ? '' : String(value)); }, [value]);
  return <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={draft} placeholder="기본" onChange={event => setDraft(event.target.value)} onBlur={event => {
    if (draft !== '' && event.target.validity.valid) save(Number(draft));
    else setDraft(value === null ? '' : String(value));
  }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

export function SubtitleStyleControls({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => void }) {
  const number = (key: 'subtitleScale' | 'subtitleShadow' | 'subtitleOutline' | 'subtitleHeight' | 'subtitlePadding', label: string, value: number | null, min: number, max: number, step: number, unit: string, reset: number | null) => (
    <div className="subtitle-style-field" key={key}>
      <label htmlFor={key}>{label}</label>
      <div className="subtitle-style-number">
        <SubtitleNumber id={key} value={value} min={min} max={max} step={step} save={next => save({ [key]: next })} />
        <span>{unit}</span>
        <button type="button" className="text-btn" onClick={() => save({ [key]: reset })}>기본</button>
      </div>
    </div>
  );
  return <div className="subtitle-style-controls">
    {number('subtitleScale', '자막 크기', settings.subtitleScale ?? ({ small: 80, medium: 100, large: 130, xlarge: 165 }[settings.subtitleSize ?? 'medium']), 50, 250, 1, '%', null)}
    <div className="subtitle-style-field"><span>배경</span><Select aria-label="자막 배경" value={settings.subtitleBackground ?? 'original'} options={[{ value: 'original', label: '기본' }, { value: 'none', label: '없음' }, { value: 'soft', label: '옅게' }, { value: 'solid', label: '진하게' }]} onChange={value => save({ subtitleBackground: value as Settings['subtitleBackground'] })} /></div>
    {number('subtitleOutline', '자막 윤곽선', settings.subtitleOutline ?? null, 0, 6, .1, 'px', null)}
    {number('subtitleShadow', '자막 그림자', settings.subtitleShadow ?? null, 0, 10, .1, 'px', null)}
    {number('subtitleHeight', '자막 높이', settings.subtitleHeight ?? 0, 0, 40, 1, '%', 0)}
    {number('subtitlePadding', '자막 배경 여백', settings.subtitlePadding ?? 6, 0, 20, 1, 'px', 6)}
    <small className="settings-hint">기본값은 자막 원본 모양을 유지해요. ASS 자막에서 배경을 켜면 그림자 대신 배경 상자가 적용돼요.</small>
  </div>;
}
