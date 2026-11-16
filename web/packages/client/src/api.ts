/**
 * Typed fetch client for the Tangent HTTP API (DESIGN §7): one method per
 * route. Every 2xx body passes through a normalizer, so nil slices and
 * missing fields never reach callers. Non-2xx responses throw a
 * `TangentError`; so does a 2xx body that is not JSON (`invalid_response`).
 */
import type {
  ChaptersView,
  CreateBranchInput,
  CreateLineInput,
  CreateMilestoneInput,
  CreateNoteInput,
  ListBranchesQuery,
  ListLinesQuery,
  ListMessagesQuery,
  MergeBranchBody,
  MoveBranchInput,
  PreviewTurnInput,
  SendMessageInput,
  SupersedeNoteInput,
  UpdateLineInput,
  UpdateNoteInput,
} from "./api-types";
import {
  normalizeBranchPreview,
  normalizeRenameBranchResult,
  normalizeSearchResult,
  type PreviewBranchInput,
  type RenameBranchInput,
  type SearchQuery,
} from "./b5-routes";
import { normalizeBranchDetail } from "./branch-normalize";
import { normalizeLinkList, normalizeSpinoffPreview, normalizeSpinoffResult, type SpinoffInput } from "./spinoff-routes";
import {
  normalizeExpandSeedResult,
  normalizeLeafResult,
  normalizeSeedList,
  normalizeSeedNoteResult,
  normalizeSeedWrite,
  normalizeSuggestionList,
  normalizeSuggestionWrite,
  type CreateSeedInput,
  type DiscardBranchBody,
  type ExpandSeedInput,
  type InboxListQuery,
  type LeafInput,
  type NoteSeedInput,
} from "./p1-routes";
import {
  normalizeGoalResult,
  normalizeOpenLoops,
  normalizePinResult,
  normalizeRelationList,
  normalizeRelationWrite,
  type CreateRelationInput,
  type OpenLoopsQuery,
  type PutGoalInput,
} from "./p2-routes";
import {
  normalizeCombineResult,
  normalizeGroupList,
  normalizeGroupResult,
  normalizeGroupWrite,
  type CombineBranchesInput,
  type CreateGroupInput,
  type GroupListQuery,
  type RenameGroupInput,
  type UpdateRelationInput,
} from "./group-routes";
import { normalizeFoldCreated, normalizeFoldList, normalizeFoldResult, type CreateFoldInput, type UpdateFoldInput } from "./fold-routes";
import {
  normalizeMemoryList,
  normalizeMemoryResult,
  normalizeMemorySearch,
  normalizeSupersedeResult,
  type CreateMemoryInput,
  type MemoryListQuery,
  type SearchMemoriesInput,
  type SupersedeMemoryInput,
  type UpdateMemoryInput,
} from "./memory-routes";
import { normalizeMemoList, normalizeMemoResult, type CreateMemoInput, type MemoListQuery } from "./memo-routes";
import {
  normalizeTermList,
  normalizeTermResult,
  normalizeTermSearchPage,
  normalizeTermWriteResult,
  type CreateTermInput,
  type TermSearchQuery,
  type UpdateTermInput,
} from "./glossary-routes";
import {
  normalizeComparisonList,
  normalizeComparisonResult,
  normalizeConvergeStarted,
  normalizeDecideResult,
  type ConvergeInput,
  type DecideInput,
  type DivergeInput,
} from "./comparison-routes";
import type { TagKind, TagStatus } from "./types";
import { normalizeTagDraftList } from "./b15-routes";
import { normalizeUpdateBranchCardResult, type UpdateBranchCardInput } from "./b17-routes";
import { normalizeAttachResult, type AttachLineInput } from "./b20-routes";
import {
  normalizeImportBatchDeletion,
  normalizeImportBatchPage,
  type DeleteImportBatchQuery,
  type ListImportBatchesQuery,
} from "./b25-routes";
import { normalizeContinueAsideResult, type ContinueAsideInput } from "./aside-routes";
import { normalizeImportAnalyzePlan, type ImportAnalyzeInput } from "./import-analyze";
import { normalizeDivergeModelsResult, normalizeSeedsBatchResult, normalizeTreeExport, type CreateSeedsBatchInput, type DivergeModelsInput } from "./b14-routes";
import {
  normalizeDecomposePlan,
  normalizeExtractResult,
  normalizeImportResult,
  normalizeLineOrganization,
  normalizeRenameFolderResult,
  type ExtractBranchInput,
  type ImportConversationInput,
  type RenameFolderInput,
} from "./b18-routes";

