/**
 * The mock's `POST /preview` (B4, B9 phase B): the next prompt's blocks, the
 * shared budget, and — with the fisheye feature on — the fisheye report and
 * the prompt it shapes (recent messages whole, older ones condensed into
 * "earlier", other branches' leaves in "branch_conclusions"). One test-only
 * simplification: the newest 2 rounds stay whole (the server keeps 4), so
 * the short scenario shows every level.
 */
import type { PreviewBlock, PreviewTurnResult } from "../api-types";
import { isFeatureOn } from "../capabilities";
import type { FisheyeItem, FisheyeReport, PromptBudget } from "../fisheye";
import type { Group } from "../group-routes";
import type { BranchView, ChatMessage, LeafKind, Message, PromptSection } from "../types";
import type { MockContext } from "./mock-context";
import { buildMockNotesBlock } from "./mock-notes-block";
import { applyMockFolds } from "./mock-p3";
import { tokensOf } from "./mock-tokens";
import { findLine, messagesOf, rootOf, type MockState } from "./mock-store";

const PREVIEW_HISTORY = 6;
const MOCK_PROVIDER = "mock";
const MOCK_MODEL = "mock-1";
/** USD per million input tokens, so the preview shows an estimate like a server with pricing. */
const INPUT_PRICE_PER_MTOK = 3;
/** domain `Limits.Context`: the whole budget and the most history may take. */
const TOKEN_BUDGET = 40_000;
const HISTORY_BUDGET = 24_000;
/** Fisheye: rounds kept whole (the server keeps 4), condensed within 20, pinned +100, cards +6. */
const FULL_ROUNDS = 2;
const SUMMARY_ROUNDS = 20;
const PIN_SCORE = 100;
const CARD_SCORE = 6;
const LEAF_SCORE: Readonly<Record<LeafKind, number>> = { decision: 5, conclusion: 4, answer: 3, to_continue: 2, dead_end: 1 };
const CARD_ONLY_SCORE = 4;
const BRANCH_MIN_SCORE = -3;
const BRANCH_MAX = 20;
const SUMMARY_TOKENS_MAX = 12;

export { tokensOf };

/** The line's messages a prompt may carry: finished user / assistant chat messages and conclusion cards. */
function promptMessages(state: MockState, lineId: string): Message[] {
  return messagesOf(state, lineId).filter((message) => message.status === "done" && (message.kind === "branch_card" || (message.kind === "chat" && message.role !== "system")));
}

/** Lines from the root down to `lineId`. */
function pathTo(state: MockState, lineId: string): string[] {
  const path: string[] = [];
  for (let current: string | undefined = lineId; current; current = state.branches.find((branch) => branch.lineId === current)?.parentLineId) path.unshift(current);
  return path;
}

function distance(a: readonly string[], b: readonly string[]): number {
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return a.length + b.length - 2 * common;
}

function messageItems(messages: readonly Message[], foldIds: ReadonlySet<string> = new Set()): FisheyeItem[] {
  return messages.map((message, index) => {
    const round = messages.slice(index + 1).filter((later) => later.role === "user" && later.kind === "chat").length;
    const score = (message.pinned ? PIN_SCORE : 0) + (message.kind === "branch_card" ? CARD_SCORE : 0) - round;
    const whole = index === messages.length - 1 || message.pinned || round < FULL_ROUNDS;
    const level = whole ? "full" : round < SUMMARY_ROUNDS ? "summary" : "hidden";
    const tokens = level === "full" ? tokensOf(message.content) : level === "summary" ? Math.min(SUMMARY_TOKENS_MAX, tokensOf(message.content)) : 0;
    return { kind: foldIds.has(message.id) ? "fold" : "message", id: message.id, lineId: message.lineId, level, score, tokens };
  });
}

