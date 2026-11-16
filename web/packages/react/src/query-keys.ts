import { normalizeBaseUrl, type ListLinesQuery } from "@tangent/client";

export interface TangentKeyScope {
  baseUrl: string;
  tenant?: string | undefined;
  /** The viewer's identity; see `TangentProviderProps.scopeKey`. */
  scopeKey?: string | undefined;
}

/**
 * TanStack Query keys. Every key starts with `["tangent", baseUrl, tenant,
 * scopeKey]`, so two servers, tenants or signed-in identities never share
 * cache entries, and line-scoped keys nest under `line(id)` so invalidating a
 * line reaches all of them. On an identity change the host should still call
 * `queryClient.clear()`; the new keys only stop old entries from being read.
 */
export function tangentKeys(scope: TangentKeyScope) {
  const all = ["tangent", normalizeBaseUrl(scope.baseUrl), scope.tenant ?? "", scope.scopeKey ?? ""] as const;
  const line = (lineId: string) => [...all, "line", lineId] as const;
  return {
    all,
    capabilities: () => [...all, "capabilities"] as const,
    /** GET /search for one query (B5); not line-scoped, so writes do not reach it (it is short-lived instead). */
    search: (q: string, archived = false) => [...all, "search", q, { archived }] as const,
    lineLists: () => [...all, "lines"] as const,
    /**
     * `GET /lines/organization` (B18.1): the tenant's folders and tags with counts. Deliberately not under `lineLists()`:
     * the list updaters there treat every entry as a `LinePage`.
     */
    lineOrganization: () => [...all, "organization"] as const,
    lines: (query: ListLinesQuery = {}) =>
      [...all, "lines", { archived: query.archived ?? false, limit: query.limit ?? null, cursor: query.cursor ?? "", folder: query.folder ?? "", tag: query.tag ?? "" }] as const,
    line,
    /** The `LineView` itself (GET /lines/{id}); `line(id)` is only the prefix of every line key. */
    lineView: (lineId: string) => [...line(lineId), "view"] as const,
    messages: (lineId: string) => [...line(lineId), "messages"] as const,
    /** POST /preview for one draft text (read-only, so a query). */
    preview: (lineId: string, content: string) => [...line(lineId), "preview", content] as const,
    stream: (lineId: string) => [...line(lineId), "stream"] as const,
    /**
     * The tree's outline, keyed under the ROOT line: `GET /branches` answers the
     * whole tree for any line, so one key per tree lets `branch.changed`
     * (addressed to the root) reach it. Pass the root line's id.
     */
    branchesOf: (rootLineId: string) => [...line(rootLineId), "branches"] as const,
    branches: (rootLineId: string, includeAside = false) => [...line(rootLineId), "branches", { includeAside }] as const,
    branch: (lineId: string) => [...line(lineId), "branch"] as const,
    /** POST /branches/preview for one set of inputs (writes nothing, so a query; B5). */
    branchPreview: (lineId: string, input: object) => [...line(lineId), "branchPreview", input] as const,
    notes: (rootLineId: string) => [...line(rootLineId), "notes"] as const,
    /** Every line's chapters of a tree, under the root (`chapters.changed` names the root). */
    chaptersOf: (rootLineId: string) => [...line(rootLineId), "chapters"] as const,
    chapters: (rootLineId: string, lineId: string = rootLineId) => [...line(rootLineId), "chapters", lineId] as const,
    /** A branch's leaf (B8 `GET /lines/{id}/leaf`). */
    leaf: (lineId: string) => [...line(lineId), "leaf"] as const,
    /** The tree's parking lot, under the root (`seeds.changed` names the root); `status` as the route takes it. */
    seedsOf: (rootLineId: string) => [...line(rootLineId), "seeds"] as const,
    seeds: (rootLineId: string, status = "open") => [...line(rootLineId), "seeds", { status }] as const,
    /** The tree's suggestion inbox, under the root. */
    suggestionsOf: (rootLineId: string) => [...line(rootLineId), "suggestions"] as const,
    suggestions: (rootLineId: string, status = "open") => [...line(rootLineId), "suggestions", { status }] as const,
    /**
     * Seeds and suggestions this page decided (the writes' results, with when):
     * the inbox keeps showing them, as expanded / noted / accepted…, while it
     * stays open. Never fetched, so invalidation does not clear them.
     */
    /** `POST /spinoff/preview` for one body (writes nothing, so a query; B8.2). */
    spinoffPreview: (lineId: string, input: object) => [...line(lineId), "spinoffPreview", input] as const,
    /** The tree's links to other conversations (B8 phase B, spinoff). */
    links: (rootLineId: string) => [...line(rootLineId), "links"] as const,
    /** The tree's goal (B9), under the root (`goal.changed` names the root). */
    goal: (rootLineId: string) => [...line(rootLineId), "goal"] as const,
    /** The tree's groups (B9 phase C `GET /groups`), under the root (`group.changed` names it); `status` as the route takes it. */
    groupsOf: (rootLineId: string) => [...line(rootLineId), "groups"] as const,
    /** A line's folds (B10 phase A, `GET /lines/{id}/folds`). */
    folds: (lineId: string) => [...line(lineId), "folds"] as const,
    /** The comparisons of the branches under a line (B10 phase B, `GET /lines/{id}/comparisons`). */
    comparisons: (lineId: string) => [...line(lineId), "comparisons"] as const,
    groups: (rootLineId: string, status = "active") => [...line(rootLineId), "groups", { status }] as const,
    /** The tree's relations (B9 `GET /relations`), under the root (`link.changed` names each tree it touches). */
    relations: (rootLineId: string) => [...line(rootLineId), "relations"] as const,
    /** The tree's AI-drafted argument types (B15 `GET /tag-drafts`), under the root (`message.updated` names it). */
    tagDrafts: (rootLineId: string) => [...line(rootLineId), "tagDrafts"] as const,
    /** The tree's memos (B13 `GET /memos`), under the root (`memo.changed` names it). */
    memos: (rootLineId: string) => [...line(rootLineId), "memos"] as const,
    /** The tree's glossary (B24 `GET /lines/{id}/terms`), under the root (`terms.changed` names it). */
    terms: (rootLineId: string) => [...line(rootLineId), "terms"] as const,
    /** `GET /terms` across conversations for one query (F19 §2.4); not line-scoped, any `terms.changed` reloads it. */
    termSearchAll: () => [...all, "termSearch"] as const,
    termSearch: (q: string) => [...all, "termSearch", q] as const,
    /**
     * `GET /open-loops` (B9): for one tree (`root`) or across conversations
     * (null). Not line-scoped: seeds, suggestions, notes and branches of any
     * tree change it, so those events invalidate the whole prefix.
     */
    openLoopsAll: () => [...all, "openLoops"] as const,
    /** The tenant's memories (B10 phase C): not line-scoped. */
    memoriesAll: () => [...all, "memories"] as const,
    memories: (query: { kind?: string; status?: string; limit?: number } = {}) =>
      [...all, "memories", "list", { kind: query.kind ?? "", status: query.status ?? "active", limit: query.limit ?? 0 }] as const,
    /** POST /memories/search for one query (a read). */
    memorySearch: (query: string) => [...all, "memories", "search", query] as const,
    openLoops: (rootLineId: string | null) => [...all, "openLoops", rootLineId ?? ""] as const,
    seedsDecided: (rootLineId: string) => [...line(rootLineId), "seedsDecided"] as const,
    /** `GET /lines/{id}/decompose` (B18): one snapshot per opening of the panel. */
    decompose: (lineId: string) => [...line(lineId), "decompose"] as const,
    suggestionsDecided: (rootLineId: string) => [...line(rootLineId), "suggestionsDecided"] as const,
  };
}

export type TangentKeys = ReturnType<typeof tangentKeys>;
