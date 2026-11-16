/**
 * Simulated groups and combining (B9 phase C): groups of ended branches with
 * a shared summary (drafted after `draftMs`; `[fake:job-error]` in a
 * member's leaf makes it fail with `job.failed`), combining open siblings
 * into one new branch, conflicts with their choices (keepBoth writes a
 * 待確認 note), and the group suggestion after a branch ends — the fake
 * runner's: the newest two ended candidates as one group (with one
 * conflict), the newest two open ones as another.
 */
import type { CreateBranchInput, CreateBranchResult, CreateNoteInput, JobStarted, NoteWriteResult } from "../api-types";
import { featureMode, isFeatureOn } from "../capabilities";
import { BRANCH_OPEN_PER_PARENT_LIMIT } from "../branch-errors";
import { TangentError } from "../errors";
import {
  CONFLICT_CHOICES,
  DEFAULT_GROUP_LIMITS,
  GROUP_MIN_MEMBERS,
  type CombineBranchesInput,
  type CombineResult,
  type Conflict,
  type ConflictChoice,
  type CreateGroupInput,
  type Group,
  type GroupList,
  type GroupListQuery,
  type GroupWrite,
  type NotesApplied,
} from "../group-routes";
import type { BranchOrigin, BranchView, JsonValue, Note, Suggestion } from "../types";
import { closeBranch } from "./mock-branches";
import { address, publishLine, type MockContext } from "./mock-context";
import { findBranch, findLine, messagesOf, newId, rootOf, withBranch, withLine } from "./mock-store";

export const JOB_ERROR_DIRECTIVE = "[fake:job-error]";
const SUMMARY_TEXT = "These branches settle one question together (fake runner).";
const ENDED_TITLE = "Ended together (fake runner)";
const OPEN_TITLE = "Open together (fake runner)";
const CANDIDATES_MIN = 3;
const runes = (text: string) => Array.from(text).length;

