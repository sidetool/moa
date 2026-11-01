import { DEFAULT_PLAYER_SHORTCUTS, type Settings as ProfileSettings } from '@moa/shared';
import { SubtitleStyleControls } from '../src/features/settings/SubtitleStyleControls';
import { EpisodeDownloadButton, MovieDownloadButton } from '../src/features/title/ServerSave';
import { PlayerShortcutSettings } from '../src/features/settings/PlayerShortcutSettings';
import { NextEpisodeLeadSetting } from '../src/features/settings/PlaybackAdvancedSettings';
import { QualityControl, ServerControl } from '../src/player/playback/QualityControl';
import { useId, useRef, useState } from 'react';
import { Check, FastForward, RefreshCw, Settings, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, EmptyState, IconButton, NumberStepper, PasswordInput, ProgressBar, SegmentedControl, Select, Skeleton, Spinner, Toggle } from '../src/components/ui';

export function ButtonsPreview() {
  const [message, setMessage] = useState('');
  return <div className="preview-stack">
    <div className="preview-row">{(['primary', 'secondary', 'ghost', 'accent'] as const).map(variant => <Button key={variant} variant={variant} onClick={() => setMessage(`${variant} 선택됨`)}>{variant}</Button>)}</div>
    <div className="preview-row"><Button size="l" icon={<Check size={20} />} onClick={() => setMessage('저장됨')}>변경 저장</Button><Button disabled>사용 불가</Button><Button disabled aria-busy="true" icon={<Spinner size={16} />}>저장 중</Button><IconButton label="설정" onClick={() => setMessage('설정 선택됨')}><Settings size={20} /></IconButton></div>
    <p className="preview-status" role="status">{message || '버튼을 선택하세요.'}</p>
  </div>;
}

export function FieldsPreview() {
  const id = useId();
  const [selected, setSelected] = useState([1, 2]);
  return <div className="preview-grid">
    <label className="preview-field">프로필 이름<input className="input" placeholder="이름" /></label>
    <div className="preview-field"><label htmlFor={`${id}-password`}>비밀번호</label><PasswordInput id={`${id}-password`} className="input" defaultValue="preview-password" autoComplete="off" /></div>
    <div className="preview-field"><label htmlFor={`${id}-invalid`}>제목</label><input id={`${id}-invalid`} className="input" aria-invalid="true" aria-describedby={`${id}-error`} defaultValue="" /><p id={`${id}-error`} className="preview-error">제목을 입력하세요.</p></div>
    <label className="preview-field">읽기 전용<input className="input" value="MOA" readOnly /></label>
    <label className="preview-field">비활성<input className="input" value="사용 불가" disabled readOnly /></label>
    <div className="preview-stack">
      <label className="preview-row"><input type="checkbox" checked={selected.length === 2} ref={input => { if (input) input.indeterminate = selected.length === 1; }} onChange={event => setSelected(event.target.checked ? [1, 2] : [])} />전체 선택</label>
      {[1, 2].map(item => <label className="preview-row" key={item}><input type="checkbox" checked={selected.includes(item)} onChange={event => setSelected(event.target.checked ? [...selected, item] : selected.filter(value => value !== item))} />항목 {item}</label>)}
    </div>
  </div>;
}

const options = [{ value: 'ko', label: '한국어' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }];
export function SelectPreview() {
  const [language, setLanguage] = useState('ko');
  const [selected, setSelected] = useState(['ko']);
  const [longValue, setLongValue] = useState('long');
  return <div className="preview-stack"><div className="preview-grid">
    <div className="preview-field"><span>자막 언어</span><Select aria-label="자막 언어" value={language} options={options} onChange={setLanguage} /></div>
    <div className="preview-field"><span>검색할 언어</span><Select aria-label="검색할 언어" multiple value={selected} options={options} onChange={setSelected} /></div>
    <div className="preview-field"><span>사용할 수 없는 선택</span><Select aria-label="사용할 수 없는 선택" disabled value="ko" options={options} onChange={() => {}} /></div>
    <div className="preview-field"><span>긴 항목</span><Select aria-label="긴 항목" value={longValue} options={[{ value: 'long', label: '여러 언어가 포함된 긴 자막 이름 · Original subtitles with accessibility descriptions' }, { value: 'short', label: '한국어' }]} onChange={setLongValue} /></div>
  </div><p className="preview-status" role="status">자막: {language} · 검색: {selected.join(', ') || '없음'}</p></div>;
}

