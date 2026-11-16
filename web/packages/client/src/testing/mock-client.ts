/**
 * `createMockTangentClient()`: an in-memory stand-in with the exact
 * `TangentClient` interface — routes, `TangentError`s with domain codes, and
 * an event stream with simulated streaming turns. Like the real client, every
 * result goes through the route's normalizer (on a structured clone, so the
 * caller never holds the mock's state) and `opts.signal` aborts a request.
 * Used by the demo's mock mode, by component tests and by the mock e2e run;
 * mock-contract.test.ts checks every simulated route's raw body against the
 * server's contract samples (`httpapi/testdata/contract/`).
 */
import type { ArchiveResult, CreateLineInput, DeleteLineResult, ListLinesQuery, ListMessagesQuery, UpdateLineInput } from "../api-types";
import type { RequestOptions, TangentClient } from "../api";
import { normalizeBranchPreview, normalizeRenameBranchResult, normalizeSearchResult } from "../b5-routes";
import { normalizeBranchDetail } from "../branch-normalize";
import { normalizeLinkList, normalizeSpinoffPreview, normalizeSpinoffResult } from "../spinoff-routes";
import { normalizeTagDraftList } from "../b15-routes";
import { normalizeUpdateBranchCardResult } from "../b17-routes";
import { normalizeGoalResult, normalizeOpenLoops, normalizePinResult, normalizeRelationList, normalizeRelationWrite } from "../p2-routes";
import {
  normalizeExpandSeedResult,
  normalizeLeafResult,
  normalizeSeedList,
  normalizeSeedNoteResult,
  normalizeSeedWrite,
  normalizeSuggestionList,
  normalizeSuggestionWrite,
} from "../p1-routes";
import { isFeatureOn, normalizeCapabilities } from "../capabilities";
import { normalizeChapters, normalizeMilestoneWrite } from "../chapters";
import { TangentError } from "../errors";
import { normalizeLine } from "../line-normalize";
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
} from "../result-normalize";
import type { HostMeta, JsonValue, LineView, Message } from "../types";
import { createMockBranchMoves } from "./mock-branch-moves";
import { createMockBranches } from "./mock-branches";
import { createMockBus } from "./mock-bus";
import { deleteTree } from "./mock-delete";
import { createMockInbox } from "./mock-inbox";
import { createMockMemos } from "./mock-memos";
import { createMockGlossary } from "./mock-glossary";
import { normalizeTermList, normalizeTermResult, normalizeTermSearchPage, normalizeTermWriteResult } from "../glossary-routes";
import { normalizeMemoList, normalizeMemoResult } from "../memo-routes";
import { createMockLeaves } from "./mock-leaves";
import { publishLine, type MockContext, type MockTimers } from "./mock-context";
import { createMockSpinoff } from "./mock-spinoff";
import { createMockP3 } from "./mock-p3";
import { normalizeFoldCreated, normalizeFoldList, normalizeFoldResult } from "../fold-routes";
import { normalizeComparisonList, normalizeComparisonResult, normalizeConvergeStarted, normalizeDecideResult } from "../comparison-routes";
import { createMockDiverge } from "./mock-diverge";
import { createMockB14 } from "./mock-b14";
import { createMockB18 } from "./mock-b18";
import { createMockB25 } from "./mock-b25";
import { createMockAttach } from "./mock-attach";
import { createMockAside } from "./mock-aside";
import { normalizeContinueAsideResult } from "../aside-routes";
import { normalizeAttachResult } from "../b20-routes";
import { normalizeImportBatchDeletion, normalizeImportBatchPage } from "../b25-routes";
import { normalizeImportAnalyzePlan } from "../import-analyze";
import { analyzeImportLocal } from "../import-analyze-local";
import { normalizeDecomposePlan, normalizeExtractResult, normalizeImportResult, normalizeLineOrganization, normalizeRenameFolderResult } from "../b18-routes";
import { normalizeDivergeModelsResult, normalizeSeedsBatchResult, normalizeTreeExport } from "../b14-routes";
import { createMockMemory } from "./mock-memory";
import { normalizeMemoryList, normalizeMemoryResult, normalizeMemorySearch, normalizeSupersedeResult } from "../memory-routes";
import { createMockNotes } from "./mock-notes";
import { createMockP2 } from "./mock-p2";
import { createMockGroups } from "./mock-groups";
import { normalizeCombineResult, normalizeGroupList, normalizeGroupResult, normalizeGroupWrite } from "../group-routes";
import { createMockResponder, type Normalize } from "./mock-respond";
import { mockSearch } from "./mock-search";
import { findBranch, findLine, initialState, messagesOf, newId, recount, rootOf, withLine, type MockState } from "./mock-store";
import { createMockTurns } from "./mock-turns";
import { fixture, type MockScenario } from "./scenario";
import { nasScenario } from "./scenario-nas";

