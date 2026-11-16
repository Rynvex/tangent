/**
 * The routes B23 added, as the server runs them: keeping an aside, continuing
 * an answered aside as an open branch at the same place, and deleting an
 * ended branch with everything under it (store.KeepBranch, ContinueAside,
 * DeleteBranch). The refusals and the events come in the server's order
 * (docs/devlog/B23-aside-keep-continue-delete.md).
 */
import type { ContinueAsideInput, ContinueAsideResult, DeleteBranchResult, KeepBranchResult } from "../aside-routes";
import { branchDescendants, canDeleteBranch } from "../aside-rules";
import { canAnchorBranch } from "../b17-routes";
import { BRANCH_HARD_DEPTH_LIMIT, BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "../branch-errors";
import { BRANCH_PURPOSE_MAX } from "../branch-input";
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import type { BranchView, LineView, Link } from "../types";
import { address, publishLine, type MockContext } from "./mock-context";
import { termsRepointed, termsWithoutLines } from "./mock-glossary";
import { findBranch, findLine, messagesOf, newId, withBranch, withLine, type MockState } from "./mock-store";
import { fixture } from "./scenario";

/** domain.GroupMinMembers: a group left with fewer members is dissolved. */
const GROUP_MIN_MEMBERS = 2;

export interface MockAside {
  keep(lineId: string, keep: boolean): KeepBranchResult;
  continueAside(lineId: string, input: ContinueAsideInput): ContinueAsideResult;
  deleteBranch(lineId: string): DeleteBranchResult;
}

export interface MockAsideDeps {
  /** The open suggestions about these lines expire (with their `suggestion.changed`). */
  expireFor(lineIds: readonly string[]): void;
}

function without<T>(record: Readonly<Record<string, T>>, gone: ReadonlySet<string>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !gone.has(key)));
}

/** The state without `gone` and what hangs on those lines; their memos stay in the tree with no node (`line_id ON DELETE SET NULL`). */
function dropLines(state: MockState, gone: ReadonlySet<string>): MockState {
  return {
    ...state,
    lines: state.lines.filter((line) => !gone.has(line.id)),
    messages: state.messages.filter((message) => !gone.has(message.lineId)),
    // `merged_into_line_id` is ON DELETE SET NULL too: a branch combined into a deleted one reads as plainly discarded.
    branches: state.branches.filter((branch) => !gone.has(branch.lineId)).map((branch) => (gone.has(branch.mergedIntoLineId) ? { ...branch, mergedIntoLineId: "" } : branch)),
    draftCards: without(state.draftCards, gone),
    draftTips: without(state.draftTips, gone),
    packs: without(state.packs, gone),
    chaptersByLine: without(state.chaptersByLine, gone),
    leaves: without(state.leaves, gone),
    memos: state.memos.map((memo) => (gone.has(memo.lineId) ? { ...memo, lineId: "" } : memo)),
    terms: termsWithoutLines(state.terms, gone),
    links: state.links.filter((link) => !gone.has(link.fromLineId) && !gone.has(link.toLineId)),
    folds: state.folds.filter((fold) => !gone.has(fold.lineId)),
    deltas: without(state.deltas, gone),
  };
}

