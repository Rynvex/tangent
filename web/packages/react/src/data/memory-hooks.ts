/**
 * Hooks of cross-conversation memory (B10 phase C, F6 phase 3): only the
 * lazily loaded D1 parts use them. Memories are the tenant's, so the keys
 * are not line-scoped; every write reloads them (and the previews: each turn
 * recalls them).
 */
import {
  DEFAULT_MEMORY_LIMITS,
  type CreateMemoryInput,
  type Memory,
  type MemoryKind,
  type MemoryLimits,
  type MemoryList,
  type MemoryStatus,
  type SupersedeMemoryInput,
  type UpdateMemoryInput,
} from "@tangent/client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";
import { useTangent } from "../provider";
import { invalidatePreviews } from "./p2-hooks";

/** Results stay fresh for a while: a search runs as the user types. */
const SEARCH_STALE_MS = 30_000;

export interface MemoriesQuery {
  kind?: MemoryKind;
  status?: MemoryStatus | "all";
  /** Memories per page (server default 100, at most 200). */
  limit?: number;
}

/** The pages loaded so far, as one list. */
export interface MemoryPages {
  /** Newest first, every loaded page in order. */
  memories: Memory[];
  limits: MemoryLimits;
}

function joinPages(data: InfiniteData<MemoryList, string>): MemoryPages {
  return { memories: data.pages.flatMap((page) => page.memories), limits: data.pages[0]?.limits ?? DEFAULT_MEMORY_LIMITS };
}

/**
 * The tenant's memories, newest first, a page at a time (B10.1):
 * `fetchNextPage` appends the next page while `hasNextPage`. Each filter is
 * its own list from the first page; `memory.changed` reloads every loaded
 * page. `enabled` is false while the memory feature is off.
 */
export function useMemories(query: MemoriesQuery = {}, enabled = true) {
  const { client, keys } = useTangent();
  const filters = { ...(query.kind ? { kind: query.kind } : {}), ...(query.status ? { status: query.status } : {}), ...(query.limit ? { limit: query.limit } : {}) };
  return useInfiniteQuery({
    queryKey: keys.memories(query),
    queryFn: ({ signal, pageParam }) => client.listMemories({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: "",
    getNextPageParam: (last: MemoryList) => last.nextCursor || undefined,
    select: joinPages,
    enabled,
  });
}

/** What was concluded before about `query` (a new conversation's first message, a new branch's purpose); idle for an empty one. */
export function useMemorySearch(query: string, enabled = true) {
  const { client, keys } = useTangent();
  const text = query.trim();
  return useQuery({
    queryKey: keys.memorySearch(text),
    queryFn: ({ signal }) => client.searchMemories({ query: text }, { signal }),
    enabled: enabled && text !== "",
    staleTime: SEARCH_STALE_MS,
  });
}

function settle(queryClient: QueryClient, keys: TangentKeys) {
  return Promise.all([queryClient.invalidateQueries({ queryKey: keys.memoriesAll() }), invalidatePreviews(queryClient, keys)]);
}

export function useCreateMemory() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: CreateMemoryInput) => client.createMemory(input), onSuccess: () => settle(queryClient, keys) });
}

/** Category, importance and expiry; the text changes by superseding. */
export function useUpdateMemory() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, input }: { memoryId: string; input: UpdateMemoryInput }) => client.updateMemory(memoryId, input),
    onSuccess: () => settle(queryClient, keys),
  });
}

/** A new memory replaces one; the old stays as history. */
export function useSupersedeMemory() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, input }: { memoryId: string; input: SupersedeMemoryInput }) => client.supersedeMemory(memoryId, input),
    onSuccess: () => settle(queryClient, keys),
  });
}
