/** Pure view models of the conversation components (F1), tested without a DOM. */
import type { BranchStatus, BranchView, PreviewBlock } from "@tangent/client";
import type { MessageKey, Translate } from "../i18n";

const STATUS_ORDER: readonly BranchStatus[] = ["open", "merged", "discarded", "promoted"];

export const STATUS_KEYS: Record<BranchStatus, MessageKey> = {
  open: "branch.statusOpen",
  merged: "branch.statusMerged",
  discarded: "branch.statusDiscarded",
  promoted: "branch.statusPromoted",
};

/**
 * The branches opened directly on `lineId`, grouped by the message they fork
 * from (in list order). Given the line's message ids, a branch whose anchor is
 * not among them — a child moved onto a combined branch (B9.1), forked from a
 * message of the old branch — is drawn at the line's first message.
 */
export function forksByAnchor(branches: readonly BranchView[], lineId: string, messageIds?: readonly string[]): Map<string, BranchView[]> {
  const groups = new Map<string, BranchView[]>();
  const known = messageIds ? new Set(messageIds) : null;
  const first = messageIds?.[0];
  for (const branch of branches) {
    if (branch.parentLineId !== lineId) continue;
    const at = known && first !== undefined && !known.has(branch.anchorMessageId) ? first : branch.anchorMessageId;
    groups.set(at, [...(groups.get(at) ?? []), branch]);
  }
  return groups;
}

export interface ForkSummary {
  count: number;
  /** "2 條進行中・1 條已帶回・2 則未讀". */
  text: string;
  /** One per branch, for the status dots. */
  statuses: BranchStatus[];
  unread: number;
}

export function forkSummary(branches: readonly BranchView[], t: Translate): ForkSummary {
  const unread = branches.reduce((sum, branch) => sum + branch.unread, 0);
  // F12: asides are one-turn leaves, counted on their own (「1 則順口問」), not as ended branches.
  const others = branches.filter((branch) => branch.kind !== "aside");
  const asides = branches.length - others.length;
  const parts = STATUS_ORDER.flatMap((status) => {
    const count = others.filter((branch) => branch.status === status).length;
    return count > 0 ? [t("fork.statusCount", { count, status: t(STATUS_KEYS[status]) })] : [];
  });
  if (asides > 0) parts.push(t("fork.asideCount", { count: asides }));
  if (unread > 0) parts.push(t("fork.unread", { count: unread }));
  return { count: branches.length, text: parts.join("・"), statuses: branches.map((branch) => branch.status), unread };
}

/** Preview block keys with their own label; anything else is a host section. */
const BLOCK_KEYS: Record<string, MessageKey> = {
  rules: "preview.block.rules",
  goal: "preview.block.goal",
  instructions: "preview.block.instructions",
  branch_pack: "preview.block.branch_pack",
  notes: "preview.block.notes",
  summary: "preview.block.summary",
  branch_conclusions: "preview.block.branch_conclusions",
  memory: "preview.block.memory",
  branch_cards: "preview.block.branch_cards",
  earlier: "preview.block.earlier",
  history: "preview.block.history",
  user_message: "preview.block.user_message",
  // B16: the first-turn topic and main-line chapter instructions.
  reply_lines: "preview.block.reply_lines",
};

export interface PreviewRow {
  key: string;
  label: string;
  tokens: number;
  blocks: PreviewBlock[];
}

/** One row per run of blocks with the same key (the recent messages become one row), in prompt order. */
export function groupPreviewBlocks(blocks: readonly PreviewBlock[], t: Translate): PreviewRow[] {
  const runs: PreviewBlock[][] = [];
  for (const block of blocks) {
    const last = runs.at(-1);
    if (last && last[0]!.key === block.key) last.push(block);
    else runs.push([block]);
  }
  return runs.map((run) => {
    const key = run[0]!.key;
    const known = BLOCK_KEYS[key];
    const label = known ? t(known, { count: run.length }) : t("preview.block.other", { key });
    return { key, label, tokens: run.reduce((sum, block) => sum + block.tokens, 0), blocks: run };
  });
}

/** US dollars without the sign: two decimals, or four below one cent. */
export function formatUsd(amount: number): string {
  return amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
}

/** True when the server priced the turn and it costs more than the user's threshold. */
export function isOverThreshold(estimatedCostUsd: number | undefined, threshold: number): boolean {
  return estimatedCostUsd !== undefined && estimatedCostUsd > threshold;
}
