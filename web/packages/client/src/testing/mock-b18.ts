/**
 * The mock's B18 routes (docs/devlog/B18-import-extract-organize.md): folders
 * and tags on main lines (list filters, PATCH, rename), importing a
 * conversation, extracting any stretch of a line into a branch and the
 * decompose plan; B18.1 adds the tenant's folders and tags and the folds and
 * chapter cuts an extract changes. The import itself (with B19's dates,
 * chapter cuts and merged branches) is mock-import.ts. The refusals use the server's codes and
 * statuses (extract's move_* codes are 400, `source_busy` 409).
 */
import type { ListLinesQuery } from "../api-types";
import {
  BRANCH_PURPOSE_MAX_RUNES,
  EXTRACT_MAX_MESSAGES,
  FOLDER_UNFILED,
  normalizeFolder,
  normalizeTag,
  normalizeTags,
  type DecomposePlan,
  type ExtractBranchInput,
  type FolderSummary,
  type LineOrganization,
  type ExtractBranchResult,
  type ImportConversationInput,
  type ImportConversationResult,
  type RelatedLine,
  type RenameFolderInput,
  type RenameFolderResult,
} from "../b18-routes";
import { normalizeBranchCard } from "../branch-normalize";
import { BRANCH_HARD_DEPTH_LIMIT, BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT } from "../branch-errors";
import { TangentError } from "../errors";
import { isFeatureOn } from "../capabilities";
import type { Fold } from "../fold-routes";
import type { BranchCard, LineView, Message, Milestone } from "../types";
import { closeBranch } from "./mock-branches";
import { rehang, relocate } from "./mock-branch-moves";
import { address, publishLine, type MockContext } from "./mock-context";
import { buildDecomposePlan } from "./mock-decompose";
import { findBranch, findLine, messagesOf, newId, recount, rootOf, takeSeq, withBranch, withLine, withMessage, type MockState } from "./mock-store";
import { fixture } from "./scenario";
import { cardMarkdown, createMockImport, invalid } from "./mock-import";

export interface MockB18Deps {
  /** The leaf a merge writes (the leaf feature). */
  afterMerge(lineId: string, card: BranchCard): void;
}

export interface MockB18 {
  /** `GET /lines`' B18 filters on main lines. */
  filterLines(lines: readonly LineView[], query: ListLinesQuery): LineView[];
  /** The folder and tags of a POST / PATCH body, checked as the server does; `{}` when neither was given. */
  organization(input: { folder?: string; tags?: string[] }, branch: boolean): { folder?: string; tags?: string[] };
  renameFolder(input: RenameFolderInput): RenameFolderResult;
  importConversation(input: ImportConversationInput): ImportConversationResult;
  extract(lineId: string, input: ExtractBranchInput): ExtractBranchResult;
  decompose(lineId: string): DecomposePlan;
  /** `GET /lines/organization`. */
  lineOrganization(): LineOrganization;
}

const runes = (text: string) => Array.from(text).length;

const isChat = (message: Message) => message.kind === "chat" && (message.role === "user" || message.role === "assistant");
const extractable = (message: Message) => isChat(message) && message.status === "done";
const canAnchor = (message: Message) => extractable(message) || (message.kind === "branch_card" && message.status === "done");

/**
 * `store.extractFolds` + `vacateLastSeq` (B18.1): the source's folds that cross the range's ends or contain it are removed, the
 * ones inside it move to the branch, and every fold naming the range's last message takes its new seq. The changed folds come
 * back as stored (removed ones first), for `fold.changed`.
 */
export function extractFolds(state: MockState, move: { sourceId: string; branchId: string; first: Message; last: Message; newSeq: number; now: string }): [MockState, Fold[]] {
  const { sourceId, branchId, first, last, newSeq, now } = move;
  const removed: Fold[] = [];
  const moved: Fold[] = [];
  const folds = state.folds.map((fold) => {
    let next = fold;
    const touches = fold.lineId === sourceId && fold.status !== "removed" && fold.fromSeq <= last.seq && fold.toSeq >= first.seq;
    const inside = touches && fold.fromSeq >= first.seq && fold.toSeq <= last.seq;
    if (touches) next = inside ? { ...fold, lineId: branchId, updatedAt: now } : { ...fold, status: "removed", updatedAt: now };
    if (next.fromMessageId === last.id) next = { ...next, fromSeq: newSeq };
    if (next.toMessageId === last.id) next = { ...next, toSeq: newSeq };
    if (touches) (inside ? moved : removed).push(next);
    return next;
  });
  return [{ ...state, folds }, [...removed, ...moved]];
}

