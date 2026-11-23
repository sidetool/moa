import type { ResumeTarget, Settings } from '@moa/shared';

const PREFIX = 'moa.resumeScene:';
const LOGOUT = 'moa.resumeSceneLogout';
const CHANGE = 'moa:resume-scene-changed';
const MAX_SCENES = 24;
const MAX_IMAGE_LENGTH = 32 * 1024;

function purgeScenes(generation: string) {
  try {
    localStorage.setItem(LOGOUT, generation);
  } catch (error) {
    // A full origin store may have no room for its first logout marker.
    const frame = Object.keys(localStorage).find(name => name.startsWith(PREFIX));
    if (!frame) throw error;
    localStorage.removeItem(frame);
    localStorage.setItem(LOGOUT, generation);
  }
  for (const name of Object.keys(localStorage)) if (name.startsWith(PREFIX)) localStorage.removeItem(name);
}

// Both the native auth page and the app consume markers for ended and newly issued sessions.
function pendingLogout() {
  return document.cookie.match(/(?:^|;\s*)moa_scene_reset=([a-f0-9-]{36})(?:;|$)/)?.[1];
}
function documentLogoutGeneration() {
  try {
    const reset = pendingLogout();
    if (reset) {
      purgeScenes(reset);
      document.cookie = 'moa_scene_reset=; Path=/; SameSite=Lax; Max-Age=0' + (location.protocol === 'https:' ? '; Secure' : '');
    }
    return localStorage.getItem(LOGOUT);
  } catch { return undefined; }
}
const documentGeneration = documentLogoutGeneration();
function currentDocument() {
  return documentGeneration !== undefined && !pendingLogout() && documentGeneration === localStorage.getItem(LOGOUT);
}

// Wait for this profile's settings. Older responses without the field use the original enabled behavior.
export function resumeSceneEnabled(settings?: Pick<Settings, 'showResumeScene'>) {
  return Boolean(settings && settings.showResumeScene !== false);
}

export interface VideoStill { position: number; image: string }
interface ResumeScene extends VideoStill { second: number }

function localFrame(video: HTMLVideoElement) {
  return video.readyState >= 2 && !video.seeking && !video.ended && !video.mediaKeys && video.videoWidth > 0 && video.videoHeight > 0
    && !(video as HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless;
}

function drawStill(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight, 1);
  const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.drawImage(video, 0, 0, width, height);
  return true;
}
function encodeStill(canvas: HTMLCanvasElement) {
  const image = canvas.toDataURL('image/jpeg', 0.65);
  if (image.startsWith('data:image/jpeg;base64,') && image.length <= MAX_IMAGE_LENGTH) return image;
}

export function captureVideoStill(video: HTMLVideoElement, position: number): VideoStill | undefined {
  if (!localFrame(video)) return;
  try {
    const canvas = document.createElement('canvas');
    const image = drawStill(video, canvas) && encodeStill(canvas);
    if (image) return { position, image };
  } catch { /* Device or video policy disallows frame capture. */ }
}

/** Retain the displayed frame covering the integer Home will actually seek to. Only encode on a save. */
export function sampleResumeSeconds(video: HTMLVideoElement) {
  const slots = Array.from({ length: 2 }, () => ({ canvas: document.createElement('canvas'), second: -1, image: '' }));
  let pending: { second: number; frame: number; dropped: number | undefined } | undefined;
  let lastTime: number | undefined;
  let callback: number | undefined;
  let blocked = false;

  function draw(second: number, confirmed: boolean) {
    if (blocked || second < 1 || !localFrame(video) || second >= video.duration * .9 || video.duration - second < 120) return false;
    const slot = slots[second % 2];
    if (slot.second === second) return false;
    slot.second = -1;
    slot.image = '';
    try {
      if (!drawStill(video, slot.canvas)) return false;
      if (confirmed) slot.second = second;
      return true;
    } catch { blocked = true; return false; }
  }

  // Non-integer frame rates can place the boundary between two presentation timestamps.
  // Sample the likely predecessor, then require consecutive presented frames to confirm its interval.
  function onFrame(_now: number, { mediaTime, presentedFrames }: VideoFrameCallbackMetadata) {
    if (localFrame(video)) {
      if (pending && presentedFrames === pending.frame + 1 && mediaTime > pending.second
        && video.getVideoPlaybackQuality?.().droppedVideoFrames === pending.dropped) {
        slots[pending.second % 2].second = pending.second;
      }
      pending = undefined;
      const second = Math.ceil(mediaTime);
      if (mediaTime === second) draw(second, true);
      else if (lastTime !== undefined && second - mediaTime <= (mediaTime - lastTime) * 1.25 && draw(second, false)) {
        pending = { second, frame: presentedFrames, dropped: video.getVideoPlaybackQuality?.().droppedVideoFrames };
      }
      lastTime = mediaTime;
    } else resetInterval();
    if (!blocked) callback = video.requestVideoFrameCallback(onFrame);
  }
  function resetInterval() { lastTime = undefined; pending = undefined; }
  function atSeek() {
    resetInterval();
    // A seek to an integer explicitly decodes that instant, including variable-rate video.
    if (Number.isInteger(video.currentTime)) draw(video.currentTime, true);
  }
  atSeek();
  video.addEventListener('loadeddata', atSeek);
  video.addEventListener('seeking', resetInterval);
  video.addEventListener('seeked', atSeek);
  if (typeof video.requestVideoFrameCallback === 'function') callback = video.requestVideoFrameCallback(onFrame);
  return {
    sceneFor(position: number): ResumeScene | undefined {
      if (!localFrame(video) || blocked) return;
      const second = Math.floor(position), slot = slots[second % 2];
      if (second === position && video.currentTime === position) draw(second, true);
      if (slot.second !== second) return;
      try {
        const image = slot.image || encodeStill(slot.canvas);
        if (image) {
          slot.image = image;
          return { position, second, image };
        }
      } catch { blocked = true; } // A protected/tainted surface cannot be read back.
    },
    stop() {
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      video.removeEventListener('loadeddata', atSeek);
      video.removeEventListener('seeking', resetInterval);
      video.removeEventListener('seeked', atSeek);
    }
  };
}

