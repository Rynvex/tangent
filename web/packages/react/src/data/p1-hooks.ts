/**
 * P1 reads and writes (F4 phase 1, B8 phase A): a branch's leaf, the tree's
 * parking lot and its suggestion inbox. Server-validated, so not optimistic:
 * each write puts what its result says into the cache and invalidates what
 * it changed (the 待處理 count lives on the main line's `LineView`). The
 * events (`leaf.changed`, `seeds.changed`, `suggestion.changed`) do the same
 * for other tabs and viewers. Only the lazily loaded parts (the inbox, the
 * leaf editor, the seed dialog) use these; the always-loaded pieces live in
 * `leaf-cache.ts` (events) and `park-hooks.ts` (the composer's 停車).
 */
import {
  rebalanceResultOf,
  type BranchView,
  type ExpandSeedInput,
  type Goal,
  type LeafInput,
  type LeafResult,
  type LineView,
  type NoteSeedInput,
  type RebalanceAcceptBody,
  type Seed,
  type SpinoffInput,
  type Suggestion,
} from "@tangent/client";
import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";
import { useTangent } from "../provider";
import { writeLeaf } from "./leaf-cache";
import { invalidateAll } from "./park-hooks";

/** Every cached `POST /preview` (the notes block is in every prompt of the tree). */
function invalidatePreviews(queryClient: QueryClient, keys: TangentKeys): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => keys.all.every((part, index) => query.queryKey[index] === part) && query.queryKey.at(-2) === "preview" });
}

/** A seed or suggestion this page decided, and when (epoch ms). */
export interface Decided<T> {
  at: number;
  item: T;
}

function remember<T extends { id: string }>(queryClient: QueryClient, key: QueryKey, item: T): void {
  queryClient.setQueryData<readonly Decided<T>[]>(key, (list = []) => [{ at: Date.now(), item }, ...list.filter((entry) => entry.item.id !== item.id)]);
}

/** Reads a decided list (set only by the writes below; never fetched). */
function useDecided<T>(key: QueryKey) {
  const query = useQuery<readonly Decided<T>[]>({ queryKey: key, queryFn: () => [], enabled: false, staleTime: Infinity, gcTime: Infinity });
  return query.data ?? [];
}

/** Seeds this page expanded, noted or dropped, newest first. */
export function useDecidedSeeds(rootLineId: string): readonly Decided<Seed>[] {
  const { keys } = useTangent();
  return useDecided<Seed>(keys.seedsDecided(rootLineId));
}

/** Suggestions this page accepted or dismissed, newest first. */
export function useDecidedSuggestions(rootLineId: string): readonly Decided<Suggestion>[] {
  const { keys } = useTangent();
  return useDecided<Suggestion>(keys.suggestionsDecided(rootLineId));
}

// Leaves ---------------------------------------------------------------------

/** A branch's leaf (`{leaf: null}` when it has none); `enabled` is false while the leaf feature is off. */
export function useLeaf(lineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.leaf(lineId ?? ""), queryFn: ({ signal }) => client.getLeaf(lineId ?? "", { signal }), enabled: enabled && lineId !== null });
}

/** Writes and confirms the leaf (an AI draft becomes the user's). */
export function usePutLeaf(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeafInput) => client.putLeaf(lineId, input),
    onSuccess: (result) => {
      if (result.leaf) writeLeaf(queryClient, keys, lineId, result.leaf.rootLineId, result.leaf);
    },
  });
}

/** Asks AI for a draft (202); the draft (or its `draftError`, B8.1) arrives with `leaf.changed`. The last failure is cleared meanwhile. */
export function useStartLeafDraft(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.startLeafDraft(lineId),
    onSuccess: () => queryClient.setQueryData<LeafResult>(keys.leaf(lineId), (data) => (data ? { leaf: data.leaf } : data)),
  });
}

// Seeds ----------------------------------------------------------------------

