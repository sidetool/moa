import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { HomeResponse, MediaCard } from '@moa/shared';
import { api, ApiError, currentProfileId } from '../lib/api';

const profileHomes = (profile: string | null) => ({
  queryKey: ['home'],
  predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === profile,
});

const changeKey = (profile: string) => `moa.continueChanged:${profile}`;

export function listenForContinueChanges(client: QueryClient) {
  const receive = async (event: StorageEvent) => {
    const profile = currentProfileId();
    if (!profile || event.key !== changeKey(profile) || !event.newValue) return;
    const homes = profileHomes(profile);
    // A delayed notification can arrive after playback restored the card. Read current server state.
    client.removeQueries({ ...homes, type: 'inactive' });
    await client.cancelQueries(homes);
    if (profile === currentProfileId()) void client.invalidateQueries(homes);
  };
  window.addEventListener('storage', receive);
  return () => window.removeEventListener('storage', receive);
}

export function useHideContinue() {
  const client = useQueryClient();
  const profile = currentProfileId();
  const homes = profileHomes(profile);
  return async (card: MediaCard) => {
    if (profile !== currentProfileId()) throw new DOMException('Profile changed', 'AbortError');
    const versions = new Map(client.getQueryCache().findAll(homes).map(query => [query, query.state.dataUpdateCount]));
    const group = card.groupId ? `?${new URLSearchParams({ groupId: card.groupId, resumeMediaId: card.resumeMediaId ?? card.id })}` : '';
    try {
      const { mediaIds } = await api<{mediaIds: string[]}>(`/home/continue/${encodeURIComponent(card.id)}/hidden${group}`, { method: 'PUT' });
      if (profile) {
        try {
          localStorage.setItem(changeKey(profile), '1');
          localStorage.removeItem(changeKey(profile));
        } catch { /* Home can also refresh on focus. */ }
      }
      if (profile !== currentProfileId()) return;
      await client.cancelQueries(homes, { revert: false });
      const hidden = new Set(mediaIds);
      // Playback may have restored an edition and Home may have read it while this PUT was in flight.
      client.setQueriesData<HomeResponse>({ queryKey: homes.queryKey, predicate: query => versions.get(query) === query.state.dataUpdateCount }, old => old && ({
        ...old,
        rows: old.rows.flatMap(row => {
          if (row.kind !== 'continue') return [row];
          const items = row.items.filter(item => !hidden.has(item.resumeMediaId ?? item.id));
          return items.length ? [{ ...row, items }] : [];
        }),
      }));
      // Refill the capped row and resolve the current representative of any remaining group.
      void client.invalidateQueries(homes);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'continue-group-changed') void client.invalidateQueries(homes);
      throw error;
    }
  };
}
