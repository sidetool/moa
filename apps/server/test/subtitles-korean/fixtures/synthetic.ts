import { createSubtitleClient } from '../../../src/subtitles/korean/index.js';
import type { AliasEntry, SubtitleClientOptions, SubtitleCreator, ResolvedTitle } from '../../../src/subtitles/korean/types.js';

// Authored names, offsets and provider identities for offline unit tests.
export const aliases: AliasEntry[] = [
  { korean: '구름 정원', aliases: ['Example TV', '雲の庭', '예제', '구름정원', '구름정원극'], episodeOffsets: { '1': 0, '2': 11, '3': 24 } },
  { korean: '별빛 학교', aliases: ['Starlight Academy', '星の学校'], episodeOffsets: { '1': 0, '2': 24, '3': 47 },
    seasonTitles: { '2': ['별빛 학교 푸른 교실'], '3': ['별빛 학교 별의 여행'] } },
  { korean: '하늘 탐험대', aliases: ['Sky Explorers', '空の探検隊'], episodeOffsets: { '1': 0, '2': 25, '3': 37, '4': 59 } },
  { korean: '숲의 여행', aliases: ['Forest Journey', '森の旅'] },
];
const providers = [
  { id: 'example-a', name: 'Example Creator A', website: 'https://example-creator-a.blogspot.com/' },
  { id: 'example-b', name: 'Example Creator B', website: 'https://example-creator-b.blogspot.com/' },
  { id: 'example-legacy', name: 'Example Legacy Creator', website: 'https://example-legacy.tistory.com/' },
];

/** Keep provider scheduling under test; supply fictional archive identities at its boundary. */
export function createOfflineSubtitleClient(options: SubtitleClientOptions = {}) {
  const client = createSubtitleClient({ ...options, aliases: [...(options.aliases ?? []), ...aliases], enableAniList: false });
  const metadata = (client as unknown as { metadata: { archive: (resolved: ResolvedTitle, source?: boolean | 'melody') => SubtitleCreator } }).metadata;
  metadata.archive = (resolved, source = false) => ({
    ...providers[source === 'melody' ? 2 : source ? 1 : 0], id: `${providers[source === 'melody' ? 2 : source ? 1 : 0].id}:${resolved.title}`,
    aliases: resolved.aliases, source: 'archive', title: resolved.title, season: resolved.season,
    episodeOffset: resolved.episodeOffset, isCurrentEpisode: false, confidence: Math.min(resolved.confidence, .85),
  });
  (client as unknown as { collector: { discover: () => Promise<[]> } }).collector.discover = async () => [];
  return client;
}