export interface MockGroups {
  /** Detach took these lines to another conversation: their active groups dissolve, with group.changed (R8). */
  dissolveOfLines(lineIds: readonly string[]): void;
  list(lineId: string, query: GroupListQuery): GroupList;
  create(lineId: string, input: CreateGroupInput): GroupWrite;
  get(groupId: string): { group: Group };
  rename(groupId: string, title: string): { group: Group };
  dissolve(groupId: string): { group: Group };
  summarize(groupId: string): JobStarted;
  combine(lineId: string, input: CombineBranchesInput): CombineResult;
  /** After a non-aside branch ended (merge / discard): the group suggestion. */
  afterBranchEnded(lineId: string): void;
  /** Runs an accepted group suggestion (group or combine); null for another feature's. */
  act(suggestion: Suggestion, body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null;
  /** Groups whose summary is ready, for the fisheye report. */
  readyGroups(rootLineId: string): Group[];
}

export interface MockGroupDeps {
  createBranch(lineId: string, input: CreateBranchInput, origin: BranchOrigin): CreateBranchResult;
  createNote(lineId: string, input: CreateNoteInput): NoteWriteResult;
  propose(suggestion: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void;
  expireFor(lineIds: readonly string[]): void;
}

export function createMockGroups(ctx: MockContext, deps: MockGroupDeps): MockGroups {
  const state = ctx.state;
  const capabilities = () => ctx.scenario.capabilities;

  function require(): void {
    if (!isFeatureOn(capabilities(), "group")) throw new TangentError(404, "the group feature is off", "feature_disabled", { feature: "group" });
  }
  const invalid = (why: string) => new TangentError(422, why, "invalid_group");

  function save(group: Group): Group {
    const exists = state().groups.some((item) => item.id === group.id);
    ctx.commit({ ...state(), groups: exists ? state().groups.map((item) => (item.id === group.id ? group : item)) : [...state().groups, group] });
    ctx.bus.publish("group.changed", { lineId: group.rootLineId, rootLineId: group.rootLineId }, { rootLineId: group.rootLineId, group });
    return group;
  }

  function find(groupId: string): Group {
    require();
    const group = state().groups.find((item) => item.id === groupId);
    if (!group) throw new TangentError(404, "group not found", "group_not_found");
    return group;
  }

  const leafLine = (branch: BranchView) => state().leaves[branch.lineId]?.line ?? branch.conclusionLine;
  const activeMembers = (root: string) => new Set(state().groups.filter((group) => group.rootLineId === root && group.status === "active").flatMap((group) => group.memberLineIds));

  /** Starts (or restarts) the shared summary; it lands after `draftMs`, or fails on `[fake:job-error]`. */
  function startSummary(group: Group): JobStarted {
    const [jobId, next] = newId(state(), "job");
    ctx.commit(next);
    ctx.timers.setTimeout(() => {
      const current = state().groups.find((item) => item.id === group.id);
      if (!current) return;
      const failing = current.memberLineIds.some((lineId) => (state().leaves[lineId]?.line ?? "").includes(JOB_ERROR_DIRECTIVE));
      // R8: a dissolved group stays as it is; a failing job still says so.
      if (current.status !== "active") {
        if (failing) ctx.bus.publish("job.failed", { lineId: current.rootLineId, rootLineId: current.rootLineId }, { jobId, kind: "group_summary", lineId: current.rootLineId, rootLineId: current.rootLineId, error: { code: "run_failed", message: "the job run failed" } });
        return;
      }
      if (failing) {
        save({ ...current, summaryStatus: "failed", updatedAt: ctx.now() });
        ctx.bus.publish("job.failed", { lineId: current.rootLineId, rootLineId: current.rootLineId }, { jobId, kind: "group_summary", lineId: current.rootLineId, rootLineId: current.rootLineId, error: { code: "run_failed", message: "the job run failed" } });
        return;
      }
      save({ ...current, summary: SUMMARY_TEXT, summaryStatus: "ready", updatedAt: ctx.now() });
    }, ctx.draftMs);
    const root = findLine(state(), group.rootLineId);
    return { jobId, kind: "group_summary", lineId: group.rootLineId, provider: root.provider || "mock", model: root.model || "mock-1" };
  }

  /** Every conflict needs a choice; keepBoth writes one 待確認 note (notes on). */
  function applyConflicts(root: string, conflicts: readonly Conflict[] | undefined): NotesApplied | undefined {
    const kept = (conflicts ?? []).filter((conflict) => {
      if (!conflict.choice || !(CONFLICT_CHOICES as readonly string[]).includes(conflict.choice)) throw invalid("every conflict needs a choice");
      return conflict.choice === "keepBoth";
    });
    if (kept.length === 0) return undefined;
    if (!isFeatureOn(capabilities(), "notes")) throw invalid("keepBoth needs the notes feature");
    const title = (lineId: string) => state().branches.find((branch) => branch.lineId === lineId)?.purpose ?? "";
    const created: Note[] = [];
    let revision = 0;
    for (const conflict of kept) {
      const written = deps.createNote(root, { section: "to_confirm", text: `${title(conflict.branch.lineId)}: ${conflict.branch.claim} / ${title(conflict.other.lineId)}: ${conflict.other.claim}`, sourceLineId: conflict.branch.lineId });
      created.push(written.note);
      revision = written.revision;
    }
    return { rootLineId: root, revision, created, superseded: [] };
  }

  function create(lineId: string, input: CreateGroupInput): GroupWrite {
    require();
    const root = rootOf(findLine(state(), lineId));
    if (findLine(state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    const ids = [...new Set(input.memberLineIds)];
    if (ids.length < GROUP_MIN_MEMBERS || ids.length > DEFAULT_GROUP_LIMITS.maxMembers) throw invalid(`a group takes ${GROUP_MIN_MEMBERS}–${DEFAULT_GROUP_LIMITS.maxMembers} branches`);
    const grouped = activeMembers(root);
    const members = ids.map((id) => state().branches.find((branch) => branch.lineId === id));
    for (const member of members) {
      if (!member || member.rootLineId !== root) throw invalid("every member must be a branch of this conversation");
      if (member.status === "open") throw invalid("only ended branches can be grouped");
      if (member.status === "promoted") throw invalid("a branch promoted to the main line is no member");
      if (!leafLine(member)) throw invalid("every member needs an ending or a card conclusion");
      if (grouped.has(member.lineId)) throw invalid("a branch can be in one active group at a time");
    }
    const title = (input.title ?? "").replace(/\s+/g, " ").trim();
    if (title === "") throw new TangentError(400, "the title is empty", "invalid_input");
    if (runes(title) > DEFAULT_GROUP_LIMITS.titleMaxRunes) throw new TangentError(422, "the title is too long", "too_long", { field: "title", max: DEFAULT_GROUP_LIMITS.titleMaxRunes });
    if (state().groups.filter((group) => group.rootLineId === root && group.status === "active").length >= DEFAULT_GROUP_LIMITS.maxActivePerTree) {
      throw new TangentError(409, "too many groups", "group_limit", { limit: DEFAULT_GROUP_LIMITS.maxActivePerTree });
    }
    const notes = applyConflicts(root, input.conflicts);
    const [id, next] = newId(state(), "group");
    ctx.commit(next);
    const now = ctx.now();
    const order = new Map(state().branches.map((branch, index) => [branch.lineId, index]));
    const memberLineIds = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const group = save({ id, rootLineId: root, title, summary: "", summaryStatus: "drafting", status: "active", memberLineIds, createdBy: "mock-user", createdAt: now, updatedAt: now });
    const job = startSummary(group);
    return { group, job, ...(notes ? { notes } : {}) };
  }

  /**
   * Where the new branch forks: the latest of their forks on the parent; when
   * none is on it (children re-hung by B9.1, R8), the parent's newest finished
   * reply or question; before it has one, `anchor_not_found`.
   */
  function combineAnchor(parentId: string, anchors: readonly string[]): string {
    const messages = messagesOf(state(), parentId);
    const seqOf = new Map(messages.map((message) => [message.id, message.seq]));
    const onParent = anchors.filter((id) => seqOf.has(id)).sort((a, b) => seqOf.get(b)! - seqOf.get(a)!);
    if (onParent[0]) return onParent[0];
    const finished = messages.filter((message) => message.kind === "chat" && message.role !== "system" && message.status === "done").at(-1);
    if (finished) return finished.id;
    throw new TangentError(404, "these branches were re-hung here by a combine and this line has no finished message yet: reply here first", "anchor_not_found");
  }

  function combine(lineId: string, input: CombineBranchesInput): CombineResult {
    require();
    const parent = findLine(state(), lineId);
    const ids = [...new Set(input.lineIds)];
    if (ids.length < GROUP_MIN_MEMBERS || ids.length > DEFAULT_GROUP_LIMITS.maxMembers) throw invalid(`combining takes ${GROUP_MIN_MEMBERS}–${DEFAULT_GROUP_LIMITS.maxMembers} branches`);
    const branches = ids.map((id) => state().branches.find((branch) => branch.lineId === id));
    for (const branch of branches) {
      if (!branch || branch.parentLineId !== parent.id) throw invalid("the branches must be children of this line");
      if (branch.status !== "open" || branch.kind === "aside") throw invalid("only open branches that are not asides can be combined");
    }
    const purpose = (input.purpose ?? "").trim();
    if (purpose === "") throw new TangentError(400, "the purpose is empty", "invalid_input");
    // B9.1: their open children move onto the new branch; more than a parent may hold refuses the whole combine.
    const moving = state().branches.filter((child) => ids.includes(child.parentLineId) && child.status === "open");
    if (moving.length > BRANCH_OPEN_PER_PARENT_LIMIT) throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
    const notes = applyConflicts(rootOf(parent), input.conflicts);
    const anchor = combineAnchor(parent.id, branches.map((branch) => branch!.anchorMessageId));
    const created = deps.createBranch(parent.id, { anchorMessageId: anchor, purpose, kind: input.kind ?? "investigate" }, "merge");
    const combined = branches.map((branch) => {
      const closed = closeBranch(ctx, findBranch(state(), branch!.lineId), { status: "discarded", mergedIntoLineId: created.line.id });
      ctx.bus.publish("branch.changed", address(ctx, closed.lineId), { change: "discarded", branch: closed });
      return closed;
    });
    // B9.1: their open children hang on the new branch now (anchor and depth kept), with branch.changed{moved}.
    const reparented = moving.map((child) => child.lineId).sort();
    for (const childId of reparented) {
      const child = findBranch(state(), childId);
      const moved = { ...child, parentLineId: created.line.id };
      const line = findLine(state(), childId);
      ctx.commit(withLine(withBranch(state(), moved), { ...line, conversationBranch: line.conversationBranch ? { ...line.conversationBranch, parentLineId: created.line.id } : null }));
      ctx.bus.publish("branch.changed", address(ctx, childId), { change: "moved", branch: moved });
    }
    for (const oldId of new Set(moving.map((child) => child.parentLineId))) publishLine(ctx, oldId);
    publishLine(ctx, parent.id);
    deps.expireFor(ids);
    return { ...created, combined, ...(notes ? { notes } : {}), reparented };
  }

  /** Candidates for a suggestion: non-aside branches outside any active group, ended with an ending or open with replies. */
  function candidates(root: string): { ended: BranchView[]; open: BranchView[] } {
    const grouped = activeMembers(root);
    const pool = state()
      .branches.filter((branch) => branch.rootLineId === root && branch.kind !== "aside" && !grouped.has(branch.lineId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      ended: pool.filter((branch) => branch.status !== "open" && branch.status !== "promoted" && !branch.mergedIntoLineId && Boolean(leafLine(branch))),
      open: pool.filter((branch) => branch.status === "open" && (branch.messageCount > 0 || messagesOf(state(), branch.lineId).length > 0)),
    };
  }

  const member = (branch: BranchView) => ({ lineId: branch.lineId, purpose: branch.purpose, ended: branch.status !== "open", leaf: leafLine(branch) });

  function proposeGroup(root: string, members: readonly BranchView[], title: string, conflicts: Conflict[]): void {
    const ids = members.map((branch) => branch.lineId).sort();
    deps.propose({
      rootLineId: root,
      lineId: root,
      feature: "group",
      kind: "group",
      targetKey: `group:${ids.join(",")}`,
      payload: { title, members: members.map(member), conflicts: conflicts as unknown as JsonValue[] },
    });
  }

  function acceptGroup(suggestion: Suggestion, body: Readonly<Record<string, unknown>>) {
    const payload = suggestion.payload as { title?: string; members?: Array<{ lineId: string; ended: boolean }>; conflicts?: Conflict[] };
    const members = payload.members ?? [];
    const ended = members.filter((item) => item.ended).map((item) => item.lineId);
    const action = body.action === "group" || body.action === "combine" ? body.action : ended.length >= GROUP_MIN_MEMBERS ? "group" : "combine";
    const choices = (typeof body.choices === "object" && body.choices !== null ? body.choices : {}) as Record<string, ConflictChoice>;
    const conflicts = (payload.conflicts ?? []).filter((conflict) => conflict.id && choices[conflict.id]).map((conflict) => ({ ...conflict, choice: choices[conflict.id!]! }));
    if (action === "group") {
      const written = create(suggestion.rootLineId, { memberLineIds: ended, title: typeof body.title === "string" ? body.title : (payload.title ?? ""), conflicts });
      return { action, group: written.group, ...(written.job ? { job: { jobId: written.job.jobId, kind: written.job.kind } } : {}), ...(written.notes ? { notes: written.notes } : {}) };
    }
    const open = members.filter((item) => !item.ended).map((item) => item.lineId);
    const parent = findBranch(state(), open[0] ?? "").parentLineId;
    const done = combine(parent, { lineIds: open, purpose: typeof body.purpose === "string" ? body.purpose : (payload.title ?? ""), conflicts });
    return {
      action,
      combined: { created: { line: done.line, branch: done.branch, pack: done.pack }, combined: done.combined, notes: done.notes ?? null, reparented: done.reparented ?? [] },
      notes: done.notes ?? null,
    };
  }

  return {
    list(lineId, query) {
      require();
      const root = rootOf(findLine(state(), lineId));
      const raw = query.status ?? "active";
      const keep = raw === "all" ? () => true : (status: string) => raw.split(",").includes(status);
      return { rootLineId: root, groups: state().groups.filter((group) => group.rootLineId === root && keep(group.status)), limits: DEFAULT_GROUP_LIMITS };
    },
    create,
    get: (groupId) => ({ group: find(groupId) }),
    rename(groupId, title) {
      const group = find(groupId);
      if (group.status !== "active") throw new TangentError(409, "the group is dissolved", "group_not_active");
      const clean = title.replace(/\s+/g, " ").trim();
      if (clean === "") throw new TangentError(400, "the title is empty", "invalid_input");
      return { group: save({ ...group, title: clean, updatedAt: ctx.now() }) };
    },
    dissolve(groupId) {
      const group = find(groupId);
      if (group.status !== "active") throw new TangentError(409, "the group is dissolved", "group_not_active");
      return { group: save({ ...group, status: "dissolved", updatedAt: ctx.now() }) };
    },
    summarize(groupId) {
      const group = find(groupId);
      if (group.status !== "active") throw new TangentError(409, "the group is dissolved", "group_not_active");
      return startSummary(save({ ...group, summaryStatus: "drafting", updatedAt: ctx.now() }));
    },
    combine,
    dissolveOfLines(lineIds) {
      const taken = new Set(lineIds);
      for (const group of state().groups) {
        if (group.status === "active" && group.memberLineIds.some((id) => taken.has(id))) save({ ...group, status: "dissolved", updatedAt: ctx.now() });
      }
    },
    afterBranchEnded(lineId) {
      const mode = featureMode(capabilities(), "group");
      if (mode !== "suggest" && mode !== "auto") return;
      const branch = state().branches.find((item) => item.lineId === lineId);
      if (!branch || branch.kind === "aside") return;
      const pool = candidates(branch.rootLineId);
      if (pool.ended.length + pool.open.length < CANDIDATES_MIN) return;
      const [a, b] = pool.ended;
      if (a && b) {
        proposeGroup(branch.rootLineId, [a, b], ENDED_TITLE, [{ id: "c1", branch: { lineId: a.lineId, claim: "the first one says yes" }, other: { lineId: b.lineId, claim: "the second one says no" } }]);
      }
      const [c, d] = pool.open;
      if (c && d && c.parentLineId === d.parentLineId) proposeGroup(branch.rootLineId, [c, d], OPEN_TITLE, []);
    },
    act: (suggestion, body) => (suggestion.feature === "group" && suggestion.kind === "group" ? acceptGroup(suggestion, body) : null),
    readyGroups: (root) => state().groups.filter((group) => group.rootLineId === root && group.status === "active" && group.summaryStatus === "ready"),
  };
}
