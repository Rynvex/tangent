/**
 * Simulated spinoff and tree balance (B8 phase B): `POST /lines/{id}/spinoff`
 * (detach an open branch with everything under it, or start fresh from a
 * message) and the `rebalance` suggestion a branch
 * turn may propose (its accept runs promote or detach).
 */
import type { NotesView, PromoteBranchResult } from "../api-types";
import { featureMode, isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import type { SpinoffInput, SpinoffPreview, SpinoffResult } from "../spinoff-routes";
import { estimateTokens } from "../branch-pack-estimate";
import type { RebalanceResult } from "../spinoff";
import type { BranchView, Link, LineView, Message, Note, Suggestion } from "../types";
import { publishLine, type MockContext } from "./mock-context";
import { termsRehomed } from "./mock-glossary";
import { findBranch, findLine, messagesOf, newId, rootOf, takeSeq, withLine, withMessage } from "./mock-store";
import { fixture } from "./scenario";

export interface MockSpinoff {
  spinoff(lineId: string, input: SpinoffInput): SpinoffResult;
  /** B8.2: the capsule that spinoff would store; nothing is written. */
  preview(lineId: string, input: SpinoffInput): SpinoffPreview;
  /** After a branch's turn: proposes the tree-balance suggestion when it is due. */
  afterTurn(lineId: string): void;
  /** Accepts a tree-balance suggestion: runs the chosen action. */
  acceptRebalance(suggestion: Suggestion, body: Readonly<Record<string, unknown>>): RebalanceResult;
}

export interface MockSpinoffDeps {
  promote(lineId: string): PromoteBranchResult;
  propose(suggestion: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void;
  expireFor(lineIds: readonly string[]): void;
  notes(rootLineId: string): NotesView;
  /** Detach: the active groups with a member among these lines dissolve (R8). */
  dissolveGroups(lineIds: readonly string[]): void;
}

/** domain.DefaultLimits().Rebalance. */
const REBALANCE = { minBranchTurns: 6, shareFactor: 2, recentTurns: 5 } as const;
const TITLE_MAX = 200;

const doneReplies = (messages: readonly Message[]) => messages.filter((message) => message.role === "assistant" && message.kind === "chat" && message.status === "done");

export function createMockSpinoff(ctx: MockContext, deps: MockSpinoffDeps): MockSpinoff {
  const state = () => ctx.state();

  function requireSpinoff(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "spinoff")) throw new TangentError(404, "the spinoff feature is off", "feature_disabled", { feature: "spinoff" });
  }

  function titleOf(input: SpinoffInput, fallback: string): string {
    const title = (input.title ?? "").trim() || fallback;
    if (Array.from(title).length > TITLE_MAX) throw new TangentError(422, "the title is too long", "too_long", { field: "title", max: TITLE_MAX });
    return title;
  }

  /** The marker on the source line and the link between the two conversations; both published. */
  function connect(source: LineView, atMessageId: string, target: LineView): { marker: Message; link: Link } {
    const [seq, afterSeq] = takeSeq(state());
    const [markerId, afterMarker] = newId(afterSeq, "marker");
    const [linkId, next] = newId(afterMarker, "link");
    const marker = fixture.message({
      id: markerId, seq, lineId: source.id, role: "system", kind: "branch_marker", createdAt: ctx.now(),
      content: `Spun off into a new conversation: ${target.title}`,
      meta: { spunOffTo: { lineId: target.id, messageId: atMessageId, title: target.title, available: true } },
    });
    const link: Link = {
      id: linkId, kind: "spinoff", fromLineId: source.id, fromMessageId: atMessageId, toLineId: target.id, toMessageId: "",
      label: target.title, fromTitle: source.title, toTitle: target.title, createdBy: "mock-user", createdAt: ctx.now(),
    };
    ctx.commit({ ...withMessage(next, marker), links: [...next.links, link] });
    ctx.bus.publish("message.created", { lineId: source.id, rootLineId: rootOf(source) }, marker);
    publishLine(ctx, source.id);
    for (const root of new Set([rootOf(source), target.id])) ctx.bus.publish("link.changed", { lineId: root, rootLineId: root }, { rootLineId: root, link });
    return { marker, link };
  }

  /** `copyNotes`: the old tree's active notes, copied in order and pointing back. */
  function copyNotes(from: string, to: string): NonNullable<SpinoffResult["notes"]> {
    const active = deps.notes(from).notes.filter((note) => note.status === "active").reverse();
    let next = state();
    const created: Note[] = active.map((note) => {
      const [id, after] = newId(next, "note");
      next = after;
      return { ...note, id, copiedFromNoteId: note.id, createdAt: ctx.now(), updatedAt: ctx.now() };
    });
    const revision = (next.notesRevision[to] ?? 0) + 1;
    ctx.commit({ ...next, notesByRoot: { ...next.notesByRoot, [to]: created }, notesRevision: { ...next.notesRevision, [to]: revision } });
    ctx.bus.publish("notes.changed", { lineId: to, rootLineId: to }, { rootLineId: to, revision });
    return { rootLineId: to, revision, created, superseded: [] };
  }

  const descendants = (lineId: string): string[] => state().branches.filter((branch) => branch.parentLineId === lineId).flatMap((branch) => [branch.lineId, ...descendants(branch.lineId)]);

  /** Moves the branch's subtree into a tree of its own (store.Detach). */
  function moveSubtree(branch: BranchView, title: string, source: LineView): LineView {
    const below = descendants(branch.lineId);
    const inSubtree = new Set([branch.lineId, ...below]);
    const current = state();
    const branches = current.branches
      .filter((item) => item.lineId !== branch.lineId)
      .map((item) => (inSubtree.has(item.lineId) ? { ...item, rootLineId: branch.lineId, depth: item.depth - branch.depth } : item));
    const lines = current.lines.map((line) => {
      if (line.id === branch.lineId) {
        const { pinnedAt: _pin, importBatchId: _batch, ...rest } = line;
        return { ...rest, title, conversationBranch: null, spunOffFrom: { lineId: source.id, messageId: branch.anchorMessageId, title: source.title, available: true } };
      }
      if (!inSubtree.has(line.id) || !line.conversationBranch) return line;
      return { ...line, conversationBranch: { ...line.conversationBranch, rootLineId: branch.lineId, depth: line.conversationBranch.depth - branch.depth } };
    });
    const movedMessages = new Set(current.messages.filter((message) => inSubtree.has(message.lineId)).map((message) => message.id));
    const { [branch.lineId]: _ownLeaf, ...leaves } = current.leaves;
    const { [branch.lineId]: _ownBaseline, ...importBaselines } = current.importBaselines;
    ctx.commit({
      ...current,
      branches,
      lines,
      importBaselines,
      leaves: Object.fromEntries(Object.entries(leaves).map(([id, leaf]) => [id, inSubtree.has(id) ? { ...leaf, rootLineId: branch.lineId } : leaf])),
      seeds: current.seeds.map((seed) => (movedMessages.has(seed.anchorMessageId) ? { ...seed, rootLineId: branch.lineId } : seed)),
      suggestions: current.suggestions.map((item) => (inSubtree.has(item.lineId) && item.lineId !== branch.lineId ? { ...item, rootLineId: branch.lineId } : item)),
      terms: termsRehomed(current.terms, inSubtree, branch.lineId),
    });
    return findLine(state(), branch.lineId);
  }

  function detach(lineId: string, input: SpinoffInput): SpinoffResult {
    const branch = findBranch(state(), lineId);
    if (branch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    if (findLine(state(), branch.rootLineId).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    if (findLine(state(), lineId).status === "thinking") throw new TangentError(409, "the branch is answering", "branch_busy");
    if (findLine(state(), branch.parentLineId).status === "thinking") throw new TangentError(409, "the parent is answering", "source_busy");
    if (branch.draftStatus === "drafting") throw new TangentError(409, "a card is being drafted", "branch_drafting");
    const source = findLine(state(), branch.parentLineId);
    const oldRoot = branch.rootLineId;
    const moved = descendants(lineId);
    deps.expireFor([lineId]);
    // R8: groups lose members to the other conversation: they dissolve (group.changed), before the move.
    deps.dissolveGroups([lineId, ...moved]);
    const line = moveSubtree(branch, titleOf(input, branch.purpose), source);
    ctx.bus.publish("line.created", { lineId, rootLineId: lineId }, line);
    const { marker, link } = connect(source, branch.anchorMessageId, line);
    const notes = input.copyNotes ? { notes: copyNotes(oldRoot, lineId) } : {};
    ctx.bus.publish("branch.changed", { lineId, rootLineId: oldRoot }, { change: "detached", branch });
    for (const id of moved) ctx.bus.publish("branch.changed", { lineId: id, rootLineId: lineId }, { change: "moved", branch: findBranch(state(), id) });
    publishLine(ctx, oldRoot);
    return { mode: "detach", line: publishLine(ctx, lineId), sourceLineId: source.id, rootLineId: oldRoot, marker, link, branch, moved, ...notes };
  }

  function fresh(lineId: string, input: SpinoffInput): SpinoffResult {
    const source = findLine(state(), lineId);
    const at = messagesOf(state(), lineId).find((message) => message.id === input.atMessageId && message.kind === "chat" && message.status === "done" && message.role !== "system");
    if (!at) throw new TangentError(404, "the message is not on this line", "anchor_not_found");
    if (source.status === "thinking") throw new TangentError(409, "the line is answering", "source_busy");
    const [id, next] = newId(state(), "line");
    const now = ctx.now();
    const title = titleOf(input, source.conversationBranch?.purpose || source.title);
    const line = fixture.line({ id, title, provider: source.provider, model: source.model, createdAt: now, updatedAt: now, lastActivityAt: now, spunOffFrom: { lineId, messageId: at.id, title: source.title } });
    ctx.commit(withLine(next, line));
    ctx.bus.publish("line.created", { lineId: id, rootLineId: id }, line);
    const { marker, link } = connect(source, at.id, line);
    const notes = input.copyNotes ? { notes: copyNotes(rootOf(source), id) } : {};
    return { mode: "fresh", line: publishLine(ctx, id), sourceLineId: lineId, rootLineId: rootOf(source), marker, link, moved: [], ...notes };
  }

  /** domain.RebalanceDue: enough replies here and twice the parent's since the fork, or the tree's last replies all here. */
  function due(branch: BranchView): { reason: "share" | "recent"; branchTurns: number; parentTurns: number; recentInBranch: boolean } | null {
    const branchTurns = doneReplies(messagesOf(state(), branch.lineId)).length;
    const parentMessages = messagesOf(state(), branch.parentLineId);
    const anchorSeq = parentMessages.find((message) => message.id === branch.anchorMessageId)?.seq ?? 0;
    const parentTurns = doneReplies(parentMessages.filter((message) => message.seq > anchorSeq)).length;
    const treeLines = new Set(state().lines.filter((line) => rootOf(line) === branch.rootLineId).map((line) => line.id));
    const recent = doneReplies(state().messages.filter((message) => treeLines.has(message.lineId))).sort((a, b) => a.seq - b.seq).slice(-REBALANCE.recentTurns);
    const recentInBranch = recent.length === REBALANCE.recentTurns && recent.every((message) => message.lineId === branch.lineId);
    if (branchTurns >= REBALANCE.minBranchTurns && branchTurns >= REBALANCE.shareFactor * parentTurns) return { reason: "share", branchTurns, parentTurns, recentInBranch };
    if (recentInBranch && branchTurns >= REBALANCE.recentTurns) return { reason: "recent", branchTurns, parentTurns, recentInBranch };
    return null;
  }

  return {
    spinoff(lineId, input) {
      requireSpinoff();
      if (input.mode === "detach") return detach(lineId, input);
      if (input.mode === "fresh") return fresh(lineId, input);
      throw new TangentError(400, "mode must be detach or fresh", "invalid_input");
    },

    preview(lineId, input) {
      requireSpinoff();
      const line = findLine(state(), lineId);
      if (input.mode === "detach") {
        const branch = findBranch(state(), lineId);
        if (branch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
      } else if (input.mode === "fresh") {
        const at = messagesOf(state(), lineId).some((message) => message.id === input.atMessageId && message.kind === "chat" && message.status === "done");
        if (!at) throw new TangentError(404, "the message is not on this line", "anchor_not_found");
      } else {
        throw new TangentError(400, "mode must be detach or fresh", "invalid_input");
      }
      const source = line.conversationBranch ? findLine(state(), line.conversationBranch.parentLineId) : line;
      const text = `## Where this conversation came from\n\nThis conversation was spun off from an earlier one (mock).\n\nEarlier conversation:\n> ${source.title}\n\nPurpose: ${line.conversationBranch?.purpose ?? line.title}\n\n(End of the carried-over background.)\n`;
      const notesToCopy = input.copyNotes ? deps.notes(rootOf(line)).notes.filter((note) => note.status === "active").length : 0;
      return { mode: input.mode, capsule: { text, tokenEstimate: estimateTokens(text), tokenBudget: 6000, truncated: false }, notesToCopy };
    },

    afterTurn(lineId) {
      const mode = featureMode(ctx.scenario.capabilities, "rebalance");
      if (mode !== "suggest" && mode !== "auto") return;
      const branch = state().branches.find((item) => item.lineId === lineId);
      if (!branch || branch.status !== "open" || branch.kind === "aside") return;
      const signals = due(branch);
      const actions = [...(branch.parentLineId === branch.rootLineId ? ["promote"] : []), ...(isFeatureOn(ctx.scenario.capabilities, "spinoff") ? ["spinoff"] : [])];
      if (!signals || actions.length === 0) return;
      const parentIsMain = branch.parentLineId === branch.rootLineId;
      const parentTitle = parentIsMain ? "" : findLine(state(), branch.parentLineId).title;
      deps.propose({ rootLineId: branch.rootLineId, lineId, feature: "rebalance", kind: "promote_or_spinoff", targetKey: `branch:${lineId}`, payload: { ...signals, actions, parentIsMain, parentTitle } });
    },

    acceptRebalance(suggestion, body) {
      if (body.action === "promote") {
        const promoted = deps.promote(suggestion.lineId);
        return { action: "promote", line: promoted.line, branch: promoted.branch, previousMainLine: promoted.previousMainLine };
      }
      if (body.action === "spinoff") {
        requireSpinoff();
        const input: SpinoffInput = { mode: "detach", ...(typeof body.title === "string" ? { title: body.title } : {}), ...(body.copyNotes === true ? { copyNotes: true } : {}) };
        const result = detach(suggestion.lineId, input);
        return { action: "spinoff", line: result.line, link: result.link };
      }
      throw new TangentError(400, "action must be promote or spinoff", "invalid_input");
    },
  };
}
