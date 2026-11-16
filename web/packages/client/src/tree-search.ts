/**
 * Searching one conversation (S3 InTreeSearchBar). With the search feature
 * on, the server answers (`search({ q, root })`); with it off, only what is
 * already loaded is searched here — branch purposes and the messages of the
 * lines in the query cache (decision #15: never a whole-tree read per key).
 * Hits are placed for the result list: main line, which branch, an aside,
 * or inside a fold (which the jump unfolds).
 */
import type { SearchHit } from "./b5-routes";
import type { Fold } from "./fold-routes";
import { foldSpans } from "./folds";
import type { BranchView, Message } from "./types";

/** The server's query bounds (B5). */
export const TREE_SEARCH_MIN = 2;
export const TREE_SEARCH_LIMIT = 50;

const SNIPPET_CONTEXT = 60;

/** What a local search reads: the tree's outline and the messages of the lines loaded so far. */
export interface LoadedTree {
  rootLineId: string;
  rootTitle: string;
  branches: readonly BranchView[];
  /** Messages of each loaded line, by line id. */
  messagesByLine: Readonly<Record<string, readonly Message[]>>;
}

function snippet(text: string, at: number, length: number): { text: string; start: number } {
  const flat = text.replace(/[\n\t]/g, " ");
  const from = Math.max(0, at - SNIPPET_CONTEXT);
  const to = at + length + SNIPPET_CONTEXT;
  const head = from > 0 ? "…" : "";
  return { text: `${head}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`, start: at - from + head.length };
}

/** Case-insensitive substring hits over the loaded tree: purposes first, then messages newest first. */
export function searchLoadedTree(tree: LoadedTree, query: string, limit = TREE_SEARCH_LIMIT): SearchHit[] {
  const q = query.trim();
  if (Array.from(q).length < TREE_SEARCH_MIN) return [];
  const needle = q.toLowerCase();
  const purposeOf = new Map(tree.branches.map((branch) => [branch.lineId, branch.purpose]));
  const base = (lineId: string) => ({ lineId, rootLineId: tree.rootLineId, rootTitle: tree.rootTitle, purpose: purposeOf.get(lineId) ?? "", score: 0 });
  const purposes: SearchHit[] = tree.branches.flatMap((branch) => {
    const at = branch.purpose.toLowerCase().indexOf(needle);
    return at < 0 ? [] : [{ ...base(branch.lineId), kind: "purpose" as const, snippet: branch.purpose, highlights: [{ start: at, end: at + q.length }], at: branch.lastActivityAt }];
  });
  const messages: SearchHit[] = Object.entries(tree.messagesByLine).flatMap(([lineId, list]) =>
    list
      .filter((message) => message.kind === "chat" && message.status === "done" && (message.role === "user" || message.role === "assistant"))
      .flatMap((message) => {
        const at = message.content.toLowerCase().indexOf(needle);
        if (at < 0) return [];
        const cut = snippet(message.content, at, q.length);
        return [{ ...base(lineId), kind: "message" as const, snippet: cut.text, highlights: [{ start: cut.start, end: cut.start + q.length }], at: message.createdAt, messageId: message.id, seq: message.seq, role: message.role }];
      }),
  );
  messages.sort((a, b) => b.at.localeCompare(a.at));
  return [...purposes, ...messages].slice(0, limit);
}

/** Where a hit sits, for its row: the main line, a branch (an aside is said so), and the fold around it when known. */
export interface HitPlace {
  line: { kind: "main" } | { kind: "branch"; purpose: string; aside: boolean };
  /** `#n` of the message on its line, when its messages are loaded. */
  n: number | null;
  /** The fold holding the message ("在折疊 #a–#b 裡"), by its first and last numbers. */
  fold: { id: string; from: number; to: number } | null;
}

export function hitPlace(hit: SearchHit, rootLineId: string, branches: readonly BranchView[], messages: readonly Message[] | undefined, folds: readonly Fold[] | undefined): HitPlace {
  const branch = branches.find((item) => item.lineId === hit.lineId);
  const line: HitPlace["line"] = hit.lineId === rootLineId || !branch ? { kind: "main" } : { kind: "branch", purpose: branch.purpose, aside: branch.kind === "aside" };
  if (!hit.messageId || !messages) return { line, n: null, fold: null };
  const chat = messages.filter((message) => message.kind === "chat" && message.role !== "system").sort((a, b) => a.seq - b.seq);
  const numbers = new Map(chat.map((message, index) => [message.id, index + 1]));
  const n = numbers.get(hit.messageId) ?? null;
  if (!folds || folds.length === 0) return { line, n, fold: null };
  const spans = foldSpans(messages, folds, hit.lineId);
  for (const span of spans.byFirst.values()) {
    if (!span.messages.some((message) => message.id === hit.messageId)) continue;
    const inside = span.messages.map((message) => numbers.get(message.id)).filter((value): value is number => value !== undefined);
    return { line, n, fold: inside.length > 0 ? { id: span.fold.id, from: inside[0]!, to: inside.at(-1)! } : null };
  }
  return { line, n, fold: null };
}
