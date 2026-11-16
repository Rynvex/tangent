/**
 * A rough, client-side estimate of the background a new branch receives (A3
 * "背景會帶哪些內容"). The server builds the real pack only when the branch is
 * created (no preview route), so the dialog labels these numbers approximate.
 */
import { BRANCH_PACK_RECENT } from "./branch-input";
import { chatMessages } from "./branch-view";
import type { Message } from "./types";

/** CJK ideographs, kana and hangul: about one token per character. */
const WIDE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;
/** Other text: about four characters per token. */
const NARROW_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    if (WIDE.test(char)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / NARROW_CHARS_PER_TOKEN);
}

export type PackRowKey = "purpose" | "excerpt" | "recent" | "later";

export interface PackEstimateRow {
  key: PackRowKey;
  count: number;
  tokens: number;
}

export interface PackEstimate {
  rows: PackEstimateRow[];
  total: number;
}

export interface PackEstimateInput {
  /** The parent line's messages. */
  messages: readonly Message[];
  anchorMessageId: string;
  purpose: string;
  excerpt: string;
  includeLater?: boolean;
  /** Messages quoted up to the fork point (the server's `Pack.RecentMessages`). */
  recent?: number;
}

const sumTokens = (messages: readonly Message[]) => messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

export function estimatePack({ messages, anchorMessageId, purpose, excerpt, includeLater = false, recent = BRANCH_PACK_RECENT }: PackEstimateInput): PackEstimate {
  const chat = chatMessages(messages);
  const index = chat.findIndex((message) => message.id === anchorMessageId);
  if (index < 0) return { rows: [], total: 0 };
  const quoted = chat.slice(Math.max(0, index + 1 - recent), index + 1);
  const later = chat.slice(index + 1);
  const rows: PackEstimateRow[] = [
    ...(purpose.trim() ? [{ key: "purpose" as const, count: 1, tokens: estimateTokens(purpose.trim()) }] : []),
    ...(excerpt.trim() ? [{ key: "excerpt" as const, count: 1, tokens: estimateTokens(excerpt.trim()) }] : []),
    { key: "recent", count: quoted.length, tokens: sumTokens(quoted) },
    ...(includeLater && later.length > 0 ? [{ key: "later" as const, count: later.length, tokens: sumTokens(later) }] : []),
  ];
  return { rows, total: rows.reduce((sum, row) => sum + row.tokens, 0) };
}