/** The tree's open seeds, newest first (pass the root); `enabled` is false while parking is off. */
export function useSeeds(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.seeds(rootLineId ?? ""), queryFn: ({ signal }) => client.listSeeds(rootLineId ?? "", {}, { signal }), enabled: enabled && rootLineId !== null });
}

/** The parking lot and the main line (its 待處理 count) after a seed changed. */
function useSeedSettle(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return {
    client,
    keys,
    queryClient,
    settle: (seed: Seed, ...more: QueryKey[]) => {
      remember(queryClient, keys.seedsDecided(rootLineId), seed);
      return invalidateAll(queryClient, keys.seedsOf(rootLineId), keys.lineView(rootLineId), ...more);
    },
  };
}

/** Opens a branch from a seed: like opening one (the new line is cached, the outline reloads). */
export function useExpandSeed(rootLineId: string) {
  const { client, keys, queryClient, settle } = useSeedSettle(rootLineId);
  return useMutation({
    mutationFn: ({ seedId, input = {} }: { seedId: string; input?: ExpandSeedInput }) => client.expandSeed(seedId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(keys.lineView(result.line.id), result.line);
      return settle(result.seed, keys.branchesOf(result.branch.rootLineId), keys.lineView(result.branch.parentLineId));
    },
  });
}

/** Writes a seed into the notes (待確認 unless another section is given). */
export function useNoteSeed(rootLineId: string) {
  const { client, keys, queryClient, settle } = useSeedSettle(rootLineId);
  return useMutation({
    mutationFn: ({ seedId, input = {} }: { seedId: string; input?: NoteSeedInput }) => client.noteSeed(seedId, input),
    onSuccess: (result) => Promise.all([settle(result.seed, keys.notes(result.rootLineId)), invalidatePreviews(queryClient, keys)]),
  });
}

export function useDropSeed(rootLineId: string) {
  const { client, settle } = useSeedSettle(rootLineId);
  return useMutation({ mutationFn: ({ seedId }: { seedId: string }) => client.dropSeed(seedId), onSuccess: (result) => settle(result.seed) });
}

// Suggestions ----------------------------------------------------------------

export { useSuggestions } from "./suggestion-query";

function useSuggestionSettle(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return {
    client,
    settle: (suggestion: Suggestion) => {
      remember(queryClient, keys.suggestionsDecided(rootLineId), suggestion);
      return invalidateAll(queryClient, keys.suggestionsOf(rootLineId), keys.lineView(rootLineId));
    },
  };
}

/**
 * What an accepted B9 suggestion did, at once rather than with its events: a
 * goal (goal proposal), a new branch (drift hint) or a relation.
 */
function settleResult(queryClient: QueryClient, keys: TangentKeys, rootLineId: string, result: Readonly<Record<string, unknown>> | undefined) {
  if (!result) return Promise.resolve();
  const written = result as { goal?: Goal; line?: LineView; branch?: BranchView; link?: unknown; group?: unknown; combined?: unknown };
  if (written.goal) queryClient.setQueryData(keys.goal(rootLineId), { goal: written.goal });
  if (written.line && written.branch) queryClient.setQueryData(keys.lineView(written.line.id), written.line);
  return invalidateAll(
    queryClient,
    ...(written.branch ? [keys.branchesOf(rootLineId), keys.lineView(written.branch.parentLineId)] : []),
    ...(written.link ? [keys.relations(rootLineId), keys.links(rootLineId)] : []),
    // B9 phase C: an accepted group suggestion made a group, or combined branches.
    ...(written.group ? [keys.groupsOf(rootLineId)] : []),
    ...(written.combined ? [keys.branchesOf(rootLineId), keys.notes(rootLineId)] : []),
  );
}