/** What a branch leaves for others: its leaf's line, else its card's conclusion. */
function leafOf(state: MockState, branch: BranchView): { line: string; score: number } | null {
  const leaf = state.leaves[branch.lineId];
  if (leaf) return { line: leaf.line, score: LEAF_SCORE[leaf.kind] };
  return branch.conclusionLine ? { line: branch.conclusionLine, score: CARD_ONLY_SCORE } : null;
}

/** A group whose summary is ready stands for its members (B9 phase C). */
const GROUP_SCORE = 4;

function branchItems(state: MockState, lineId: string, groups: readonly Group[]): FisheyeItem[] {
  const own = pathTo(state, lineId);
  const root = own[0] ?? lineId;
  const grouped = new Set(groups.flatMap((group) => group.memberLineIds));
  const groupItems: FisheyeItem[] = groups.map((group) => ({ kind: "group", id: group.id, lineId: "", level: "leaf_only", score: GROUP_SCORE, tokens: tokensOf(`${group.title} ${group.summary}`) }));
  const branchItemsOf = state.branches
    .filter((branch) => branch.rootLineId === root && !own.includes(branch.lineId) && !grouped.has(branch.lineId))
    .map((branch) => {
      const leaf = leafOf(state, branch);
      const score = (leaf?.score ?? 0) - distance(own, pathTo(state, branch.lineId));
      return { kind: "branch" as const, id: branch.lineId, lineId: branch.lineId, level: leaf ? ("leaf_only" as const) : ("hidden" as const), score, tokens: leaf ? tokensOf(leaf.line) : 0 };
    })
    .filter((item) => item.score >= BRANCH_MIN_SCORE);
  return [...groupItems, ...branchItemsOf].sort((a, b) => b.score - a.score).slice(0, BRANCH_MAX);
}

function mockFisheye(state: MockState, lineId: string, messages: readonly Message[], groups: readonly Group[], foldIds: ReadonlySet<string>): FisheyeReport {
  const items = [...messageItems(messages, foldIds), ...branchItems(state, lineId, groups)];
  return { items, tokens: items.reduce((sum, item) => sum + item.tokens, 0), budget: HISTORY_BUDGET };
}

const chat = (message: Message): ChatMessage => ({ role: message.role, content: message.content });

/** History, "earlier" and branch conclusions as the fisheye report shapes them. */
function fisheyePrompt(state: MockState, report: FisheyeReport, messages: readonly Message[], groups: readonly Group[]) {
  const level = new Map(report.items.map((item) => [item.id, item.level]));
  const history = messages.filter((message) => message.kind === "chat" && level.get(message.id) === "full").map(chat);
  const condensed = messages.filter((message) => level.get(message.id) === "summary");
  const earlier = condensed.length > 0 ? `Earlier in this session (${condensed.length} messages, condensed): ${condensed.map((message) => `${message.role === "user" ? "operator" : "agent"}: ${Array.from(message.content).slice(0, 40).join("")};`).join(" ")}` : "";
  const leaves = report.items
    .filter((item) => item.kind !== "message" && item.level === "leaf_only")
    .map((item) => {
      if (item.kind === "group") {
        const group = groups.find((candidate) => candidate.id === item.id);
        return group ? `> [group] ${group.title} — ${group.summary}` : "";
      }
      const branch = state.branches.find((candidate) => candidate.lineId === item.lineId);
      return branch ? `> [${state.leaves[branch.lineId]?.kind ?? "conclusion"}] ${branch.purpose} — ${leafOf(state, branch)?.line ?? ""}` : "";
    })
    .filter(Boolean);
  const conclusions = leaves.length > 0 ? `## Other branches' conclusions\n\n${leaves.join("\n")}` : "";
  return { history, earlier, conclusions };
}

