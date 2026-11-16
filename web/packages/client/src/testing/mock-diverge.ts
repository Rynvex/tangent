/**
 * Simulated diverge (B10 phase B): directions opened as sibling branches,
 * a comparison table of open siblings, and the decision. Same refusals and
 * events as the server; the AI parts answer like the fake runner (Direction
 * n; the first option 5, the next 4…; O1 recommended). Test-only
 * simplification: each job lands after `draftMs`.
 */
import type { CreateBranchInput, CreateBranchResult, JobStarted } from "../api-types";
import { BRANCH_OPEN_PER_PARENT_LIMIT } from "../branch-errors";
import { isFeatureOn } from "../capabilities";
import { DEFAULT_COMPARISON_LIMITS, DIVERGE_COUNT, type Comparison, type ComparisonList, type ComparisonMatrix, type ConvergeInput, type ConvergeStarted, type DecideInput, type DecideResult, type DivergeInput } from "../comparison-routes";
import { TangentError } from "../errors";
import type { JobErrorCode } from "../group-routes";
import { canTag } from "../folds";
import type { BranchOrigin, BranchView, Leaf, LeafKind } from "../types";
import { closeBranch } from "./mock-branches";
import { address, publishLine, type MockContext } from "./mock-context";
import { findBranch, findLine, messagesOf, newId, rootOf, withBranch } from "./mock-store";

const JOB_ERROR = "[fake:job-error]";
const FAKE_CRITERION = "Fit (fake runner)";
const FAKE_WHY = "Scored by the fake runner.";
const FAKE_REASON = "The first option fits best (fake runner).";
const TOP_SCORE = 5;

export interface MockDiverge {
  diverge(lineId: string, input: DivergeInput): JobStarted;
  converge(lineId: string, input: ConvergeInput): ConvergeStarted;
  list(lineId: string): ComparisonList;
  get(comparisonId: string): { comparison: Comparison };
  decide(comparisonId: string, input: DecideInput): DecideResult;
}

export interface MockDivergeDeps {
  createBranch(lineId: string, input: CreateBranchInput, origin: BranchOrigin): CreateBranchResult;
}