/** Accepts a suggestion; `body` is what its kind needs (`{text}` for a goal proposal, `{kind, purpose}` for a drift hint, `{label}` for a relation). */
export function useAcceptSuggestion(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  const { settle } = useSuggestionSettle(rootLineId);
  return useMutation({
    mutationFn: ({ suggestionId, body = {} }: { suggestionId: string; body?: Readonly<Record<string, unknown>> }) => client.acceptSuggestion(suggestionId, body),
    onSuccess: (result) => Promise.all([settle(result.suggestion), settleResult(queryClient, keys, rootLineId, result.result)]),
  });
}

export function useDismissSuggestion(rootLineId: string) {
  const { client, settle } = useSuggestionSettle(rootLineId);
  return useMutation({ mutationFn: ({ suggestionId }: { suggestionId: string }) => client.dismissSuggestion(suggestionId), onSuccess: (result) => settle(result.suggestion) });
}

/**
 * B17 「忽略全部」: every open suggestion of the tree in one call (no undo).
 * Each dismissed one is remembered as decided, then the inbox and the main
 * line (its 待處理 count) reload.
 */
export function useDismissAllSuggestions(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.dismissAllSuggestions(rootLineId),
    onSuccess: (result) => {
      // Oldest first, so the list of decided items stays newest first.
      for (const suggestion of [...result.suggestions].reverse()) remember(queryClient, keys.suggestionsDecided(rootLineId), suggestion);
      return invalidateAll(queryClient, keys.suggestionsOf(rootLineId), keys.lineView(rootLineId));
    },
  });
}

// Spinoff and tree balance (B2, B4) -------------------------------------------------

/**
 * What a spinoff or an accepted tree balance changed: the new conversation,
 * the source tree, the list, and the line holding the 「已獨立 →」 marker
 * (`link.fromLineId`, else the source line; R7 D2) — a branch is keyed under
 * itself, not the root, so the tree's prefix does not reach it.
 */
function settleSpinoff(queryClient: QueryClient, keys: TangentKeys, sourceRoot: string, line: LineView | null, markerLineId: string) {
  if (line) queryClient.setQueryData(keys.lineView(line.id), line);
  const lines = new Set([sourceRoot, markerLineId, ...(line ? [line.id] : [])].filter(Boolean));
  // The new conversation inherits the source's folder and tags (B18), so the tenant's counts change (B18.1).
  return invalidateAll(queryClient, keys.lineLists(), keys.lineOrganization(), ...[...lines].map((id) => keys.line(id)));
}

/** The capsule a spinoff with this body would carry (B8.2 `POST /spinoff/preview`); recomputed when the body changes. */
export function useSpinoffPreview(lineId: string, input: SpinoffInput, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.spinoffPreview(lineId, input), queryFn: ({ signal }) => client.previewSpinoff(lineId, input, { signal }), enabled, retry: false });
}

/** Spins `lineId` off: a whole open branch (`detach`) or a fresh start from one of its messages. */
export function useSpinoff(lineId: string, sourceRoot: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SpinoffInput) => client.spinoff(lineId, input),
    onSuccess: (result) => settleSpinoff(queryClient, keys, sourceRoot, result.line, result.link.fromLineId || result.sourceLineId),
  });
}

/** Accepts a tree-balance suggestion with the chosen action; its result, read (null when the server sent none). */
export function useAcceptRebalance(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ suggestionId, body }: { suggestionId: string; body: RebalanceAcceptBody }) => {
      const written = await client.acceptSuggestion(suggestionId, body);
      return { suggestion: written.suggestion, result: rebalanceResultOf(written.result) };
    },
    onSuccess: ({ suggestion, result }) => {
      remember(queryClient, keys.suggestionsDecided(rootLineId), suggestion);
      // Accepted tree balance detaches the suggestion's branch: the marker goes on its parent (link.fromLineId).
      return settleSpinoff(queryClient, keys, rootLineId, result?.action === "spinoff" ? result.line : null, result?.link?.fromLineId || suggestion.lineId);
    },
  });
}
