/**
 * Simulated P2 modules (B9 phase A): a conversation's goal (with AI
 * proposals and drift hints), relations between nodes, the open-loops review
 * and message pins. Same refusals and events as the server; the AI parts
 * answer like the fake runner. Two simplifications, both test-only:
 * a goal proposal lands after `draftMs`, and drift is detected on any
 * main-line turn whose user message says `[fake:drift]` (the server checks
 * every 4th reply).
 */
import type { CreateBranchInput, CreateBranchResult, JobStarted } from "../api-types";
import { featureMode, isFeatureOn, type FeatureName } from "../capabilities";
import { TangentError } from "../errors";
import type { UpdateRelationInput } from "../group-routes";
import type { CreateRelationInput, GoalResult, OpenLoops, OpenLoopsQuery, PinResult, PutGoalInput, RelationList, RelationWrite } from "../p2-routes";
import { DEFAULT_RELATION_LIMITS } from "../p2-routes";
import { RELATION_KINDS, type BranchOrigin, type Goal, type Link, type Message, type RelationKind, type Suggestion } from "../types";
import { address, type MockContext } from "./mock-context";
import { JOB_ERROR_DIRECTIVE } from "./mock-groups";
import { findLine, messagesOf, MOCK_STALE_DAYS, newId, rootOf, staleBranchesOf, withMessage } from "./mock-store";

export const GOAL_TEXT_MAX = 300;
/** The fake runner's drift directive (DESIGN §12 B9: tests only). */
export const DRIFT_DIRECTIVE = "[fake:drift]";
/** Main-line replies after which suggest / auto propose a goal once (B9). */
const GOAL_PROPOSE_AFTER = 2;
const OPEN_LOOPS_MAX = 50;
const STALE_DAYS_MAX = 365;
const DRIFT_PURPOSE = "Follow the side topic (fake runner)";
const DRIFT_REASON = "It moved away from the goal (fake runner).";
const RELATION_LABEL = "Related (fake runner)";
const PROPOSAL_FALLBACK = "Settle what this conversation set out to decide (fake runner).";

const flatten = (text: string) => text.replace(/\s+/g, " ").trim();
const runes = (text: string) => Array.from(text).length;

