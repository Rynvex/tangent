/**
 * Simulated B14 routes: the whole tree as data (`GET /lines/{id}/export`),
 * branches opened across models (`POST /lines/{id}/diverge/models`) and
 * seeds parked in one go (`POST /lines/{id}/seeds/batch`). Same refusals,
 * order and events as the server (export.go, feature_diverge_models.go,
 * store/seeds_batch.go); bodies are raw wire shapes.
 */
import type { CreateBranchInput, CreateBranchResult } from "../api-types";
import { DIVERGE_MODELS_COUNT, EXPORT_MAX_MESSAGES_PER_LINE, SEED_BATCH_MAX, type CreateSeedsBatchInput, type DivergeModelTarget, type DivergeModelsInput } from "../b14-routes";
import { BRANCH_HARD_DEPTH_LIMIT, BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "../branch-errors";
import { BRANCH_EXCERPT_MAX, BRANCH_PURPOSE_MAX } from "../branch-input";
import { isFeatureOn, type FeatureName } from "../capabilities";
import type { Comparison } from "../comparison-routes";
import { TangentError } from "../errors";
import type { Fold } from "../fold-routes";
import { canTag } from "../folds";
import type { Memo } from "../memo-routes";
import type { Term } from "../glossary-routes";
import { SEED_OPEN_MAX, SEED_TEXT_MAX } from "../p1";
import type { BranchOrigin, Chapter, Goal, LineView, Link, Message, Note, Seed } from "../types";
import { publishLine, type MockContext } from "./mock-context";
import { mockSourceLabel } from "./mock-notes";
import { findLine, messagesOf, newId, recount, rootOf } from "./mock-store";

/** `store.OutlineCap`: an outline this long may have been cut. */
const OUTLINE_CAP = 500;
/** `store.TreeComparisonCap`. */
const TREE_COMPARISON_CAP = 500;
/** `defaultDivergePurposeRunes`: how much of the anchor names a target's branch. */
const DEFAULT_PURPOSE_RUNES = 40;
const MODEL_SEPARATOR = " · ";

/** What the export reads from the other simulations (each only called while its feature is on). */
export interface MockB14Deps {
  createBranch(lineId: string, input: CreateBranchInput, origin: BranchOrigin): CreateBranchResult;
  notes(rootLineId: string): readonly Note[];
  memos(rootLineId: string): readonly Memo[];
  terms(rootLineId: string): readonly Term[];
  chapters(rootLineId: string): readonly Chapter[];
  /** Spinoffs and relations touching the tree, whichever of the two features is on. */
  links(rootLineId: string): readonly Link[];
}

export interface MockB14 {
  exportTree(lineId: string): unknown;
  divergeModels(lineId: string, input: DivergeModelsInput): unknown;
  createSeedsBatch(lineId: string, input: CreateSeedsBatchInput): unknown;
}

const runes = (text: string) => Array.from(text).length;
/** `branchLine`: one line, whitespace collapsed. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** `domain.CutRunes`: at most `max` characters, the last one "…" when cut. */
function cutRunes(text: string, max: number): string {
  const all = Array.from(text);
  if (all.length <= max || max < 1) return text;
  return `${all.slice(0, max - 1).join("").trim()}…`;
}

const invalidPurpose = () => new TangentError(400, "purpose is required and must not be too long", "invalid_input");

/** `NormalizeBranchPurpose`: 1–200 characters, else invalid_input. */
function checkedPurpose(text: string): string {
  const trimmed = text.trim();
  if (runes(trimmed) < 1 || runes(trimmed) > BRANCH_PURPOSE_MAX) throw invalidPurpose();
  return trimmed;
}

/** `domain.DivergeTargetPurpose`: its own, else "{shared} · {model}", else the anchor's start · model; a derived one keeps the model when cut. */
export function mockDivergePurpose(target: DivergeModelTarget, shared: string, anchor: string): string {
  if ((target.purpose ?? "").trim() !== "") return checkedPurpose(oneLine(target.purpose ?? ""));
  const prefix = oneLine(shared) || cutRunes(oneLine(anchor), DEFAULT_PURPOSE_RUNES);
  const model = oneLine(target.model);
  if (prefix === "") return checkedPurpose(model);
  const suffix = `${MODEL_SEPARATOR}${model}`;
  const room = BRANCH_PURPOSE_MAX - runes(suffix);
  if (room < 1) return checkedPurpose(cutRunes(prefix + suffix, BRANCH_PURPOSE_MAX));
  return checkedPurpose(cutRunes(prefix, room) + suffix);
}

/** `domain.BuildDivergeTargetsNote`: the pack says which model answers the branch and names its siblings. */
function targetsNote(own: number, targets: readonly DivergeModelTarget[], purposes: readonly string[]): string {
  const label = (index: number) => `> ${oneLine(purposes[index] ?? "")} (${oneLine(targets[index]!.provider)}/${oneLine(targets[index]!.model)})`;
  const others = targets.map((_target, index) => index).filter((index) => index !== own).map(label);
  const head = `\n## Parallel answers\n\nThis branch is one of several parallel branches on the message above, each answered by a different model.\n${label(own)}\n`;
  return others.length > 0 ? `${head}\nThe sibling branches:\n${others.join("\n")}\n` : head;
}

export function createMockB14(ctx: MockContext, deps: MockB14Deps): MockB14 {
  const state = ctx.state;
  const on = (feature: FeatureName) => isFeatureOn(ctx.scenario.capabilities, feature);
  function require(feature: FeatureName): void {
    if (!on(feature)) throw new TangentError(404, `the ${feature} feature is off`, "feature_disabled", { feature });
  }

  /** The cmd/tangent-server model check: the fake takes any model, others the listed ones (when the server lists any). */
  function checkModel(provider: string, model: string): void {
    const listed = ctx.scenario.capabilities.models;
    if (provider.toLowerCase() === "fake" || !listed) return;
    if (listed.some((entry) => entry.provider === provider && entry.models.includes(model))) return;
    throw new TangentError(422, `the model ${provider}/${model} is not allowed here`, "model_not_allowed", { provider, model });
  }

  /** CheckBranchCreate for `count` branches opened in one transaction: the first one refused refuses them all. */
  function checkOpen(parent: LineView, count: number, confirmDeeper: boolean): void {
    const root = rootOf(parent);
    if (findLine(state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    if (parent.conversationBranch && parent.conversationBranch.status !== "open") throw new TangentError(409, "the parent branch has ended", "parent_closed");
    const depth = (parent.conversationBranch?.depth ?? 0) + 1;
    if (depth > BRANCH_HARD_DEPTH_LIMIT) throw new TangentError(409, "too deep", "depth_hard_limit", { limit: BRANCH_HARD_DEPTH_LIMIT });
    const open = state().branches.filter((branch) => branch.parentLineId === parent.id && branch.status === "open").length;
    const tree = state().branches.filter((branch) => branch.rootLineId === root).length;
    for (let made = 0; made < count; made += 1) {
      if (open + made >= BRANCH_OPEN_PER_PARENT_LIMIT) throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
      if (tree + made >= BRANCH_TREE_LIMIT) throw new TangentError(409, "the tree is full", "tree_limit", { limit: BRANCH_TREE_LIMIT });
    }
    if (depth > BRANCH_SOFT_DEPTH_LIMIT && !confirmDeeper) throw new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth, limit: BRANCH_SOFT_DEPTH_LIMIT });
  }

  /** A line's messages as `GET /messages` gives them (a spinoff marker says whether its conversation is still there). */
  function exportedMessages(lineId: string): { messages: Message[]; cut: boolean } {
    const all = messagesOf(state(), lineId).map((message) => {
      const to = message.meta.spunOffTo;
      return to ? { ...message, meta: { ...message.meta, spunOffTo: { ...to, available: state().lines.some((line) => line.id === to.lineId) } } } : message;
    });
    return { messages: all.slice(0, EXPORT_MAX_MESSAGES_PER_LINE), cut: all.length > EXPORT_MAX_MESSAGES_PER_LINE };
  }

  function foldsOf(lineIds: readonly string[]): Record<string, Fold[]> {
    const tree = new Set(lineIds);
    const out: Record<string, Fold[]> = {};
    const kept = state().folds.filter((fold) => tree.has(fold.lineId) && fold.status !== "removed").sort((a, b) => a.fromSeq - b.fromSeq);
    for (const fold of kept) out[fold.lineId] = [...(out[fold.lineId] ?? []), fold];
    return out;
  }

  function comparisonsOf(lineIds: readonly string[]): { comparisons: Comparison[]; cut: boolean } {
    const tree = new Set(lineIds);
    const own = state().comparisons.filter((comparison) => tree.has(comparison.parentLineId));
    return { comparisons: own.slice(0, TREE_COMPARISON_CAP), cut: own.length > TREE_COMPARISON_CAP };
  }

  /** `NormalizeSeedTexts`: 1–20 texts, each one line, not empty and at most 500 characters. */
  function seedTexts(texts: readonly unknown[] | undefined): string[] {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length < 1 || list.length > SEED_BATCH_MAX) throw new TangentError(400, `a batch parks 1 to ${SEED_BATCH_MAX} thoughts`, "invalid_input");
    return list.map((raw) => {
      const text = oneLine(typeof raw === "string" ? raw : "");
      if (text === "") throw new TangentError(400, "the text of a parked thought must not be empty", "invalid_input");
      if (runes(text) > SEED_TEXT_MAX) throw new TangentError(422, "the text is too long", "too_long", { field: "text", max: SEED_TEXT_MAX });
      return text;
    });
  }

  /** CreateSeed's anchor: a finished chat message of the tree, or the line's newest one. */
  function seedAnchor(lineId: string, root: string, requested: string | undefined): string {
    if (requested) {
      const message = state().messages.find((item) => item.id === requested && item.kind === "chat" && item.status === "done");
      if (!message || rootOf(findLine(state(), message.lineId)) !== root) throw new TangentError(404, "the anchor message is not in this conversation", "anchor_not_found");
      return requested;
    }
    return messagesOf(state(), lineId).filter((message) => message.kind === "chat" && message.status === "done").at(-1)?.id ?? "";
  }

  return {
    exportTree(lineId) {
      const root = rootOf(findLine(state(), lineId));
      const branches = state().branches.filter((branch) => branch.rootLineId === root);
      const lineIds = [root, ...branches.map((branch) => branch.lineId)];
      let truncated = branches.length >= OUTLINE_CAP;
      const messagesByLine: Record<string, Message[]> = {};
      for (const id of lineIds) {
        const { messages, cut } = exportedMessages(id);
        messagesByLine[id] = messages;
        truncated = truncated || cut;
      }
      const compared = on("diverge") ? comparisonsOf(lineIds) : { comparisons: [], cut: false };
      const goal: Goal | null = on("goal") ? (state().goals[root] ?? null) : null;
      return {
        rootLineId: root,
        exportedAt: ctx.now(),
        truncated: truncated || compared.cut,
        rootLine: recount(state(), root),
        branches,
        messagesByLine,
        notes: on("notes") ? deps.notes(root) : [],
        memos: on("memo") ? deps.memos(root) : [],
        chapters: on("chapters") ? deps.chapters(root) : [],
        goal,
        comparisons: compared.comparisons,
        links: on("spinoff") || on("relations") ? deps.links(root) : [],
        foldsByLine: on("fold") ? foldsOf(lineIds) : {},
        terms: on("glossary") ? deps.terms(root) : [],
      };
    },

    divergeModels(lineId, input) {
      require("diverge");
      const targets = Array.isArray(input.targets) ? input.targets : [];
      if (targets.length < DIVERGE_MODELS_COUNT.min || targets.length > DIVERGE_MODELS_COUNT.max) throw new TangentError(400, "count must be 2–5", "invalid_input");
      const shared = input.purpose ?? "";
      if (shared.trim() !== "") checkedPurpose(shared);
      for (const target of targets) {
        if (!target.provider?.trim() || !target.model?.trim()) throw new TangentError(400, "every target needs a provider and a model", "invalid_input");
        checkModel(target.provider.trim(), target.model.trim());
      }
      const parent = findLine(state(), lineId);
      const anchor = messagesOf(state(), lineId).find((message) => message.id === input.anchorMessageId);
      if (!anchor || !canTag(anchor)) throw new TangentError(404, "the anchor message is not on this line", "anchor_not_found");
      const trimmed = targets.map((target) => ({ ...target, provider: target.provider.trim(), model: target.model.trim() }));
      const purposes = trimmed.map((target) => mockDivergePurpose(target, shared, anchor.content));
      const excerpt = (input.excerpt ?? "").trim();
      if (runes(excerpt) > BRANCH_EXCERPT_MAX) throw new TangentError(400, "the selected excerpt is too long", "invalid_input");
      checkOpen(parent, trimmed.length, input.confirmDeeper === true);
      const branches = trimmed.map((target, index) => {
        const created = deps.createBranch(
          lineId,
          { anchorMessageId: anchor.id, purpose: purposes[index]!, kind: "alternative", provider: target.provider, model: target.model, ...(excerpt ? { excerpt } : {}), ...(input.confirmDeeper ? { confirmDeeper: true } : {}) },
          "diverge",
        );
        return { ...created, pack: { ...created.pack, rendered: created.pack.rendered + targetsNote(index, trimmed, purposes) } };
      });
      return { parentLineId: lineId, rootLineId: rootOf(parent), branches };
    },

    createSeedsBatch(lineId, input) {
      require("parking");
      const texts = seedTexts(input.texts);
      const line = findLine(state(), lineId);
      const root = rootOf(line);
      if (findLine(state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
      const open = state().seeds.filter((seed) => seed.rootLineId === root && seed.status === "open").length;
      if (open + texts.length > SEED_OPEN_MAX) throw new TangentError(409, "the parking lot is full", "seed_limit", { limit: SEED_OPEN_MAX });
      const anchorMessageId = seedAnchor(lineId, root, input.anchorMessageId);
      const anchor = state().messages.find((message) => message.id === anchorMessageId);
      const sourceLabel = anchor ? mockSourceLabel(state(), root, { sourceLineId: anchor.lineId, sourceMessageId: anchor.id }) : "";
      const now = ctx.now();
      const seeds: Seed[] = texts.map((text) => {
        const [id, next] = newId(state(), "seed");
        ctx.commit(next);
        return { id, rootLineId: root, anchorMessageId, anchorLineId: anchor?.lineId ?? "", sourceLabel, text, status: "open", expandedLineId: "", noteId: "", createdBy: "mock-user", createdAt: now, updatedAt: now };
      });
      ctx.commit({ ...state(), seeds: [...state().seeds, ...seeds] });
      // One seeds.changed and the main line's count, after the whole batch (the server's seedEvents).
      ctx.bus.publish("seeds.changed", { lineId: root, rootLineId: root }, { rootLineId: root });
      publishLine(ctx, root);
      return { rootLineId: root, seeds };
    },
  };
}