// The episode ID is source-specific. Include the server's exact progress revision and position so
// a deleted/recreated history entry, a rewind or another device's save invalidates the old frame.
function key(account: string, profile: string, episode: string, updatedAt: string, position: number) {
  return PREFIX + JSON.stringify([updatedAt, account, profile, episode, position]);
}

export function storeResumeScene(account: string, profile: string, mediaId: string, episode: string, updatedAt: string, position: number, scene: ResumeScene) {
  if (!updatedAt || scene.position !== position || scene.second !== Math.floor(position)) return;
  try {
    if (!currentDocument()) return;
    const destination = key(account, profile, episode, updatedAt, position);
    for (const name of Object.keys(localStorage)) {
      if (!name.startsWith(PREFIX) || name === destination) continue;
      const [date, owner, viewer, id] = JSON.parse(name.slice(PREFIX.length));
      if (owner === account && viewer === profile && id === episode) {
        if (date > updatedAt) return; // A later save finished first.
        localStorage.removeItem(name);
      }
    }
    localStorage.setItem(destination, JSON.stringify({ mediaId, second: scene.second, image: scene.image }));
    // A logout in another tab can race this write even within one synchronous task.
    if (!currentDocument()) { localStorage.removeItem(destination); return; }
    const stored = Object.keys(localStorage).filter(name => name.startsWith(PREFIX)).sort();
    for (const name of stored.slice(0, Math.max(0, stored.length - MAX_SCENES))) localStorage.removeItem(name);
    window.dispatchEvent(new Event(CHANGE));
  } catch { /* Keep progress usable in private mode or with a full storage quota. */ }
}

export function clearResumeScenes(profile?: string, target?: { episodeId: string } | { mediaId: string }) {
  try {
    if (!profile) {
      const reset = pendingLogout();
      // A delayed login-required response from an old tab must not invalidate a newer session.
      if (!reset && documentGeneration !== localStorage.getItem(LOGOUT)) return;
      purgeScenes(reset ?? Date.now().toString(36) + Math.random().toString(36));
    } else for (const name of Object.keys(localStorage)) {
      if (!name.startsWith(PREFIX)) continue;
      const [, , viewer, episode] = JSON.parse(name.slice(PREFIX.length));
      if (viewer !== profile) continue;
      if (target && ('episodeId' in target ? episode !== target.episodeId : JSON.parse(localStorage.getItem(name) || '{}').mediaId !== target.mediaId)) continue;
      localStorage.removeItem(name);
    }
    window.dispatchEvent(new Event(CHANGE));
  } catch { /* Storage access is optional. */ }
}

export function readResumeScene(account?: string, profile?: string | null, target?: ResumeTarget) {
  if (!account || !profile || target?.kind !== 'resume' || !target.updatedAt || !(target.position > 0)) return;
  try {
    if (!currentDocument()) return;
    const entry = localStorage.getItem(key(account, profile, target.episodeId, target.updatedAt, target.position));
    if (!entry) return;
    const { image, second } = JSON.parse(entry);
    if (second === Math.floor(target.position) && typeof image === 'string' && image.startsWith('data:image/jpeg;base64,') && image.length <= MAX_IMAGE_LENGTH) return image;
  } catch { /* Fall back to the episode thumbnail when device storage is unavailable. */ }
}

// Home can receive the new progress revision before the progress POST returns and stores its JPEG.
export function subscribeResumeScenes(notify: () => void) {
  const changed = (event: StorageEvent) => {
    if (!event.key || event.key === LOGOUT || event.key.startsWith(PREFIX)) notify();
  };
  window.addEventListener(CHANGE, notify);
  window.addEventListener('storage', changed);
  return () => {
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener('storage', changed);
  };
}