/**
 * `store.keepChapterStart` (B18.1): when the line goes on after the range, the newest chapter cut of each kind on a moved message
 * moves onto the marker, so what follows stays in that chapter. The other cuts stay on their messages, which are on the branch
 * now (cuts are per conversation, so the branch's chapters show them). A range at the end of the line moves no cut.
 */
export function keepChapterStart(state: MockState, cut: { rootId: string; range: readonly Message[]; markerId: string; linesGoOn: boolean }): [MockState, number] {
  const view = state.chaptersByLine[cut.rootId];
  if (!cut.linesGoOn || !view) return [state, 0];
  const position = new Map(cut.range.map((message, index) => [message.id, index]));
  const newest = new Map<string, Milestone>();
  for (const milestone of view.milestones) {
    const at = position.get(milestone.messageId);
    if (at === undefined) continue;
    const kept = newest.get(milestone.kind);
    if (!kept || at > position.get(kept.messageId)!) newest.set(milestone.kind, milestone);
  }
  if (newest.size === 0) return [state, 0];
  const onMarker = new Set([...newest.values()].map((milestone) => milestone.id));
  const milestones = view.milestones.map((milestone) => (onMarker.has(milestone.id) ? { ...milestone, messageId: cut.markerId } : milestone));
  return [{ ...state, chaptersByLine: { ...state.chaptersByLine, [cut.rootId]: { ...view, milestones } } }, newest.size];
}

