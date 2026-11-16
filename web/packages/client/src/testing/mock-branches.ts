/** Simulated branch routes: list, create, detail, draft, merge and discard (move and promote: mock-branch-moves.ts). */
import type { BranchList, CreateBranchInput, CreateBranchResult, DiscardBranchResult, JobStarted, ListBranchesQuery, MergeBranchBody, MergeBranchResult } from "../api-types";
import type { BranchPreview, PreviewBranchInput, RenameBranchInput, RenameBranchResult } from "../b5-routes";
import { canAnchorBranch, type UpdateBranchCardInput } from "../b17-routes";
import { normalizeBranchCard, normalizeBranchDetail, normalizeBranchPack } from "../branch-normalize";
import { BRANCH_PURPOSE_MAX } from "../branch-input";
import { BRANCH_HARD_DEPTH_LIMIT, BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "../branch-errors";
import { chatMessages } from "../branch-view";
import { isFeatureOn } from "../capabilities";
import { canRenameBranch } from "../branch-promote";
import { TangentError } from "../errors";
import type { BranchCard, BranchDetail, BranchOrigin, BranchView, LineView, Message } from "../types";
import { address, publishLine, type MockContext } from "./mock-context";
import { findBranch, findLine, messagesOf, newId, rootOf, takeSeq, withBranch, withLine, withMessage } from "./mock-store";
import { fixture } from "./scenario";

export interface MockBranches {
  list(lineId: string, query: ListBranchesQuery): BranchList;
  /** `origin` overrides the one the input implies (a seed's expansion, B8). */
  create(lineId: string, input: CreateBranchInput, origin?: BranchOrigin): CreateBranchResult;
  detail(lineId: string): BranchDetail;
  draft(lineId: string): JobStarted;
  merge(lineId: string, body: MergeBranchBody): MergeBranchResult;
  discard(lineId: string): DiscardBranchResult;
  /** B5: the pack a branch opened now would get; writes nothing. */
  preview(lineId: string, input: PreviewBranchInput): BranchPreview;
  /** B5: an open branch's new purpose. */
  rename(lineId: string, input: RenameBranchInput): RenameBranchResult;
  /** B17: a merged branch's card, edited in place (`meta.delivered` cleared, B17.1 `meta.editedAt` and `cardEditedAt` set); `before` is the card it replaced. */
  updateCard(lineId: string, input: UpdateBranchCardInput): { branch: BranchView; message: Message; before: BranchCard | null };
}

const PACK_TOKEN_ESTIMATE = 2400;
const PACK_TOKEN_BUDGET = 8000;

/** B17: a card anchor ends the pack with the card, quoted under its own header (domain packBlockHeader). */
function cardBlock(card: Message | undefined) {
  if (!card || card.kind !== "branch_card") return { text: "", recent: [] };
  const quoted = card.content.split("\n").map((line) => `> ${line}`).join("\n");
  return { text: `[main-line message ${card.id} · branch conclusion card]\n${quoted}`, recent: [{ id: card.id, seq: card.seq, role: "system", createdAt: card.createdAt, truncated: false }] };
}

function packFor(purpose: string, excerpt: string, anchorMessageId: string, later = { included: false, messages: 0 }, anchor?: Message) {
  const card = cardBlock(anchor);
  return normalizeBranchPack({
    rendered: [`Purpose: ${purpose}\n${excerpt}`.trim(), card.text].filter(Boolean).join("\n\n"),
    recent: card.recent,
    anchorMessageId,
    purpose,
    excerpt,
    tokenEstimate: PACK_TOKEN_ESTIMATE,
    tokenBudget: PACK_TOKEN_BUDGET,
    laterIncluded: later.included,
    laterMessages: later.messages,
    laterQuoted: later.messages,
  });
}

/**
 * B17.1: a card edit's time, like the server's clock: now, but always later
 * than every branch of the tree opened so far and than the card's previous
 * edit (a mock clock may stand still), so a follow-up opened before the edit
 * reads as older.
 */
function editTime(ctx: MockContext, rootLineId: string, previous: string | undefined): string {
  const times = [...ctx.state().branches.filter((item) => item.rootLineId === rootLineId).map((item) => item.createdAt), previous ?? ""];
  const latest = Math.max(...times.map((time) => Date.parse(time)).filter((ms) => !Number.isNaN(ms)));
  const now = Date.parse(ctx.now());
  return new Date(Number.isFinite(latest) && now <= latest ? latest + 1 : now).toISOString();
}

function originOf(input: CreateBranchInput): BranchOrigin {
  if (input.suggestionMessageId) return "suggestion";
  return input.excerpt ? "selection" : "button";
}

/** Closes a branch: its view and its line's `conversationBranch` get the new status. */
export function closeBranch(ctx: MockContext, branch: BranchView, change: Partial<BranchView>): BranchView {
  const closed: BranchView = { ...branch, ...change, closedAt: ctx.now(), lastActivityAt: ctx.now() };
  const line = findLine(ctx.state(), branch.lineId);
  const ref = line.conversationBranch ? { ...line.conversationBranch, status: closed.status } : null;
  ctx.commit(withLine(withBranch(ctx.state(), closed), { ...line, conversationBranch: ref }));
  return closed;
}

export function createMockBranches(ctx: MockContext): MockBranches {
  function openBranch(lineId: string): BranchView {
    const branch = findBranch(ctx.state(), lineId);
    if (branch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    return branch;
  }

  /** The Engine's refusals of a new branch, in its order (domain.CheckBranchCreate). */
  function checkCreate(parent: LineView, input: CreateBranchInput, depth: number): void {
    const state = ctx.state();
    if (input.kind === "aside" && !isFeatureOn(ctx.scenario.capabilities, "aside")) throw new TangentError(404, "the aside feature is off", "feature_disabled", { feature: "aside" });
    // B23: only an aside can be kept.
    if (input.keep && input.kind !== "aside") throw new TangentError(400, "only an aside can be kept", "invalid_input", { field: "keep" });
    if (parent.conversationBranch && parent.conversationBranch.status !== "open") throw new TangentError(409, "the parent branch has ended", "parent_closed");
    // domain.CanAnchorBranch: a finished user / assistant chat message or (B17) a conclusion card of this line.
    if (!messagesOf(state, parent.id).some((message) => message.id === input.anchorMessageId && canAnchorBranch(message))) throw new TangentError(404, "the anchor message is not on this line", "anchor_not_found");
    // domain.CheckBranchCreate: the hard limits come before the soft one, so nobody confirms a branch that is then refused.
    if (depth > BRANCH_HARD_DEPTH_LIMIT) throw new TangentError(409, "too deep", "depth_hard_limit", { limit: BRANCH_HARD_DEPTH_LIMIT });
    const open = state.branches.filter((branch) => branch.parentLineId === parent.id && branch.status === "open").length;
    if (open >= BRANCH_OPEN_PER_PARENT_LIMIT) throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
    if (state.branches.filter((branch) => branch.rootLineId === rootOf(parent)).length >= BRANCH_TREE_LIMIT) {
      throw new TangentError(409, "the tree is full", "tree_limit", { limit: BRANCH_TREE_LIMIT });
    }
    if (depth > BRANCH_SOFT_DEPTH_LIMIT && !input.confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth, limit: BRANCH_SOFT_DEPTH_LIMIT });
  }

  /** The anchor message on the parent line, when it is a card (its pack quotes it). */
  const anchorOf = (parentId: string, anchorId: string) => messagesOf(ctx.state(), parentId).find((message) => message.id === anchorId && message.kind === "branch_card");

  function laterOf(parentId: string, anchorId: string, include: boolean) {
    const chat = chatMessages(messagesOf(ctx.state(), parentId));
    const index = chat.findIndex((message) => message.id === anchorId);
    return { included: include, messages: include ? chat.length - index - 1 : 0 };
  }

  function finishDraft(lineId: string): void {
    const state = ctx.state();
    const current = state.branches.find((item) => item.lineId === lineId);
    if (!current || current.draftStatus !== "drafting") return;
    const ready: BranchView = { ...current, draftStatus: "ready" };
    const card = state.draftCards[lineId] ?? fixture.card({ question: current.purpose, conclusion: "The branch reached a conclusion (mock)." });
    const tip = messagesOf(state, current.parentLineId).at(-1)?.id ?? "";
    ctx.commit(withBranch({ ...state, draftCards: { ...state.draftCards, [lineId]: card }, draftTips: { ...state.draftTips, [lineId]: tip } }, ready));
    ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "draft", branch: ready });
  }

  /** A stale tip is refused unless the user confirmed bringing the card back anyway. */
  function checkTip(branch: BranchView, body: MergeBranchBody): void {
    const parentMessages = messagesOf(ctx.state(), branch.parentLineId);
    const tip = parentMessages.at(-1);
    if (!tip || tip.id === body.parentTipMessageId || body.confirmParentMoved) return;
    const seen = parentMessages.find((message) => message.id === body.parentTipMessageId)?.seq ?? 0;
    const moved = chatMessages(parentMessages).filter((message) => message.seq > seen).length;
    throw new TangentError(409, "the main line moved on", "parent_moved", { movedMessages: moved, movedCards: 0 });
  }

  return {
    list(lineId, query) {
      const root = rootOf(findLine(ctx.state(), lineId));
      const branches = ctx.state().branches.filter((branch) => branch.rootLineId === root && (query.includeAside || branch.kind !== "aside"));
      return { branches };
    },

    create(lineId, input, origin) {
      const parent = findLine(ctx.state(), lineId);
      const depth = (parent.conversationBranch?.depth ?? 0) + 1;
      checkCreate(parent, input, depth);
      const [id, next] = newId(ctx.state(), "branch");
      const now = ctx.now();
      const ref = { parentLineId: lineId, rootLineId: rootOf(parent), anchorMessageId: input.anchorMessageId, depth, purpose: input.purpose, kind: input.kind, status: "open", origin: origin ?? originOf(input) };
      const line: LineView = fixture.line({ id, title: input.purpose, provider: input.provider ?? parent.provider, model: input.model ?? parent.model, conversationBranch: ref, createdAt: now, updatedAt: now, lastActivityAt: now });
      const branch = fixture.branch({ ...ref, lineId: id, excerpt: input.excerpt ?? "", provider: line.provider, model: line.model, draftStatus: "none", createdAt: now, lastActivityAt: now, ...(input.keep ? { keptAt: now } : {}) });
      const pack = packFor(input.purpose, input.excerpt ?? "", input.anchorMessageId, laterOf(lineId, input.anchorMessageId, input.includeLater === true), anchorOf(lineId, input.anchorMessageId));
      ctx.commit(withBranch(withLine({ ...next, packs: { ...next.packs, [id]: pack } }, line), branch));
      ctx.bus.publish("line.created", { lineId: id, rootLineId: ref.rootLineId }, line);
      ctx.bus.publish("branch.changed", { lineId: id, rootLineId: ref.rootLineId }, { change: "created", branch });
      publishLine(ctx, lineId);
      return { branch, line, pack };
    },

    detail(lineId) {
      const branch = findBranch(ctx.state(), lineId);
      const state = ctx.state();
      const card = branch.draftStatus === "ready" ? (state.draftCards[lineId] ?? null) : null;
      // With notes on, a ready draft proposes writing its conclusion under 已決定 (B5: the AI's note proposals).
      const proposals = card && card.conclusion ? [{ op: "add", section: "decided", sourceLineId: lineId, text: card.conclusion }] : [];
      // Always present (B5); only a ready draft with notes on proposes anything.
      const noteChanges = { noteChanges: isFeatureOn(ctx.scenario.capabilities, "notes") ? proposals : [] };
      return normalizeBranchDetail({
        branch,
        pack: state.packs[lineId] ?? packFor(branch.purpose, branch.excerpt, branch.anchorMessageId),
        draft: { status: branch.draftStatus || "none", card, provider: branch.provider, model: branch.model, manualCardAvailable: true, parentTipMessageId: state.draftTips[lineId] ?? "", ...noteChanges },
        parentTipMessageId: messagesOf(state, branch.parentLineId).at(-1)?.id ?? "",
      });
    },

    draft(lineId) {
      const branch = openBranch(lineId);
      if (branch.draftStatus === "drafting") throw new TangentError(409, "a draft is already running", "branch_drafting");
      if (messagesOf(ctx.state(), lineId).length === 0) throw new TangentError(409, "the branch has no messages yet", "no_messages");
      const [jobId, next] = newId(ctx.state(), "job");
      const drafting: BranchView = { ...branch, draftStatus: "drafting" };
      ctx.commit(withBranch(next, drafting));
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "draft", branch: drafting });
      ctx.timers.setTimeout(() => finishDraft(lineId), ctx.draftMs);
      return { jobId, kind: "card_draft", lineId, provider: branch.provider, model: branch.model };
    },

    preview(lineId, input) {
      // B5: only the input is checked (anchor, the aside feature); the depth and count limits wait for the real create.
      if (input.kind === "aside" && !isFeatureOn(ctx.scenario.capabilities, "aside")) throw new TangentError(404, "the aside feature is off", "feature_disabled", { feature: "aside" });
      if (!messagesOf(ctx.state(), findLine(ctx.state(), lineId).id).some((message) => message.id === input.anchorMessageId && canAnchorBranch(message))) {
        throw new TangentError(404, "the anchor message is not on this line", "anchor_not_found");
      }
      const pack = packFor(input.purpose ?? "", input.excerpt ?? "", input.anchorMessageId, laterOf(lineId, input.anchorMessageId, input.includeLater === true), anchorOf(lineId, input.anchorMessageId));
      return { pack, text: pack.rendered, tokenEstimate: pack.tokenEstimate };
    },

    rename(lineId, input) {
      // B13: ended branches too; not a promoted one or the previous main line.
      const branch = findBranch(ctx.state(), lineId);
      if (!canRenameBranch(branch)) throw new TangentError(409, "this branch cannot be renamed", "branch_closed");
      if (findLine(ctx.state(), branch.rootLineId).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
      const purpose = input.purpose.trim();
      // B5: missing, blank or over 200 characters is 400 invalid_input.
      if (!purpose || Array.from(purpose).length > BRANCH_PURPOSE_MAX) throw new TangentError(400, "the purpose must be 1–200 characters", "invalid_input");
      const renamed: BranchView = { ...branch, purpose, lastActivityAt: ctx.now() };
      const line = findLine(ctx.state(), lineId);
      const ref = line.conversationBranch ? { ...line.conversationBranch, purpose } : null;
      // The branch line's title follows (the pack stays the snapshot it was).
      ctx.commit(withLine(withBranch(ctx.state(), renamed), { ...line, title: purpose, conversationBranch: ref, updatedAt: ctx.now() }));
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "renamed", branch: renamed });
      publishLine(ctx, lineId);
      return { branch: renamed };
    },

    merge(lineId, body) {
      const branch = openBranch(lineId);
      const card = normalizeBranchCard(body.card);
      if (!card || !card.conclusion.trim()) throw new TangentError(422, "the card needs a conclusion", "invalid_card", { problems: [{ field: "conclusion", message: "required" }] });
      checkTip(branch, body);
      const [seq, afterSeq] = takeSeq(ctx.state());
      const [messageId, next] = newId(afterSeq, "card");
      const message = fixture.message({ id: messageId, seq, lineId: branch.parentLineId, role: "system", kind: "branch_card", content: card.conclusion, createdAt: ctx.now(), meta: { card, branchLineId: lineId } });
      ctx.commit(withMessage(next, message));
      const merged = closeBranch(ctx, branch, { status: "merged", cardMessageId: messageId, conclusionLine: card.conclusion });
      ctx.bus.publish("message.created", address(ctx, branch.parentLineId), message);
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "merged", branch: merged });
      const parent = publishLine(ctx, branch.parentLineId);
      return { branch: merged, message, line: parent };
    },

    updateCard(lineId, input) {
      const branch = findBranch(ctx.state(), lineId);
      if (branch.status !== "merged" || !branch.cardMessageId) throw new TangentError(409, "only a merged branch has a conclusion card to edit", "branch_closed");
      if (findLine(ctx.state(), branch.rootLineId).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
      const card = normalizeBranchCard(input.card);
      if (!card || !card.question.trim() || !card.conclusion.trim()) {
        const field = !card?.question.trim() ? "question" : "conclusion";
        throw new TangentError(422, "the card is not acceptable", "invalid_card", { problems: [{ field, message: "required" }] });
      }
      const old = messagesOf(ctx.state(), branch.parentLineId).find((message) => message.id === branch.cardMessageId);
      // The card moved to the previous main line (a promotion), or the line holding it has ended.
      const parent = findLine(ctx.state(), branch.parentLineId);
      if (!old || (parent.conversationBranch && parent.conversationBranch.status !== "open")) throw new TangentError(409, "the line holding the card has ended", "parent_closed");
      if (parent.status === "thinking") throw new TangentError(409, "the parent line is mid-turn", "parent_busy");
      const { delivered: _delivered, ...meta } = old.meta;
      const editedAt = editTime(ctx, branch.rootLineId, old.meta.editedAt);
      const message: Message = { ...old, content: card.conclusion, meta: { ...meta, card, editedAt } };
      ctx.commit(withMessage(ctx.state(), message));
      const edited: BranchView = { ...findBranch(ctx.state(), lineId), conclusionLine: card.conclusion, cardEditedAt: editedAt };
      ctx.commit(withBranch(ctx.state(), edited));
      // The same events as the server, in its order: the card, then the branch merged again (= its card was edited).
      ctx.bus.publish("message.updated", address(ctx, branch.parentLineId), message);
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "merged", branch: edited });
      return { branch: edited, message, before: old.meta.card ?? null };
    },

    discard(lineId) {
      const branch = openBranch(lineId);
      const discarded = closeBranch(ctx, branch, { status: "discarded" });
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "discarded", branch: discarded });
      publishLine(ctx, branch.parentLineId);
      return { branch: discarded };
    },
  };
}
