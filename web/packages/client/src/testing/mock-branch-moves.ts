/**
 * Simulated after-the-fact moves (DESIGN §4.3, store/branch_move.go and
 * branch_promote.go): moving a line's last messages into a new branch, and
 * promoting a branch of the main line. Message seqs never change; messages
 * only change lines.
 */
import type { MoveBranchInput, MoveBranchResult, PromoteBranchResult } from "../api-types";
import { BRANCH_MOVE_MAX } from "../branch-move";
import { BRANCH_SOFT_DEPTH_LIMIT } from "../branch-errors";
import { TangentError } from "../errors";
import type { BranchView, LineView, Message } from "../types";
import { closeBranch } from "./mock-branches";
import { address, publishLine, type MockContext } from "./mock-context";
import { findBranch, findLine, messagesOf, newId, recount, rootOf, takeSeq, withBranch, withLine, withMessage, type MockState } from "./mock-store";
import { fixture } from "./scenario";

export interface MockBranchMoves {
  move(lineId: string, input: MoveBranchInput): MoveBranchResult;
  promote(lineId: string): PromoteBranchResult;
}

const PREVIOUS_MAIN_LINE = "Previous main line";

const isChat = (message: Message) => message.kind === "chat" && (message.role === "user" || message.role === "assistant");

/** Puts `messages` on `lineId` (their seqs stay). */
export function relocate(state: MockState, messages: readonly Message[], lineId: string): MockState {
  const ids = new Set(messages.map((message) => message.id));
  return { ...state, messages: state.messages.map((message) => (ids.has(message.id) ? { ...message, lineId } : message)) };
}

/** Every branch below `ids` (not themselves). */
function below(state: MockState, ids: readonly string[]): string[] {
  const found: string[] = [];
  let frontier = [...ids];
  while (frontier.length > 0) {
    const children = state.branches.filter((branch) => frontier.includes(branch.parentLineId)).map((branch) => branch.lineId);
    found.push(...children);
    frontier = children;
  }
  return found;
}

/** Hangs `ids` under `parentLineId` and shifts their depth (and everything below them) by `delta`. */
export function rehang(state: MockState, ids: readonly string[], parentLineId: string, delta: number): MockState {
  const moved = new Set(ids);
  const shifted = new Set([...ids, ...below(state, ids)]);
  const branches = state.branches.map((branch) =>
    shifted.has(branch.lineId) ? { ...branch, depth: branch.depth + delta, parentLineId: moved.has(branch.lineId) ? parentLineId : branch.parentLineId } : branch,
  );
  const lines = state.lines.map((line) => {
    const ref = line.conversationBranch;
    if (!ref || !shifted.has(line.id)) return line;
    return { ...line, conversationBranch: { ...ref, depth: ref.depth + delta, parentLineId: moved.has(line.id) ? parentLineId : ref.parentLineId } };
  });
  return { ...state, branches, lines };
}