export function createMockDiverge(ctx: MockContext, deps: MockDivergeDeps): MockDiverge {
  const state = ctx.state;

  function require(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "diverge")) throw new TangentError(404, "the diverge feature is off", "feature_disabled", { feature: "diverge" });
  }
  function writable(lineId: string): void {
    if (findLine(state(), rootOf(findLine(state(), lineId))).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
  }
  function newJob(lineId: string, kind: string): JobStarted {
    const [jobId, next] = newId(state(), "job");
    ctx.commit(next);
    const line = findLine(state(), lineId);
    return { jobId, kind, lineId, provider: line.provider || "mock", model: line.model || "mock-1" };
  }
  const jobFailed = (lineId: string, job: JobStarted, code: JobErrorCode, message: string) =>
    ctx.bus.publish("job.failed", address(ctx, lineId), { jobId: job.jobId, kind: job.kind, lineId, rootLineId: address(ctx, lineId).rootLineId, error: { code, message } });
  const openUnder = (lineId: string) => state().branches.filter((branch) => branch.parentLineId === lineId && branch.status === "open").length;

  function save(comparison: Comparison): Comparison {
    const exists = state().comparisons.some((item) => item.id === comparison.id);
    ctx.commit({ ...state(), comparisons: exists ? state().comparisons.map((item) => (item.id === comparison.id ? comparison : item)) : [...state().comparisons, comparison] });
    ctx.bus.publish("comparison.changed", address(ctx, comparison.parentLineId), { rootLineId: comparison.rootLineId, comparison });
    return comparison;
  }
  function find(comparisonId: string): Comparison {
    const comparison = state().comparisons.find((item) => item.id === comparisonId);
    if (!comparison) throw new TangentError(404, "comparison not found", "comparison_not_found");
    return comparison;
  }

  /** Writes a confirmed leaf the way the server's decide does, with leaf.changed. */
  function writeLeaf(lineId: string, kind: LeafKind, line: string, body: string): Leaf {
    const branch = findBranch(state(), lineId);
    const now = ctx.now();
    const leaf: Leaf = { lineId, rootLineId: branch.rootLineId, kind, line, body, status: "confirmed", aiDrafted: false, createdBy: "mock-user", createdAt: now, updatedAt: now };
    ctx.commit(withBranch({ ...state(), leaves: { ...state().leaves, [lineId]: leaf } }, { ...findBranch(state(), lineId), leaf: { kind, line, status: "confirmed" } }));
    ctx.bus.publish("leaf.changed", { lineId, rootLineId: branch.rootLineId }, { lineId, rootLineId: branch.rootLineId, leaf });
    return leaf;
  }

  function matrixOf(comparison: Comparison): ComparisonMatrix {
    const criteria = comparison.criteria.length > 0 ? comparison.criteria : [FAKE_CRITERION];
    const options = comparison.lineIds.map((lineId) => ({ lineId, label: findBranch(state(), lineId).purpose }));
    return {
      criteria,
      options,
      scores: criteria.map(() => options.map((_option, column) => ({ score: Math.max(1, TOP_SCORE - column), why: FAKE_WHY }))),
      recommendation: { lineId: options[0]!.lineId, reason: FAKE_REASON },
    };
  }

  return {
    diverge(lineId, input) {
      require();
      writable(lineId);
      if (!Number.isInteger(input.count) || input.count < DIVERGE_COUNT.min || input.count > DIVERGE_COUNT.max) throw new TangentError(400, "count must be 2–5", "invalid_input");
      const anchor = messagesOf(state(), lineId).find((message) => message.id === input.anchorMessageId);
      if (!anchor || !canTag(anchor)) throw new TangentError(404, "the anchor message is not on this line", "anchor_not_found");
      if (openUnder(lineId) + input.count > BRANCH_OPEN_PER_PARENT_LIMIT) throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
      const job = newJob(lineId, "diverge");
      ctx.timers.setTimeout(() => {
        if (openUnder(lineId) + input.count > BRANCH_OPEN_PER_PARENT_LIMIT) return jobFailed(lineId, job, "failed", "the branches could not be opened: too many open branches");
        for (let n = 1; n <= input.count; n += 1) deps.createBranch(lineId, { anchorMessageId: input.anchorMessageId, purpose: `Direction ${n} (fake runner)`, kind: "alternative" }, "diverge");
      }, ctx.draftMs);
      return job;
    },

    converge(lineId, input) {
      require();
      writable(lineId);
      const ids = [...new Set(input.lineIds)];
      if (ids.length < DEFAULT_COMPARISON_LIMITS.minOptions || ids.length > DEFAULT_COMPARISON_LIMITS.maxOptions) throw new TangentError(422, "a comparison takes 2–5 branches", "invalid_comparison");
      if ((input.criteria ?? []).length > DEFAULT_COMPARISON_LIMITS.maxCriteria) throw new TangentError(400, "too many criteria", "invalid_input");
      for (const id of ids) {
        const branch = state().branches.find((item) => item.lineId === id);
        if (!branch || branch.parentLineId !== lineId || branch.kind === "aside") throw new TangentError(422, "the options must be branches of this line", "invalid_comparison");
        if (branch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
      }
      const [id, next] = newId(state(), "comparison");
      ctx.commit(next);
      const now = ctx.now();
      const comparison = save({
        id,
        rootLineId: rootOf(findLine(state(), lineId)),
        parentLineId: lineId,
        lineIds: ids,
        criteria: (input.criteria ?? []).map((criterion) => criterion.trim()).filter(Boolean),
        status: "drafting",
        matrix: null,
        decidedLineId: "",
        createdBy: "mock-user",
        decidedBy: "",
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
      });
      const job = newJob(lineId, "converge");
      ctx.timers.setTimeout(() => {
        const current = state().comparisons.find((item) => item.id === id);
        if (!current || current.status !== "drafting") return;
        if (ids.some((option) => messagesOf(state(), option).some((message) => message.content.includes(JOB_ERROR)))) {
          save({ ...current, status: "failed", updatedAt: ctx.now() });
          return jobFailed(lineId, job, "run_failed", "the job run failed");
        }
        save({ ...current, status: "ready", matrix: matrixOf(current), updatedAt: ctx.now() });
      }, ctx.draftMs);
      return { comparison, job };
    },

    list(lineId) {
      require();
      const line = findLine(state(), lineId);
      const own = state().comparisons.filter((comparison) => comparison.parentLineId === lineId).reverse();
      return { lineId, rootLineId: rootOf(line), comparisons: own, limits: DEFAULT_COMPARISON_LIMITS };
    },

    get(comparisonId) {
      require();
      return { comparison: find(comparisonId) };
    },

    decide(comparisonId, input) {
      require();
      const comparison = find(comparisonId);
      writable(comparison.parentLineId);
      if (comparison.status === "decided") throw new TangentError(409, "already decided", "comparison_decided");
      if (comparison.status !== "ready" || !comparison.matrix) throw new TangentError(409, "the table is not ready", "comparison_not_ready");
      if (!comparison.lineIds.includes(input.lineId)) throw new TangentError(422, "not one of the options", "invalid_comparison");
      const chosen = findBranch(state(), input.lineId);
      if (chosen.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
      const matrix = comparison.matrix;
      const column = matrix.options.findIndex((option) => option.lineId === input.lineId);
      const body = matrix.criteria.map((criterion, row) => `- ${criterion}: ${matrix.scores[row]?.[column]?.score ?? 0}/5 — ${matrix.scores[row]?.[column]?.why ?? ""}`).join("\n");
      const line = input.line?.trim() || (matrix.recommendation.lineId === input.lineId ? matrix.recommendation.reason : chosen.purpose);
      const discarded: BranchView[] = [];
      for (const other of comparison.lineIds.filter((id) => id !== input.lineId)) {
        const branch = findBranch(state(), other);
        if (branch.status !== "open" || branch.parentLineId !== comparison.parentLineId) continue;
        const closed = closeBranch(ctx, branch, { status: "discarded" });
        ctx.bus.publish("branch.changed", address(ctx, other), { change: "discarded", branch: closed });
        discarded.push(closed);
      }
      publishLine(ctx, comparison.parentLineId);
      // The server's language (zh-TW by default, B10 phase C): 沒選：改走「…」.
      for (const branch of discarded) writeLeaf(branch.lineId, "dead_end", `沒選：改走「${chosen.purpose}」`, "");
      const decision = writeLeaf(input.lineId, "decision", line, body);
      const now = ctx.now();
      const decided = save({ ...comparison, status: "decided", decidedLineId: input.lineId, decidedBy: "mock-user", decidedAt: now, updatedAt: now });
      return { comparison: decided, chosen: findBranch(state(), input.lineId), decision, discarded: discarded.map((branch) => findBranch(state(), branch.lineId)) };
    },
  };
}