export interface MockP2 {
  getGoal(lineId: string): GoalResult;
  putGoal(lineId: string, input: PutGoalInput): GoalResult;
  deleteGoal(lineId: string): void;
  proposeGoal(lineId: string): JobStarted;
  listRelations(lineId: string): RelationList;
  createRelation(lineId: string, input: CreateRelationInput): RelationWrite;
  deleteRelation(lineId: string, relationId: string): void;
  /** B9 phase C: a relation's new label; B15: its kind. A field left out keeps its value. */
  updateRelation(lineId: string, relationId: string, input: UpdateRelationInput): RelationWrite;
  /** `GET /links`: spinoff and relation links of the tree, each only while its feature is on. */
  links(lineId: string, spinoffs: readonly Link[]): { links: Link[] };
  openLoops(query: OpenLoopsQuery): OpenLoops;
  pin(messageId: string, pinned: boolean): PinResult;
  /** After a finished turn: the goal proposal (2nd main-line reply) and the drift check. */
  afterTurn(lineId: string, userContent: string): void;
  /** A non-aside branch ended: suggest relating it to the newest other branch. */
  afterBranchEnded(lineId: string): void;
  /** Runs an accepted goal / drift / relation suggestion; null for another feature's. */
  act(suggestion: Suggestion, body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null;
}

export interface MockP2Deps {
  createBranch(lineId: string, input: CreateBranchInput, origin: BranchOrigin): CreateBranchResult;
  propose(suggestion: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void;
  /** Open suggestions matching `match` expire (a goal written by the user ends the open proposals). */
  expireWhere(match: (suggestion: Suggestion) => boolean): void;
}

export function createMockP2(ctx: MockContext, deps: MockP2Deps): MockP2 {
  const state = ctx.state;
  const capabilities = () => ctx.scenario.capabilities;
  const rootFor = (lineId: string) => rootOf(findLine(state(), lineId));
  const aiOn = (feature: FeatureName) => ["suggest", "auto"].includes(featureMode(capabilities(), feature));

  function require(feature: FeatureName): void {
    if (!isFeatureOn(capabilities(), feature)) throw new TangentError(404, `the ${feature} feature is off`, "feature_disabled", { feature });
  }

  function writableRoot(lineId: string): string {
    const root = rootFor(lineId);
    if (findLine(state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    return root;
  }

  // Goal -----------------------------------------------------------------------

  function writeGoal(root: string, text: string, source: Goal["source"]): Goal {
    const now = ctx.now();
    const previous = state().goals[root];
    const goal: Goal = { rootLineId: root, text, source, updatedBy: "mock-user", createdAt: previous?.createdAt ?? now, updatedAt: now };
    ctx.commit({ ...state(), goals: { ...state().goals, [root]: goal } });
    ctx.bus.publish("goal.changed", { lineId: root, rootLineId: root }, { rootLineId: root, goal });
    return goal;
  }

  function checkedGoalText(raw: unknown): string {
    const text = flatten(typeof raw === "string" ? raw : "");
    if (text === "") throw new TangentError(400, "the goal's text is empty", "invalid_input");
    if (runes(text) > GOAL_TEXT_MAX) throw new TangentError(422, "the text is too long", "too_long", { field: "text", max: GOAL_TEXT_MAX });
    return text;
  }

  const doneReplies = (lineId: string) => messagesOf(state(), lineId).filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done");

  /** What AI proposes: the scenario's text for this conversation, or the fake runner's. */
  function proposalText(root: string): string {
    return ctx.scenario.goalProposals?.[root] ?? ctx.scenario.goalProposals?.["*"] ?? PROPOSAL_FALLBACK;
  }

  /** Lands a proposal: the inbox in manual / suggest (and for the button in auto when a goal exists), else the goal itself. */
  function landProposal(root: string, asked: boolean): void {
    const text = proposalText(root);
    const auto = featureMode(capabilities(), "goal") === "auto";
    if (auto && (asked || !state().goals[root])) {
      writeGoal(root, text, "ai");
      return;
    }
    deps.propose({ rootLineId: root, lineId: root, feature: "goal", kind: "goal_propose", targetKey: `goal:${root}`, payload: { text } });
  }

  // Relations ------------------------------------------------------------------

  /** A link with each message end on the line that message is on now. */
  function located(link: Link): Link {
    const lineOf = (messageId: string, fallback: string) => (messageId ? (state().messages.find((message) => message.id === messageId)?.lineId ?? fallback) : fallback);
    return { ...link, fromLineId: lineOf(link.fromMessageId, link.fromLineId), toLineId: lineOf(link.toMessageId, link.toLineId) };
  }

  const treeOf = (root: string) => new Set(state().lines.filter((line) => rootOf(line) === root).map((line) => line.id));
  const touches = (link: Link, tree: ReadonlySet<string>) => tree.has(link.fromLineId) || tree.has(link.toLineId);
  const relationsOf = (root: string) => state().links.filter((link) => link.kind === "relation").map(located).filter((link) => touches(link, treeOf(root)));

  /** A done user / assistant chat message or a conclusion card of `lineId` (the pin rule). */
  function endMessage(lineId: string, messageId: string | undefined): string {
    if (!messageId) return "";
    const message = state().messages.find((item) => item.id === messageId);
    if (!message || message.lineId !== lineId) throw new TangentError(404, "the message is not on that line", "message_not_found");
    return messageId;
  }

  function sameEnds(link: Link, from: { line: string; message: string }, to: { line: string; message: string }): boolean {
    const a = `${link.fromLineId}/${link.fromMessageId}`;
    const b = `${link.toLineId}/${link.toMessageId}`;
    const x = `${from.line}/${from.message}`;
    const y = `${to.line}/${to.message}`;
    return (a === x && b === y) || (a === y && b === x);
  }

  /** `domain.ParseRelationKind`: one of the four, case-sensitive; `""` is related only on create. */
  function checkedKind(kind: unknown, onCreate: boolean): RelationKind {
    const clean = typeof kind === "string" ? kind.trim() : kind;
    if (onCreate && (clean === undefined || clean === null || clean === "")) return "related";
    if (typeof clean === "string" && (RELATION_KINDS as readonly string[]).includes(clean)) return clean as RelationKind;
    throw new TangentError(400, "relationKind must be related, supports, contradicts or depends_on", "invalid_input", { field: "relationKind" });
  }

  function createRelation(lineId: string, input: CreateRelationInput): RelationWrite {
    require("relations");
    const root = writableRoot(lineId);
    const fromLine = input.fromLineId || lineId;
    if (rootFor(fromLine) !== root) throw new TangentError(400, "the start must be in this conversation", "invalid_input");
    const toLine = findLine(state(), input.toLineId);
    const toRoot = rootOf(toLine);
    if (findLine(state(), toRoot).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    const from = { line: fromLine, message: endMessage(fromLine, input.fromMessageId) };
    const to = { line: toLine.id, message: endMessage(toLine.id, input.toMessageId) };
    if (from.line === to.line && from.message === to.message) throw new TangentError(400, "a relation needs two different ends", "invalid_input");
    if (state().links.some((link) => link.kind === "relation" && sameEnds(located(link), from, to))) throw new TangentError(409, "these two are already related", "relation_exists");
    for (const tree of new Set([root, toRoot])) {
      if (relationsOf(tree).length >= DEFAULT_RELATION_LIMITS.maxPerTree) throw new TangentError(409, "too many relations", "relation_limit", { limit: DEFAULT_RELATION_LIMITS.maxPerTree });
    }
    const label = flatten(input.label ?? "");
    if (runes(label) > DEFAULT_RELATION_LIMITS.labelMaxRunes) throw new TangentError(422, "the label is too long", "too_long", { field: "label", max: DEFAULT_RELATION_LIMITS.labelMaxRunes });
    const relationKind = checkedKind(input.relationKind, true);
    const [id, next] = newId(state(), "relation");
    const relation: Link = {
      id,
      kind: "relation",
      fromLineId: from.line,
      fromMessageId: from.message,
      toLineId: to.line,
      toMessageId: to.message,
      label,
      relationKind,
      fromTitle: findLine(next, from.line).title,
      toTitle: toLine.title,
      createdBy: "mock-user",
      createdAt: ctx.now(),
    };
    ctx.commit({ ...next, links: [...next.links, relation] });
    const rootLineIds = [...new Set([root, toRoot])];
    for (const tree of rootLineIds) ctx.bus.publish("link.changed", { lineId: tree, rootLineId: tree }, { rootLineId: tree, link: relation });
    return { relation, rootLineIds };
  }

  // Suggestions ----------------------------------------------------------------

  function actGoal(suggestion: Suggestion, body: Readonly<Record<string, unknown>>) {
    const proposed = String(suggestion.payload.text ?? "");
    const text = body.text === undefined ? proposed : checkedGoalText(body.text);
    return { goal: writeGoal(suggestion.rootLineId, text, text === proposed ? "ai" : "manual") };
  }

  function actDrift(suggestion: Suggestion, body: Readonly<Record<string, unknown>>) {
    const payload = suggestion.payload;
    const anchorMessageId = String(payload.anchorMessageId ?? "");
    const lineId = state().messages.find((message) => message.id === anchorMessageId)?.lineId ?? suggestion.rootLineId;
    const kind = body.kind === "aside" || body.kind === "investigate" ? body.kind : payload.kind === "aside" ? "aside" : "investigate";
    const purpose = typeof body.purpose === "string" && body.purpose.trim() !== "" ? body.purpose : String(payload.purpose ?? DRIFT_PURPOSE);
    const created = deps.createBranch(lineId, { anchorMessageId, purpose, kind }, "button");
    return { line: created.line, branch: created.branch };
  }

  function actRelation(suggestion: Suggestion, body: Readonly<Record<string, unknown>>) {
    const payload = suggestion.payload;
    const label = typeof body.label === "string" ? body.label : String(payload.label ?? "");
    const chosen = typeof body.relationKind === "string" ? body.relationKind.trim() : "";
    const relationKind = checkedKind(chosen || payload.relationKind || "related", true);
    const written = createRelation(String(payload.fromLineId), { toLineId: String(payload.toLineId), label, relationKind });
    return { link: written.relation };
  }

  return {
    getGoal(lineId) {
      require("goal");
      return { goal: state().goals[rootFor(lineId)] ?? null };
    },

    putGoal(lineId, input) {
      require("goal");
      const root = writableRoot(lineId);
      const goal = writeGoal(root, checkedGoalText(input.text), "manual");
      // DESIGN §12 B9: the user's own goal ends the open AI proposals.
      deps.expireWhere((suggestion) => suggestion.rootLineId === root && suggestion.kind === "goal_propose");
      return { goal };
    },

    deleteGoal(lineId) {
      require("goal");
      const root = writableRoot(lineId);
      if (!state().goals[root]) throw new TangentError(404, "this conversation has no goal", "goal_not_found");
      const { [root]: _gone, ...rest } = state().goals;
      ctx.commit({ ...state(), goals: rest });
      ctx.bus.publish("goal.changed", { lineId: root, rootLineId: root }, { rootLineId: root, goal: null });
    },

    proposeGoal(lineId) {
      require("goal");
      const root = writableRoot(lineId);
      if (doneReplies(root).length === 0) throw new TangentError(409, "the main line has no finished turn yet", "no_messages");
      const [jobId, next] = newId(state(), "job");
      ctx.commit(next);
      // `[fake:job-error]` in the main line makes the proposal fail (B9 phase C `job.failed`).
      const failing = messagesOf(state(), root).some((message) => message.content.includes(JOB_ERROR_DIRECTIVE));
      ctx.timers.setTimeout(() => {
        if (!failing) return landProposal(root, true);
        ctx.bus.publish("job.failed", { lineId: root, rootLineId: root }, { jobId, kind: "goal_propose", lineId: root, rootLineId: root, error: { code: "run_failed", message: "the job run failed" } });
      }, ctx.draftMs);
      const line = findLine(state(), root);
      return { jobId, kind: "goal_propose", lineId: root, provider: line.provider || "mock", model: line.model || "mock-1" };
    },

    listRelations(lineId) {
      require("relations");
      return { relations: [...relationsOf(rootFor(lineId))].reverse(), limits: DEFAULT_RELATION_LIMITS };
    },

    createRelation,

    updateRelation(lineId, relationId, input) {
      require("relations");
      const root = writableRoot(lineId);
      const link = relationsOf(root).find((item) => item.id === relationId);
      if (!link) throw new TangentError(404, "relation not found", "relation_not_found");
      const clean = input.label === undefined || input.label === null ? link.label : flatten(input.label);
      if (runes(clean) > DEFAULT_RELATION_LIMITS.labelMaxRunes) throw new TangentError(422, "the label is too long", "too_long", { field: "label", max: DEFAULT_RELATION_LIMITS.labelMaxRunes });
      const relationKind = input.relationKind === undefined || input.relationKind === null ? (link.relationKind ?? "related") : checkedKind(input.relationKind, false);
      const relation = { ...link, label: clean, relationKind };
      ctx.commit({ ...state(), links: state().links.map((item) => (item.id === relationId ? relation : item)) });
      const rootLineIds = [...new Set([rootFor(link.fromLineId), rootFor(link.toLineId)])];
      for (const tree of rootLineIds) ctx.bus.publish("link.changed", { lineId: tree, rootLineId: tree }, { rootLineId: tree, link: relation });
      return { relation, rootLineIds };
    },

    deleteRelation(lineId, relationId) {
      require("relations");
      const root = writableRoot(lineId);
      const link = relationsOf(root).find((item) => item.id === relationId);
      if (!link) throw new TangentError(404, "relation not found", "relation_not_found");
      ctx.commit({ ...state(), links: state().links.filter((item) => item.id !== relationId) });
      for (const tree of new Set([rootFor(link.fromLineId), rootFor(link.toLineId)])) {
        ctx.bus.publish("link.changed", { lineId: tree, rootLineId: tree }, { rootLineId: tree, link, deleted: true });
      }
    },

    links(lineId, spinoffs) {
      const spinoffOn = isFeatureOn(capabilities(), "spinoff");
      const relationsOn = isFeatureOn(capabilities(), "relations");
      if (!spinoffOn && !relationsOn) throw new TangentError(404, "the spinoff feature is off", "feature_disabled", { feature: "spinoff" });
      const root = rootFor(lineId);
      const tree = treeOf(root);
      const relations = relationsOn ? relationsOf(root) : [];
      const kept = spinoffOn ? spinoffs.filter((link) => link.kind === "spinoff" && touches(link, tree)) : [];
      return { links: [...kept, ...relations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    },

    openLoops(query) {
      require("open_loops");
      const staleDays = query.staleDays ?? MOCK_STALE_DAYS;
      if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > STALE_DAYS_MAX) throw new TangentError(400, "staleDays must be 1–365", "invalid_input");
      const root = query.root ? rootFor(query.root) : null;
      const titles = new Map(state().lines.map((line) => [line.id, line.title]));
      const archived = new Set(state().lines.filter((line) => line.archivedAt).map((line) => line.id));
      const inScope = (rootLineId: string) => (root === null || rootLineId === root) && !archived.has(rootLineId);
      const group = <T>(items: readonly T[]) => ({ items: items.slice(0, OPEN_LOOPS_MAX), total: items.length });
      const titled = <T extends { rootLineId: string }>(item: T) => ({ ...item, rootTitle: titles.get(item.rootLineId) ?? "" });
      const notes = Object.entries(state().notesByRoot)
        .filter(([rootLineId]) => inScope(rootLineId))
        .flatMap(([rootLineId, list]) => list.filter((note) => note.section === "to_confirm" && note.status === "active").map((note) => ({ ...note, rootLineId, rootTitle: titles.get(rootLineId) ?? "" })));
      const inboxOn = isFeatureOn(capabilities(), "suggestions");
      return {
        rootLineId: root ?? "",
        staleDays,
        staleBranches: group(staleBranchesOf(state(), root, staleDays).map(titled)),
        ...(isFeatureOn(capabilities(), "notes") ? { toConfirm: group(notes) } : {}),
        ...(isFeatureOn(capabilities(), "parking") ? { seeds: group(state().seeds.filter((seed) => seed.status === "open" && inScope(seed.rootLineId)).map(titled)) } : {}),
        ...(inboxOn ? { suggestions: group(state().suggestions.filter((item) => item.status === "open" && inScope(item.rootLineId)).map(titled)) } : {}),
      };
    },

    pin(messageId, pinned) {
      const message = state().messages.find((item) => item.id === messageId);
      if (!message) throw new TangentError(404, "message not found", "message_not_found");
      const pinnable = message.status === "done" && ((message.kind === "chat" && message.role !== "system") || message.kind === "branch_card");
      if (!pinnable) throw new TangentError(400, "only a finished chat message or a conclusion card can be pinned", "invalid_input");
      writableRoot(message.lineId);
      if (message.pinned === pinned) return { message };
      const changed: Message = { ...message, pinned };
      ctx.commit(withMessage(state(), changed));
      ctx.bus.publish("message.updated", address(ctx, message.lineId), changed);
      return { message: changed };
    },

    afterTurn(lineId, userContent) {
      const line = findLine(state(), lineId);
      if (line.conversationBranch || !aiOn("goal")) return;
      const goal = state().goals[lineId];
      if (!goal) {
        if (doneReplies(lineId).length === GOAL_PROPOSE_AFTER) landProposal(lineId, false);
        return;
      }
      if (!userContent.includes(DRIFT_DIRECTIVE)) return;
      const reply = doneReplies(lineId).at(-1);
      if (!reply) return;
      // Like the fake runner: an investigation (the server may propose an aside only while asides are on).
      const kind = "investigate";
      deps.propose({
        rootLineId: lineId,
        lineId,
        feature: "goal",
        kind: "drift",
        targetKey: `drift:${reply.id}`,
        payload: { anchorMessageId: reply.id, kind, purpose: DRIFT_PURPOSE, reason: DRIFT_REASON, goal: goal.text },
      });
    },

    afterBranchEnded(lineId) {
      if (!aiOn("relations")) return;
      const branch = state().branches.find((item) => item.lineId === lineId);
      if (!branch || branch.kind === "aside") return;
      const other = state()
        .branches.filter((item) => item.rootLineId === branch.rootLineId && item.lineId !== lineId && item.kind !== "aside")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!other) return;
      const [a, b] = [lineId, other.lineId].sort();
      deps.propose({
        rootLineId: branch.rootLineId,
        lineId: branch.rootLineId,
        feature: "relations",
        kind: "relation",
        targetKey: `relation:${a}:${b}`,
        payload: { fromLineId: lineId, toLineId: other.lineId, fromTitle: branch.purpose, toTitle: other.purpose, label: RELATION_LABEL, relationKind: "related" },
      });
    },

    act(suggestion, body) {
      if (suggestion.feature === "goal" && suggestion.kind === "goal_propose") return actGoal(suggestion, body);
      if (suggestion.feature === "goal" && suggestion.kind === "drift") return actDrift(suggestion, body);
      if (suggestion.feature === "relations" && suggestion.kind === "relation") return actRelation(suggestion, body);
      return null;
    },
  };
}
