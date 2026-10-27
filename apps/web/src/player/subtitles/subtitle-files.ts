import type { SubtitleTrack } from '@moa/shared';
import { api, ApiError, currentProfileId } from '../../lib/api';
import { readTrack } from '../translation/subtitle-translation';

export const SUBTITLE_FILES = '.srt,.vtt,.vvt,.ass,.ssa,.smi,.sami,.zip,.7z,.rar';

export async function importSubtitleFile(file: File, episodeId: string, signal: AbortSignal): Promise<SubtitleTrack[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error('자막 파일은 10MB 이하로 선택해 주세요.');
  if (!SUBTITLE_FILES.split(',').some(ext => file.name.toLowerCase().endsWith(ext))) throw new Error('SRT·VTT·ASS·SMI·ZIP·7z·RAR 파일을 선택해 주세요.');
  const profileId = currentProfileId();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  if (currentProfileId() !== profileId) throw new DOMException('프로필이 변경되었어요.', 'AbortError');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  try {
    const tracks = await api<SubtitleTrack[]>('/subtitles/import', { method: 'POST', body: { episodeId, filename: file.name, data: btoa(binary) }, signal });
    signal.throwIfAborted();
    return tracks;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new Error(error.code === 'subtitle-archive-unavailable' ? '서버에 압축 자막 도구(bsdtar)가 설치되지 않았어요.'
      : error.code === 'subtitle-archive-empty' ? '압축 파일에 지원하는 자막이 없어요.'
      : error.status === 413 ? '자막 파일이 너무 크거나 압축 파일에 자막이 너무 많아요.'
      : '자막을 읽지 못했어요. 파일 형식과 압축 암호를 확인해 주세요.');
  }
}

export async function exportSubtitle(track: SubtitleTrack, title: string) {
  const { content } = await readTrack(track, new AbortController().signal, 4 * 1024 * 1024);
  const url = URL.createObjectURL(new Blob([content], { type: track.format === 'ass' ? 'text/x-ssa' : 'text/vtt' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160) || '자막'}${track.source === 'translation' ? '.ko' : ''}.${track.format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
