export type CastMedia = { token: string; url: string; mime: string; expiresAt: number; hlsSegmentFormat?: string; subtitle?: { url: string; label: string; lang?: string } };
type RemotePlayer = { isConnected: boolean; isPaused: boolean; currentTime: number; duration: number; volumeLevel: number; isMuted: boolean };
type Controller = { playOrPause(): void; seek(): void; setVolumeLevel(): void; muteOrUnmute(): void; addEventListener(event: string, callback: () => void): void; removeEventListener(event: string, callback: () => void): void };
type CastSession = { loadMedia(request: Record<string, unknown>): Promise<void>; getCastDevice(): { friendlyName: string } };
type Context = { setOptions(options: Record<string, unknown>): void; requestSession(): Promise<void>; getCurrentSession(): CastSession | null; endCurrentSession(stop: boolean): void };
export type CastSdk = { context: Context; player: RemotePlayer; controller: Controller; event: string; media: {
  MediaInfo: new (url: string, mime: string) => Record<string, unknown>;
  LoadRequest: new (media: Record<string, unknown>) => Record<string, unknown>;
  GenericMediaMetadata: new () => Record<string, unknown>;
  Track: new (id: number, type: string) => Record<string, unknown>;
  TrackType: { TEXT: string }; TextTrackType: { SUBTITLES: string };
} };
type CastWindow = Window & {
  __onGCastApiAvailable?: (available: boolean) => void;
  chrome?: { cast?: { AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: string }; media: CastSdk['media'] & { DEFAULT_MEDIA_RECEIVER_APP_ID: string } } };
  cast?: { framework: { CastContext: { getInstance(): Context }; RemotePlayer: new () => RemotePlayer; RemotePlayerController: new (player: RemotePlayer) => Controller; RemotePlayerEventType: { ANY_CHANGE: string } } };
};
let loading: Promise<CastSdk> | null = null;

export function loadCast(): Promise<CastSdk> {
  if (loading) return loading;
  loading = new Promise<CastSdk>((resolve, reject) => {
    const target = window as CastWindow;
    const fail = () => { clearTimeout(timeout); loading = null; document.getElementById('moa-cast-sdk')?.remove(); reject(new Error('Chromecast에 연결하지 못했어요. Chrome 브라우저와 네트워크 연결을 확인해 주세요.')); };
    const ready = (available: boolean) => {
      if (!available || !target.cast || !target.chrome?.cast) { fail(); return; }
      clearTimeout(timeout);
      const { framework } = target.cast, { media, AutoJoinPolicy } = target.chrome.cast;
      const context = framework.CastContext.getInstance(), player = new framework.RemotePlayer();
      context.setOptions({ receiverApplicationId: media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED });
      resolve({ context, player, controller: new framework.RemotePlayerController(player), event: framework.RemotePlayerEventType.ANY_CHANGE, media });
    };
    const timeout = window.setTimeout(fail, 15000);
    if (target.cast && target.chrome?.cast) { ready(true); return; }
    target.__onGCastApiAvailable = ready;
    const script = document.createElement('script');
    script.id = 'moa-cast-sdk'; script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.async = true; script.onerror = fail; document.head.append(script);
  });
  return loading;
}

export function loadCastMedia(sdk: CastSdk, target: CastMedia, title: string, position: number, live: boolean) {
  const session = sdk.context.getCurrentSession();
  if (!session) throw new Error('TV 연결이 해제되었어요. 다시 연결해 주세요.');
  const info = new sdk.media.MediaInfo(new URL(target.url, location.href).href, target.mime);
  const metadata = new sdk.media.GenericMediaMetadata(); metadata.title = title; info.metadata = metadata;
  if (target.hlsSegmentFormat) { info.hlsSegmentFormat = target.hlsSegmentFormat; info.hlsVideoSegmentFormat = target.hlsSegmentFormat; }
  info.streamType = live ? 'LIVE' : 'BUFFERED';
  if (target.subtitle) {
    const track = new sdk.media.Track(1, sdk.media.TrackType.TEXT);
    Object.assign(track, { trackContentId: new URL(target.subtitle.url, location.href).href, trackContentType: 'text/vtt', subtype: sdk.media.TextTrackType.SUBTITLES, name: target.subtitle.label, language: target.subtitle.lang || 'ko' });
    info.tracks = [track];
  }
  const request = new sdk.media.LoadRequest(info);
  request.autoplay = true; if (!live) request.currentTime = position;
  if (target.subtitle) request.activeTrackIds = [1];
  return session.loadMedia(request);
}
