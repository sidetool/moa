import { useQuery } from "@tanstack/react-query";
import type { Franchise } from "@moa/shared";
import { api } from "../../lib/api";

export type { Franchise, FranchiseSeason } from "@moa/shared";

/** Regular seasons of the title across sources; polls briefly while the server is still discovering them. */
export const useFranchise = (id: string, enabled: boolean) => useQuery({
  queryKey: ["franchise", id],
  queryFn: ({ signal }) => api<Franchise>(`/media/${encodeURIComponent(id)}/franchise`, { signal }),
  enabled,
  retry: false,
  staleTime: 5 * 60_000,
  refetchInterval: query => query.state.data && !query.state.data.complete && query.state.dataUpdateCount < 8 ? 2500 : false,
});
