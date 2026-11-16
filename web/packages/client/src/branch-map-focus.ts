/**
 * Focus mode's map helpers (FOCUS_MODE.md §6.3, §8.4): which nodes stay
 * fully shown while a subtree is focused, and how many notes each node is
 * the source of. Keys are map keys: a branch's line id, MAP_ROOT_KEY for
 * the main line.
 */
import { MAP_ROOT_KEY, pathKeys } from "./branch-map-layout";
import type { BranchView, Note } from "./types";

/**
 * The map keys a focused subtree keeps lit: the focus node, everything under
 * it and the way from it up to the main line. Focusing the main line (or a
 * line the outline does not know) keeps the whole tree lit.
 */
export function focusScope(focusKey: string, branches: readonly BranchView[]): Set<string> {
  if (focusKey === MAP_ROOT_KEY || !branches.some((branch) => branch.lineId === focusKey)) {
    return new Set([MAP_ROOT_KEY, ...branches.map((branch) => branch.lineId)]);
  }
  return new Set([...pathKeys(focusKey, branches), ...subtreeKeys(focusKey, branches)]);
}

/** The focus node and everything under it (what the map fits when a subtree is focused); the whole tree for the main line. */
export function subtreeKeys(focusKey: string, branches: readonly BranchView[]): Set<string> {
  if (focusKey === MAP_ROOT_KEY) return new Set([MAP_ROOT_KEY, ...branches.map((branch) => branch.lineId)]);
  const children = new Map<string, string[]>();
  for (const branch of branches) children.set(branch.parentLineId, [...(children.get(branch.parentLineId) ?? []), branch.lineId]);
  const keys = new Set<string>([focusKey]);
  const queue = [...(children.get(focusKey) ?? [])];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (keys.has(key)) continue;
    keys.add(key);
    queue.push(...(children.get(key) ?? []));
  }
  return keys;
}

/**
 * Active notes per map key, by the line they came from (`sourceLineId`).
 * Notes from the main line count on the main line's node; notes without a
 * source, replaced ones and those of lines not on the map are left out.
 */
export function noteCountsByNode(notes: readonly Note[], rootLineId: string, branches: readonly BranchView[]): Map<string, number> {
  const known = new Set(branches.map((branch) => branch.lineId));
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (note.status === "superseded" || !note.sourceLineId) continue;
    const key = note.sourceLineId === rootLineId ? MAP_ROOT_KEY : note.sourceLineId;
    if (key !== MAP_ROOT_KEY && !known.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
