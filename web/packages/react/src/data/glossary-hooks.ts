/**
 * The glossary's writes and its search across conversations (B24 / F19). A
 * save writes its result into the tree's list at once (the term shows
 * without waiting for the reload that follows) and, when it kept the aside
 * it was saved from, into the outline; `terms.changed` from others reloads
 * the list (event-sync).
 */
import type { CreateTermInput, Term, TermList, UpdateTermInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import type { TangentKeys } from "../query-keys";
import { writeBranch } from "./branch-cache";

const byKey = (a: Term, b: Term) => (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : a.id < b.id ? -1 : 1);

/** Puts `term` into its tree's cached list (replacing its older copy), then reloads the list and the searches. */
export function writeTerm(queryClient: QueryClient, keys: TangentKeys, term: Term): void {
  queryClient.setQueryData<TermList>(keys.terms(term.rootLineId), (list) => (list ? { ...list, terms: [...list.terms.filter((item) => item.id !== term.id), term].sort(byKey) } : list));
  void queryClient.invalidateQueries({ queryKey: keys.terms(term.rootLineId) });
  void queryClient.invalidateQueries({ queryKey: keys.termSearchAll() });
}

/** Takes a term out of its tree's cached list, then reloads the list and the searches. */
export function forgetTerm(queryClient: QueryClient, keys: TangentKeys, rootLineId: string, termId: string): void {
  queryClient.setQueryData<TermList>(keys.terms(rootLineId), (list) => (list ? { ...list, terms: list.terms.filter((item) => item.id !== termId) } : list));
  void queryClient.invalidateQueries({ queryKey: keys.terms(rootLineId) });
  void queryClient.invalidateQueries({ queryKey: keys.termSearchAll() });
}

/** Saves a term from `lineId` (an aside is kept by it); `replace` overwrites the stored one after `term_exists`. */
export function useSaveTerm() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, input }: { lineId: string; input: CreateTermInput }) => client.createTerm(lineId, input),
    onSuccess: (result) => {
      writeTerm(queryClient, keys, result.term);
      if (result.keptBranch) writeBranch(queryClient, keys, result.keptBranch);
    },
  });
}

export function useUpdateTerm() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ termId, input }: { termId: string; input: UpdateTermInput }) => client.updateTerm(termId, input),
    onSuccess: (result) => writeTerm(queryClient, keys, result.term),
  });
}

/** How long a lookup across conversations may take before it is given up (it must never hold 秒問解釋 back). */
export const TERM_LOOKUP_TIMEOUT_MS = 4000;
/** One page is enough to find the same term in another conversation (the ones that start with the query come first). */
const TERM_LOOKUP_PAGE = 20;
const TERM_LOOKUP_STALE_MS = 30_000;

/**
 * `GET /terms` for one query (F19 §2.4): the terms of every unarchived
 * conversation, the ones that start with it first. Given up after
 * `TERM_LOOKUP_TIMEOUT_MS`; a failure is not retried (the lookup is a hint).
 */
export function useTermSearch(q: string, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.termSearch(q),
    queryFn: ({ signal }) => {
      // The query's own cancel and the time limit both end the request.
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop);
      const timer = setTimeout(stop, TERM_LOOKUP_TIMEOUT_MS);
      return client.searchTerms({ q, limit: TERM_LOOKUP_PAGE }, { signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      });
    },
    enabled: enabled && q !== "",
    retry: false,
    staleTime: TERM_LOOKUP_STALE_MS,
  });
}
