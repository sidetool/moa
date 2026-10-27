import { useState, type KeyboardEvent } from 'react';
import { DEFAULT_PLAYER_SHORTCUTS, PLAYER_SHORTCUT_LABELS, keyboardShortcutKey, playerShortcutLabel, type PlayerShortcutAction, type PlayerShortcuts } from '@moa/shared';
import { Button } from '../../components/ui';

export function PlayerShortcutSettings({ shortcuts, save }: { shortcuts: PlayerShortcuts; save: (value: PlayerShortcuts) => Promise<unknown> }) {
  const [editing, setEditing] = useState<PlayerShortcutAction | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [failed, setFailed] = useState(false);
  const update = async (next: PlayerShortcuts) => {
    setEditing(null); setSaving(true); setError(''); setFailed(false);
    try { await save(next); }
    catch { setError('서버에 저장하지 못했습니다. 다시 시도해 주세요.'); setFailed(true); }
    finally { setSaving(false); }
  };
  const capture = (event: KeyboardEvent<HTMLButtonElement>, action: PlayerShortcutAction) => {
    if (editing !== action) return;
    if (event.code === 'Tab') { setEditing(null); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') { setEditing(null); setError(''); return; }
    const clear = ['Backspace', 'Delete'].includes(event.code) && !event.ctrlKey && !event.altKey && !event.metaKey;
    const key = clear ? null : keyboardShortcutKey(event);
    if (!clear && key === null) { setError('문자·기호·↑·↓ 키 또는 Shift 조합을 눌러 주세요.'); return; }
    const conflict = Object.entries(shortcuts).find(([name, value]) => name !== action && key !== null && value === key);
    if (conflict) { setError(`이미 ${PLAYER_SHORTCUT_LABELS[conflict[0] as PlayerShortcutAction]}에 사용 중입니다.`); return; }
    void update({ ...shortcuts, [action]: key });
  };
  return <section className="settings-group">
    <h2>플레이어 단축키</h2>
    <p className="settings-hint">키를 선택한 뒤 새 키를 눌러 주세요. Esc는 취소, Delete·Backspace는 해제합니다.</p>
    <div className="settings-card">{(Object.keys(PLAYER_SHORTCUT_LABELS) as PlayerShortcutAction[]).map(action => <div className="setting" key={action}>
      <div><b>{PLAYER_SHORTCUT_LABELS[action]}</b></div>
      <Button aria-label={`${PLAYER_SHORTCUT_LABELS[action]} 단축키`} aria-pressed={editing === action} disabled={saving} onClick={() => { setEditing(action); setError(''); }} onBlur={() => setEditing(null)} onKeyDown={event => capture(event, action)}>{editing === action ? '키를 눌러 주세요' : playerShortcutLabel(shortcuts[action]) || '사용 안 함'}</Button>
    </div>)}</div>
    <p className="settings-hint">고정: Space 재생·길게 누르기 배속 · Esc 닫기 · ←/→ 5초 이동 · 0–9 재생 위치</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {failed && <Button disabled={saving} onClick={() => void update(shortcuts)}>다시 저장</Button>}
    <Button disabled={saving || Object.entries(DEFAULT_PLAYER_SHORTCUTS).every(([action, key]) => shortcuts[action as PlayerShortcutAction] === key)} onClick={() => void update({ ...DEFAULT_PLAYER_SHORTCUTS })}>기본 단축키 복원</Button>
  </section>;
}
