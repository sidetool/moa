import { useEffect, useRef, useState, type RefObject } from 'react';
import { Airplay, Cast, Pause, Play, RotateCcw, RotateCw, X } from 'lucide-react';
import type { PlaybackSession, SubtitleTrack } from '@moa/shared';
import { Button } from '../../components/ui';
import { api } from '../../lib/api';
import { clock } from '../../lib/format';
import { readTrack } from '../translation/subtitle-translation';
import { loadCast, loadCastMedia, type CastMedia, type CastSdk } from './cast';

type AirPlayVideo = HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void; webkitCurrentPlaybackTargetIsWireless?: boolean };
type Props = { session: PlaybackSession; subtitle: SubtitleTrack | null; offset: number; video: RefObject<HTMLVideoElement | null>; onAirPlay: (media: CastMedia | null) => Promise<void>; onProgress: (progress: { position: number; duration: number } | null) => void };

export function CastButton(props: Props) {
  const { session, subtitle, offset, video } = props;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [sdk, setSdk] = useState<CastSdk | null>(null), [airplay, setAirplay] = useState<'prepared' | 'connected' | null>(null);
  const [remote, setRemote] = useState<{ name: string; time: number; duration: number; paused: boolean; volume: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), grant = useRef<CastMedia | null>(null), current = useRef(props);
  const active = useRef(false), native = useRef(false), abort = useRef<AbortController | null>(null), latestSdk = useRef(sdk);
  const progressAt = useRef(0), mounted = useRef(true);
  const lastPosition = useRef(0);
  current.current = props; latestSdk.current = sdk;
  const supportsAirPlay = typeof (video.current as AirPlayVideo | null)?.webkitShowPlaybackTargetPicker === 'function';
  const local = /(^|\.)localhost$|^(127\..*|0\.0\.0\.0|\[?::1\]?)$/i.test(location.hostname);
  const release = () => {
    const target = grant.current; grant.current = null;
    if (target) void api(`/playback/${session.sessionId}/cast/${target.token}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  const stop = async () => {
    abort.current?.abort(); setBusy(false);
    if (active.current) {
      const time = lastPosition.current;
      active.current = false; latestSdk.current?.context.endCurrentSession(true);
      if (video.current && time && Number.isFinite(time)) video.current.currentTime = time;
      current.current.onProgress(null);
    }
    if (native.current) { native.current = false; video.current?.pause(); await current.current.onAirPlay(null); }
    release(); setRemote(null); setAirplay(null);
  };
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal();
    if (!supportsAirPlay && isSecureContext && !local) void loadCast().then(value => { if (mounted.current) setSdk(value); }).catch(reason => { if (mounted.current) setError(reason.message); });
    return () => { element.close(); opener?.focus(); };
  }, [open]);
  useEffect(() => {
    if (!sdk) return;
    const update = () => {
      if (!active.current) return;
      const player = sdk.player;
      if (!player.isConnected) {
        active.current = false; release(); setRemote(null);
        if (video.current && lastPosition.current > 0) video.current.currentTime = lastPosition.current;
        current.current.onProgress(null);
        return;
      }
      lastPosition.current = player.currentTime;
      current.current.onProgress({ position: player.currentTime, duration: player.duration });
      video.current?.pause();
      setRemote({ name: sdk.context.getCurrentSession()?.getCastDevice().friendlyName || 'Chromecast', time: player.currentTime, duration: player.duration, paused: player.isPaused, volume: player.volumeLevel });
      if (!session.live && player.duration > 0 && Math.abs(player.currentTime - progressAt.current) >= 10) {
        progressAt.current = player.currentTime;
        void api('/progress', { method: 'POST', body: { episodeId: session.episodeId, position: player.currentTime, duration: player.duration } }).catch(() => {});
      }
    };
    sdk.controller.addEventListener(sdk.event, update);
    return () => sdk.controller.removeEventListener(sdk.event, update);
  }, [sdk, session]);
  useEffect(() => {
    const element = video.current as AirPlayVideo | null;
    if (!element) return;
    const change = () => {
      if (!native.current) return;
      if (element.webkitCurrentPlaybackTargetIsWireless) setAirplay('connected');
      else if (airplay === 'connected') void stop();
    };
    const resume = () => { if (active.current) { element.pause(); setOpen(true); } };
    element.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', change);
    element.addEventListener('play', resume);
    return () => { element.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', change); element.removeEventListener('play', resume); };
  }, [airplay]);
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      abort.current?.abort();
      if (active.current) { active.current = false; latestSdk.current?.context.endCurrentSession(true); }
      release();
    };
    window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; window.removeEventListener('pagehide', leave); leave(); };
  }, [session.sessionId]);
  const prepare = async (signal: AbortSignal) => {
    const caption = subtitle ? { ...await readTrack(subtitle, signal), label: subtitle.label.slice(0, 200), lang: subtitle.lang, offset } : undefined;
    const result = await api<CastMedia>(`/playback/${session.sessionId}/cast`, { method: 'POST', body: { subtitle: caption }, signal });
    grant.current = result;
    return result;
  };
  const connect = async (kind: 'cast' | 'airplay') => {
    if (busy) return;
    setError(''); setBusy(true); const controller = new AbortController(); abort.current = controller;
    let requested = false;
    try {
      if (kind === 'cast') {
        if (!sdk) throw new Error('Chromecast를 불러오는 중이에요. 잠시 후 다시 시도해 주세요.');
        await sdk.context.requestSession();
        requested = true;
        controller.signal.throwIfAborted();
        const target = await prepare(controller.signal);
        await loadCastMedia(sdk, target, session.mediaTitle, video.current?.currentTime ?? session.startPosition, Boolean(session.live));
        controller.signal.throwIfAborted();
        active.current = true; video.current?.pause();
        lastPosition.current = sdk.player.currentTime;
        current.current.onProgress({ position: sdk.player.currentTime, duration: sdk.player.duration });
        setRemote({ name: sdk.context.getCurrentSession()?.getCastDevice().friendlyName || 'Chromecast', time: sdk.player.currentTime, duration: sdk.player.duration, paused: sdk.player.isPaused, volume: sdk.player.volumeLevel });
      } else {
        const target = await prepare(controller.signal);
        native.current = true;
        await current.current.onAirPlay(target);
        controller.signal.throwIfAborted(); setAirplay('prepared');
      }
    } catch (reason) {
      if (requested) sdk?.context.endCurrentSession(true);
      if (native.current) { native.current = false; if (mounted.current) await current.current.onAirPlay(null); }
      release();
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'TV 연결을 완료하지 못했어요. TV와 서버가 같은 네트워크인지 확인해 주세요.');
    } finally { if (mounted.current) setBusy(false); }
  };
  const seek = (time: number) => { if (sdk && remote && !session.live) { sdk.player.currentTime = Math.max(0, Math.min(remote.duration, time)); sdk.controller.seek(); } };
  return <>
    <button className={`icon-btn icon-btn-l${remote || airplay ? ' is-active' : ''}`} aria-label="TV 스트리밍" title="TV 스트리밍" onClick={() => setOpen(true)}><Cast size={26} /></button>
    {open && <dialog ref={dialog} className="confirm-dialog cast-dialog" aria-labelledby="cast-title" onCancel={event => { event.preventDefault(); if (!busy) setOpen(false); }} onKeyDown={event => event.stopPropagation()}>
      <header className="sheet-head"><h2 id="cast-title">TV 스트리밍</h2><button className="icon-btn" aria-label="닫기" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></header>
      <div className="confirm-dialog-body">
        {local ? <p role="alert">TV에서 접속할 수 있는 서버의 LAN IP 또는 HTTPS 주소로 MOA를 다시 열어 주세요. localhost 주소는 TV에서 연결할 수 없어요.</p>
          : <p>TV와 같은 네트워크에서 연결해 주세요. 이 플레이어를 닫으면 TV 재생도 종료됩니다.</p>}
        {subtitle && <p>선택한 자막과 싱크를 전송합니다. TV에서는 기본 자막 모양으로 표시되며, 번역이 진행 중이면 연결 시점까지 완성된 내용이 표시됩니다.</p>}
        {error && <p role="alert">{error}</p>}
        {remote ? <>
          <p role="status">{remote.name}에서 재생 중</p>
          {!session.live && <><input type="range" min={0} max={remote.duration || 1} step={1} value={Math.min(remote.time, remote.duration || 1)} aria-label="TV 재생 위치" onChange={event => seek(Number(event.target.value))} /><p>{clock(remote.time)} / {clock(remote.duration)}</p></>}
          <div className="cast-actions">
            {!session.live && <Button aria-label="TV 10초 뒤로" icon={<RotateCcw size={20} />} onClick={() => seek(remote.time - 10)} />}
            <Button aria-label={remote.paused ? 'TV 재생' : 'TV 일시정지'} icon={remote.paused ? <Play size={20} /> : <Pause size={20} />} onClick={() => sdk?.controller.playOrPause()} />
            {!session.live && <Button aria-label="TV 10초 앞으로" icon={<RotateCw size={20} />} onClick={() => seek(remote.time + 10)} />}
          </div>
          <label>TV 볼륨 <input type="range" min={0} max={1} step={0.05} value={remote.volume} onChange={event => { if (sdk) { sdk.player.volumeLevel = Number(event.target.value); sdk.controller.setVolumeLevel(); } }} /></label>
        </> : airplay ? <><p role="status">{airplay === 'connected' ? 'AirPlay로 재생 중' : '준비됐어요. AirPlay에서 TV를 선택해 주세요.'}</p><Button icon={<Airplay size={20} />} onClick={() => (video.current as AirPlayVideo)?.webkitShowPlaybackTargetPicker?.()}>AirPlay 기기 선택</Button></>
          : <div className="cast-actions">
            {supportsAirPlay ? <Button disabled={busy || local} icon={<Airplay size={20} />} onClick={() => void connect('airplay')}>{busy ? '준비 중…' : 'AirPlay 준비'}</Button>
              : <><Button disabled={busy || local || !sdk || !isSecureContext} icon={<Cast size={20} />} onClick={() => void connect('cast')}>{busy ? '연결 중…' : 'Chromecast 연결'}</Button>{!isSecureContext && !local && <p>Chromecast는 Chrome에서 HTTPS 주소로 접속해야 사용할 수 있어요. AirPlay는 Safari에서 사용할 수 있어요.</p>}</>}
          </div>}
      </div>
      <footer className="sheet-foot">{(remote || airplay) && <Button onClick={() => void stop()}>연결 종료</Button>}<Button disabled={busy} onClick={() => setOpen(false)}>닫기</Button></footer>
    </dialog>}
  </>;
}