export function createMockB18(ctx: MockContext, deps: MockB18Deps): MockB18 {
  function organization(input: { folder?: string; tags?: string[] }, branch: boolean): { folder?: string; tags?: string[] } {
    const out: { folder?: string; tags?: string[] } = {};
    if (input.folder !== undefined) {
      const { folder, problem } = normalizeFolder(input.folder);
      if (problem) throw invalid("folder", problem === "reserved" ? `${FOLDER_UNFILED} is reserved` : "a folder name is at most 40 characters");
      if (branch && folder !== "") throw new TangentError(400, "folders and tags belong to main conversations, not branches", "invalid_input", { field: "folder" });
      if (!branch) out.folder = folder;
    }
    if (input.tags !== undefined) {
      const { tags, problem } = normalizeTags(input.tags);
      if (problem) throw invalid("tags", problem === "tooMany" ? "a conversation has at most 12 tags" : "a tag is at most 24 characters");
      if (branch && tags.length > 0) throw new TangentError(400, "folders and tags belong to main conversations, not branches", "invalid_input", { field: "tags" });
      if (!branch) out.tags = tags;
    }
    return out;
  }

  function filterLines(lines: readonly LineView[], query: ListLinesQuery): LineView[] {
    const folder = query.folder ? (query.folder === FOLDER_UNFILED ? "" : normalizeFolder(query.folder).folder) : null;
    const tag = query.tag ? normalizeTag(query.tag) : null;
    if (tag !== null && runes(tag) > 24) throw invalid("tag", "a tag is at most 24 characters");
    return lines.filter((line) => (folder === null || line.folder === folder) && (tag === null || line.tags.includes(tag)));
  }

  function renameFolder(input: RenameFolderInput): RenameFolderResult {
    const from = normalizeFolder(input.from ?? "");
    const to = normalizeFolder(input.to ?? "");
    if (from.problem) throw invalid("from", "not a folder name");
    if (to.problem) throw invalid("to", "not a folder name");
    if (from.folder === "") throw invalid("from", "from is required");
    if (from.folder === to.folder) return { updated: 0 };
    const now = ctx.now();
    const moved = ctx
      .state()
      .lines.filter((line) => !line.conversationBranch && line.folder === from.folder)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const line of moved) {
      ctx.commit(withLine(ctx.state(), { ...findLine(ctx.state(), line.id), folder: to.folder, updatedAt: now }));
      publishLine(ctx, line.id);
    }
    return { updated: moved.length };
  }

  /** The range under the server's rules (store.readExtractRange), in its order. */
  function extractRange(source: LineView, input: ExtractBranchInput): Message[] {
    const all = messagesOf(ctx.state(), source.id);
    if (source.status === "thinking" || all.some((message) => message.status === "pending")) throw new TangentError(409, "the conversation is answering; wait for it or cancel the turn", "source_busy");
    const from = all.find((message) => message.id === input.fromMessageId);
    const to = all.find((message) => message.id === input.toMessageId);
    if (!from || !to) throw new TangentError(404, "message not found", "message_not_found");
    if (from.seq > to.seq) throw invalid("fromMessageId", "fromMessageId must not come after toMessageId");
    const range = all.filter((message) => message.seq >= from.seq && message.seq <= to.seq);
    if (range.length > EXTRACT_MAX_MESSAGES) throw new TangentError(400, `count must be between 1 and ${EXTRACT_MAX_MESSAGES}`, "invalid_count", { max: EXTRACT_MAX_MESSAGES });
    if (range.some((message) => !extractable(message))) throw new TangentError(400, "a conclusion card or a move marker is in that range and cannot be moved", "move_protected_message");
    if (range[0]!.role !== "user") throw new TangentError(400, "the first message to move must be one of yours", "move_must_start_with_user");
    const ids = new Set(range.map((message) => message.id));
    const cardsLeft = ctx.state().branches.filter((branch) => branch.parentLineId === source.id && ids.has(branch.anchorMessageId) && branch.cardMessageId && all.some((message) => message.id === branch.cardMessageId));
    if (cardsLeft.length > 0) throw new TangentError(400, "a conclusion card or a move marker is in that range and cannot be moved", "move_protected_message");
    return range;
  }

  function checkExtract(source: LineView, input: ExtractBranchInput): { kind: "investigate" | "alternative"; purpose: string; card: BranchCard | null } {
    const kind = input.kind ?? "investigate";
    if (kind !== "investigate" && kind !== "alternative") throw new TangentError(400, "this kind of branch cannot be made here", "kind_unsupported");
    const purpose = (input.purpose ?? "").trim();
    if (!purpose || runes(purpose) > BRANCH_PURPOSE_MAX_RUNES) throw new TangentError(400, "purpose is required and must not be too long", "invalid_input");
    if (findLine(ctx.state(), rootOf(source)).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    if (source.conversationBranch && source.conversationBranch.status !== "open") throw new TangentError(409, "the parent branch has ended", "parent_closed");
    if (input.card === undefined) return { kind, purpose, card: null };
    const card = normalizeBranchCard(input.card);
    if (!card || !card.question.trim() || !card.conclusion.trim()) {
      const field = !card?.question.trim() ? "question" : "conclusion";
      throw new TangentError(422, "the card is not acceptable", "invalid_card", { problems: [{ field, message: "required" }] });
    }
    return { kind, purpose, card };
  }

  function extract(lineId: string, input: ExtractBranchInput): ExtractBranchResult {
    const source = findLine(ctx.state(), lineId);
    const { kind, purpose, card } = checkExtract(source, input);
    const range = extractRange(source, input);
    const all = messagesOf(ctx.state(), lineId);
    const first = range[0]!;
    const last = range.at(-1)!;
    const anchor = all.filter((message) => message.seq < first.seq && canAnchor(message)).at(-1);
    if (!anchor) throw new TangentError(400, "moving that many messages would leave nothing to branch from", "move_no_anchor");
    const depth = (source.conversationBranch?.depth ?? 0) + 1;
    if (depth > BRANCH_HARD_DEPTH_LIMIT) throw new TangentError(409, "too deep", "depth_hard_limit", { limit: BRANCH_HARD_DEPTH_LIMIT });
    if (ctx.state().branches.filter((branch) => branch.parentLineId === lineId && branch.status === "open").length >= BRANCH_OPEN_PER_PARENT_LIMIT) {
      throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
    }
    if (depth > BRANCH_SOFT_DEPTH_LIMIT && !input.confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth, limit: BRANCH_SOFT_DEPTH_LIMIT });
    const root = rootOf(source);
    const now = ctx.now();
    const [id, afterId] = newId(ctx.state(), "branch");
    const ref = { parentLineId: lineId, rootLineId: root, anchorMessageId: anchor.id, depth, purpose, kind, status: "open", origin: "move" };
    const line = fixture.line({ id, title: purpose, provider: input.provider ?? source.provider, model: input.model ?? source.model, conversationBranch: ref, createdAt: now, updatedAt: now, lastActivityAt: now });
    const branch = fixture.branch({ ...ref, lineId: id, provider: line.provider, model: line.model, draftStatus: "none", messageCount: range.length, createdAt: now, lastActivityAt: now });
    const ids = new Set(range.map((message) => message.id));
    const reparented = ctx.state().branches.filter((item) => item.parentLineId === lineId && ids.has(item.anchorMessageId)).map((item) => item.lineId);
    // The range's last message takes a new seq (still the branch's newest); the marker takes its old one, in the range's place.
    const [newSeq, seqState] = takeSeq(relocate(withBranch(withLine(afterId, line), branch), range, id));
    const [foldState, folds] = extractFolds(withMessage(seqState, { ...last, lineId: id, seq: newSeq }), { sourceId: lineId, branchId: id, first, last, newSeq, now });
    const [markerId, markerState] = newId(foldState, card ? "card" : "marker");
    let state: MockState = markerState;
    const marker = card
      ? fixture.message({ id: markerId, seq: last.seq, lineId, role: "system", kind: "branch_card", status: "done", content: cardMarkdown(card, purpose), createdAt: last.createdAt, meta: { branchLineId: id, card, delivered: true } })
      : fixture.message({ id: markerId, seq: last.seq, lineId, role: "system", kind: "branch_marker", status: "done", content: `${range.length} message(s) moved to a branch: ${purpose}`, createdAt: last.createdAt, meta: { branchLineId: id } });
    const [cutState, movedCuts] = keepChapterStart(withMessage(state, marker), { rootId: root, range, markerId: marker.id, linesGoOn: all.some((message) => message.seq > last.seq) });
    ctx.commit(rehang(cutState, reparented, id, 1));
    if (card) {
      closeBranch(ctx, findBranch(ctx.state(), id), { status: "merged", cardMessageId: marker.id, conclusionLine: card.conclusion });
      deps.afterMerge(id, card);
    }
    ctx.bus.publish("line.created", { lineId: id, rootLineId: root }, recount(ctx.state(), id));
    ctx.bus.publish("message.created", address(ctx, lineId), marker);
    publishLine(ctx, lineId);
    ctx.bus.publish("branch.changed", address(ctx, id), { change: "moved", branch: findBranch(ctx.state(), id) });
    for (const moved of reparented) ctx.bus.publish("branch.changed", address(ctx, moved), { change: "moved", branch: findBranch(ctx.state(), moved) });
    // As Engine.extractEvents: the folds that changed while fold is on, the source's chapters when a cut moved while chapters is on.
    if (isFeatureOn(ctx.scenario.capabilities, "fold")) {
      for (const fold of folds) ctx.bus.publish("fold.changed", { lineId: fold.lineId, rootLineId: root }, { lineId: fold.lineId, rootLineId: root, fold });
    }
    if (movedCuts > 0 && isFeatureOn(ctx.scenario.capabilities, "chapters")) ctx.bus.publish("chapters.changed", { lineId, rootLineId: root }, { rootLineId: root });
    return {
      branch: findBranch(ctx.state(), id),
      line: recount(ctx.state(), id),
      marker,
      movedMessageIds: range.map((message) => message.id),
      reparented,
      rootLineId: root,
      sourceLineId: lineId,
      summaryReset: false,
    };
  }

  /** Other unarchived main lines sharing a tag or the (non-empty) folder with the tree's main line. */
  function relatedTo(main: LineView): RelatedLine[] {
    if (main.tags.length === 0 && main.folder === "") return [];
    return ctx
      .state()
      .lines.filter((line) => !line.conversationBranch && line.id !== main.id && !line.archivedAt)
      .map((line) => ({ line, shared: line.tags.filter((tag) => main.tags.includes(tag)).sort() }))
      .filter(({ line, shared }) => shared.length > 0 || (main.folder !== "" && line.folder === main.folder))
      .sort((a, b) => b.shared.length - a.shared.length || b.line.lastActivityAt.localeCompare(a.line.lastActivityAt))
      .map(({ line, shared }) => ({ lineId: line.id, title: line.title, folder: line.folder, sharedTags: shared }));
  }

  function decompose(lineId: string): DecomposePlan {
    const line = findLine(ctx.state(), lineId);
    const main = findLine(ctx.state(), rootOf(line));
    // Cuts are per conversation (store.chapterCuts reads the root's).
    const cuts = new Set((ctx.state().chaptersByLine[main.id]?.milestones ?? []).map((milestone) => milestone.messageId));
    const tenantTags = lineOrganization().tags.map((item) => item.tag);
    return buildDecomposePlan({ lineId, title: line.title, messages: messagesOf(ctx.state(), lineId), cutMessageIds: cuts, tags: main.tags, tenantTags, related: relatedTo(main) });
  }

  /** `GET /lines/organization` (B18.1): every main line's folder (active and archived apart) and the tags of unarchived ones. */
  function lineOrganization(): LineOrganization {
    const folders = new Map<string, FolderSummary>();
    const tags = new Map<string, number>();
    for (const line of ctx.state().lines) {
      if (line.conversationBranch) continue;
      if (line.folder !== "") {
        const item = folders.get(line.folder) ?? { folder: line.folder, active: 0, archived: 0 };
        folders.set(line.folder, line.archivedAt ? { ...item, archived: item.archived + 1 } : { ...item, active: item.active + 1 });
      }
      if (!line.archivedAt) for (const tag of line.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    // Code point order, as the server's COLLATE "C".
    const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      folders: [...folders.values()].sort((a, b) => byName(a.folder, b.folder)),
      tags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || byName(a.tag, b.tag)),
    };
  }

  const { importConversation } = createMockImport(ctx, { organization: (input) => organization(input, false), afterMerge: deps.afterMerge });

  return { filterLines, organization, renameFolder, importConversation, extract, decompose, lineOrganization };
}