export function TogglePreview() {
  const [checked, setChecked] = useState(true);
  return <div className="preview-stack"><div className="preview-row"><span>다음 화 자동 재생</span><Toggle label="다음 화 자동 재생" checked={checked} onChange={setChecked} /></div><div className="preview-row"><span>사용 불가</span><Toggle label="사용 불가" checked={false} disabled onChange={() => {}} /></div></div>;
}

export function FeedbackPreview() {
  const [failed, setFailed] = useState(true);
  return <div className="preview-stack">
    <div className="preview-row"><Spinner size={20} /><span>불러오는 중</span></div>
    <ProgressBar ratio={0.6} />
    <Skeleton className="preview-skeleton" />
    <EmptyState title={failed ? '목록을 불러오지 못했어요.' : '표시할 작품이 없어요.'} action={<Button icon={<RefreshCw size={16} />} onClick={() => setFailed(false)}>다시 시도</Button>} />
  </div>;
}

export function ConfirmationPreview() {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  return <div className="preview-stack"><div className="preview-row"><Button icon={<Trash2 size={18} />} onClick={() => setOpen(true)}>선택 항목 삭제</Button><Button onClick={() => setRemoved(false)} disabled={!removed}>초기화</Button></div><p role="status" className="preview-status">{removed ? '미리보기 항목을 삭제했어요.' : '선택 항목 1개'}</p>{open && <ConfirmDialog title="선택한 항목을 삭제할까요?" confirmLabel="삭제" onClose={() => setOpen(false)} onConfirm={() => { setRemoved(true); setOpen(false); }}>미리보기에서만 적용됩니다.</ConfirmDialog>}</div>;
}

// The real .sheet styles inside a frame as tall as the sheet on a 667×320 landscape phone.
export function SheetPreview() {
  const [height, setHeight] = useState<'normal' | 'short'>('short');
  const [name, setName] = useState(''), [picked, setPicked] = useState('');
  return <div className="preview-stack">
    <SegmentedControl label="시트 미리보기 화면" value={height} options={[{ value: 'normal', label: '보통 화면' }, { value: 'short', label: '낮은 가로 화면' }]} onChange={setHeight} />
    <div className={`preview-sheet-screen${height === 'short' ? ' is-short' : ''}`}>
      <section className="sheet" aria-label="폴더 선택 미리보기">
        <header className="sheet-head"><h2>폴더 선택</h2></header>
        <ul className="preview-sheet-list">{['애니', '드라마', '영화', '다큐멘터리', '예능', '기타'].map(item => <li key={item}>{item}</li>)}</ul>
        <div className="preview-sheet-fields"><label className="field"><span>이름 (선택)</span><input className="input" value={name} placeholder="media" onChange={event => setName(event.target.value)} /></label></div>
        <footer className="sheet-foot"><span className="sheet-path">/media</span><Button variant="primary" onClick={() => setPicked(name.trim() || 'media')}>이 폴더 추가</Button></footer>
      </section>
    </div>
    <p role="status" className="preview-status">{picked ? `${picked} 폴더를 추가했어요.` : '낮은 화면에서는 시트를 스크롤해 확인 버튼까지 이동합니다.'}</p>
  </div>;
}

