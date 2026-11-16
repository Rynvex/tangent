/** Simulated `GET /search` (B5): substring matches over titles, branch purposes and finished chat messages. */
import type { SearchHit, SearchQuery, SearchResult } from "../b5-routes";
import { TangentError } from "../errors";
import type { MockState } from "./mock-store";
import { findLine, rootOf } from "./mock-store";

/** B14 `root`: one of the main lines (a branch or an unknown id is line_not_found); "" searches every tree. */
function searchRoot(state: MockState, root: string | undefined): string | null {
  const id = (root ?? "").trim();
  if (id === "") return null;
  if (findLine(state, id).conversationBranch) throw new TangentError(404, `line ${id} not found`, "line_not_found");
  return id;
}

const QUERY_MIN = 2;
const QUERY_MAX = 200;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
/** Characters kept on each side of a message match (the server's snippets are about 120 long). */
const SNIPPET_CONTEXT = 60;
const SCORES = { title: 0.7, purpose: 0.65, message: 0.6 } as const;

/** About 120 characters around the match, "…" where cut, line breaks as spaces (B5). */
function snippetAround(text: string, at: number, length: number): { snippet: string; start: number } {
  const flat = text.replace(/[\n\t]/g, " ");
  const from = Math.max(0, at - SNIPPET_CONTEXT);
  const to = at + length + SNIPPET_CONTEXT;
  const head = from > 0 ? "…" : "";
  return { snippet: `${head}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`, start: at - from + head.length };
}

export function mockSearch(state: MockState, query: SearchQuery): SearchResult {
  const q = query.q.trim();
  const length = Array.from(q).length;
  if (length < QUERY_MIN) throw new TangentError(400, `the query needs at least ${QUERY_MIN} characters`, "invalid_input");
  if (length > QUERY_MAX) throw new TangentError(422, "the query is too long", "too_long", { field: "q", max: QUERY_MAX });
  const needle = q.toLowerCase();
  const archived = query.archived === true;
  const tree = searchRoot(state, query.root);
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  // Within one tree, archived or not (store searchTree); otherwise the main lines archived or not as asked.
  const rootOk = (rootId: string) => (tree !== null ? rootId === tree : Boolean(lineById.get(rootId)?.archivedAt) === archived);
  const hits: SearchHit[] = [];
  const match = (text: string) => text.toLowerCase().indexOf(needle);
  for (const line of state.lines) {
    const root = rootOf(line);
    if (!rootOk(root)) continue;
    const rootTitle = lineById.get(root)?.title ?? "";
    const purpose = line.conversationBranch?.purpose ?? "";
    const base = { lineId: line.id, rootLineId: root, rootTitle, purpose, at: line.lastActivityAt };
    const text = line.conversationBranch ? purpose : line.title;
    const at = match(text);
    if (at >= 0) hits.push({ ...base, kind: line.conversationBranch ? "purpose" : "title", snippet: text, highlights: [{ start: at, end: at + q.length }], score: SCORES[line.conversationBranch ? "purpose" : "title"] });
  }
  for (const message of state.messages) {
    if (message.kind !== "chat" || message.status !== "done" || (message.role !== "user" && message.role !== "assistant")) continue;
    const line = lineById.get(message.lineId);
    const at = match(message.content);
    if (!line || at < 0 || !rootOk(rootOf(line))) continue;
    const { snippet, start } = snippetAround(message.content, at, q.length);
    hits.push({
      kind: "message",
      lineId: line.id,
      rootLineId: rootOf(line),
      rootTitle: lineById.get(rootOf(line))?.title ?? "",
      purpose: line.conversationBranch?.purpose ?? "",
      messageId: message.id,
      seq: message.seq,
      role: message.role,
      snippet,
      highlights: [{ start, end: start + q.length }],
      score: SCORES.message,
      at: message.createdAt,
    });
  }
  const limit = Math.min(Math.max(query.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  const sorted = [...hits].sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return { query: q, hits: sorted.slice(0, limit) };
}
