import { useEffect, useId, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { Settings } from '@moa/shared';
import { useSaveSettings } from '../../api/queries';
import { currentProfileId } from '../../lib/api';
import { Button, NumberStepper } from '../../components/ui';
import { SettingsDisclosure } from './SettingsDisclosure';

const MAX_LEAD = 600;
const SAVE_DELAY_MS = 600;

const span = (seconds: number) => {
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return minutes ? `${minutes}분${rest ? ` ${rest}초` : ''}` : `${rest}초`;
};

function leadSummary(lead: number) {
  return lead ? `다음 화 안내 · 끝나기 ${span(lead)} 전` : '다음 화 안내 · 영상이 끝난 뒤';
}

/** What the chosen lead means with this profile's autoplay settings, in plain words. */
function leadOutcome(lead: number, autoplay: boolean, delay: number) {
  if (!autoplay) return lead ? `끝나기 ${span(lead)} 전에 다음 화 카드를 띄워요. 자동 재생이 꺼져 있어 직접 눌러야 넘어가요.` : '자동 재생이 꺼져 있어 영상이 끝나면 다음 화를 직접 골라요.';
  if (!lead) return `영상이 끝나면 다음 화 카드를 띄우고 ${delay}초 뒤 재생해요.`;
  // The countdown runs its full delay from when the card appears, even past the end of the video.
  if (lead > delay) return `끝나기 ${span(lead)} 전에 카드를 띄우고, ${span(lead - delay)} 남았을 때 다음 화로 넘어가요.`;
  return lead === delay
    ? `끝나기 ${span(lead)} 전에 카드를 띄우고, 영상이 끝나면 바로 다음 화로 넘어가요.`
    : `끝나기 ${span(lead)} 전에 카드를 띄우고, 영상이 끝나고 ${span(delay - lead)} 뒤 다음 화로 넘어가요.`;
}

type Status = { kind: 'saved' } | { kind: 'clamped' } | { kind: 'error'; value: number } | null;

/** Collapsed playback options that most profiles never change. */
export function PlaybackAdvancedSettings({ settings: s }: { settings: Settings }) {
  const saveSettings = useSaveSettings();
  const saved = Number.isInteger(s.nextEpisodeLeadSeconds) ? Math.min(MAX_LEAD, Math.max(0, s.nextEpisodeLeadSeconds!)) : 0;
  // The save below targets whichever profile is current when it runs, so a delayed save
  // from before a profile switch is dropped instead of landing on the new profile.
  const profile = currentProfileId();
  const save = (nextEpisodeLeadSeconds: number) => currentProfileId() === profile ? saveSettings({ nextEpisodeLeadSeconds }) : Promise.resolve();
  return (
    <SettingsDisclosure id="playback-advanced" title="재생 고급설정" summary={leadSummary(saved)} icon={<SlidersHorizontal size={20} />}>
      <NextEpisodeLeadSetting key={profile ?? ''} value={saved} autoplay={s.autoplayNext !== false} delay={s.autoplayDelay ?? 5} save={save} />
    </SettingsDisclosure>
  );
}

/** Seconds before an unmarked video ends to show the next-episode card. `save` should reject when the value was not kept. */
export function NextEpisodeLeadSetting({ value: saved, autoplay, delay, save }: { value: number; autoplay: boolean; delay: number; save: (value: number) => Promise<unknown> }) {
  // Stepper presses update at once and save together after a short pause.
  const [draft, setDraft] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const timer = useRef<number>(undefined);
  const queued = useRef<number | null>(null);
  // Only the latest change may settle the draft and message; earlier replies arrive too late to matter.
  const generation = useRef(0);
  const outcome = useId();
  const lead = draft ?? saved;

  const flush = () => {
    window.clearTimeout(timer.current);
    const value = queued.current;
    queued.current = null;
    if (value === null) return;
    const request = ++generation.current;
    const latest = () => request === generation.current;
    save(value)
      .then(() => { if (latest()) { setDraft(null); setStatus(current => current?.kind === 'clamped' ? current : { kind: 'saved' }); } })
      .catch(() => { if (latest()) { setDraft(null); setStatus({ kind: 'error', value }); } });
  };
  const change = (value: number, clamped = false) => {
    generation.current++;
    setDraft(value);
    setStatus(clamped ? { kind: 'clamped' } : null);
    queued.current = value;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };
  // Leaving the page right after a press still saves it.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  return <>
    <div className="setting setting-stack setting-next-lead">
      <div>
        <b>엔딩 정보가 없을 때 다음 화 안내</b>
        <small>엔딩 구간을 모르는 영상에서 끝나기 몇 초 전에 다음 화 카드를 띄울지 정해요. 엔딩 정보가 있는 회차는 그 정보에 맞춰 안내해요.</small>
        <small id={outcome} className="setting-outcome" aria-live="polite">{leadOutcome(lead, autoplay, delay)}</small>
      </div>
      <NumberStepper label="다음 화 안내 시점" unit="초" min={0} max={MAX_LEAD} step={10} value={lead} invalid={status?.kind === 'error'}
        aria-describedby={outcome} onChange={(value, { clamped }) => change(value, clamped)} />
    </div>
    {status?.kind === 'error' ? <div className="settings-advanced-note setting-save-error" role="alert">
      <span>{span(status.value)}{span(status.value).endsWith('분') ? '으로' : '로'} 저장하지 못해 이전 값으로 돌려놨어요.</span>
      <Button onClick={() => change(status.value)}>다시 시도</Button>
    </div> : status && <p className="settings-advanced-note settings-hint" role="status">
      {status.kind === 'saved' ? '저장했어요.' : `0초부터 ${span(MAX_LEAD)}까지 정할 수 있어서 가까운 값으로 맞췄어요.`}
    </p>}
  </>;
}
