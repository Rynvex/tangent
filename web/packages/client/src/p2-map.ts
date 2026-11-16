/**
 * The relation layer's pure logic (C3): which relations the branch map can
 * draw and whether two ends are already related. Kept apart from `p2.ts`,
 * which the always-loaded conversation uses, so the map layout stays lazy.
 */
import { MAP_ROOT_KEY } from "./branch-map-layout";
import type { FisheyeLevel, FisheyeReport } from "./fisheye";
import type { Group } from "./group-routes";
import type { Link } from "./types";

/** One end of a relation: a line, or a message of it. */
export interface RelationEnd {
  lineId: string;
  messageId?: string;
}

/** Whether `link` joins these two ends, in either direction (the server allows one relation per pair). */
export function sameRelationEnds(link: Pick<Link, "fromLineId" | "fromMessageId" | "toLineId" | "toMessageId">, a: RelationEnd, b: RelationEnd): boolean {
  const key = (lineId: string, messageId = "") => `${lineId}/${messageId}`;
  const from = key(link.fromLineId, link.fromMessageId);
  const to = key(link.toLineId, link.toMessageId);
  const x = key(a.lineId, a.messageId);
  const y = key(b.lineId, b.messageId);
  return (from === x && to === y) || (from === y && to === x);
}

export interface DrawnRelation {
  relation: Link;
  /** Map node keys (`MAP_ROOT_KEY` for the main line). */
  from: string;
  to: string;
}

/**
 * The relations the map can draw (both ends are nodes of this tree's map; a
 * message end sits on its line's node) and the rest, which reach another
 * conversation or a folded or hidden line and are listed instead.
 */
export function relationsOnMap(relations: readonly Link[], rootLineId: string, nodeKeys: ReadonlySet<string>): { drawn: DrawnRelation[]; elsewhere: Link[] } {
  const keyOf = (lineId: string) => (lineId === rootLineId ? MAP_ROOT_KEY : lineId);
  const drawn: DrawnRelation[] = [];
  const elsewhere: Link[] = [];
  for (const relation of relations) {
    const from = keyOf(relation.fromLineId);
    const to = keyOf(relation.toLineId);
    if (nodeKeys.has(from) && nodeKeys.has(to) && from !== to) drawn.push({ relation, from, to });
    else elsewhere.push(relation);
  }
  return { drawn, elsewhere };
}


/** Where the line on screen sits, for `mapFisheyeLevels`. */
export interface FisheyeMapContext {
  rootLineId: string;
  currentLineId: string;
  /** The current line's ancestors (the root included): their background reaches the model whole. */
  ancestors: readonly string[];
  /** The map's node keys (`MAP_ROOT_KEY` for the main line). */
  nodeKeys: Iterable<string>;
  /** The tree's groups: a group's item (C2) gives its level to each member. */
  groups?: readonly Group[];
}

/**
 * Each map node's fisheye level (C1, the map's 魚眼 layer): the line on
 * screen and its ancestors are sent whole (the report leaves them out), a
 * listed branch is what the report says, a member of a listed group what
 * the group's item says, any other branch is not seen.
 */
export function mapFisheyeLevels(report: FisheyeReport, context: FisheyeMapContext): Map<string, FisheyeLevel> {
  const lineOf = (key: string) => (key === MAP_ROOT_KEY ? context.rootLineId : key);
  const whole = new Set([context.currentLineId, ...context.ancestors]);
  const branches = new Map(report.items.filter((item) => item.kind === "branch").map((item) => [item.lineId || item.id, item.level]));
  for (const item of report.items) {
    if (item.kind !== "group") continue;
    const group = context.groups?.find((entry) => entry.id === item.id);
    for (const lineId of group?.memberLineIds ?? []) branches.set(lineId, item.level);
  }
  return new Map(
    [...context.nodeKeys].map((key) => {
      const lineId = lineOf(key);
      return [key, whole.has(lineId) ? "full" : (branches.get(lineId) ?? "hidden")];
    }),
  );
}
