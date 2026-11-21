import { useQueryClient } from '@tanstack/react-query';
import type { HomeResponse, MediaCard } from '@moa/shared';
import { api, ApiError, currentProfileId } from '../lib/api';

export function useHideContinue() {
  const client = useQueryClient();
  const profile = currentProfileId();
  const homes = { queryKey: ['home'], predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === profile };
  return async (card: MediaCard) => {
    if (profile !== currentProfileId()) throw new DOMException('Profile changed', 'AbortError');
    const group = card.groupId ? `?${new URLSearchParams({ groupId: card.groupId })}` : '';
    try {
      const { mediaIds } = await api<{mediaIds: string[]}>(`/home/continue/${encodeURIComponent(card.id)}/hidden${group}`, { method: 'PUT' });
      if (profile !== currentProfileId()) return;
      await client.cancelQueries(homes, { revert: false });
      const hidden = new Set(mediaIds);
      client.setQueriesData<HomeResponse>(homes, old => old && ({
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
