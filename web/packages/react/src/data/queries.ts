/**
 * Read hooks (F1). TanStack Query owns all server state; keys come from the
 * provider's key factory (scoped by base URL, tenant and identity). Events
 * keep these queries fresh (`useTangentEvents`), so nothing polls.
 */
import type { BranchList, ListLinesQuery, MessagePage, TangentClient } from "@tangent/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { useTangent } from "../provider";

/** The server's page limit for `GET /messages` (B4: 1..500). */
export const MESSAGE_PAGE_LIMIT = 500;
/** Stop after this many pages (10 000 messages); longer lines are summarized by then. */
const MAX_MESSAGE_PAGES = 20;
/** Capabilities change only when the server is reconfigured; reconnects refresh them anyway. */
const CAPABILITIES_STALE_MS = 5 * 60_000;

/** Every message of a line in seq order, read in pages of MESSAGE_PAGE_LIMIT. */
export async function fetchAllMessages(client: TangentClient, lineId: string, signal?: AbortSignal): Promise<MessagePage> {
  let messages: MessagePage["messages"] = [];
  let afterSeq = 0;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const batch = await client.listMessages(lineId, { afterSeq, limit: MESSAGE_PAGE_LIMIT }, signal ? { signal } : undefined);
    messages = [...messages, ...batch.messages];
    const last = batch.messages.at(-1);
    if (batch.messages.length < MESSAGE_PAGE_LIMIT || !last) break;
    afterSeq = last.seq;
  }
  return { messages };
}

export function useCapabilities() {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.capabilities(), queryFn: ({ signal }) => client.getCapabilities({ signal }), staleTime: CAPABILITIES_STALE_MS });
}

/** Main lines, newest activity first; `archived: true` lists the archived ones. */
export function useLines(query: ListLinesQuery = {}, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.lines(query), queryFn: ({ signal }) => client.listLines(query, { signal }), enabled });
}

/** One line (`LineView`); disabled while `lineId` is null. */
export function useLine(lineId: string | null) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.lineView(lineId ?? ""),
    queryFn: ({ signal }) => client.getLine(lineId ?? "", { signal }),
    enabled: lineId !== null,
  });
}

/** A line's messages in seq order; disabled while `lineId` is null. */
export function useMessages(lineId: string | null) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.messages(lineId ?? ""),
    queryFn: ({ signal }) => fetchAllMessages(client, lineId ?? "", signal),
    enabled: lineId !== null,
  });
}

/**
 * The whole tree's outline. Pass the ROOT line's id (`line.conversationBranch?.rootLineId ?? line.id`):
 * the cache keeps one outline per tree, which `branch.changed` refreshes.
 */
export function useBranches(rootLineId: string | null, includeAside = false) {
  const { client, keys, live } = useTangent();
  // F18: branches a delete was asked for (not sent yet, it can still be undone) are left out. Only a branch with nothing under it waits.
  const hidden = useSyncExternalStore(
    live.subscribe,
    () => live.getState().hidden,
    () => live.getState().hidden,
  );
  const select = useCallback(
    (list: BranchList): BranchList => (hidden.size > 0 ? { ...list, branches: list.branches.filter((branch) => !hidden.has(branch.lineId)) } : list),
    [hidden],
  );
  return useQuery({
    queryKey: keys.branches(rootLineId ?? "", includeAside),
    queryFn: ({ signal }) => client.listBranches(rootLineId ?? "", { includeAside }, { signal }),
    enabled: rootLineId !== null,
    select,
  });
}

/**
 * What the next turn would send, for one draft text (POST /preview writes
 * nothing, so it is a query). `enabled` gates it, e.g. while the drawer is
 * open or the draft has settled.
 */
export function usePreview(lineId: string | null, content: string, enabled = true, options: { staleTime?: number; refetchOnWindowFocus?: boolean } = {}) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.preview(lineId ?? "", content),
    queryFn: ({ signal }) => client.previewTurn(lineId ?? "", { content }, { signal }),
    enabled: enabled && lineId !== null,
    ...options,
  });
}

/** How many hits the conversation list asks for (the server allows up to 50). */
export const SEARCH_LIMIT = 30;
/** Search results are a snapshot; reopening the same query a little later asks again. */
const SEARCH_STALE_MS = 15_000;

/**
 * Full-text search over titles, branch purposes and messages (B5 `GET
 * /search`, the `search` feature); disabled while `enabled` is false (the
 * feature off, or a query under 2 characters). The server searches either the
 * active conversations or, with `archived`, only the archived ones.
 */
export function useSearch(q: string, enabled = true, archived = false) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.search(q, archived),
    queryFn: ({ signal }) => client.search({ q, limit: SEARCH_LIMIT, ...(archived ? { archived: true } : {}) }, { signal }),
    enabled,
    staleTime: SEARCH_STALE_MS,
    retry: false,
  });
}
