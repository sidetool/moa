import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { KeyRound, Trash2 } from 'lucide-react';
import { ApiError } from '../lib/api';
import { cx } from '../lib/format';
import {
  BATCH_SIZE, patchTranslationConfig, translationErrorMessage, translationKeys, translationModels, testTranslationKey, TRANSLATION_MAX_KEYS, useTranslationConfig,
  type TranslationConfig, type TranslationConfigPatch
} from '../api/translation';
import { Button, ConfirmDialog, IconButton, Select, Skeleton } from './ui';

const apiMessage = (error: unknown, fallback: string) => error instanceof ApiError && error.code.startsWith('translation-') ? translationErrorMessage(error.code) : fallback;
const clampBatch = (value: number) => Math.min(BATCH_SIZE.max, Math.max(BATCH_SIZE.min, Math.round(value) || BATCH_SIZE.default));

export function TranslationSettings() {
  const client = useQueryClient();
  const config = useTranslationConfig();
  const { hash } = useLocation();
  const section = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState('');
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [batch, setBatch] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [testing, setTesting] = useState<string[]>([]);
  const [removeKeys, setRemoveKeys] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (hash === '#translation' && config.data) section.current?.scrollIntoView({ block: 'start' });
  }, [hash, Boolean(config.data)]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = useMutation({
    mutationFn: translationModels,
    onSuccess: data => { setModels(data.models); setMessage({ text: `모델 목록을 불러왔어요 · ${data.models.length}개` }); },
    onError: error => setMessage({ text: apiMessage(error, '모델 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'), error: true })
  });
  const save = useMutation({
    mutationFn: (patch: TranslationConfigPatch) => patchTranslationConfig(patch),
    onSuccess: (data, patch) => {
      client.setQueryData<TranslationConfig>(translationKeys.config, data);
      if (patch.provider !== undefined || patch.baseUrl !== undefined) { setEndpoint(null); setModels(null); setCustomModel(''); setMessage({ text: 'API 설정을 저장했어요. 사용할 API 키를 등록해 주세요.' }); }
      else if (patch.model !== undefined) { setCustomModel(''); setMessage(null); }
      else if (patch.addKeys) { setDraft(value => [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].join('\n') === patch.addKeys!.join('\n') ? '' : value); setMessage({ text: `키 ${patch.addKeys.length}개를 저장했어요. 모델 목록을 불러오는 중…` }); loadModels.mutate(); }
      else if (patch.removeKeyIds || patch.clearKey) { setRemoveKeys(null); setMessage({ text: data.keys.length ? '키를 지웠어요.' : '키를 모두 지웠어요. 번역을 사용할 수 없어요.' }); if (!data.keys.length) setModels(null); }
      else if (patch.batchSize !== undefined) { setBatch(null); setMessage({ text: `묶음당 ${data.batchSize}줄로 저장했어요.` }); }
      else setMessage(null);
    },
    onError: (error, patch) => {
      if (patch.batchSize !== undefined) setBatch(null);
      setMessage({ text: apiMessage(error, '저장하지 못했어요. 다시 시도해 주세요.'), error: true });
    }
  });

  const testKey = useMutation({
    mutationFn: async (ids: string[]) => {
      setTesting(ids);
      let error: unknown;
      for (let i = 0; i < ids.length; i += 3) {
        const results = await Promise.allSettled(ids.slice(i, i + 3).map(async id => {
          try {
            const data = await testTranslationKey(id);
            client.setQueryData<TranslationConfig>(translationKeys.config, current => current ? {
              ...current, keys: current.keys.map(key => key.id === id ? data.keys.find(item => item.id === id) ?? key : key)
            } : data);
          } finally { setTesting(current => current.filter(key => key !== id)); }
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') error ??= failed.reason;
      }
      if (error) throw error;
    },
    onMutate: () => setMessage(null),
    onError: error => {
      setMessage({ text: apiMessage(error, '키를 검사하지 못했어요. 다시 시도해 주세요.'), error: true });
      void client.invalidateQueries({ queryKey: translationKeys.config });
    },
    onSettled: () => setTesting([])
  });

  const c = config.data;
  const busy = save.isPending || loadModels.isPending || testKey.isPending;
  const keys = c?.keys ?? [];
  const checked = keys.filter(key => key.test).length;
  const failed = keys.filter(key => key.test?.ok === false).length;
  const lines = [...new Set(draft.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  const room = TRANSLATION_MAX_KEYS - keys.length;
  const tooMany = lines.length > room;
  const options = [...new Set([...(c ? [c.model] : []), ...(models ?? [])])];
  const commitBatch = () => {
    if (batch === null || !c) return;
    const value = clampBatch(Number(batch));
    if (value === c.batchSize) setBatch(null); else save.mutate({ batchSize: value });
  };

  return <section className="settings-group" id="translation" ref={section}>
    <h2>자막 번역</h2>
    <div className="settings-card">
      {config.isPending ? <Skeleton className="folder-sk" /> : config.isError || !c ? <p className="settings-error translation-error" role="alert">번역 설정을 불러오지 못했어요. <button className="text-btn" onClick={() => void config.refetch()}>다시 시도</button></p> : <>
        <div className="setting">
          <div><b>AI 자막 번역</b><small>선택한 AI 서비스로 외국어 자막을 한국어로 번역해요. 요청마다 API 사용료가 발생할 수 있어요.</small></div>
          <button role="switch" aria-checked={c.enabled} aria-label="AI 자막 번역" disabled={!c.configured || busy} className={cx('switch', c.enabled && 'is-on')} onClick={() => save.mutate({ enabled: !c.enabled })}><i /></button>
        </div>

        <div className="setting">
          <div><b>API 방식</b><small>서비스나 주소를 바꾸면 저장된 키가 삭제되고 번역이 꺼져요.</small></div>
          <Select className="setting-select" aria-label="번역 API 방식" value={c.provider} disabled={busy}
            options={[{ value: 'gemini', label: 'Gemini 호환' }, { value: 'openai', label: 'OpenAI 호환' }]}
            onChange={value => { setDraft(''); save.mutate({ provider: value as TranslationConfig['provider'] }); }} />
        </div>
        <div className="setting setting-field">
          <div><b>API 주소</b><small>HTTPS API 또는 로컬·내부 네트워크의 HTTP API 기본 주소를 입력해 주세요. localhost는 MOA 서버를 가리켜요.</small></div>
          <form className="translation-model" onSubmit={event => { event.preventDefault(); if (endpoint !== null && endpoint.trim() !== c.baseUrl) { setDraft(''); save.mutate({ baseUrl: endpoint.trim() }); } }}>
            <input aria-label="번역 API 주소" type="url" value={endpoint ?? c.baseUrl} disabled={busy} required
              onChange={event => setEndpoint(event.target.value)} />
            <Button type="submit" disabled={busy || endpoint === null || endpoint.trim() === c.baseUrl}>주소 저장</Button>
          </form>
        </div>

        <div className="translation-keys">
          <div className="translation-keys-head">
            <div><b>API 키</b><small>등록한 순서대로 쓰고, 한도나 오류로 막히면 다음 키로 넘어가요. 전체 테스트는 최대 3개씩 검사하고 일시적인 오류는 다시 시도해요. 키마다 현재 모델로 한 줄씩 번역하므로 API 사용료가 발생할 수 있어요.</small></div>
            <span className={cx('status-pill', c.configured && 'is-ok')}>{keys.length ? `${keys.length}개` : '없음'}</span>
          </div>
          {keys.length > 0 && <div className="network-actions">
            <small className="translation-key-count" role="status">{testKey.isPending ? `${testKey.variables!.length - testing.length}/${testKey.variables!.length}개 검사 완료…` : checked ? `${checked}개 검사 · 정상 ${checked - failed}개 · 문제 ${failed}개${checked < keys.length ? ` · 미검사 ${keys.length - checked}개` : ''}` : '전체 테스트로 등록한 키를 확인해 주세요.'}</small>
            <Button type="button" disabled={busy} onClick={() => { setMessage(null); setRemoveKeys(keys.map(key => key.id)); }}>전체 삭제</Button>
            <Button type="button" variant="primary" disabled={busy} onClick={() => testKey.mutate(keys.map(key => key.id))}>{testKey.isPending && testKey.variables!.length > 1 ? '전체 검사 중…' : '전체 테스트'}</Button>
          </div>}
          {keys.length > 0 && <ol className="translation-key-list" aria-label="등록된 키">
            {keys.map((key, i) => <li key={key.id} className={cx(key.test?.ok === false && 'is-invalid')}>
              <span className="translation-key-order">{i + 1}</span>
              <KeyRound size={16} aria-hidden="true" />
              <div className="translation-key-content">
                <code>{key.label}</code>
                <small className={cx('translation-key-result', key.test?.ok && 'is-ok')} role="status">{testing.includes(key.id) ? '검사 중…' : key.test ? key.test.ok ? '정상 · 현재 모델로 번역할 수 있어요.' : translationErrorMessage(key.test.error) : '검사하지 않음'}</small>
              </div>
              {key.test?.ok === false && <Button type="button" aria-label={`${i + 1}번 키 다시 검사`} disabled={busy} onClick={() => testKey.mutate([key.id])}>다시 검사</Button>}
              <IconButton label={`${i + 1}번 키 지우기`} disabled={busy} onClick={() => { setMessage(null); setRemoveKeys([key.id]); }}><Trash2 size={16} /></IconButton>
            </li>)}
          </ol>}
          {room > 0 ? <form className="translation-key-add" onSubmit={e => { e.preventDefault(); if (lines.length && !tooMany) save.mutate({ addKeys: lines }); }}>
            <textarea disabled={busy} aria-label="추가할 API 키" name="translation-api-keys" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} rows={Math.min(4, Math.max(1, lines.length + (draft.endsWith('\n') ? 1 : 0)))}
              placeholder={keys.length ? '키 추가 (여러 개는 줄마다 하나씩)' : '선택한 서비스에서 발급한 키 (여러 개는 줄마다 하나씩)'}
              value={draft} onChange={e => { setDraft(e.target.value); setMessage(null); }} />
            <div className="network-actions">
              <small className={cx('translation-key-count', tooMany && 'is-over')}>{tooMany ? `최대 ${TRANSLATION_MAX_KEYS}개까지 · ${room}개 더 추가할 수 있어요` : lines.length ? `${lines.length}개 입력됨` : `최대 ${TRANSLATION_MAX_KEYS}개`}</small>
              <Button type="submit" variant="primary" disabled={!lines.length || tooMany || busy}>{save.isPending && save.variables?.addKeys ? '저장 중…' : '키 저장'}</Button>
            </div>
          </form> : <p className="settings-hint translation-key-full">키는 최대 {TRANSLATION_MAX_KEYS}개까지 등록할 수 있어요. 새 키를 넣으려면 하나를 지워 주세요.</p>}
        </div>

        <div className="setting">
          <div><b>번역 모델</b><small>{c.configured ? '모델 목록에서 고르거나 모델 ID를 직접 입력할 수 있어요.' : '키를 저장하면 모델을 고를 수 있어요.'}</small></div>
          <div className="translation-model">
            <Select className="setting-select" aria-label="번역 모델" value={c.model} disabled={busy}
              options={options.map(model => ({ value: model, label: model }))} onChange={model => save.mutate({ model })} />
            <Button type="button" disabled={!c.configured || busy} onClick={() => { setMessage(null); loadModels.mutate(); }}>{loadModels.isPending ? '확인 중…' : models ? '새로고침' : '모델 불러오기'}</Button>
          </div>
        </div>
        <div className="setting setting-field">
          <div><b>모델 직접 입력</b><small>모델 목록을 제공하지 않는 호환 API에서도 설정할 수 있어요.</small></div>
          <form className="translation-model" onSubmit={event => { event.preventDefault(); if (customModel.trim()) save.mutate({ model: customModel.trim() }); }}>
            <input aria-label="번역 모델 ID" value={customModel} placeholder={c.model} maxLength={200} disabled={busy}
              onChange={event => setCustomModel(event.target.value)} />
            <Button type="submit" disabled={busy || !customModel.trim() || customModel.trim() === c.model}>모델 저장</Button>
          </form>
        </div>
        <div className="setting">
          <div><b>묶음당 자막 수</b><small>한 번에 보내는 자막 줄 수 ({BATCH_SIZE.min}–{BATCH_SIZE.max}). 크게 하면 요청 수가 줄고, 작게 하면 실패해도 다시 보내는 양이 적어요.</small></div>
          <label className="translation-batch">
            <input aria-label="묶음당 자막 수" inputMode="numeric" disabled={busy} value={batch ?? String(c.batchSize)}
              onChange={e => setBatch(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={commitBatch}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitBatch(); } else if (e.key === 'Escape') setBatch(null); }} />
            <span>줄</span>
          </label>
        </div>
        <p className="settings-hint translation-message">요청 간격과 실패 시 다시 시도 횟수는 <Link className="text-btn" to="/settings#subtitle-advanced">자막 고급설정</Link>에서 바꿀 수 있어요.</p>
        {message && <p className={cx('translation-message', message.error ? 'settings-error' : 'settings-hint')} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      </>}
    </div>
    {removeKeys && <ConfirmDialog title={removeKeys.length === keys.length ? 'API 키를 모두 지울까요?' : 'API 키를 지울까요?'} confirmLabel="삭제" busy={save.isPending}
      onClose={() => setRemoveKeys(null)} onConfirm={() => save.mutate(removeKeys.length === keys.length ? { clearKey: true } : { removeKeyIds: removeKeys })}>
      <p>{removeKeys.length === keys.length ? `저장된 API 키 ${keys.length}개를 모두 삭제하고 자막 번역을 꺼요.` : keys.find(key => key.id === removeKeys[0])?.label}</p>
      {message?.error && <p className="settings-error" role="alert">{message.text}</p>}
    </ConfirmDialog>}
  </section>;
}