export function createMockAside(ctx: MockContext, deps: MockAsideDeps): MockAside {
  const asideOn = () => isFeatureOn(ctx.scenario.capabilities, "aside");
  const featureOff = () => new TangentError(404, "the aside feature is off", "feature_disabled", { feature: "aside" });
  const archived = (rootLineId: string) => Boolean(ctx.state().lines.find((line) => line.id === rootLineId)?.archivedAt);
  const refuseArchived = () => new TangentError(409, "the conversation is archived", "archived");

  /** Whether a line of `ids` is mid-turn. */
  const answering = (ids: ReadonlySet<string>) =>
    ctx.state().lines.some((line) => ids.has(line.id) && line.status === "thinking") || ctx.state().messages.some((message) => ids.has(message.lineId) && message.status === "pending");

  /**
   * What the server does for lines about to go (store.releaseLines): their
   * links are read (they cascade away), the groups lose them as members (one
   * left with fewer than two dissolves). Returns what to publish after.
   */
  function release(gone: ReadonlySet<string>): { links: Link[]; groupIds: string[] } {
    const state = ctx.state();
    const links = state.links.filter((link) => gone.has(link.fromLineId) || gone.has(link.toLineId));
    const now = ctx.now();
    const touched = state.groups.filter((group) => group.status === "active" && group.memberLineIds.some((id) => gone.has(id)));
    const groups = state.groups.map((group) => {
      if (!touched.includes(group)) return group;
      const memberLineIds = group.memberLineIds.filter((id) => !gone.has(id));
      return { ...group, memberLineIds, status: memberLineIds.length < GROUP_MIN_MEMBERS ? ("dissolved" as const) : group.status, updatedAt: now };
    });
    ctx.commit({ ...state, groups });
    return { links, groupIds: touched.map((group) => group.id) };
  }

  function publishReleased(rootLineId: string, released: { links: Link[]; groupIds: string[] }): void {
    for (const link of released.links) ctx.bus.publish("link.changed", { lineId: rootLineId, rootLineId }, { rootLineId, link, deleted: true });
    for (const id of released.groupIds) {
      const group = ctx.state().groups.find((item) => item.id === id);
      if (group) ctx.bus.publish("group.changed", { lineId: rootLineId, rootLineId }, { rootLineId, group });
    }
  }

  /** The parent's refusals of a branch opened in the aside's place (domain.CheckBranchCreate; the aside itself is not counted). */
  function checkReplace(aside: BranchView, parent: LineView, confirmDeeper: boolean): void {
    const state = ctx.state();
    if (parent.conversationBranch && parent.conversationBranch.status !== "open") throw new TangentError(409, "the parent branch has ended", "parent_closed");
    if (!messagesOf(state, parent.id).some((message) => message.id === aside.anchorMessageId && canAnchorBranch(message))) throw new TangentError(404, "the anchor message is not on this line", "anchor_not_found");
    if (aside.depth > BRANCH_HARD_DEPTH_LIMIT) throw new TangentError(409, "too deep", "depth_hard_limit", { limit: BRANCH_HARD_DEPTH_LIMIT });
    const open = state.branches.filter((branch) => branch.parentLineId === parent.id && branch.status === "open").length;
    if (open >= BRANCH_OPEN_PER_PARENT_LIMIT) throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
    const inTree = state.branches.filter((branch) => branch.rootLineId === aside.rootLineId && branch.lineId !== aside.lineId).length;
    if (inTree >= BRANCH_TREE_LIMIT) throw new TangentError(409, "the tree is full", "tree_limit", { limit: BRANCH_TREE_LIMIT });
    if (aside.depth > BRANCH_SOFT_DEPTH_LIMIT && !confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth: aside.depth, limit: BRANCH_SOFT_DEPTH_LIMIT });
  }

  return {
    keep(lineId, keep) {
      if (!asideOn()) throw featureOff();
      if (typeof keep !== "boolean") throw new TangentError(400, "keep is required", "invalid_input", { field: "keep" });
      const branch = findBranch(ctx.state(), lineId);
      if (branch.kind !== "aside") throw new TangentError(400, "only an aside can be kept", "kind_unsupported");
      if (archived(branch.rootLineId)) throw refuseArchived();
      if (Boolean(branch.keptAt) === keep) return { branch };
      const { keptAt: _was, ...rest } = branch;
      const next: BranchView = keep ? { ...rest, keptAt: ctx.now() } : rest;
      ctx.commit(withBranch(ctx.state(), next));
      ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "kept", branch: next });
      return { branch: next };
    },

    continueAside(lineId, input) {
      if (!asideOn()) throw featureOff();
      const kind = input.kind ?? "investigate";
      if (kind !== "investigate" && kind !== "alternative") throw new TangentError(400, "an aside continues as investigate or alternative", "kind_unsupported");
      const aside = findBranch(ctx.state(), lineId);
      if (aside.kind !== "aside") throw new TangentError(400, "only an aside can be continued", "kind_unsupported");
      if (archived(aside.rootLineId)) throw refuseArchived();
      if (aside.status === "open") throw new TangentError(409, "the aside has not been answered yet", "branch_busy");
      const children = ctx.state().branches.filter((branch) => branch.parentLineId === lineId);
      const subtree = new Set([lineId, ...branchDescendants(ctx.state().branches, lineId).map((branch) => branch.lineId)]);
      if (answering(subtree)) throw new TangentError(409, "a turn is running under this aside", "branch_busy");
      const moved = messagesOf(ctx.state(), lineId).filter((message) => message.status === "done");
      if (!moved.some((message) => message.role === "assistant")) throw new TangentError(409, "the aside has no answer", "no_messages");
      const parent = findLine(ctx.state(), aside.parentLineId);
      checkReplace(aside, parent, input.confirmDeeper === true);
      const purpose = (input.purpose ?? "").trim() || aside.purpose;
      if (Array.from(purpose).length > BRANCH_PURPOSE_MAX) throw new TangentError(400, "the purpose must be 1–200 characters", "invalid_input", { field: "purpose" });

      const old = findLine(ctx.state(), lineId);
      const [id, next] = newId(ctx.state(), "branch");
      ctx.commit(next);
      const now = ctx.now();
      const ref = { parentLineId: aside.parentLineId, rootLineId: aside.rootLineId, anchorMessageId: aside.anchorMessageId, depth: aside.depth, purpose, kind, status: "open", origin: aside.origin };
      // Usage and unread start at zero: the aside's turn was counted on the line that goes.
      const line: LineView = fixture.line({ id, title: purpose, provider: old.provider, model: old.model, conversationBranch: ref, createdAt: now, updatedAt: now, lastActivityAt: now });
      const branch = fixture.branch({ ...ref, lineId: id, excerpt: aside.excerpt, provider: old.provider, model: old.model, draftStatus: "none", messageCount: moved.filter((message) => message.kind === "chat").length, createdAt: now, lastActivityAt: now });
      const movedIds = new Set(moved.map((message) => message.id));
      const gone = new Set([lineId]);
      const released = release(gone);
      // A link whose end is on a moved message follows it to the new line; one that only named the line goes with it.
      const follows = (link: Link) => (link.fromLineId === lineId && movedIds.has(link.fromMessageId)) || (link.toLineId === lineId && movedIds.has(link.toMessageId));
      const rehomed = released.links.filter(follows).map((link) => ({ ...link, fromLineId: link.fromLineId === lineId ? id : link.fromLineId, toLineId: link.toLineId === lineId ? id : link.toLineId }));
      const state = ctx.state();
      const reparented = children.map((child) => ({ ...child, parentLineId: id }));
      const kept: MockState = {
        ...state,
        messages: state.messages.map((message) => (movedIds.has(message.id) ? { ...message, lineId: id } : message)),
        // B24: the aside's terms keep their source, now on the new branch (its messages keep their ids).
        terms: termsRepointed(state.terms, lineId, id),
        branches: state.branches.map((item) => reparented.find((child) => child.lineId === item.lineId) ?? item),
        lines: state.lines.map((item) => (item.conversationBranch?.parentLineId === lineId ? { ...item, conversationBranch: { ...item.conversationBranch, parentLineId: id } } : item)),
      };
      const dropped = dropLines(kept, gone);
      ctx.commit(withBranch(withLine({ ...dropped, links: [...dropped.links, ...rehomed] }, line), branch));

      ctx.bus.publish("line.deleted", { lineId, rootLineId: aside.rootLineId }, { rootLineId: aside.rootLineId, lineIds: [lineId] });
      ctx.bus.publish("line.created", { lineId: id, rootLineId: aside.rootLineId }, line);
      publishLine(ctx, aside.parentLineId);
      ctx.bus.publish("branch.changed", { lineId: id, rootLineId: aside.rootLineId }, { change: "created", branch });
      for (const child of reparented) ctx.bus.publish("branch.changed", { lineId: child.lineId, rootLineId: aside.rootLineId }, { change: "moved", branch: child });
      publishReleased(aside.rootLineId, { links: released.links.filter((link) => !follows(link)), groupIds: released.groupIds });
      deps.expireFor([lineId]);
      return { branch, line: findLine(ctx.state(), id), replacedLineId: lineId };
    },

    deleteBranch(lineId) {
      const line = findLine(ctx.state(), lineId);
      if (!line.conversationBranch) throw new TangentError(400, "a main line is deleted with DELETE /lines/{id}", "invalid_input");
      const branch = findBranch(ctx.state(), lineId);
      if (archived(branch.rootLineId)) throw refuseArchived();
      if (!canDeleteBranch(branch)) throw new TangentError(409, "this branch cannot be deleted", "branch_not_deletable");
      const under = branchDescendants(ctx.state().branches, lineId);
      const lineIds = [lineId, ...under.map((item) => item.lineId)];
      const gone = new Set(lineIds);
      if (answering(gone)) throw new TangentError(409, "a turn is running under this branch", "branch_busy");
      if (under.some((item) => item.status === "open")) throw new TangentError(409, "a branch under it is still open", "branch_busy");
      const released = release(gone);
      ctx.commit(dropLines(ctx.state(), gone));
      const root = branch.rootLineId;
      ctx.bus.publish("line.deleted", { lineId, rootLineId: root }, { rootLineId: root, lineIds });
      publishReleased(root, released);
      deps.expireFor(lineIds);
      publishLine(ctx, branch.parentLineId);
      if (branch.parentLineId !== root) publishLine(ctx, root);
      return { rootLineId: root, lineIds };
    },
  };
}