export interface MockTangentClientOptions {
  /** Defaults to scenario 1 (家用 NAS 與備份策略). */
  scenario?: MockScenario;
  baseUrl?: string;
  tenant?: string;
  /** Delay before each response resolves; 0 resolves on the next microtask. */
  latencyMs?: number;
  /** Delay between streamed chunks. */
  chunkMs?: number;
  /** How long a conclusion-card draft takes. */
  draftMs?: number;
  now?: () => Date;
  timers?: MockTimers;
  /** Sees every raw result before it is normalized (the mock contract test checks their shapes). */
  inspect?: (route: string, raw: unknown) => void;
}

export interface MockControls {
  /** The current in-memory state (read-only snapshot). */
  snapshot(): MockState;
  /** Stops running turns and drafts. */
  dispose(): void;
  /** A host writes a system message (B7.2 `Engine.AppendSystemMessage`): at the end of the line, also while a reply streams. */
  appendSystemMessage(lineId: string, content: string): Message;
}

export type MockTangentClient = TangentClient & { readonly mock: MockControls };

const DEFAULT_CHUNK_MS = 40;
const DEFAULT_DRAFT_MS = 1200;
const DEFAULT_PAGE = 50;

const DEFAULT_TIMERS: MockTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createMockTangentClient(options: MockTangentClientOptions = {}): MockTangentClient {
  const scenario = options.scenario ?? nasScenario();
  const timers = options.timers ?? DEFAULT_TIMERS;
  const latency = options.latencyMs ?? 0;
  const clock = options.now ?? (() => new Date());
  let state = initialState(scenario, clock().toISOString());
  const pendingDrafts = new Set<unknown>();

  const ctx: MockContext = {
    state: () => state,
    commit: (next) => {
      state = next;
    },
    bus: createMockBus(options.tenant ?? "", (callback) => void Promise.resolve().then(callback)),
    scenario,
    now: () => clock().toISOString(),
    timers: {
      setTimeout: (callback, ms) => {
        const handle: unknown = timers.setTimeout(() => {
          pendingDrafts.delete(handle);
          callback();
        }, ms);
        pendingDrafts.add(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        pendingDrafts.delete(handle);
        timers.clearTimeout(handle);
      },
    },
    chunkMs: options.chunkMs ?? DEFAULT_CHUNK_MS,
    draftMs: options.draftMs ?? DEFAULT_DRAFT_MS,
  };
  const turns = createMockTurns(ctx);
  const branches = createMockBranches(ctx);
  const moves = createMockBranchMoves(ctx);
  const notes = createMockNotes(ctx);
  const leaves = createMockLeaves(ctx);
  /** Promote, with what follows it on the server (a leaf draft for the old tail, the branch's suggestions expire). */
  const promote = (lineId: string) => {
    const promoted = moves.promote(lineId);
    leaves.afterPromote(promoted.previousMainLine.lineId);
    inbox.expireFor([lineId]);
    return promoted;
  };
  const spinoffs = createMockSpinoff(ctx, {
    promote,
    propose: (suggestion) => inbox.propose(suggestion),
    expireFor: (ids) => inbox.expireFor(ids),
    notes: notes.list,
    dissolveGroups: (lineIds) => groups.dissolveOfLines(lineIds),
  });
  const memos = createMockMemos(ctx);
  const glossary = createMockGlossary(ctx);
  const inbox = createMockInbox(ctx, {
    createBranch: branches.create,
    createNote: notes.create,
    act: (suggestion, body) =>
      suggestion.feature === "rebalance"
        ? { ...spinoffs.acceptRebalance(suggestion, body) }
        : (p2.act(suggestion, body) ?? groups.act(suggestion, body) ?? p3.act(suggestion, body) ?? memory.act(suggestion, body)),
  });
  const groups = createMockGroups(ctx, { createBranch: branches.create, createNote: notes.create, propose: (suggestion) => inbox.propose(suggestion), expireFor: (ids) => inbox.expireFor(ids) });
  ctx.readyGroups = groups.readyGroups;
  const p2 = createMockP2(ctx, { createBranch: branches.create, propose: (suggestion) => inbox.propose(suggestion), expireWhere: (match) => inbox.expireWhere(match) });
  const p3 = createMockP3(ctx, { propose: (suggestion) => inbox.propose(suggestion), chapters: (lineId) => notes.chapters(lineId).chapters });
  ctx.activeFolds = p3.activeFolds;
  const diverging = createMockDiverge(ctx, { createBranch: branches.create });
  const memory = createMockMemory(ctx, { propose: (suggestion) => inbox.propose(suggestion) });
  const b14 = createMockB14(ctx, {
    createBranch: branches.create,
    notes: (root) => notes.list(root).notes,
    memos: (root) => memos.list(root, {}).memos,
    terms: (root) => glossary.list(root).terms,
    chapters: (root) => notes.chapters(root).chapters,
    links: (root) => p2.links(root, state.links).links,
  });
  const b18 = createMockB18(ctx, { afterMerge: (lineId, card) => leaves.afterMerge(lineId, card) });
  const b25 = createMockB25(ctx);
  const attaching = createMockAttach(ctx, { afterMerge: (lineId, card) => leaves.afterMerge(lineId, card) });
  const asides = createMockAside(ctx, { expireFor: (ids) => inbox.expireFor(ids) });
  ctx.recallMemories = (query) => {
    const results = memory.recall(query);
    return { results, block: results.length > 0 ? memory.recallBlock(results) : "" };
  };
  ctx.afterTurn = (lineId, content) => {
    inbox.afterTurn(lineId, content);
    spinoffs.afterTurn(lineId);
    p2.afterTurn(lineId, content);
    p3.afterTurn(lineId, content);
  };
  /** A branch and every line under it (suggestions about them expire when it ends). */
  const subtree = (lineId: string): string[] => [lineId, ...state.branches.filter((branch) => branch.parentLineId === lineId).flatMap((branch) => subtree(branch.lineId))];

  const responder = createMockResponder(latency, timers);
  const ignore: Normalize<void> = () => undefined;

  /** Runs `operation` after the simulated latency; its errors reject the promise like a failed request. */
  function call<T>(normalize: Normalize<T>, opts: RequestOptions | undefined, operation: () => unknown, route = ""): Promise<T> {
    const inspected = options.inspect
      ? () => {
          const raw = operation();
          options.inspect?.(route, raw);
          return raw;
        }
      : operation;
    return responder.respond(inspected, normalize, opts?.signal);
  }

  /** A host_meta object with its reasoning effort set (or removed by ""), as the reference server keeps it (G1). */
  function withReasoningEffort(meta: HostMeta, effort: string): HostMeta {
    const fields: Record<string, JsonValue> = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? { ...meta } : {};
    const level = effort.trim().toLowerCase();
    if (level === "") delete fields.reasoningEffort;
    else fields.reasoningEffort = level;
    return fields;
  }

  /** The defined fields of a PATCH body (an explicit `undefined` must not erase a value). */
  function defined<T extends object>(input: T): Partial<T> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
  }

  function updateLine(lineId: string, change: (line: LineView) => LineView): LineView {
    ctx.commit(withLine(state, change(findLine(state, lineId))));
    return publishLine(ctx, lineId);
  }

  function listLines(query: ListLinesQuery) {
    if (query.pinned) {
      if (query.cursor) throw new TangentError(400, "cursor cannot be used with pinned", "invalid_input", { field: "cursor" });
      const limit = Math.min(query.limit ?? 200, 200);
      const pinned = b18
        .filterLines(
          state.lines.filter((line) => !line.conversationBranch && Boolean(line.archivedAt) === Boolean(query.archived) && Boolean(line.pinnedAt)),
          query,
        )
        .map((line) => recount(state, line.id))
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") || b.id.localeCompare(a.id))
        .slice(0, limit);
      return { lines: pinned, nextCursor: "" };
    }
    const offset = Number(query.cursor ?? 0) || 0;
    const limit = query.limit ?? DEFAULT_PAGE;
    const mains = b18
      .filterLines(
        state.lines.filter((line) => !line.conversationBranch && Boolean(line.archivedAt) === Boolean(query.archived)),
        query,
      )
      .map((line) => recount(state, line.id))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const page = mains.slice(offset, offset + limit);
    return { lines: page, nextCursor: offset + limit < mains.length ? String(offset + limit) : "" };
  }

  function createLine(input: CreateLineInput): LineView {
    const [id, next] = newId(state, "line");
    const now = ctx.now();
    const org = b18.organization({ ...(input.folder !== undefined ? { folder: input.folder } : {}), ...(input.tags !== undefined ? { tags: input.tags } : {}) }, false);
    const effort = input.reasoningEffort ? { hostMeta: withReasoningEffort({}, input.reasoningEffort) } : {};
    const line = fixture.line({ id, title: input.title ?? "", provider: input.provider ?? "", model: input.model ?? "", ...org, ...effort, createdAt: now, updatedAt: now, lastActivityAt: now });
    ctx.commit(withLine(next, line));
    ctx.bus.publish("line.created", { lineId: id, rootLineId: id }, line);
    return line;
  }

  function deleteLine(lineId: string): DeleteLineResult {
    const { state: next, result } = deleteTree(state, lineId);
    ctx.commit(next);
    ctx.bus.publish("line.deleted", { lineId, rootLineId: lineId }, result);
    return result;
  }

  /** Archives or restores the whole tree; the main line comes first in the result (like the server). */
  function setArchived(lineId: string, archived: boolean): ArchiveResult {
    const root = rootOf(findLine(state, lineId));
    if (root !== lineId) throw new TangentError(409, "only a main line can be archived", "branch_not_main_line");
    const archivedAt = archived ? ctx.now() : null;
    const tree = state.lines.filter((line) => rootOf(line) === root).sort((a, b) => Number(a.id !== root) - Number(b.id !== root));
    const lines = tree.map((line) => updateLine(line.id, (current) => ({ ...current, archivedAt })));
    return { lines };
  }

  function markRead(lineId: string): LineView {
    const line = updateLine(lineId, (current) => ({ ...current, unread: 0 }));
    const branch = state.branches.find((item) => item.lineId === lineId);
    if (!branch) return line;
    ctx.commit({ ...state, branches: state.branches.map((item) => (item.lineId === lineId ? { ...item, unread: 0 } : item)) });
    publishLine(ctx, branch.rootLineId);
    return recount(state, lineId);
  }

  function listMessages(lineId: string, query: ListMessagesQuery) {
    findLine(state, lineId);
    // B8.2: a spinoff marker says whether the new conversation still exists, checked when read.
    const after = messagesOf(state, lineId)
      .filter((message) => message.seq > (query.afterSeq ?? 0))
      .map((message) => {
        const to = message.meta.spunOffTo;
        return to ? { ...message, meta: { ...message.meta, spunOffTo: { ...to, available: state.lines.some((line) => line.id === to.lineId) } } } : message;
      });
    return { messages: query.limit ? after.slice(0, query.limit) : after };
  }

  const client: TangentClient = {
    baseUrl: options.baseUrl ?? "mock:",
    eventsUrl: () => `${options.baseUrl ?? "mock:"}/events`,
    subscribe: (subscription) => ctx.bus.subscribe(subscription),

    listLines: (query = {}, opts) => call(normalizeLinePage, opts, () => listLines(query), "lines.list"),
    createLine: (input, opts) => call(normalizeLine, opts, () => createLine(input), "lines.create"),
    getLine: (lineId, opts) => call(normalizeLine, opts, () => recount(state, lineId), "lines.get"),
    updateLine: async (lineId, input: UpdateLineInput, opts) => {
      const { folder, tags, reasoningEffort, pinned, ...rest } = input;
      if (
        input.title === undefined &&
        input.provider === undefined &&
        input.model === undefined &&
        folder === undefined &&
        tags === undefined &&
        pinned === undefined &&
        reasoningEffort === undefined
      ) {
        throw new TangentError(0, "a line update needs a title, provider, model, folder, tags, pinned or reasoningEffort", "invalid_input");
      }
      return call(
        normalizeLine,
        opts,
        () => {
          const line = findLine(state, lineId);
          const org = b18.organization({ ...(folder !== undefined ? { folder } : {}), ...(tags !== undefined ? { tags } : {}) }, line.conversationBranch !== null);
          if (pinned === true && line.conversationBranch !== null) {
            throw new TangentError(400, "only a main line can be pinned", "invalid_input", { field: "pinned" });
          }
          // G1: like the reference server's host_meta hook, the effort lives in the line's hostMeta.
          const effort = reasoningEffort !== undefined ? { hostMeta: withReasoningEffort(line.hostMeta, reasoningEffort) } : {};
          return updateLine(lineId, (current) => {
            const { pinnedAt: currentPin, ...withoutPin } = current;
            const pinField =
              pinned === undefined || current.conversationBranch !== null
                ? currentPin !== undefined
                  ? { pinnedAt: currentPin }
                  : {}
                : pinned
                  ? { pinnedAt: currentPin ?? ctx.now() }
                  : {};
            return { ...withoutPin, ...defined(rest), ...org, ...effort, ...pinField, updatedAt: ctx.now() };
          });
        },
        "lines.update",
      );
    },
    deleteLine: (lineId, opts) => call(normalizeDeleteLineResult, opts, () => deleteLine(lineId), "lines.delete"),
    archiveLine: (lineId, opts) => call(normalizeArchiveResult, opts, () => setArchived(lineId, true), "lines.archive"),
    unarchiveLine: (lineId, opts) => call(normalizeArchiveResult, opts, () => setArchived(lineId, false), "lines.unarchive"),
    markRead: (lineId, opts) => call(normalizeLine, opts, () => markRead(lineId), "lines.read"),

    listMessages: (lineId, query = {}, opts) => call(normalizeMessagePage, opts, () => listMessages(lineId, query), "messages.list"),
    sendMessage: (lineId, input, opts) => call(normalizeSendResult, opts, () => turns.send(lineId, input.content), "messages.send"),
    getStream: (lineId, afterSeq, opts) => call(normalizeStreamPage, opts, () => turns.stream(lineId, afterSeq), "stream"),
    cancelTurn: (lineId, opts) => call(normalizeCancelResult, opts, () => turns.cancel(lineId), "cancel"),
    retryTurn: (lineId, opts) => call(normalizeSendResult, opts, () => turns.retry(lineId), "retry"),
    compact: (lineId, opts) =>
      call(
        normalizeJobStarted,
        opts,
        () => {
          const [jobId, next] = newId(state, "job");
          ctx.commit(next);
          const line = findLine(state, lineId);
          return { jobId, kind: "summary", lineId, provider: line.provider || "anthropic", model: line.model || "claude-haiku-4-5" };
        },
        "compact",
      ),
    previewTurn: (lineId, input = {}, opts) => call(normalizePreviewResult, opts, () => turns.preview(lineId, input.content ?? ""), "preview"),

    listBranches: (lineId, query = {}, opts) =>
      call(normalizeBranchList, opts, () => ({ branches: p3.withAnchorTags(branches.list(lineId, query).branches) }), "branches.list"),
    createBranch: (lineId, input, opts) => call(normalizeCreateBranchResult, opts, () => branches.create(lineId, input), "branches.create"),
    moveToBranch: (lineId, input, opts) => call(normalizeMoveBranchResult, opts, () => moves.move(lineId, input), "branches.move"),
    previewBranch: (lineId, input, opts) => call(normalizeBranchPreview, opts, () => branches.preview(lineId, input), "branches.preview"),
    getBranch: (lineId, opts) =>
      call(
        normalizeBranchDetail,
        opts,
        () => {
          const detail = branches.detail(lineId);
          return { ...detail, branch: p3.withAnchorTags([detail.branch])[0] };
        },
        "branch.get",
      ),
    renameBranch: (lineId, input, opts) => call(normalizeRenameBranchResult, opts, () => branches.rename(lineId, input), "branch.rename"),
    startDraft: (lineId, opts) => call(normalizeJobStarted, opts, () => branches.draft(lineId), "branch.draft"),
    mergeBranch: (lineId, body, opts) =>
      call(
        normalizeMergeBranchResult,
        opts,
        () => {
          const merged = branches.merge(lineId, body);
          const card = merged.message.meta.card;
          if (card) leaves.afterMerge(lineId, card);
          if (card) memory.afterSource(lineId, card.conclusion);
          inbox.expireFor(subtree(lineId));
          p2.afterBranchEnded(lineId);
          groups.afterBranchEnded(lineId);
          const withLeaf = { ...merged, branch: findBranch(state, lineId) };
          if (!body.noteChanges?.length) return withLeaf;
          return { ...withLeaf, notes: notes.applyChanges(lineId, body.noteChanges, lineId) };
        },
        "branch.merge",
      ),
    discardBranch: (lineId, body, opts) =>
      call(
        normalizeDiscardResult,
        opts,
        () => {
          leaves.checkDiscard(body?.leaf);
          branches.discard(lineId);
          leaves.afterDiscard(lineId, body?.leaf);
          if (body?.leaf) memory.afterSource(lineId, body.leaf.line);
          inbox.expireFor(subtree(lineId));
          p2.afterBranchEnded(lineId);
          groups.afterBranchEnded(lineId);
          return { branch: findBranch(state, lineId) };
        },
        "branch.discard",
      ),
    promoteBranch: (lineId, opts) => call(normalizePromoteResult, opts, () => promote(lineId), "branch.promote"),
    keepBranch: (lineId, keep, opts) => call(normalizeRenameBranchResult, opts, () => asides.keep(lineId, keep), "branch.keep"),
    continueAside: (lineId, input, opts) => call(normalizeContinueAsideResult, opts, () => asides.continueAside(lineId, input ?? {}), "branch.continue"),
    deleteBranch: (lineId, opts) => call(normalizeDeleteLineResult, opts, () => asides.deleteBranch(lineId), "branch.delete"),
    updateBranchCard: (lineId, input, opts) =>
      call(
        normalizeUpdateBranchCardResult,
        opts,
        () => {
          const edited = branches.updateCard(lineId, input);
          const card = edited.message.meta.card;
          if (edited.before && card) leaves.afterCardEdit(lineId, edited.before, card);
          // The server's response leaves meta.delivered out (B17).
          return { branch: findBranch(state, lineId), message: edited.message };
        },
        "branch.card.update",
      ),

    getLeaf: (lineId, opts) => call(normalizeLeafResult, opts, () => leaves.get(lineId), "leaf.get"),
    putLeaf: (lineId, input, opts) =>
      call(
        normalizeLeafResult,
        opts,
        () => {
          const written = leaves.put(lineId, input);
          memory.afterSource(lineId, input.line);
          return written;
        },
        "leaf.put",
      ),
    deleteLeaf: (lineId, opts) => call(ignore, opts, () => leaves.remove(lineId), "leaf.delete"),
    startLeafDraft: (lineId, opts) => call(normalizeJobStarted, opts, () => leaves.draft(lineId), "leaf.draft"),

    listSeeds: (lineId, query = {}, opts) => call(normalizeSeedList, opts, () => inbox.listSeeds(lineId, query), "seeds.list"),
    createSeed: (lineId, input, opts) => call(normalizeSeedWrite, opts, () => inbox.createSeed(lineId, input), "seeds.create"),
    expandSeed: (seedId, input = {}, opts) => call(normalizeExpandSeedResult, opts, () => inbox.expandSeed(seedId, input), "seeds.expand"),
    noteSeed: (seedId, input = {}, opts) => call(normalizeSeedNoteResult, opts, () => inbox.noteSeed(seedId, input), "seeds.to_note"),
    dropSeed: (seedId, opts) => call(normalizeSeedWrite, opts, () => inbox.dropSeed(seedId), "seeds.drop"),

    listSuggestions: (lineId, query = {}, opts) => call(normalizeSuggestionList, opts, () => inbox.listSuggestions(lineId, query), "suggestions.list"),
    acceptSuggestion: (suggestionId, body = {}, opts) => call(normalizeSuggestionWrite, opts, () => inbox.accept(suggestionId, body), "suggestions.accept"),
    dismissSuggestion: (suggestionId, opts) => call(normalizeSuggestionWrite, opts, () => inbox.dismiss(suggestionId), "suggestions.dismiss"),
    dismissAllSuggestions: (lineId, opts) => call(normalizeSuggestionList, opts, () => inbox.dismissAll(lineId), "suggestions.dismiss.all"),

    listNotes: (lineId, opts) => call(normalizeNotesView, opts, () => notes.list(lineId), "notes.list"),
    createNote: (lineId, input, opts) => call(normalizeNoteWriteResult, opts, () => notes.create(lineId, input), "notes.create"),
    updateNote: (lineId, noteId, input, opts) => call(normalizeNoteWriteResult, opts, () => notes.update(lineId, noteId, defined(input)), "notes.update"),
    supersedeNote: (lineId, noteId, input, opts) => call(normalizeNoteWriteResult, opts, () => notes.supersede(lineId, noteId, input), "notes.supersede"),

    listChapters: (lineId, opts) => call(normalizeChapters, opts, () => notes.chapters(lineId), "chapters.list"),
    addMilestone: (lineId, input, opts) => call(normalizeMilestoneWrite, opts, () => notes.addMilestone(lineId, input), "chapters.milestones.add"),
    deleteMilestone: (lineId, milestoneId, opts) => call(ignore, opts, () => notes.deleteMilestone(lineId, milestoneId), "chapters.milestones.delete"),

    spinoff: (lineId, input, opts) => call(normalizeSpinoffResult, opts, () => spinoffs.spinoff(lineId, input), "spinoff"),
    previewSpinoff: (lineId, input, opts) => call(normalizeSpinoffPreview, opts, () => spinoffs.preview(lineId, input), "spinoff.preview"),
    listLinks: (lineId, opts) => call(normalizeLinkList, opts, () => p2.links(lineId, state.links), "links.list"),

    getGoal: (lineId, opts) => call(normalizeGoalResult, opts, () => p2.getGoal(lineId), "goal.get"),
    putGoal: (lineId, input, opts) => call(normalizeGoalResult, opts, () => p2.putGoal(lineId, input), "goal.put"),
    deleteGoal: (lineId, opts) => call(ignore, opts, () => p2.deleteGoal(lineId), "goal.delete"),
    proposeGoal: (lineId, opts) => call(normalizeJobStarted, opts, () => p2.proposeGoal(lineId), "goal.propose"),
    listRelations: (lineId, opts) => call(normalizeRelationList, opts, () => p2.listRelations(lineId), "relations.list"),
    createRelation: (lineId, input, opts) => call(normalizeRelationWrite, opts, () => p2.createRelation(lineId, input), "relations.create"),
    deleteRelation: (lineId, relationId, opts) => call(ignore, opts, () => p2.deleteRelation(lineId, relationId), "relations.delete"),
    updateRelation: (lineId, relationId, input, opts) => call(normalizeRelationWrite, opts, () => p2.updateRelation(lineId, relationId, input), "relations.update"),
    listGroups: (lineId, query = {}, opts) => call(normalizeGroupList, opts, () => groups.list(lineId, query), "groups.list"),
    createGroup: (lineId, input, opts) => call(normalizeGroupWrite, opts, () => groups.create(lineId, input), "groups.create"),
    getGroup: (groupId, opts) => call(normalizeGroupResult, opts, () => groups.get(groupId), "groups.get"),
    renameGroup: (groupId, input, opts) => call(normalizeGroupResult, opts, () => groups.rename(groupId, input.title), "groups.rename"),
    dissolveGroup: (groupId, opts) => call(normalizeGroupResult, opts, () => groups.dissolve(groupId), "groups.dissolve"),
    summarizeGroup: (groupId, opts) => call(normalizeJobStarted, opts, () => groups.summarize(groupId), "groups.summarize"),
    combineBranches: (lineId, input, opts) => call(normalizeCombineResult, opts, () => groups.combine(lineId, input), "branches.combine"),
    listOpenLoops: (query = {}, opts) => call(normalizeOpenLoops, opts, () => p2.openLoops(query), "open_loops.list"),
    pinMessage: (messageId, opts) => call(normalizePinResult, opts, () => p2.pin(messageId, true), "messages.pin"),
    unpinMessage: (messageId, opts) => call(normalizePinResult, opts, () => p2.pin(messageId, false), "messages.unpin"),
    tagMessage: (messageId, input, opts) => call(normalizePinResult, opts, () => p3.tag(messageId, input.kind, input.status), "messages.tag"),
    listTagDrafts: (lineId, opts) => call(normalizeTagDraftList, opts, () => p3.tagDrafts(lineId), "ibis.drafts"),
    untagMessage: (messageId, opts) => call(normalizePinResult, opts, () => p3.tag(messageId, null), "messages.untag"),
    listFolds: (lineId, opts) => call(normalizeFoldList, opts, () => p3.listFolds(lineId), "folds.list"),
    createFold: (lineId, input, opts) => call(normalizeFoldCreated, opts, () => p3.createFold(lineId, input), "folds.create"),
    deleteFold: (foldId, opts) => call(ignore, opts, () => p3.removeFold(foldId), "folds.delete"),
    updateFold: (foldId, input, opts) => call(normalizeFoldResult, opts, () => p3.updateFold(foldId, input.summary), "folds.update"),
    diverge: (lineId, input, opts) => call(normalizeJobStarted, opts, () => diverging.diverge(lineId, input), "diverge"),
    converge: (lineId, input, opts) => call(normalizeConvergeStarted, opts, () => diverging.converge(lineId, input), "converge"),
    listComparisons: (lineId, opts) => call(normalizeComparisonList, opts, () => diverging.list(lineId), "comparisons.list"),
    getComparison: (comparisonId, opts) => call(normalizeComparisonResult, opts, () => diverging.get(comparisonId), "comparisons.get"),
    decideComparison: (comparisonId, input, opts) => call(normalizeDecideResult, opts, () => diverging.decide(comparisonId, input), "comparisons.decide"),
    listMemories: (query = {}, opts) => call(normalizeMemoryList, opts, () => memory.list(query), "memories.list"),
    listMemos: (lineId, query = {}, opts) => call(normalizeMemoList, opts, () => memos.list(lineId, query), "memos.list"),
    createMemo: (lineId, input, opts) => call(normalizeMemoResult, opts, () => memos.create(lineId, input), "memos.create"),
    updateMemo: (memoId, text, opts) => call(normalizeMemoResult, opts, () => memos.update(memoId, text), "memos.update"),
    deleteMemo: (memoId, opts) => call(normalizeMemoResult, opts, () => memos.remove(memoId), "memos.delete"),
    listTerms: (lineId, opts) => call(normalizeTermList, opts, () => glossary.list(lineId), "terms.list"),
    createTerm: (lineId, input, opts) => call(normalizeTermWriteResult, opts, () => glossary.create(lineId, input), "terms.create"),
    updateTerm: (termId, input, opts) => call(normalizeTermResult, opts, () => glossary.update(termId, input), "terms.update"),
    deleteTerm: (termId, opts) => call(ignore, opts, () => glossary.remove(termId), "terms.delete"),
    searchTerms: (query = {}, opts) => call(normalizeTermSearchPage, opts, () => glossary.search(query), "terms.search"),
    createMemory: (input, opts) => call(normalizeMemoryResult, opts, () => memory.create(input), "memories.create"),
    updateMemory: (memoryId, input, opts) => call(normalizeMemoryResult, opts, () => memory.update(memoryId, input), "memories.update"),
    supersedeMemory: (memoryId, input, opts) => call(normalizeSupersedeResult, opts, () => memory.supersede(memoryId, input), "memories.supersede"),
    searchMemories: (input, opts) => call(normalizeMemorySearch, opts, () => memory.search(input), "memories.search"),

    exportTree: (lineId, opts) => call(normalizeTreeExport, opts, () => b14.exportTree(lineId), "lines.export"),
    divergeModels: (lineId, input, opts) => call(normalizeDivergeModelsResult, opts, () => b14.divergeModels(lineId, input), "diverge.models"),
    createSeedsBatch: (lineId, input, opts) => call(normalizeSeedsBatchResult, opts, () => b14.createSeedsBatch(lineId, input), "seeds.batch"),

    renameFolder: (input, opts) => call(normalizeRenameFolderResult, opts, () => b18.renameFolder(input), "lines.folders.rename"),
    importConversation: (input, opts) => call(normalizeImportResult, opts, () => b18.importConversation(input), "lines.import"),
    extractBranch: (lineId, input, opts) => call(normalizeExtractResult, opts, () => b18.extract(lineId, input), "branches.extract"),
    decomposeLine: (lineId, opts) => call(normalizeDecomposePlan, opts, () => b18.decompose(lineId), "lines.decompose"),
    getLineOrganization: (opts) => call(normalizeLineOrganization, opts, () => b18.lineOrganization(), "lines.organization"),
    attachLine: (targetLineId, input, opts) => call(normalizeAttachResult, opts, () => attaching.attach(targetLineId, input), "lines.attach"),
    // B22: the server's deterministic analyzer, run here (no model, no network).
    analyzeImport: (input, opts) => call(normalizeImportAnalyzePlan, opts, () => analyzeImportLocal(input), "lines.import_analyze"),
    // B25: import batches.
    listImportBatches: (query = {}, opts) => call(normalizeImportBatchPage, opts, () => b25.listImportBatches(query), "imports.list"),
    deleteImportBatch: (batchId, query = {}, opts) => call(normalizeImportBatchDeletion, opts, () => b25.deleteImportBatch(batchId, query), "imports.delete"),

    getCapabilities: (opts) => call(normalizeCapabilities, opts, () => scenario.capabilities, "capabilities"),

    search: (query, opts) =>
      call(
        normalizeSearchResult,
        opts,
        () => {
          if (!isFeatureOn(scenario.capabilities, "search")) throw new TangentError(404, "the search feature is off", "feature_disabled", { feature: "search" });
          return mockSearch(state, query);
        },
        "search",
      ),
  };

  return {
    ...client,
    mock: {
      snapshot: () => state,
      appendSystemMessage: (lineId, content) => structuredClone(turns.notice(lineId, content)),
      dispose: () => {
        turns.dispose();
        responder.dispose();
        for (const handle of pendingDrafts) timers.clearTimeout(handle);
        pendingDrafts.clear();
      },
    },
  };
}
