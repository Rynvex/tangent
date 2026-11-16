/**
 * The mock's B20 route, `POST /lines/{id}/attach` (store/attach.go): another
 * main line, with its whole tree, becomes a branch of the line. The source
 * keeps its messages and their seqs; its branches go one level deeper per the
 * new branch's depth; its notes, memos, seeds, leaves, milestones,
 * suggestions and groups move to the target's main line (open suggestions the
 * target already has open expire first); its goal, folder and tags go. The
 * refusals use the server's codes and statuses.
 */
import { BRANCH_PURPOSE_MAX_RUNES } from "../b18-routes";
import type { AttachLineInput, AttachLineResult } from "../b20-routes";
import { BRANCH_HARD_DEPTH_LIMIT, BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "../branch-errors";
import { normalizeBranchCard } from "../branch-normalize";
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import type { BranchCard, BranchView, LineView, Message, Suggestion } from "../types";
import { closeBranch } from "./mock-branches";
import { address, publishLine, type MockContext } from "./mock-context";
import { termsAttached } from "./mock-glossary";
import { cardMarkdown, invalid } from "./mock-import";
import { findBranch, findLine, messagesOf, newId, recount, rootOf, takeSeq, withBranch, withLine, withMessage, type MockState } from "./mock-store";
import { fixture } from "./scenario";

export interface MockAttachDeps {
  /** The leaf a merge writes (the leaf feature). */
  afterMerge(lineId: string, card: BranchCard): void;
}

export interface MockAttach {
  attach(targetLineId: string, input: AttachLineInput): AttachLineResult;
}

/** `domain.ImportTitleRunes`: a purpose taken from a message. */
const OPENING_RUNES = 60;

const runes = (text: string) => Array.from(text).length;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => (runes(text) <= max ? text : `${Array.from(text).slice(0, max - 1).join("").trim()}…`);
const isChat = (message: Message) => message.kind === "chat" && (message.role === "user" || message.role === "assistant") && message.status === "done";
const canAnchor = (message: Message) => message.status === "done" && (message.role === "user" || message.role === "assistant" || message.kind === "branch_card");
const busy = (state: MockState, line: LineView) => line.status === "thinking" || messagesOf(state, line.id).some((message) => message.status === "pending");

/** `domain.AttachPurpose`: the purpose given, else the source's title, else its first question (or first message). */
export function attachPurpose(given: string | undefined, source: LineView, messages: readonly Message[]): string {
  const purpose = (given ?? "").trim();
  if (purpose !== "") {
    if (runes(purpose) > BRANCH_PURPOSE_MAX_RUNES) throw new TangentError(400, "purpose is required and must not be too long", "invalid_input");
    return purpose;
  }
  if (flat(source.title) !== "") return cut(flat(source.title), BRANCH_PURPOSE_MAX_RUNES);
  const chat = messages.filter(isChat);
  const opening = chat.find((message) => message.role === "user") ?? chat[0];
  return cut(flat(opening?.content ?? ""), OPENING_RUNES);
}

/**
 * `store.pickAttachAnchor`: the anchor given (it must be one), else the newest anchorable message of the target (seq order) dated no
 * later than the source's start, else its newest.
 */
export function attachAnchor(target: readonly Message[], sourceStart: string, anchorId?: string): Message {
  const candidates = target.filter(canAnchor);
  if (anchorId) {
    const given = candidates.find((message) => message.id === anchorId);
    if (!given) throw new TangentError(404, "anchor message not found in this conversation", "anchor_not_found");
    return given;
  }
  const start = Date.parse(sourceStart);
  const anchor = candidates.filter((message) => Date.parse(message.createdAt) <= start).at(-1) ?? candidates.at(-1);
  if (!anchor) throw new TangentError(400, "the conversation has nothing to hang a branch on", "move_no_anchor");
  return anchor;
}

/** `domain.CheckAttach`: the depth of the new branch; the source's tree counts against the depths and the tree's size. */
function checkLimits(state: MockState, target: LineView, source: LineView, input: AttachLineInput, open: boolean): number {
  const depth = (target.conversationBranch?.depth ?? 0) + 1;
  const subtree = state.branches.filter((branch) => branch.rootLineId === source.id);
  const deepest = depth + subtree.reduce((max, branch) => Math.max(max, branch.depth), 0);
  if (deepest > BRANCH_HARD_DEPTH_LIMIT) throw new TangentError(409, "branches cannot be nested any deeper", "depth_hard_limit", { limit: BRANCH_HARD_DEPTH_LIMIT });
  if (open && state.branches.filter((branch) => branch.parentLineId === target.id && branch.status === "open").length >= BRANCH_OPEN_PER_PARENT_LIMIT) {
    throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
  }
  if (state.branches.filter((branch) => branch.rootLineId === rootOf(target)).length + 1 + subtree.length > BRANCH_TREE_LIMIT) {
    throw new TangentError(409, "too many branches in this conversation", "tree_limit", { limit: BRANCH_TREE_LIMIT });
  }
  if (deepest > BRANCH_SOFT_DEPTH_LIMIT && !input.confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth: deepest, limit: BRANCH_SOFT_DEPTH_LIMIT });
  return depth;
}

