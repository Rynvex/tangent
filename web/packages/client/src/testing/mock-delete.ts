/**
 * `DELETE /lines/{id}` in the mock (F7), as store.DeleteTree does it: only a
 * main line, never while any line of the tree is answering, and the whole
 * tree goes with every record that hangs on its lines (the server's
 * ON DELETE CASCADE), other trees' links to it included.
 */
import type { DeleteLineResult } from "../api-types";
import { TangentError } from "../errors";
import { findLine, rootOf, type MockState } from "./mock-store";

/** The keys of a record that are not in `gone`. */
function keep<T>(record: Readonly<Record<string, T>>, gone: ReadonlySet<string>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !gone.has(key)));
}

/** The state without the tree of `rootId`, and the deleted ids (the main line first). */
export function deleteTree(state: MockState, rootId: string): { state: MockState; result: DeleteLineResult } {
  const line = findLine(state, rootId);
  if (line.conversationBranch) throw new TangentError(409, "only a main line can be deleted", "branch_not_main_line");
  const lineIds = [rootId, ...state.lines.filter((item) => item.id !== rootId && rootOf(item) === rootId).map((item) => item.id)];
  const gone = new Set(lineIds);
  const answering = state.lines.some((item) => gone.has(item.id) && item.status === "thinking") || state.messages.some((message) => gone.has(message.lineId) && message.status === "pending");
  if (answering) throw new TangentError(409, "a turn is running in this conversation", "session_busy");
  const next: MockState = {
    ...state,
    lines: state.lines.filter((item) => !gone.has(item.id)),
    messages: state.messages.filter((message) => !gone.has(message.lineId)),
    branches: state.branches.filter((branch) => !gone.has(branch.lineId)),
    draftCards: keep(state.draftCards, gone),
    draftTips: keep(state.draftTips, gone),
    notesByRoot: keep(state.notesByRoot, gone),
    notesRevision: keep(state.notesRevision, gone),
    chaptersByLine: keep(state.chaptersByLine, gone),
    leaves: keep(state.leaves, gone),
    seeds: state.seeds.filter((seed) => !gone.has(seed.rootLineId)),
    memos: state.memos.filter((memo) => !gone.has(memo.rootLineId)),
    terms: state.terms.filter((term) => !gone.has(term.rootLineId)),
    importBaselines: keep(state.importBaselines, gone),
    suggestions: state.suggestions.filter((suggestion) => !gone.has(suggestion.rootLineId)),
    links: state.links.filter((link) => !gone.has(link.fromLineId) && !gone.has(link.toLineId)),
    groups: state.groups.filter((group) => !gone.has(group.rootLineId)),
    folds: state.folds.filter((fold) => !gone.has(fold.lineId)),
    comparisons: state.comparisons.filter((comparison) => !gone.has(comparison.rootLineId)),
    goals: keep(state.goals, gone),
    deltas: keep(state.deltas, gone),
  };
  return { state: next, result: { rootLineId: rootId, lineIds } };
}