/** `PUT /messages/{mid}/tag`. */
export interface TagMessageInput {
  kind: TagKind;
  /** B15: `draft` puts the type back as AI's unconfirmed one (復原); `confirmed` by default. */
  status?: TagStatus;
}
import { normalizeBaseUrl } from "./base-url";
import { normalizeCapabilities } from "./capabilities";
import { normalizeChapters, normalizeMilestoneWrite } from "./chapters";
import { errorFromResponse } from "./error-response";
import { TangentError } from "./errors";
import { subscribeEvents, type EventSubscription, type SubscribeEventsOptions } from "./events";
import { normalizeLine } from "./line-normalize";
import {
  normalizeArchiveResult,
  normalizeBranchList,
  normalizeCancelResult,
  normalizeCreateBranchResult,
  normalizeDeleteLineResult,
  normalizeDiscardResult,
  normalizeJobStarted,
  normalizeLinePage,
  normalizeMergeBranchResult,
  normalizeMessagePage,
  normalizeMoveBranchResult,
  normalizeNotesView,
  normalizeNoteWriteResult,
  normalizePreviewResult,
  normalizePromoteResult,
  normalizeSendResult,
  normalizeStreamPage,
} from "./result-normalize";

export { normalizeBaseUrl } from "./base-url";

const NO_CONTENT = 204;

export interface TangentClientOptions {
  /** Prefix of every route, e.g. `/api` or `https://host/tangent`. */
  baseUrl: string;
  /** Extra headers per request, REST and SSE alike (the host's auth, tenant…). */
  headers?: () => HeadersInit;
  /** `fetch` credentials mode for REST and SSE; the browser default (`same-origin`) when unset. */
  credentials?: RequestCredentials;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** The request outlives the page (a write sent while the page is going away); passed to `fetch`. */
  keepalive?: boolean;
}

type QueryValue = string | number | boolean | undefined;
type Normalize<T> = (raw: unknown) => T;

interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Built lazily so an invalid id rejects the returned promise instead of throwing. */
  path: () => string;
  query?: Readonly<Record<string, QueryValue>> | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  keepalive?: boolean | undefined;
}

function queryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** One encoded path segment; "", "." and ".." would change the route, so they are refused. */
export function pathSegment(id: string): string {
  if (id === "" || id === "." || id === "..") throw new TangentError(0, `invalid id: "${id}"`, "invalid_id");
  return encodeURIComponent(id);
}

const linePath =
  (lineId: string, ...rest: string[]) =>
  (): string =>
    ["/lines", pathSegment(lineId), ...rest].join("/");
const fixed = (path: string) => (): string => path;
/** `/seeds/{sid}/…`, `/suggestions/{sid}/…` (B8) and `/messages/{mid}/pin` (B9): routes keyed by the item, not the line. */
const itemPath =
  (collection: "seeds" | "suggestions" | "messages" | "groups", id: string, action: string) =>
  (): string =>
    `/${collection}/${pathSegment(id)}/${action}`;
const ignore = (): void => undefined;

/** `Retry-After` in seconds (a number or an HTTP date), or null. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The error of a failed response, with `extra.retryAfterSeconds` when the server sent `Retry-After`. */
async function failure(response: Response): Promise<TangentError> {
  const error = errorFromResponse(response.status, response.statusText, await response.text(), response.headers.get("Content-Type") ?? "");
  const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
  if (retryAfter === null) return error;
  return new TangentError(error.status, error.message, error.code, { ...error.extra, retryAfterSeconds: retryAfter });
}

/** PATCH /lines/{id} needs at least one field; refuse an empty patch before sending it. */
function assertLinePatch(input: UpdateLineInput): UpdateLineInput {
  if (
    input.title === undefined &&
    input.provider === undefined &&
    input.model === undefined &&
    input.folder === undefined &&
    input.tags === undefined &&
    input.pinned === undefined &&
    input.reasoningEffort === undefined
  ) {
    throw new TangentError(0, "a line update needs a title, provider, model, folder, tags, pinned or reasoningEffort", "invalid_input");
  }
  return input;
}

function parseBody(status: number, text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TangentError(status, "invalid JSON response", "invalid_response");
  }
}