export function mockPreview(ctx: MockContext, lineId: string, content: string): PreviewTurnResult {
  const state = ctx.state();
  const line = findLine(state, lineId);
  const capabilities = ctx.scenario.capabilities;
  // B10 phase A: active folds replace their messages with one system entry (before the history is chosen).
  const folded = applyMockFolds(promptMessages(state, lineId), ctx.activeFolds?.(lineId) ?? []);
  const messages = folded.messages;
  const notesBlock = isFeatureOn(capabilities, "notes") ? buildMockNotesBlock(state.notesByRoot[rootOf(line)] ?? [], ctx.scenario.noteLimits.tokenBudget) : "";
  const rules = { key: "rules", title: "", body: "You are the agent in an interactive conversation with an operator." };
  // B9: the tree's goal goes right after the rules while the goal feature is on.
  const goal = isFeatureOn(capabilities, "goal") ? state.goals[rootOf(line)] : undefined;
  const sections: PromptSection[] = [rules, ...(goal ? [{ key: "goal", title: "", body: `The goal of this conversation: ${goal.text}` }] : []), ...(notesBlock ? [{ key: "notes", title: "", body: notesBlock }] : [])];
  const groups = ctx.readyGroups?.(rootOf(line)) ?? [];
  const fisheye = isFeatureOn(capabilities, "fisheye") ? mockFisheye(state, lineId, messages, groups, folded.foldIds) : undefined;
  const shaped = fisheye ? fisheyePrompt(state, fisheye, messages, groups) : { history: messages.filter((message) => message.kind === "chat").slice(-PREVIEW_HISTORY).map(chat), earlier: "", conclusions: "" };
  // B10 phase C: the memories this turn recalls go last, as their own trailing block.
  const recalled = ctx.recallMemories?.(content || line.title) ?? { results: [], block: "" };
  const trailing = [...(shaped.conclusions ? [{ key: "branch_conclusions", title: "", body: shaped.conclusions }] : []), ...(recalled.block ? [{ key: "memory", title: "", body: recalled.block }] : [])];
  const blocks: PreviewBlock[] = [
    ...sections.map((section) => ({ key: section.key, content: section.body, tokens: tokensOf(section.body) })),
    ...trailing.map((section) => ({ key: section.key, content: section.body, tokens: tokensOf(section.body) })),
    ...(shaped.earlier ? [{ key: "earlier", content: shaped.earlier, tokens: tokensOf(shaped.earlier) }] : []),
    ...shaped.history.map((item) => ({ key: "history", role: item.role, content: item.content, tokens: tokensOf(item.content) })),
    { key: "user_message", role: "user", content, tokens: tokensOf(content) },
  ];
  const totalTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
  return {
    prompt: { sections, summary: null, ...(trailing.length > 0 ? { trailing } : {}), earlier: shaped.earlier, history: shaped.history, userMessage: content, notesChanged: false },
    blocks,
    totalTokens,
    provider: line.provider || MOCK_PROVIDER,
    model: line.model || MOCK_MODEL,
    estimatedCostUsd: (totalTokens * INPUT_PRICE_PER_MTOK) / 1_000_000,
    budget: budgetOf(blocks),
    ...(fisheye ? { fisheye } : {}),
    ...(folded.applied.length > 0 ? { folds: folded.applied } : {}),
    ...(recalled.results.length > 0 ? { memories: [...recalled.results] } : {}),
  };
}

/** Like the server's allocator: each feature's block is its share (rules and the message itself are outside it), then history. */
function budgetOf(blocks: readonly PreviewBlock[]): PromptBudget {
  const owner = (key: string) => (key === "branch_conclusions" ? "fisheye" : key === "earlier" ? "history" : key);
  const spent = new Map<string, number>();
  for (const block of blocks) {
    if (block.key === "rules" || block.key === "user_message") continue;
    spent.set(owner(block.key), (spent.get(owner(block.key)) ?? 0) + block.tokens);
  }
  const ordered = [...spent].sort(([a], [b]) => Number(a === "history") - Number(b === "history"));
  const shares = ordered.map(([name, tokens]) => ({ owner: name, tokens }));
  return { total: TOKEN_BUDGET, shares, history: HISTORY_BUDGET, used: shares.reduce((sum, share) => sum + share.tokens, 0) };
}
