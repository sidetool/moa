import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecommendationsResponse } from "@moa/shared";
import { api } from "../lib/api";

export const recommendationsKey = ["recommendations"] as const;

/** Profile-based picks. The server owns history, matching and kids rules; the client only shows them. */
export const useRecommendations = (enabled: boolean) => useQuery({
  queryKey: recommendationsKey,
  queryFn: ({ signal }) => api<RecommendationsResponse>("/recommendations", { signal }),
  enabled,
  staleTime: 0,
  refetchInterval: query => query.state.data?.refreshAfterMs ?? false,
  retry: false
});

const dismissalPath = (key: string) => `/recommendations/dismissals/${encodeURIComponent(key)}`;
export const dismissRecommendation = (key: string) => api<void>(dismissalPath(key), { method: "PUT", body: {} });
export const undoDismissRecommendation = (key: string) => api<void>(dismissalPath(key), { method: "DELETE" });

export function useResetDismissals() {
  const client = useQueryClient();
  return async () => {
    await api<void>("/recommendations/dismissals", { method: "DELETE" });
    await client.invalidateQueries({ queryKey: recommendationsKey });
  };
}

/** Only in-app destinations; anything else falls back to a title search. */
export function recommendationTarget(href: string, title: string) {
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\") ? href : `/search?q=${encodeURIComponent(title)}`;
}
