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

// deploy/auth/login.js normally consumes the native form logout marker. A browser
// can also log out and back in with scripts disabled, then open the app directly.
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

export interface ResumeScene { position: number; image: string }

/** Only sample the frame already decoded by the main player. Protected/tainted video can refuse readback. */
export function captureResumeScene(video: HTMLVideoElement, position: number): ResumeScene | undefined {
  if ((video as HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless) return;
  if (video.readyState < 2 || video.seeking || video.ended || video.mediaKeys || !video.videoWidth || !video.videoHeight) return;
  try {
    const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.65);
    if (image.startsWith('data:image/jpeg;base64,') && image.length <= MAX_IMAGE_LENGTH) return { position, image };
  } catch { /* Device or video policy disallows frame capture. */ }
}

// The episode ID is source-specific. Include the server's exact progress revision and position so
// a deleted/recreated history entry, a rewind or another device's save invalidates the old frame.
function key(account: string, profile: string, episode: string, updatedAt: string, position: number) {
  return PREFIX + JSON.stringify([updatedAt, account, profile, episode, position]);
}

export function storeResumeScene(account: string, profile: string, mediaId: string, episode: string, updatedAt: string, position: number, scene: ResumeScene) {
  if (!updatedAt || scene.position !== position) return;
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
    localStorage.setItem(destination, JSON.stringify({ mediaId, image: scene.image }));
    // A logout in another tab can race this write even within one synchronous task.
    if (!currentDocument()) { localStorage.removeItem(destination); return; }
    const stored = Object.keys(localStorage).filter(name => name.startsWith(PREFIX)).sort();
    for (const name of stored.slice(0, Math.max(0, stored.length - MAX_SCENES))) localStorage.removeItem(name);
    window.dispatchEvent(new Event(CHANGE));
  } catch { /* Keep progress usable in private mode or with a full storage quota. */ }
}

export function clearResumeScenes(profile?: string, target?: { episodeId: string } | { mediaId: string }) {
  try {
    if (!profile) purgeScenes(Date.now().toString(36) + Math.random().toString(36));
    else for (const name of Object.keys(localStorage)) {
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
    const { image } = JSON.parse(entry);
    if (typeof image === 'string' && image.startsWith('data:image/jpeg;base64,') && image.length <= MAX_IMAGE_LENGTH) return image;
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