/** The refusals before anything is written; the source's opening messages for the purpose. */
function checkAttach(state: MockState, target: LineView, input: AttachLineInput): { source: LineView; kind: "investigate" | "alternative"; status: "open" | "merged" } {
  if (!input.sourceLineId?.trim()) throw invalid("sourceLineId", "sourceLineId is required");
  const kind = input.kind ?? "investigate";
  if (kind !== "investigate" && kind !== "alternative") throw new TangentError(400, "this kind of branch cannot be made here", "kind_unsupported");
  const status = input.status ?? "open";
  if (status !== "open" && status !== "merged") throw invalid("status", "status must be open or merged");
  const source = findLine(state, input.sourceLineId);
  if (source.id === target.id || rootOf(target) === source.id) throw invalid("sourceLineId", "a conversation cannot be attached to itself");
  if (source.conversationBranch) throw invalid("sourceLineId", "sourceLineId must be a main line (a conversation of its own)");
  if (findLine(state, rootOf(target)).archivedAt || target.archivedAt || source.archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
  if (busy(state, target)) throw new TangentError(409, "the conversation is answering; wait for it or cancel the turn", "source_busy");
  const tree = state.lines.filter((line) => rootOf(line) === source.id);
  if (tree.some((line) => busy(state, line))) throw new TangentError(409, "the branch is still answering", "branch_busy");
  if (state.branches.some((branch) => branch.rootLineId === source.id && branch.draftStatus === "drafting")) throw new TangentError(409, "a card is being drafted", "branch_drafting");
  if (target.conversationBranch && target.conversationBranch.status !== "open") throw new TangentError(409, "the parent branch is closed", "parent_closed");
  if (!messagesOf(state, source.id).some(isChat)) throw invalid("sourceLineId", "the conversation to attach has no finished messages");
  return { source, kind, status };
}

/** `domain.PlanAttachCard`: merged carries a card (an empty question is the purpose), open none. */
function attachCard(input: AttachLineInput, status: "open" | "merged", purpose: string): BranchCard | null {
  if (status !== "merged") {
    if (input.card !== undefined) throw invalid("card", "only a merged attach carries a card");
    return null;
  }
  if (input.card === undefined) throw invalid("card", "a merged attach carries its card");
  const card = normalizeBranchCard({ ...input.card, question: input.card.question?.trim() ? input.card.question : purpose });
  if (!card?.conclusion.trim()) throw new TangentError(422, "the card is not acceptable", "invalid_card", { problems: [{ field: "conclusion", message: "required" }] });
  return card;
}

/** What moves with the tree (store.moveTree), as a new state and what changed. */
export function moveTree(state: MockState, from: string, to: string, now: string): { state: MockState; expired: Suggestion[]; notes: number; seeds: number; milestones: number; groups: string[] } {
  const openHere = new Set(state.suggestions.filter((item) => item.rootLineId === to && item.status === "open").map((item) => `${item.feature}|${item.kind}|${item.targetKey}`));
  const expired: Suggestion[] = [];
  const suggestions = state.suggestions.map((item) => {
    if (item.rootLineId !== from) return item;
    const collides = item.status === "open" && openHere.has(`${item.feature}|${item.kind}|${item.targetKey}`);
    const next: Suggestion = collides ? { ...item, rootLineId: to, status: "expired", decidedAt: now } : { ...item, rootLineId: to };
    if (collides) expired.push(next);
    return next;
  });
  const movedNotes = state.notesByRoot[from] ?? [];
  const { [from]: _notes, ...notesByRoot } = state.notesByRoot;
  const { [from]: _revision, ...notesRevision } = state.notesRevision;
  const { [from]: chapters, ...chaptersByLine } = state.chaptersByLine;
  const movedCuts = chapters?.milestones ?? [];
  const targetChapters = chaptersByLine[to] ?? { chapters: [], milestones: [] };
  const { [from]: _goal, ...goals } = state.goals;
  const seeds = state.seeds.filter((seed) => seed.rootLineId === from).length;
  const next: MockState = {
    ...state,
    suggestions,
    notesByRoot: movedNotes.length > 0 ? { ...notesByRoot, [to]: [...(notesByRoot[to] ?? []), ...movedNotes] } : notesByRoot,
    notesRevision: movedNotes.length > 0 ? { ...notesRevision, [to]: (notesRevision[to] ?? 0) + 1 } : notesRevision,
    chaptersByLine: movedCuts.length > 0 ? { ...chaptersByLine, [to]: { ...targetChapters, milestones: [...targetChapters.milestones, ...movedCuts] } } : chaptersByLine,
    goals,
    seeds: state.seeds.map((seed) => (seed.rootLineId === from ? { ...seed, rootLineId: to } : seed)),
    memos: state.memos.map((memo) => (memo.rootLineId === from ? { ...memo, rootLineId: to } : memo)),
    terms: termsAttached(state.terms, from, to),
    groups: state.groups.map((group) => (group.rootLineId === from ? { ...group, rootLineId: to } : group)),
    leaves: Object.fromEntries(Object.entries(state.leaves).map(([id, leaf]) => [id, leaf.rootLineId === from ? { ...leaf, rootLineId: to } : leaf])),
  };
  const groups = state.groups.filter((group) => group.rootLineId === from).map((group) => group.id);
  return { state: next, expired, notes: movedNotes.length, seeds, milestones: movedCuts.length, groups };
}

/** The source line becomes a branch line and its branches join the target tree, `depth` levels deeper. */
function hangSource(state: MockState, source: LineView, branch: BranchView, depth: number): [MockState, string[]] {
  const root = branch.rootLineId;
  const below = state.branches.filter((item) => item.rootLineId === source.id).map((item) => item.lineId);
  const inTree = new Set(below);
  const ref = { parentLineId: branch.parentLineId, rootLineId: root, anchorMessageId: branch.anchorMessageId, depth, purpose: branch.purpose, kind: branch.kind, status: branch.status, origin: branch.origin };
  const lines = state.lines.map((line) => {
    if (line.id === source.id) {
      const { pinnedAt: _pin, ...rest } = line;
      return { ...rest, title: branch.purpose, folder: "", tags: [], spunOffFrom: null, conversationBranch: ref, updatedAt: branch.createdAt };
    }
    if (!inTree.has(line.id) || !line.conversationBranch) return line;
    return { ...line, conversationBranch: { ...line.conversationBranch, rootLineId: root, depth: line.conversationBranch.depth + depth } };
  });
  const branches = state.branches.map((item) => (inTree.has(item.lineId) ? { ...item, rootLineId: root, depth: item.depth + depth } : item));
  return [withBranch({ ...state, lines, branches }, branch), below];
}

export function createMockAttach(ctx: MockContext, deps: MockAttachDeps): MockAttach {
  /** The card left at the end of the target, already delivered, and the branch merged with it. */
  function leaveCard(target: LineView, sourceId: string, card: BranchCard, purpose: string): Message {
    const [seq, seqState] = takeSeq(ctx.state());
    const [id, next] = newId(seqState, "card");
    const message = fixture.message({
      id, seq, lineId: target.id, role: "system", kind: "branch_card", status: "done", content: cardMarkdown(card, purpose), createdAt: ctx.now(),
      meta: { branchLineId: sourceId, card, delivered: true },
    });
    ctx.commit(withMessage(next, message));
    closeBranch(ctx, findBranch(ctx.state(), sourceId), { status: "merged", cardMessageId: message.id, conclusionLine: card.conclusion });
    deps.afterMerge(sourceId, card);
    return message;
  }

  function publish(target: LineView, source: LineView, below: readonly string[], card: Message | null, moved: ReturnType<typeof moveTree>): void {
    const root = rootOf(findLine(ctx.state(), target.id));
    publishLine(ctx, source.id);
    if (card) ctx.bus.publish("message.created", address(ctx, target.id), card);
    publishLine(ctx, target.id);
    if (root !== target.id) publishLine(ctx, root);
    ctx.bus.publish("branch.changed", address(ctx, source.id), { change: "created", branch: findBranch(ctx.state(), source.id) });
    if (card) ctx.bus.publish("branch.changed", address(ctx, source.id), { change: "merged", branch: findBranch(ctx.state(), source.id) });
    for (const id of below) ctx.bus.publish("branch.changed", address(ctx, id), { change: "moved", branch: findBranch(ctx.state(), id) });
    if (moved.notes > 0) ctx.bus.publish("notes.changed", { lineId: root, rootLineId: root }, { rootLineId: root, revision: ctx.state().notesRevision[root] ?? 0 });
    if (moved.seeds > 0) ctx.bus.publish("seeds.changed", { lineId: root, rootLineId: root }, { rootLineId: root });
    if (moved.milestones > 0 && isFeatureOn(ctx.scenario.capabilities, "chapters")) ctx.bus.publish("chapters.changed", { lineId: source.id, rootLineId: root }, { rootLineId: root });
    for (const group of ctx.state().groups.filter((item) => moved.groups.includes(item.id))) {
      ctx.bus.publish("group.changed", { lineId: root, rootLineId: root }, { rootLineId: root, group });
    }
    for (const suggestion of moved.expired) ctx.bus.publish("suggestion.changed", { lineId: suggestion.lineId, rootLineId: root }, { rootLineId: root, suggestion });
  }

  function attach(targetLineId: string, input: AttachLineInput): AttachLineResult {
    const target = findLine(ctx.state(), targetLineId);
    const { source, kind, status } = checkAttach(ctx.state(), target, input);
    const purpose = attachPurpose(input.purpose, source, messagesOf(ctx.state(), source.id));
    const card = attachCard(input, status, purpose);
    const depth = checkLimits(ctx.state(), target, source, input, status === "open");
    const anchor = attachAnchor(messagesOf(ctx.state(), target.id), source.createdAt, input.anchorMessageId?.trim() || undefined);
    const root = rootOf(target);
    const now = ctx.now();
    const branch = fixture.branch({
      lineId: source.id, parentLineId: target.id, rootLineId: root, anchorMessageId: anchor.id, depth, purpose, kind, status: "open", origin: "move",
      provider: source.provider, model: source.model, draftStatus: "none", messageCount: messagesOf(ctx.state(), source.id).filter((m) => m.status !== "pending").length,
      createdAt: now, lastActivityAt: source.lastActivityAt,
    });
    const [hung, below] = hangSource(ctx.state(), source, branch, depth);
    const moved = moveTree(hung, source.id, root, now);
    ctx.commit(withLine(moved.state, { ...findLine(moved.state, target.id), lastActivityAt: now, updatedAt: now }));
    const cardMessage = card ? leaveCard(target, source.id, card, purpose) : null;
    publish(target, source, below, cardMessage, moved);
    return {
      targetLine: recount(ctx.state(), target.id),
      branch: findBranch(ctx.state(), source.id),
      branchLine: recount(ctx.state(), source.id),
      cardMessage,
      reparented: below,
    };
  }

  return { attach };
}
