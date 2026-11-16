/**
 * Simulated leaves (B8 phase A, the leaf feature): GET / PUT / DELETE /leaf,
 * AI drafts, the dead-end reason of a discard and the conclusion a merge
 * leaves. Like the server, `BranchView.leaf` follows every write and
 * `leaf.changed` is published after it.
 */
import type { JobStarted } from "../api-types";
import { featureMode, isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import { LEAF_BODY_MAX, LEAF_LINE_MAX, leafLine } from "../p1";
import type { LeafDraftError, LeafInput, LeafResult } from "../p1-routes";
import { LEAF_KINDS, type BranchCard, type Leaf, type LeafKind, type LeafStatus } from "../types";
import type { MockContext } from "./mock-context";
import { findBranch, findLine, messagesOf, newId, withBranch } from "./mock-store";

export interface MockLeaves {
  get(lineId: string): LeafResult;
  put(lineId: string, input: LeafInput): LeafResult;
  remove(lineId: string): void;
  draft(lineId: string): JobStarted;
  /** Refuses a discard's `leaf` before anything is written (invalid_leaf, the feature off). */
  checkDiscard(input: LeafInput | undefined): void;
  /** After a discard: the reason as a confirmed leaf, or (suggest / auto) an AI draft. */
  afterDiscard(lineId: string, input: LeafInput | undefined): void;
  /** After a merge: the card's conclusion as a confirmed leaf (domain.LeafFromCard). */
  afterMerge(lineId: string, card: BranchCard): void;
  /** B17: a card edited; the leaf follows only while it is still the one the merge wrote from the old card. */
  afterCardEdit(lineId: string, before: BranchCard, after: BranchCard): void;
  /** After a promotion: (suggest / auto) a draft for the previous main line. */
  afterPromote(previousMainLineId: string): void;
}

const DRAFT = { kind: "conclusion" as LeafKind, line: "The branch settled its question (mock).", body: "Drafted by the mock." };

const cut = (text: string, max: number) => (Array.from(text).length <= max ? text : `${Array.from(text).slice(0, max - 1).join("").trim()}…`);

/** A branch whose messages say `[fake:error]` fails its leaf draft (like the fake runner's directive). */
const FAIL_DIRECTIVE = "[fake:error]";

/** domain.LeafFromCard: the leaf a merge writes from a card. */
function leafFromCard(card: BranchCard): { kind: LeafKind; line: string; body: string } {
  const points = [...card.evidence.map((item) => item.note), ...card.openItems].map(leafLine).filter(Boolean).map((item) => `- ${item}`);
  const body = cut([leafLine(card.question), ...points].join("\n").trim(), LEAF_BODY_MAX);
  return { kind: "conclusion", line: cut(leafLine(card.conclusion), LEAF_LINE_MAX), body };
}

export function createMockLeaves(ctx: MockContext): MockLeaves {
  const mode = () => featureMode(ctx.scenario.capabilities, "leaf");
  /** The newest failed draft per branch, until the leaf is written or drafted again (B8.1 `draftError`). */
  let draftErrors: Readonly<Record<string, LeafDraftError>> = {};
  const clearError = (lineId: string) => {
    const { [lineId]: _gone, ...rest } = draftErrors;
    draftErrors = rest;
  };

  function requireLeaf(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "leaf")) throw new TangentError(404, "the leaf feature is off", "feature_disabled", { feature: "leaf" });
  }

  /** domain.NormalizeLeaf: the kind, a one-line line of at most 200 characters, a body of at most 4000. */
  function normalize(input: LeafInput, fallbackKind?: LeafKind): { kind: LeafKind; line: string; body: string } {
    const kind = input.kind ?? fallbackKind ?? ("" as LeafKind);
    const line = leafLine(input.line ?? "");
    const body = (input.body ?? "").trim();
    const problems = [
      ...((LEAF_KINDS as readonly string[]).includes(kind) ? [] : [{ field: "kind", message: "must be conclusion, decision, answer, dead_end or to_continue" }]),
      ...(line === "" ? [{ field: "line", message: "must not be empty" }] : Array.from(line).length > LEAF_LINE_MAX ? [{ field: "line", message: `is longer than ${LEAF_LINE_MAX} characters` }] : []),
      ...(Array.from(body).length > LEAF_BODY_MAX ? [{ field: "body", message: `is longer than ${LEAF_BODY_MAX} characters` }] : []),
    ];
    if (problems.length > 0) throw new TangentError(422, `the leaf is not acceptable: ${problems[0]!.field} ${problems[0]!.message}`, "invalid_leaf", { problems });
    return { kind, line, body };
  }

  /** Stores the leaf (or removes it), mirrors it on the branch view and publishes `leaf.changed`. */
  function save(lineId: string, leaf: Leaf | null): void {
    clearError(lineId);
    const state = ctx.state();
    const { [lineId]: _old, ...rest } = state.leaves;
    const branch = findBranch(state, lineId);
    const summary = leaf ? { kind: leaf.kind, line: leaf.line, status: leaf.status } : null;
    ctx.commit(withBranch({ ...state, leaves: leaf ? { ...rest, [lineId]: leaf } : rest }, { ...branch, leaf: summary }));
    ctx.bus.publish("leaf.changed", { lineId, rootLineId: branch.rootLineId }, { lineId, rootLineId: branch.rootLineId, leaf });
  }

  function write(lineId: string, fields: { kind: LeafKind; line: string; body: string }, status: LeafStatus, aiDrafted: boolean): Leaf {
    const branch = findBranch(ctx.state(), lineId);
    const old = ctx.state().leaves[lineId];
    const leaf: Leaf = { lineId, rootLineId: branch.rootLineId, ...fields, status, aiDrafted, createdBy: aiDrafted ? "" : "mock-user", createdAt: old?.createdAt ?? ctx.now(), updatedAt: ctx.now() };
    save(lineId, leaf);
    return leaf;
  }

  /** A finished draft: written unless the user wrote the leaf meanwhile (suggest / manual: a draft; auto: confirmed and marked). */
  function finishDraft(lineId: string): void {
    if (messagesOf(ctx.state(), lineId).some((message) => message.content.includes(FAIL_DIRECTIVE))) {
      const draftError: LeafDraftError = { code: "run_failed", message: "the leaf draft run failed" };
      draftErrors = { ...draftErrors, [lineId]: draftError };
      const rootLineId = findBranch(ctx.state(), lineId).rootLineId;
      ctx.bus.publish("leaf.changed", { lineId, rootLineId }, { lineId, rootLineId, leaf: ctx.state().leaves[lineId] ?? null, draftError });
      return;
    }
    const old = ctx.state().leaves[lineId];
    if (old && !old.aiDrafted) return;
    if (mode() === "auto") write(lineId, DRAFT, "confirmed", true);
    else write(lineId, DRAFT, "draft", true);
  }

  function scheduleDraft(lineId: string): void {
    clearError(lineId);
    ctx.timers.setTimeout(() => finishDraft(lineId), ctx.draftMs);
  }

  /** Suggest and auto draft on their own, never for an empty branch. */
  function autoDraft(lineId: string): void {
    const current = mode();
    if ((current === "suggest" || current === "auto") && messagesOf(ctx.state(), lineId).some((message) => message.kind === "chat")) scheduleDraft(lineId);
  }

  return {
    get(lineId) {
      requireLeaf();
      findBranch(ctx.state(), lineId);
      const draftError = draftErrors[lineId];
      return { leaf: ctx.state().leaves[lineId] ?? null, ...(draftError ? { draftError } : {}) };
    },

    put(lineId, input) {
      requireLeaf();
      const branch = findBranch(ctx.state(), lineId);
      if (findLine(ctx.state(), branch.rootLineId).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
      return { leaf: write(lineId, normalize(input), "confirmed", false) };
    },

    remove(lineId) {
      requireLeaf();
      findBranch(ctx.state(), lineId);
      if (!ctx.state().leaves[lineId]) throw new TangentError(404, "this branch has no leaf", "leaf_not_found");
      save(lineId, null);
    },

    draft(lineId) {
      requireLeaf();
      const branch = findBranch(ctx.state(), lineId);
      const [jobId, next] = newId(ctx.state(), "job");
      ctx.commit(next);
      scheduleDraft(lineId);
      return { jobId, kind: "leaf_draft", lineId, provider: branch.provider || "anthropic", model: branch.model || "claude-haiku-4-5" };
    },

    checkDiscard(input) {
      if (!input) return;
      requireLeaf();
      normalize(input, "dead_end");
    },

    afterDiscard(lineId, input) {
      if (!isFeatureOn(ctx.scenario.capabilities, "leaf")) return;
      if (input) write(lineId, normalize(input, "dead_end"), "confirmed", false);
      else autoDraft(lineId);
    },

    afterMerge(lineId, card) {
      if (!isFeatureOn(ctx.scenario.capabilities, "leaf")) return;
      write(lineId, leafFromCard(card), "confirmed", false);
    },

    afterCardEdit(lineId, before, after) {
      if (!isFeatureOn(ctx.scenario.capabilities, "leaf")) return;
      const current = ctx.state().leaves[lineId];
      const merged = leafFromCard(before);
      if (!current || current.aiDrafted || current.kind !== merged.kind || current.line !== merged.line || current.body !== merged.body) return;
      write(lineId, leafFromCard(after), current.status, false);
    },

    afterPromote(previousMainLineId) {
      if (isFeatureOn(ctx.scenario.capabilities, "leaf")) autoDraft(previousMainLineId);
    },
  };
}
