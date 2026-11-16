/**
 * SSE → cache (F1). Events never go into a global store: each one either
 * updates the exact query it concerns (`setQueryData` on data that is already
 * cached) or invalidates queries. Streamed deltas and retries are transient
 * UI state and go to the live store, batched per animation frame. After a
 * reconnect or `stream.lagged` everything Tangent cached is invalidated,
 * because events were missed.
 */
import { isHostNotice, type BranchList, type BranchView, type Delta, type LinePage, type LineView, type Message, type MessagePage, type TangentEvent } from "@tangent/client";
import { hashKey, notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";
import type { LiveStore } from "./live-store";
import { markDelivered, upsertMessage } from "./message-cache";
import { writeLeaf } from "./leaf-cache";
import { forgetLines } from "./tree-cache";

export interface SyncTarget {
  queryClient: QueryClient;
  keys: TangentKeys;
  live: LiveStore;
}

export interface EventSync {
  apply(event: TangentEvent): void;
  /** Writes the deltas waiting for the next frame now. */
  flush(): void;
  dispose(): void;
}

export interface EventSyncOptions {
  /** Runs `flush` before the next paint; defaults to requestAnimationFrame (a 16 ms timer without one). */
  schedule?: (flush: () => void) => void;
}

type Updater = (data: unknown) => unknown;

const defaultSchedule = (flush: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
};

const byActivity = (a: LineView, b: LineView) => b.lastActivityAt.localeCompare(a.lastActivityAt);

/** The event stream is in order, so its copy of a message is authoritative. */
const fromEvent = { authoritative: true } as const;

/** Everything Tangent cached is stale (events were missed); streams are read again. */
export function resyncAll(target: SyncTarget): void {
  void target.queryClient.invalidateQueries({ queryKey: target.keys.all });
  target.live.resync();
}

export function createEventSync(target: SyncTarget, options: EventSyncOptions = {}): EventSync {
  const { queryClient, keys, live } = target;
  const schedule = options.schedule ?? defaultSchedule;
  /** Updates of queries that were loading when the event came; applied once the load lands. */
  const queued = new Map<string, { key: QueryKey; updates: Updater[] }>();
  let deltas = new Map<string, Delta[]>();
  let scheduled = false;
  let disposed = false;

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const entry = queued.get(event.query.queryHash);
    if (!entry || event.query.state.fetchStatus !== "idle") return;
    queued.delete(event.query.queryHash);
    if (event.query.state.status !== "success") return;
    queryClient.setQueryData(entry.key, (data: unknown) => (data === undefined ? data : entry.updates.reduce<unknown>((current, update) => update(current), data)));
  });

  /**
   * Applies `update` to cached data only (no page is created for a line
   * nobody shows). A load in flight — the first page or a refetch — may have
   * started before the event, so the update is also queued and applied again
   * when it lands, instead of cancelling and restarting a multi-page load.
   */
  function updateCached<T>(queryKey: QueryKey, update: (data: T) => T): void {
    const apply = update as Updater;
    if (queryClient.getQueryData(queryKey) !== undefined) queryClient.setQueryData<T>(queryKey, (data) => (data === undefined ? data : update(data)));
    if (queryClient.isFetching({ queryKey, exact: true }) === 0) return;
    const hash = hashKey(queryKey);
    const entry = queued.get(hash) ?? { key: queryKey, updates: [] };
    queued.set(hash, { key: queryKey, updates: [...entry.updates, apply] });
  }

  const invalidate = (queryKey: QueryKey) => void queryClient.invalidateQueries({ queryKey });
  /** Every cached `POST /preview` of this scope (previews are keyed by line and draft). */
  const invalidatePreviews = () => void queryClient.invalidateQueries({ predicate: (query) => keys.all.every((part, index) => query.queryKey[index] === part) && query.queryKey.at(-2) === "preview" });

  function flush(): void {
    scheduled = false;
    if (disposed || deltas.size === 0) return;
    const batch = deltas;
    deltas = new Map();
    for (const [lineId, items] of batch) live.addDeltas(lineId, items);
  }

  function flushLine(lineId: string): void {
    const items = deltas.get(lineId);
    if (!items) return;
    deltas.delete(lineId);
    live.addDeltas(lineId, items);
  }

  function onDelta(lineId: string, delta: Delta): void {
    deltas.set(lineId, [...(deltas.get(lineId) ?? []), delta]);
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  /** The outline's branches forking from `message` carry its tag (`anchorTag`, B10 phase A): written in place. */
  function onAnchorTag(rootLineId: string, message: Message): void {
    queryClient.setQueriesData<BranchList>({ queryKey: keys.branchesOf(rootLineId) }, (list) => {
      if (!list?.branches.some((branch) => branch.anchorMessageId === message.id && JSON.stringify(branch.anchorTag) !== JSON.stringify(message.tag))) return list;
      const branches = list.branches.map((branch) => {
        if (branch.anchorMessageId !== message.id) return branch;
        const { anchorTag: _old, ...rest } = branch;
        return message.tag ? { ...rest, anchorTag: message.tag } : rest;
      });
      return { ...list, branches };
    });
  }

  function onMessage(lineId: string, message: Message, rootLineId = ""): void {
    const cached = queryClient.getQueryData<MessagePage>(keys.messages(lineId))?.messages.find((item) => item.id === message.id);
    updateCached<MessagePage>(keys.messages(lineId), (page) => upsertMessage(page, message, fromEvent));
    if (rootLineId) onAnchorTag(rootLineId, message);
    // B15: a tag drafted, confirmed or put back changes the tree's draft list.
    // A line not loaded here gives nothing to compare with (another tab may have cleared a draft there): read the list again.
    if (rootLineId && (!cached || cached.tag?.status !== message.tag?.status || cached.tag?.kind !== message.tag?.kind)) invalidate(keys.tagDrafts(rootLineId));
    // A tag written on a finished message (B10 phase A) is not news about the turn.
    if (cached && message.status !== "pending" && cached.status === message.status && cached.content === message.content) return;
    // B7.2: a host's notice is in the next turn's history (it may come while a reply streams; it never touches the stream).
    if (isHostNotice(message)) invalidate([...keys.line(lineId), "preview"]);
    if (message.role !== "assistant") return;
    if (message.status === "pending") {
      live.beginTurn(lineId, message.id);
      return;
    }
    flushLine(lineId);
    // CompleteTurn marks the cards the turn carried as delivered without an event of their own.
    const carried = message.meta.deliversCards ?? [];
    if (message.status === "done" && !message.meta.cancelled && carried.length > 0) {
      updateCached<MessagePage>(keys.messages(lineId), (page) => markDelivered(page, carried));
    }
    // In the same notification batch as the query observers, so no frame shows
    // the reply still pending with its streamed text already gone.
    notifyManager.schedule(() => live.finishTurn(lineId, message.id));
    // The history changed, so any preview of the next turn is out of date.
    invalidate([...keys.line(lineId), "preview"]);
  }

  /** A `keys.lines(query)` key with a folder or tag filter. */
  function isFilteredList(queryKey: readonly unknown[]): boolean {
    const query = queryKey[queryKey.length - 1] as { folder?: unknown; tag?: unknown } | undefined;
    return typeof query === "object" && query !== null && (Boolean(query.folder) || Boolean(query.tag));
  }

  /** B20: a main line attached to another conversation is a branch now; it leaves the cached lists (and the folder counts). */
  function dropAttached(lineId: string, known: LineView | undefined): void {
    queryClient.setQueriesData<LinePage>({ queryKey: keys.lineLists() }, (page) =>
      page?.lines.some((item) => item.id === lineId) ? { ...page, lines: page.lines.filter((item) => item.id !== lineId) } : page,
    );
    // It was a main line here: its folder and tags left the tenant's counts (a branch's own updates do not reload them).
    if (known && !known.conversationBranch) invalidate(keys.lineOrganization());
  }

  /** Puts a changed main line into the cached lists; a change of archive state moves it between lists, so they reload. */
  function onLineUpdated(line: LineView): void {
    const cached = queryClient.getQueryData<LineView>(keys.lineView(line.id));
    // B18: what this page knew of its folder and tags (its view, else any list holding it), before the change.
    const known =
      cached ??
      queryClient
        .getQueriesData<LinePage>({ queryKey: keys.lineLists() })
        .flatMap(([, page]) => page?.lines ?? [])
        .find((item) => item.id === line.id);
    // A newer summary answers a pending summary.due (B8.2).
    if (cached && cached.summary.updatedAt !== line.summary.updatedAt) live.setSummaryDue(line.id, false);
    if (cached !== undefined) queryClient.setQueryData(keys.lineView(line.id), line);
    if (line.conversationBranch) return dropAttached(line.id, known);
    // B18.1: the tenant's folder and tag counts, when its folder, tags or archive state changed (or nothing here knew them).
    if (!known || known.folder !== line.folder || known.tags.join("\n") !== line.tags.join("\n") || Boolean(known.archivedAt) !== Boolean(line.archivedAt)) {
      invalidate(keys.lineOrganization());
    }
    let moved = false;
    queryClient.setQueriesData<LinePage>({ queryKey: keys.lineLists() }, (page) => {
      const current = page?.lines.find((item) => item.id === line.id);
      if (!page || !current) return page;
      // A change of archive state, folder or tags may move it between lists (B18: the folder and #tag filters).
      if (Boolean(current.archivedAt) !== Boolean(line.archivedAt) || current.folder !== line.folder || current.tags.join("\n") !== line.tags.join("\n")) {
        moved = true;
        return page;
      }
      return { ...page, lines: page.lines.map((item) => (item.id === line.id ? line : item)).sort(byActivity) };
    });
    // A filtered list may have to take it in (a new tag or folder), though it was never on that page: when the
    // folder or tags changed, or nothing here knew them, the folder / #tag lists reload.
    const organized = !known || known.folder !== line.folder || known.tags.join("\n") !== line.tags.join("\n");
    if (moved) invalidate(keys.lineLists());
    else if (organized) void queryClient.invalidateQueries({ queryKey: keys.lineLists(), predicate: (query) => isFilteredList(query.queryKey) });
  }

  /**
   * The whole tree is gone (F7: the same as the delete's own result, see tree-cache), or only some of its lines
   * (B23: a deleted branch, a continued or cleared aside; `rootLineId` is then the main line that stays).
   */
  function onLineDeleted(rootLineId: string, lineIds: readonly string[]): void {
    for (const id of lineIds) deltas.delete(id);
    forgetLines(target, rootLineId, lineIds);
  }

  /**
   * The tree's outline, the branch's detail and the lines it belongs to
   * reload: a tab showing the branch learns it ended (its `conversationBranch`
   * status lives on the line). A move or a promotion also moved messages
   * between lines, so the root's line and those transcripts reload too.
   */
  function onBranchChanged(change: string, branch: BranchView, event: TangentEvent): void {
    const root = branch.rootLineId || event.rootLineId;
    const lineId = branch.lineId || event.lineId;
    invalidate(keys.branchesOf(root));
    invalidate(keys.branch(lineId));
    // B23: kept or let go changes only the branch's own `keptAt`; its lines are as they were.
    if (change === "kept") return;
    for (const id of new Set([lineId, branch.parentLineId].filter(Boolean))) invalidate(keys.lineView(id));
    // B8 phase B: a detached branch is a conversation of its own now (its line.created brings it to the list too).
    if (change === "detached") invalidate(keys.lineLists());
    if (change !== "moved" && change !== "promoted") return;
    for (const id of new Set([root, lineId, branch.parentLineId].filter(Boolean))) {
      invalidate(keys.messages(id));
      invalidate(keys.lineView(id));
    }
  }

  /** A seed, suggestion, note or branch changed: the open-loops views (B9) reload. */
  const invalidateOpenLoops = () => invalidate(keys.openLoopsAll());

  function apply(event: TangentEvent): void {
    if (event.type === "seeds.changed" || event.type === "suggestion.changed" || event.type === "notes.changed" || event.type === "branch.changed") invalidateOpenLoops();
    switch (event.type) {
      case "message.delta":
        return onDelta(event.lineId, event.data);
      case "message.created":
        return onMessage(event.lineId, event.data, event.rootLineId);
      case "message.updated":
        return onMessage(event.lineId, event.data, event.rootLineId);
      case "line.created":
        if (queryClient.getQueryData(keys.lineView(event.data.id)) !== undefined) queryClient.setQueryData(keys.lineView(event.data.id), event.data);
        if (!event.data.conversationBranch) {
          invalidate(keys.lineLists());
          invalidate(keys.lineOrganization());
        }
        return;
      case "line.updated":
        return onLineUpdated(event.data);
      case "line.deleted":
        return onLineDeleted(event.data.rootLineId, event.data.lineIds);
      case "branch.changed":
        return onBranchChanged(event.data.change, event.data.branch, event);
      case "notes.changed":
        invalidate(keys.notes(event.data.rootLineId || event.rootLineId));
        // The notes block is in every prompt of the tree; previews are keyed by line, so all of them reload.
        return invalidatePreviews();
      case "chapters.changed":
        return invalidate(keys.chaptersOf(event.data.rootLineId || event.rootLineId));
      case "turn.retrying":
        flushLine(event.lineId);
        return live.setRetrying(event.lineId, event.data);
      case "stream.lagged":
        deltas = new Map();
        return resyncAll(target);
      // B8: a leaf is written in place; the parking lot and the suggestion inbox reload (the count comes with line.updated).
      case "leaf.changed":
        return writeLeaf(queryClient, keys, event.data.lineId || event.lineId, event.data.rootLineId || event.rootLineId, event.data.leaf, event.data.draftError);
      case "seeds.changed":
        return invalidate(keys.seedsOf(event.data.rootLineId || event.rootLineId));
      case "suggestion.changed":
        return invalidate(keys.suggestionsOf(event.data.rootLineId || event.rootLineId));
      case "summary.due":
        return live.setSummaryDue(event.data.lineId || event.lineId, true);
      case "link.changed": {
        const root = event.data.rootLineId || event.rootLineId;
        invalidate(keys.links(root));
        return invalidate(keys.relations(root));
      }
      // B9 phase C: a group changed; a ready one reaches the prompt through fisheye, so previews reload too.
      case "group.changed":
        invalidate(keys.groupsOf(event.data.rootLineId || event.rootLineId));
        return invalidatePreviews();
      case "job.failed":
        return live.jobFailed(event.data);
      case "fold.changed":
        invalidate(keys.folds(event.data.lineId || event.lineId));
        return invalidatePreviews();
      case "memory.changed":
        invalidate(keys.memoriesAll());
        return invalidatePreviews();
      case "memo.changed":
        return invalidate(keys.memos(event.data.rootLineId || event.rootLineId));
      // B24: the tree's glossary and the searches across conversations; the terms are in every prompt of the tree, so previews reload.
      case "terms.changed":
        invalidate(keys.terms(event.data.rootLineId || event.rootLineId));
        invalidate(keys.termSearchAll());
        return invalidatePreviews();
      case "comparison.changed":
        return invalidate(keys.comparisons(event.data.comparison.parentLineId || event.lineId));
      // B9: the goal is written in place; it is in every prompt of the tree, so previews reload.
      case "goal.changed":
        queryClient.setQueryData(keys.goal(event.data.rootLineId || event.rootLineId), { goal: event.data.goal });
        return invalidatePreviews();
    }
  }

  return {
    apply,
    flush,
    dispose() {
      disposed = true;
      unsubscribe();
      queued.clear();
      deltas = new Map();
    },
  };
}

/** Applies one event right away (deltas included); for tests and one-off use. */
export function applyEvent(target: SyncTarget, event: TangentEvent): void {
  const sync = createEventSync(target, { schedule: () => undefined });
  sync.apply(event);
  sync.flush();
  sync.dispose();
}