export function FormPattern() {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(''), [error, setError] = useState(false), [saved, setSaved] = useState('');
  const [autoplay, setAutoplay] = useState(true);
  return <form className="preview-stack" noValidate onSubmit={event => {
    event.preventDefault();
    const valid = Boolean(name.trim());
    setError(!valid);
    setSaved(valid ? `${name.trim()} 저장됨` : '');
    if (!valid) input.current?.focus();
  }}>
    <div className="preview-field"><label htmlFor={`${id}-name`}>프로필 이름</label><input ref={input} id={`${id}-name`} className="input" value={name} onChange={event => setName(event.target.value)} required aria-invalid={error || undefined} aria-describedby={error ? `${id}-error` : undefined} />{error && <p className="preview-error" id={`${id}-error`}>이름을 입력하세요.</p>}</div>
    <div className="preview-row"><span>다음 화 자동 재생</span><Toggle label="프로필 다음 화 자동 재생" checked={autoplay} onChange={setAutoplay} /></div>
    <div className="preview-row"><Button type="submit" variant="primary">프로필 저장</Button><Button type="button" onClick={() => { setName(''); setError(false); setSaved(''); input.current?.focus(); }}>초기화</Button></div><p className="preview-status" role="status">{saved || '입력한 내용은 미리보기에만 저장됩니다.'}</p>
  </form>;
}