export function createMockBranchMoves(ctx: MockContext): MockBranchMoves {
  function newBranchLine(raw: Record<string, unknown>, ref: Record<string, unknown>, source: LineView): [LineView, BranchView] {
    const [id, next] = newId(ctx.state(), "branch");
    ctx.commit(next);
    const now = ctx.now();
    const line = fixture.line({ id, title: ref.purpose, provider: source.provider, model: source.model, conversationBranch: ref, createdAt: now, updatedAt: now, lastActivityAt: now });
    const branch = fixture.branch({ ...ref, ...raw, lineId: id, provider: source.provider, model: source.model, createdAt: now, lastActivityAt: now });
    return [line, branch];
  }

  function checkMove(line: LineView, all: readonly Message[], count: number): void {
    if (line.conversationBranch && line.conversationBranch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    if (line.status === "thinking") throw new TangentError(409, "the line is answering", "source_busy");
    if (count < 1 || count > BRANCH_MOVE_MAX) throw new TangentError(400, `count must be between 1 and ${BRANCH_MOVE_MAX}`, "invalid_count", { max: BRANCH_MOVE_MAX });
    if (count > all.length) throw new TangentError(409, "not enough messages", "not_enough_messages");
    const moved = all.slice(-count);
    if (moved[0]?.role !== "user") throw new TangentError(409, "the first message to move must be one of yours", "move_must_start_with_user");
    if (moved.some((message) => !isChat(message))) throw new TangentError(409, "a card or marker is in the range", "move_protected_message");
    if (!all.slice(0, -count).some(isChat)) throw new TangentError(409, "nothing would be left to branch from", "move_no_anchor");
  }

  function move(lineId: string, input: MoveBranchInput): MoveBranchResult {
    const source = findLine(ctx.state(), lineId);
    const all = messagesOf(ctx.state(), lineId);
    checkMove(source, all, input.count);
    const moved = all.slice(-input.count);
    const anchor = all.slice(0, -input.count).filter(isChat).at(-1)!;
    const depth = (source.conversationBranch?.depth ?? 0) + 1;
    if (depth > BRANCH_SOFT_DEPTH_LIMIT && !input.confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth, limit: BRANCH_SOFT_DEPTH_LIMIT });
    const root = rootOf(source);
    const ref = { parentLineId: lineId, rootLineId: root, anchorMessageId: anchor.id, depth, purpose: input.purpose, kind: input.kind ?? "investigate", status: "open", origin: "move" };
    const [line, branch] = newBranchLine({ messageCount: moved.length, draftStatus: "none" }, ref, source);
    const movedIds = new Set(moved.map((message) => message.id));
    const reparented = ctx.state().branches.filter((item) => item.parentLineId === lineId && movedIds.has(item.anchorMessageId)).map((item) => item.lineId);
    const [seq, afterSeq] = takeSeq(relocate(withBranch(withLine(ctx.state(), line), branch), moved, line.id));
    const [markerId, next] = newId(afterSeq, "marker");
    const marker = fixture.message({ id: markerId, seq, lineId, role: "system", kind: "branch_marker", content: `${moved.length} message(s) moved to a branch: ${input.purpose}`, createdAt: ctx.now(), meta: { branchLineId: line.id } });
    ctx.commit(rehang(withMessage(next, marker), reparented, line.id, 1));
    ctx.bus.publish("line.created", { lineId: line.id, rootLineId: root }, line);
    ctx.bus.publish("message.created", address(ctx, lineId), marker);
    ctx.bus.publish("branch.changed", address(ctx, line.id), { change: "moved", branch: findBranch(ctx.state(), line.id) });
    publishLine(ctx, lineId);
    return { line: recount(ctx.state(), line.id), branch: findBranch(ctx.state(), line.id), marker, sourceLineId: lineId, rootLineId: root, movedMessageIds: [...movedIds], reparented, summaryReset: false };
  }

  function checkPromote(branch: BranchView): void {
    const state = ctx.state();
    if (branch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    if (branch.parentLineId !== branch.rootLineId) throw new TangentError(409, "only a branch of the main line", "promote_not_top_level");
    if (branch.draftStatus === "drafting") throw new TangentError(409, "a card is being drafted", "branch_drafting");
    if (findLine(state, branch.rootLineId).status === "thinking") throw new TangentError(409, "the main line is answering", "parent_busy");
    if (findLine(state, branch.lineId).status === "thinking") throw new TangentError(409, "the branch is answering", "branch_busy");
  }

  function promote(lineId: string): PromoteBranchResult {
    const branch = findBranch(ctx.state(), lineId);
    checkPromote(branch);
    const root = branch.rootLineId;
    const main = messagesOf(ctx.state(), root);
    const anchorSeq = main.find((message) => message.id === branch.anchorMessageId)?.seq ?? 0;
    const tail = main.filter((message) => message.seq > anchorSeq);
    const tailIds = new Set(tail.map((message) => message.id));
    const onTail = ctx.state().branches.filter((item) => item.parentLineId === root && item.lineId !== lineId && tailIds.has(item.anchorMessageId)).map((item) => item.lineId);
    const blockers = [...onTail, ...below(ctx.state(), onTail)].filter((id) => findBranch(ctx.state(), id).status === "open");
    if (blockers.length > 0) throw new TangentError(409, "unfinished branches on the old tail", "open_branches_on_old_tail", { lineIds: blockers });
    const mainLine = findLine(ctx.state(), root);
    const ref = { parentLineId: root, rootLineId: root, anchorMessageId: branch.anchorMessageId, depth: 1, purpose: PREVIOUS_MAIN_LINE, kind: "alternative", status: "discarded", origin: "previous_main_line" };
    const [previousLine, previous] = newBranchLine({ messageCount: tail.length, draftStatus: "none", closedAt: ctx.now() }, ref, mainLine);
    const lifted = ctx.state().branches.filter((item) => item.parentLineId === lineId).map((item) => item.lineId);
    const branchMessages = messagesOf(ctx.state(), lineId);
    let state = relocate(relocate(withBranch(withLine(ctx.state(), previousLine), previous), tail, previousLine.id), branchMessages, root);
    state = rehang(rehang(state, onTail, previousLine.id, 1), lifted, root, -1);
    ctx.commit(state);
    const promoted = closeBranch(ctx, findBranch(ctx.state(), lineId), { status: "promoted", messageCount: 0 });
    ctx.bus.publish("line.created", { lineId: previousLine.id, rootLineId: root }, previousLine);
    ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "promoted", branch: promoted });
    publishLine(ctx, lineId);
    const line = publishLine(ctx, root);
    return { branch: promoted, previousMainLine: findBranch(ctx.state(), previousLine.id), line, reparented: [...onTail, ...lifted] };
  }

  return { move, promote };
}
