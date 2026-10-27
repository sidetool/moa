import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { searchJimaku, translateJimaku, translationErrorMessage, type JimakuCandidate, type JimakuQuery, type JimakuSearch } from "../../api/translation";
import type { TranslationSource } from "./subtitle-translation";

export type JimakuState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; result: JimakuSearch }
  | { status: "error"; message: string };

/** Japanese subtitle search on Jimaku. Searching is free; only translating a pick costs API usage. */
export function useJimakuSearch(episodeId: string) {
  const [state, setState] = useState<JimakuState>({ status: "idle" });
  const abort = useRef<AbortController | null>(null);
  const search = useCallback(async (query?: JimakuQuery) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ status: "searching" });
    try {
      const result = await searchJimaku(episodeId, query, controller.signal);
      if (!controller.signal.aborted) setState({ status: "done", result });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error", message: error instanceof ApiError && error.code.startsWith("jimaku-") ? translationErrorMessage(error.code) : "Jimaku에서 찾지 못했어요. 다시 시도해 주세요." });
    }
  }, [episodeId]);
  useEffect(() => () => abort.current?.abort(), []);
  return { state, search };
}

/** Candidates expire after 30 minutes; an expired pick is looked up again with the same query. */
export function jimakuSource(search: JimakuSearch, candidate: JimakuCandidate): TranslationSource {
  return {
    label: candidate.filename,
    create: async (episodeId, signal, startAt) => {
      try {
        return await translateJimaku(episodeId, search.searchId, candidate.id, startAt);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "jimaku-search-expired")) throw error;
        const fresh = await searchJimaku(episodeId, search.query, signal);
        const same = fresh.candidates.find(item => item.sourceUrl === candidate.sourceUrl && item.filename === candidate.filename);
        if (!same) throw error;
        return translateJimaku(episodeId, fresh.searchId, same.id, startAt);
      }
    }
  };
}