/** Builds a client; every method maps to one route of DESIGN §7. */
export function createTangentClient(options: TangentClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchFn: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(spec: RequestSpec, normalize: Normalize<T>): Promise<T> {
    const url = `${baseUrl}${spec.path()}${queryString(spec.query)}`;
    const headers = new Headers(options.headers?.());
    const hasBody = spec.body !== undefined;
    if (hasBody) headers.set("Content-Type", "application/json");
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await fetchFn(url, {
      method: spec.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
      ...(spec.signal ? { signal: spec.signal } : {}),
      ...(spec.keepalive ? { keepalive: true } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    if (!response.ok) throw await failure(response);
    const text = response.status === NO_CONTENT ? "" : await response.text();
    return normalize(parseBody(response.status, text));
  }

  const get = <T>(path: () => string, normalize: Normalize<T>, query?: RequestSpec["query"], opts?: RequestOptions) =>
    request({ method: "GET", path, query, signal: opts?.signal }, normalize);
  const post = <T>(path: () => string, normalize: Normalize<T>, body?: unknown, opts?: RequestOptions) =>
    request({ method: "POST", path, body, signal: opts?.signal }, normalize);
  const patch = <T>(path: () => string, normalize: Normalize<T>, body: unknown, opts?: RequestOptions) =>
    request({ method: "PATCH", path, body, signal: opts?.signal }, normalize);
  const put = <T>(path: () => string, normalize: Normalize<T>, body: unknown, opts?: RequestOptions) =>
    request({ method: "PUT", path, body, signal: opts?.signal }, normalize);
  const del = <T>(path: () => string, normalize: Normalize<T>, opts?: RequestOptions) =>
    request({ method: "DELETE", path, signal: opts?.signal, keepalive: opts?.keepalive }, normalize);

  const eventsUrl = (): string => `${baseUrl}/events`;

  return {
    baseUrl,
    /** URL of the SSE stream (`GET /events`). */
    eventsUrl,
    /** Opens `/events` with this client's headers, credentials and fetch (DESIGN §12: fetch-based SSE). */
    subscribe: (subscription: Omit<SubscribeEventsOptions, "url" | "headers" | "credentials" | "fetch">): EventSubscription =>
      subscribeEvents({
        ...subscription,
        url: eventsUrl(),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        fetch: fetchFn,
      }),

    // Lines
    listLines: (query: ListLinesQuery = {}, opts?: RequestOptions) =>
      get(
        fixed("/lines"),
        normalizeLinePage,
        { archived: query.archived, limit: query.limit, cursor: query.cursor, folder: query.folder || undefined, tag: query.tag || undefined, pinned: query.pinned },
        opts,
      ),
    createLine: (input: CreateLineInput, opts?: RequestOptions) => post(fixed("/lines"), normalizeLine, input, opts),
    getLine: (lineId: string, opts?: RequestOptions) => get(linePath(lineId), normalizeLine, undefined, opts),
    /** Rejects with `invalid_input` (status 0, nothing sent) when the patch is empty. */
    updateLine: async (lineId: string, input: UpdateLineInput, opts?: RequestOptions) => patch(linePath(lineId), normalizeLine, assertLinePatch(input), opts),
    /** Deletes the whole tree; only a main line can be deleted. */
    deleteLine: (lineId: string, opts?: RequestOptions) => del(linePath(lineId), normalizeDeleteLineResult, opts),
    archiveLine: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "archive"), normalizeArchiveResult, undefined, opts),
    unarchiveLine: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "unarchive"), normalizeArchiveResult, undefined, opts),
    markRead: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "read"), normalizeLine, undefined, opts),

    // Messages and turns
    listMessages: (lineId: string, query: ListMessagesQuery = {}, opts?: RequestOptions) =>
      get(linePath(lineId, "messages"), normalizeMessagePage, { afterSeq: query.afterSeq, limit: query.limit }, opts),
    sendMessage: (lineId: string, input: SendMessageInput, opts?: RequestOptions) =>
      post(linePath(lineId, "messages"), normalizeSendResult, input, opts),
    getStream: (lineId: string, afterSeq?: number, opts?: RequestOptions) =>
      get(linePath(lineId, "stream"), normalizeStreamPage, { afterSeq }, opts),
    cancelTurn: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "cancel"), normalizeCancelResult, undefined, opts),
    /**
     * Runs the line's last, failed turn again (B4.1, DESIGN §12): a new pending
     * reply under the same user message; the failed one stays as `error`.
     */
    retryTurn: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "retry"), normalizeSendResult, undefined, opts),
    compact: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "compact"), normalizeJobStarted, undefined, opts),
    previewTurn: (lineId: string, input: PreviewTurnInput = {}, opts?: RequestOptions) =>
      post(linePath(lineId, "preview"), normalizePreviewResult, input, opts),

    // Branches
    listBranches: (lineId: string, query: ListBranchesQuery = {}, opts?: RequestOptions) =>
      get(linePath(lineId, "branches"), normalizeBranchList, { includeAside: query.includeAside }, opts),
    createBranch: (lineId: string, input: CreateBranchInput, opts?: RequestOptions) =>
      post(linePath(lineId, "branches"), normalizeCreateBranchResult, input, opts),
    moveToBranch: (lineId: string, input: MoveBranchInput, opts?: RequestOptions) =>
      post(linePath(lineId, "branches", "move"), normalizeMoveBranchResult, input, opts),
    /** The background a branch opened now would get (B5); writes nothing. */
    previewBranch: (lineId: string, input: PreviewBranchInput, opts?: RequestOptions) =>
      post(linePath(lineId, "branches", "preview"), normalizeBranchPreview, input, opts),
    getBranch: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "branch"), normalizeBranchDetail, undefined, opts),
    /** An open branch's new purpose (B5); `branch.changed{renamed}` follows. */
    renameBranch: (lineId: string, input: RenameBranchInput, opts?: RequestOptions) =>
      patch(linePath(lineId, "branch"), normalizeRenameBranchResult, input, opts),
    startDraft: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "branch", "draft"), normalizeJobStarted, undefined, opts),
    mergeBranch: (lineId: string, body: MergeBranchBody, opts?: RequestOptions) =>
      post(linePath(lineId, "branch", "merge"), normalizeMergeBranchResult, body, opts),
    /** With `{leaf}` (B8, the leaf feature) the reason is written as the branch's leaf (`dead_end` unless another kind is given). */
    discardBranch: (lineId: string, body?: DiscardBranchBody, opts?: RequestOptions) =>
      post(linePath(lineId, "branch", "discard"), normalizeDiscardResult, body, opts),
    /**
     * B17: a merged branch's conclusion card, edited in place; the parent's next turn carries it again.
     * Refusals: `409 parent_busy` (the parent is mid-turn), `parent_closed`, `archived`, `branch_closed`, `422 invalid_card`.
     */
    updateBranchCard: (lineId: string, input: UpdateBranchCardInput, opts?: RequestOptions) =>
      patch(linePath(lineId, "branch", "card"), normalizeUpdateBranchCardResult, input, opts),
    /** Sends the `{confirm: true}` the server requires. */
    promoteBranch: (lineId: string, opts?: RequestOptions) =>
      post(linePath(lineId, "branch", "promote"), normalizePromoteResult, { confirm: true }, opts),
    /** B23: keeps an aside past its retention, or lets it go again; `branch.changed{kept}` follows when the state changed. */
    keepBranch: (lineId: string, keep: boolean, opts?: RequestOptions) => put(linePath(lineId, "branch", "keep"), normalizeRenameBranchResult, { keep }, opts),
    /**
     * B23: an answered aside becomes an open branch at the same place, with its question and answer in it. `line` is a new
     * line and `replacedLineId` (the aside) is gone; the messages keep their ids and are read again from the new line.
     */
    continueAside: (lineId: string, input?: ContinueAsideInput, opts?: RequestOptions) =>
      post(linePath(lineId, "branch", "continue"), normalizeContinueAsideResult, input, opts),
    /** B23: deletes an ended aside or a discarded branch with everything under it (`lineIds[0]` is the branch); the tree stays. */
    deleteBranch: (lineId: string, opts?: RequestOptions) => del(linePath(lineId, "branch"), normalizeDeleteLineResult, opts),

    // Notes
    listNotes: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "notes"), normalizeNotesView, undefined, opts),
    createNote: (lineId: string, input: CreateNoteInput, opts?: RequestOptions) =>
      post(linePath(lineId, "notes"), normalizeNoteWriteResult, input, opts),
    updateNote: (lineId: string, noteId: string, input: UpdateNoteInput, opts?: RequestOptions) =>
      patch(() => `${linePath(lineId, "notes")()}/${pathSegment(noteId)}`, normalizeNoteWriteResult, input, opts),
    supersedeNote: (lineId: string, noteId: string, input: SupersedeNoteInput, opts?: RequestOptions) =>
      post(() => `${linePath(lineId, "notes")()}/${pathSegment(noteId)}/supersede`, normalizeNoteWriteResult, input, opts),

    // Chapters
    listChapters: (lineId: string, opts?: RequestOptions): Promise<ChaptersView> =>
      get(linePath(lineId, "chapters"), normalizeChapters, undefined, opts),
    addMilestone: (lineId: string, input: CreateMilestoneInput, opts?: RequestOptions) =>
      post(linePath(lineId, "chapters", "milestones"), normalizeMilestoneWrite, input, opts),
    deleteMilestone: (lineId: string, milestoneId: string, opts?: RequestOptions) =>
      del(() => `${linePath(lineId, "chapters", "milestones")()}/${pathSegment(milestoneId)}`, ignore, opts),

    // Leaf (B8, the leaf feature): a branch's closing line.
    /** `{leaf: null}` when the branch has none. */
    getLeaf: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "leaf"), normalizeLeafResult, undefined, opts),
    /** Writes and confirms the leaf (no longer an AI draft). */
    putLeaf: (lineId: string, input: LeafInput, opts?: RequestOptions) => put(linePath(lineId, "leaf"), normalizeLeafResult, input, opts),
    deleteLeaf: (lineId: string, opts?: RequestOptions) => del(linePath(lineId, "leaf"), ignore, opts),
    /** Asks AI for a draft (202); `leaf.changed` brings it. */
    startLeafDraft: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "leaf", "draft"), normalizeJobStarted, undefined, opts),

    // Parking (B8): seeds of the whole tree.
    listSeeds: (lineId: string, query: InboxListQuery = {}, opts?: RequestOptions) => get(linePath(lineId, "seeds"), normalizeSeedList, { status: query.status }, opts),
    createSeed: (lineId: string, input: CreateSeedInput, opts?: RequestOptions) => post(linePath(lineId, "seeds"), normalizeSeedWrite, input, opts),
    /** Opens a branch from the seed (`origin: seed`); the same refusals as opening one. */
    expandSeed: (seedId: string, input: ExpandSeedInput = {}, opts?: RequestOptions) => post(itemPath("seeds", seedId, "expand"), normalizeExpandSeedResult, input, opts),
    /** Writes the seed into the notes (needs the notes feature). */
    noteSeed: (seedId: string, input: NoteSeedInput = {}, opts?: RequestOptions) => post(itemPath("seeds", seedId, "to-note"), normalizeSeedNoteResult, input, opts),
    dropSeed: (seedId: string, opts?: RequestOptions) => post(itemPath("seeds", seedId, "drop"), normalizeSeedWrite, undefined, opts),

    // The suggestion inbox (B8): suggestions of the whole tree, newest first.
    listSuggestions: (lineId: string, query: InboxListQuery = {}, opts?: RequestOptions) =>
      get(linePath(lineId, "suggestions"), normalizeSuggestionList, { status: query.status }, opts),
    /** The body depends on the suggestion's kind; `{}` when it needs none. */
    acceptSuggestion: (suggestionId: string, body: Readonly<Record<string, unknown>> = {}, opts?: RequestOptions) =>
      post(itemPath("suggestions", suggestionId, "accept"), normalizeSuggestionWrite, body, opts),
    dismissSuggestion: (suggestionId: string, opts?: RequestOptions) => post(itemPath("suggestions", suggestionId, "dismiss"), normalizeSuggestionWrite, undefined, opts),
    /** B17: every open suggestion of the tree (any line of it), newest first; `[]` when there was none. No body is sent. */
    dismissAllSuggestions: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "suggestions", "dismiss-all"), normalizeSuggestionList, undefined, opts),

    // Spinoff (B8 phase B, the spinoff feature); the UI comes with F4 phase 2.
    spinoff: (lineId: string, input: SpinoffInput, opts?: RequestOptions) => post(linePath(lineId, "spinoff"), normalizeSpinoffResult, input, opts),
    /** The capsule that spinoff would carry, with its tokens (B8.2); writes nothing, a viewer may call it. */
    previewSpinoff: (lineId: string, input: SpinoffInput, opts?: RequestOptions) => post(linePath(lineId, "spinoff", "preview"), normalizeSpinoffPreview, input, opts),
    listLinks: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "links"), normalizeLinkList, undefined, opts),

    // Goal (B9, the goal feature): `{id}` may be any line of the tree; the goal is the tree's.
    /** `{goal: null}` when the conversation has none. */
    getGoal: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "goal"), normalizeGoalResult, undefined, opts),
    /** Sets the goal as the user's (`source: manual`); open AI proposals expire. */
    putGoal: (lineId: string, input: PutGoalInput, opts?: RequestOptions) => put(linePath(lineId, "goal"), normalizeGoalResult, input, opts),
    /** 404 `goal_not_found` when there is none. */
    deleteGoal: (lineId: string, opts?: RequestOptions) => del(linePath(lineId, "goal"), ignore, opts),
    /** Asks AI for a goal (202); the proposal arrives in the suggestion inbox (auto mode: written as the goal). */
    proposeGoal: (lineId: string, opts?: RequestOptions) => post(linePath(lineId, "goal", "propose"), normalizeJobStarted, undefined, opts),

    // Relations (B9, the relations feature): links of kind `relation` touching the tree.
    listRelations: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "relations"), normalizeRelationList, undefined, opts),
    createRelation: (lineId: string, input: CreateRelationInput, opts?: RequestOptions) => post(linePath(lineId, "relations"), normalizeRelationWrite, input, opts),
    deleteRelation: (lineId: string, relationId: string, opts?: RequestOptions) =>
      del(() => `${linePath(lineId, "relations")()}/${pathSegment(relationId)}`, ignore, opts),
    /** A relation's new label (B9 phase C); `link.changed` follows. */
    updateRelation: (lineId: string, relationId: string, input: UpdateRelationInput, opts?: RequestOptions) =>
      patch(() => `${linePath(lineId, "relations")()}/${pathSegment(relationId)}`, normalizeRelationWrite, input, opts),

    // Groups (B9 phase C, the group feature): ended branches of a tree under one shared summary.
    listGroups: (lineId: string, query: GroupListQuery = {}, opts?: RequestOptions) => get(linePath(lineId, "groups"), normalizeGroupList, { status: query.status }, opts),
    /** The summary starts drafting at once; `group.changed` brings it. */
    createGroup: (lineId: string, input: CreateGroupInput, opts?: RequestOptions) => post(linePath(lineId, "groups"), normalizeGroupWrite, input, opts),
    getGroup: (groupId: string, opts?: RequestOptions) => get(() => `/groups/${pathSegment(groupId)}`, normalizeGroupResult, undefined, opts),
    renameGroup: (groupId: string, input: RenameGroupInput, opts?: RequestOptions) => patch(() => `/groups/${pathSegment(groupId)}`, normalizeGroupResult, input, opts),
    dissolveGroup: (groupId: string, opts?: RequestOptions) => post(itemPath("groups", groupId, "dissolve"), normalizeGroupResult, undefined, opts),
    /** Writes the shared summary again (202). */
    summarizeGroup: (groupId: string, opts?: RequestOptions) => post(itemPath("groups", groupId, "summarize"), normalizeJobStarted, undefined, opts),
    /** Combines open sibling branches of `lineId` into one new branch (origin `merge`); the old ones end, `mergedIntoLineId` set. */
    combineBranches: (lineId: string, input: CombineBranchesInput, opts?: RequestOptions) =>
      post(linePath(lineId, "branches", "combine"), normalizeCombineResult, input, opts),

    // Open loops (B9, the open_loops feature): one conversation (`root`) or all of them.
    listOpenLoops: (query: OpenLoopsQuery = {}, opts?: RequestOptions) =>
      get(fixed("/open-loops"), normalizeOpenLoops, { root: query.root, staleDays: query.staleDays }, opts),

    // Pins (B9, core): a done user / assistant chat message or a conclusion card.
    pinMessage: (messageId: string, opts?: RequestOptions) => post(itemPath("messages", messageId, "pin"), normalizePinResult, undefined, opts),
    unpinMessage: (messageId: string, opts?: RequestOptions) => del(itemPath("messages", messageId, "pin"), normalizePinResult, opts),

    // Argument tags (B10 phase A, the ibis feature): a finished user / assistant chat message; `message.updated` follows.
    tagMessage: (messageId: string, input: TagMessageInput, opts?: RequestOptions) => put(itemPath("messages", messageId, "tag"), normalizePinResult, input, opts),
    /** B15: the tree's AI drafts (any line of it; a viewer may read it). */
    listTagDrafts: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "tag-drafts"), normalizeTagDraftList, undefined, opts),
    /** 200 with the message even when it had no tag. */
    untagMessage: (messageId: string, opts?: RequestOptions) => del(itemPath("messages", messageId, "tag"), normalizePinResult, opts),

    // Folds (B10 phase A, the fold feature): a run of a line's messages the model sees as a summary.
    listFolds: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "folds"), normalizeFoldList, undefined, opts),
    /** Without `summary` AI drafts one (`drafting`); `fold.changed` brings it. */
    createFold: (lineId: string, input: CreateFoldInput, opts?: RequestOptions) => post(linePath(lineId, "folds"), normalizeFoldCreated, input, opts),
    /** 204; the messages show and reach the model in full again. */
    deleteFold: (foldId: string, opts?: RequestOptions) => del(() => `/folds/${pathSegment(foldId)}`, ignore, opts),
    /** The user's summary (B10 phase B): the fold becomes active, `aiDrafted` false; a drafting job no longer writes it. */
    updateFold: (foldId: string, input: UpdateFoldInput, opts?: RequestOptions) => patch(() => `/folds/${pathSegment(foldId)}`, normalizeFoldResult, input, opts),

    // Diverge and converge (B10 phase B, the diverge feature): only when the user asks, in every mode.
    /** 202; the job opens all the directions as sibling branches (origin `diverge`) or none (`job.failed`). */
    diverge: (lineId: string, input: DivergeInput, opts?: RequestOptions) => post(linePath(lineId, "diverge"), normalizeJobStarted, input, opts),
    /** `lineId` is the parent; the table drafts (`comparison.changed` brings it). */
    converge: (lineId: string, input: ConvergeInput, opts?: RequestOptions) => post(linePath(lineId, "converge"), normalizeConvergeStarted, input, opts),
    listComparisons: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "comparisons"), normalizeComparisonList, undefined, opts),
    getComparison: (comparisonId: string, opts?: RequestOptions) => get(() => `/comparisons/${pathSegment(comparisonId)}`, normalizeComparisonResult, undefined, opts),
    /** The chosen branch gets a decision leaf and stays open; the other open compared branches end (dead end). */
    decideComparison: (comparisonId: string, input: DecideInput, opts?: RequestOptions) =>
      post(() => `/comparisons/${pathSegment(comparisonId)}/decide`, normalizeDecideResult, input, opts),

    // Memory (B10 phase C, the memory feature): the tenant's, not a tree's; never deleted, superseded instead.
    /** One page, newest first; `nextCursor` (B10.1) fetches the next with the same filters. */
    listMemories: (query: MemoryListQuery = {}, opts?: RequestOptions) =>
      get(fixed("/memories"), normalizeMemoryList, { kind: query.kind, status: query.status, limit: query.limit, cursor: query.cursor }, opts),
    createMemory: (input: CreateMemoryInput, opts?: RequestOptions) => post(fixed("/memories"), normalizeMemoryResult, input, opts),
    /** Category, importance and expiry only; the text changes by `supersedeMemory`. */
    updateMemory: (memoryId: string, input: UpdateMemoryInput, opts?: RequestOptions) => patch(() => `/memories/${pathSegment(memoryId)}`, normalizeMemoryResult, input, opts),
    /** A new memory replaces it; the old one stays readable (`status: superseded`). */
    supersedeMemory: (memoryId: string, input: SupersedeMemoryInput, opts?: RequestOptions) =>
      post(() => `/memories/${pathSegment(memoryId)}/supersede`, normalizeSupersedeResult, input, opts),
    /** A read (viewers may): the new conversation's first message or a new branch's purpose finds what was concluded before. */
    searchMemories: (input: SearchMemoriesInput, opts?: RequestOptions) => post(fixed("/memories/search"), normalizeMemorySearch, input, opts),

    // Memos (B13, the memo feature): notes on a node that never go to the AI.
    listMemos: (lineId: string, query: MemoListQuery = {}, opts?: RequestOptions) => get(linePath(lineId, "memos"), normalizeMemoList, { lineId: query.lineId }, opts),
    createMemo: (lineId: string, input: CreateMemoInput, opts?: RequestOptions) => post(linePath(lineId, "memos"), normalizeMemoResult, input, opts),
    updateMemo: (memoId: string, text: string, opts?: RequestOptions) => patch(() => `/memos/${pathSegment(memoId)}`, normalizeMemoResult, { text }, opts),
    deleteMemo: (memoId: string, opts?: RequestOptions) => del(() => `/memos/${pathSegment(memoId)}`, normalizeMemoResult, opts),

    // The glossary (B24, the glossary feature): a conversation's terms; only their names reach the AI.
    /** Any line of the tree; by `termKey`. */
    listTerms: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "terms"), normalizeTermList, undefined, opts),
    /** `lineId` is the line it is saved from (an aside is kept by it). `409 term_exists` carries the stored term; `replace: true` overwrites it. */
    createTerm: (lineId: string, input: CreateTermInput, opts?: RequestOptions) => post(linePath(lineId, "terms"), normalizeTermWriteResult, input, opts),
    updateTerm: (termId: string, input: UpdateTermInput, opts?: RequestOptions) => patch(() => `/terms/${pathSegment(termId)}`, normalizeTermResult, input, opts),
    /** 204. */
    deleteTerm: (termId: string, opts?: RequestOptions) => del(() => `/terms/${pathSegment(termId)}`, ignore, opts),
    /** The tenant's terms across conversations (archived ones left out), the ones that start with `q` first. */
    searchTerms: (query: TermSearchQuery = {}, opts?: RequestOptions) => get(fixed("/terms"), normalizeTermSearchPage, { q: query.q, limit: query.limit, cursor: query.cursor }, opts),

    // Capabilities
    getCapabilities: (opts?: RequestOptions) => get(fixed("/capabilities"), normalizeCapabilities, undefined, opts),

    // Search (B5, the search feature)
    search: (query: SearchQuery, opts?: RequestOptions) =>
      get(fixed("/search"), normalizeSearchResult, { q: query.q, limit: query.limit, archived: query.archived, root: query.root || undefined }, opts),

    // B14: the whole tree as data, branches across models, seeds in one go.
    /** Any line of the tree; core, so a viewer may read it. */
    exportTree: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "export"), normalizeTreeExport, undefined, opts),
    /** 2–5 targets (another count is `400 invalid_input`); every branch opens or none does. */
    divergeModels: (lineId: string, input: DivergeModelsInput, opts?: RequestOptions) => post(linePath(lineId, "diverge", "models"), normalizeDivergeModelsResult, input, opts),
    /** 1–20 texts; all parked or none (`409 seed_limit` when the lot would overflow). */
    createSeedsBatch: (lineId: string, input: CreateSeedsBatchInput, opts?: RequestOptions) => post(linePath(lineId, "seeds", "batch"), normalizeSeedsBatchResult, input, opts),

    // B18: folders, import, extract, decompose (all core).
    /** Every main line in `from` (archived too) moves to `to`; `to: ""` dissolves the folder. One `line.updated` per line. */
    renameFolder: (input: RenameFolderInput, opts?: RequestOptions) => post(fixed("/lines/folders/rename"), normalizeRenameFolderResult, input, opts),
    /** A conversation parsed from an export, written without a model (1–2,000 messages, ≤ 50 branches of 1–500, ≤ 50 chapter cuts; body ≤ 16 MiB). */
    importConversation: (input: ImportConversationInput, opts?: RequestOptions) => post(fixed("/lines/import"), normalizeImportResult, input, opts),
    /**
     * Any stretch of a line into a new branch; a marker (or, with `card`, a delivered card) stays in its place.
     * The marker takes an older seq than the client has read: reload the source's and the branch's messages after it.
     */
    extractBranch: (lineId: string, input: ExtractBranchInput, opts?: RequestOptions) => post(linePath(lineId, "branches", "extract"), normalizeExtractResult, input, opts),
    /** Suggestions to organise a line, made without a model and writing nothing (a viewer may read it). */
    decomposeLine: (lineId: string, opts?: RequestOptions) => get(linePath(lineId, "decompose"), normalizeDecomposePlan, undefined, opts),
    /** B18.1: the tenant's folders (active and archived apart) and the tags of its unarchived main lines, over every main line (a viewer may read it). */
    getLineOrganization: (opts?: RequestOptions) => get(fixed("/lines/organization"), normalizeLineOrganization, undefined, opts),

    // B20: attaching another conversation as a branch (core).
    /**
     * Hangs the main line `input.sourceLineId`, with its whole tree, on `targetLineId`; with `status: "merged"` its card is left on the
     * line, already delivered. The source leaves the main line list (`line.updated` carries its `conversationBranch`).
     */
    attachLine: (targetLineId: string, input: AttachLineInput, opts?: RequestOptions) => post(linePath(targetLineId, "attach"), normalizeAttachResult, input, opts),

    // B22: the import analysis (core; a read, so a viewer may ask; nothing is written).
    /**
     * A proposed tree for 1–200 units (rounds or conversations): units of one topic threaded into one node even across
     * other topics, each node a chapter, branch or conversation of its own. The server asks its model and falls back to
     * its deterministic analyzer (`source`), so only bad input (`400 invalid_input`) or the network fails it.
     */
    analyzeImport: (input: ImportAnalyzeInput, opts?: RequestOptions) => post(fixed("/lines/import-analyze"), normalizeImportAnalyzePlan, input, opts),

    // B25: import batches (core).
    /** One page of the tenant's client-named import batches, newest first. */
    listImportBatches: (query: ListImportBatchesQuery = {}, opts?: RequestOptions) =>
      get(fixed("/imports"), normalizeImportBatchPage, { limit: query.limit, cursor: query.cursor }, opts),
    /** Undoes a batch: deletes unused standalone trees (or used ones with `force`), returning deleted and kept line ids. */
    deleteImportBatch: (batchId: string, query: DeleteImportBatchQuery = {}, opts?: RequestOptions) =>
      request(
        {
          method: "DELETE",
          path: () => `/imports/${pathSegment(batchId)}`,
          query: { force: query.force },
          signal: opts?.signal,
          keepalive: opts?.keepalive,
        },
        normalizeImportBatchDeletion,
      ),
  };
}

export type TangentClient = ReturnType<typeof createTangentClient>;