export function FilterPattern() {
  const [query, setQuery] = useState(''), [language, setLanguage] = useState('all');
  const entries = [{ name: '한국어 자막', language: 'ko' }, { name: 'English subtitles', language: 'en' }, { name: '日本語字幕', language: 'ja' }];
  const filtered = entries.filter(entry => (language === 'all' || entry.language === language) && entry.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="preview-stack"><div className="preview-grid"><label className="preview-field">제목 검색<input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="preview-field"><span>언어</span><Select aria-label="목록 언어" value={language} options={[{ value: 'all', label: '전체' }, ...options]} onChange={setLanguage} /></div></div><p className="preview-status" role="status">{filtered.length}개</p>{filtered.length ? <ul className="preview-results">{filtered.map(entry => <li key={entry.language}>{entry.name}</li>)}</ul> : <EmptyState title="검색 결과가 없어요." />}<div className="preview-row"><Button onClick={() => { setLanguage('all'); setQuery(''); }}>조건 초기화</Button></div></div>;
}

export function SegmentedPreview() {
  const [value, setValue] = useState('popular');
  return <div className="preview-stack"><SegmentedControl label="목록 정렬" value={value} options={[{ value: 'popular', label: '인기' }, { value: 'latest', label: '최신' }]} onChange={setValue} /><SegmentedControl label="사용할 수 없는 정렬" value="popular" disabled options={[{ value: 'popular', label: '인기' }, { value: 'latest', label: '최신' }]} onChange={() => {}} /></div>;
}

export function PlayerFeedbackPreview() {
  return <div className="preview-player-frame" aria-label="플레이어 배속 배지 위치">
    <span>영상 영역</span>
    <div className="player-boost" role="status"><FastForward size={18} />2배속</div>
  </div>;
}

export function PlayerShortcutsPreview() {
  const [shortcuts, setShortcuts] = useState(DEFAULT_PLAYER_SHORTCUTS);
  return <div className="preview-shortcuts"><PlayerShortcutSettings shortcuts={shortcuts} save={async value => { setShortcuts(value); }} /></div>;
}

export function SubtitleCompatibilityPreview() {
  const [settings, setSettings] = useState<ProfileSettings>({ groupHistory: true, autoplayNext: true, autoplayDelay: 5, defaultSubtitleLang: 'ko', subtitleSize: 'large', subtitleScale: 150, subtitleShadow: 3, preferredQuality: 'auto', hardwareTranscoding: true, autoFetchSubtitles: false, experimentalSubtitleSync: false, translationMode: 'manual', translationSourcePriority: 'site', skipSubtitleSearchWithSiteTrack: true, skipTranslationWithoutSubtitles: true });
  return <SubtitleStyleControls format="ass" settings={settings} save={patch => setSettings(previous => ({ ...previous, ...patch }))} />;
}

export function DownloadVisibilityPreview() {
  const [enabled, setEnabled] = useState(false), [message, setMessage] = useState('');
  const entry = { pending: false };
  return <div className="preview-stack">
    <div className="preview-row"><span>서버 다운로드 사용</span><Toggle label="미리보기 서버 다운로드 사용" checked={enabled} onChange={value => { setEnabled(value); setMessage(''); }} /></div>
    <div className="preview-row"><span>1화</span>{enabled && <EpisodeDownloadButton title="1화" entry={entry} onStart={() => setMessage('회차 다운로드 선택됨')} />}</div>
    {enabled && <MovieDownloadButton entry={entry} onStart={() => setMessage('영화 다운로드 선택됨')} />}
    <p className="preview-status" role="status">{message || '이 설정은 미리보기에만 적용됩니다.'}</p>
  </div>;
}

export function NumberStepperPreview() {
  const [seconds, setSeconds] = useState(90), [note, setNote] = useState('');
  return <div className="preview-stack">
    <div className="preview-row"><span>안내 시점</span><NumberStepper label="미리보기 안내 시점" unit="초" min={0} max={600} step={10} value={seconds} onChange={(value, { clamped }) => { setSeconds(value); setNote(clamped ? '범위에 맞춰 조정됨' : ''); }} /></div>
    <div className="preview-row"><span>사용 불가</span><NumberStepper label="사용할 수 없는 시점" unit="초" min={0} max={600} value={30} disabled onChange={() => {}} /></div>
    <p className="preview-status" role="status">{seconds}초{note && ` · ${note}`}</p>
  </div>;
}

export function NextEpisodeLeadPattern() {
  const [lead, setLead] = useState(90), [autoplay, setAutoplay] = useState(true), [fail, setFail] = useState(false);
  const save = (value: number) => new Promise<void>((resolve, reject) => setTimeout(() => { if (fail) reject(new Error('preview')); else { setLead(value); resolve(); } }, 300));
  return <div className="preview-stack">
    <div className="preview-settings"><NextEpisodeLeadSetting value={lead} autoplay={autoplay} delay={5} save={save} /></div>
    <div className="preview-row"><span>다음 화 자동 재생</span><Toggle label="미리보기 다음 화 자동 재생" checked={autoplay} onChange={setAutoplay} /></div>
    <div className="preview-row"><span>저장 실패 재현</span><Toggle label="미리보기 저장 실패 재현" checked={fail} onChange={setFail} /></div>
  </div>;
}

// Sample server names only; real labels come from each source extension.
const QUALITY_CASES = {
  hls: { levels: [{ index: 0, height: 360 }, { index: 1, height: 720 }, { index: 2, height: 1080 }, { index: 3, height: 0 }], streams: undefined },
  servers: { levels: [], streams: [{ id: '0', label: '서버 A', height: 1080 }, { id: '1', label: '서버 A', height: 720 }, { id: '2', label: '서버 B · 720p', height: 720 }, { id: '3', label: '서버 C' }] },
  single: { levels: [], streams: [{ id: '0', label: '서버 A' }, { id: '1', label: '서버 B' }] },
} as const;

export function PlayerQualityPreview() {
  const [scenario, setScenario] = useState<keyof typeof QUALITY_CASES>('hls');
  const [level, setLevel] = useState(-1), [streamId, setStreamId] = useState('0');
  const { levels, streams } = QUALITY_CASES[scenario];
  const stream = streams?.find(item => item.id === streamId);
  const playing = scenario === 'hls' ? levels.find(item => item.index === level)?.height ?? 720 : stream && 'height' in stream ? stream.height : 1080;
  return <div className="preview-stack">
    <SegmentedControl label="화질 미리보기 상황" value={scenario} options={[{ value: 'hls', label: 'HLS 화질' }, { value: 'servers', label: '서버별 해상도' }, { value: 'single', label: '해상도 정보 없음' }]}
      onChange={value => { setScenario(value); setLevel(-1); setStreamId('0'); }} />
    <div className="preview-player-panel panel-form">
      <QualityControl levels={levels} level={level} onLevel={setLevel} streams={streams} streamId={streamId} onStream={setStreamId} playingHeight={playing} transcode={false} />
      <ServerControl streams={streams} streamId={streamId} onStream={setStreamId} />
    </div>
  </div>;
}
