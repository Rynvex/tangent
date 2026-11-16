/**
 * Geometry of the map's relation layer (C3): where a relation's curve runs
 * between two nodes, which node a point is over, and the candidate ends in
 * keyboard order (nearest first). Layout pixels, before zoom.
 */
import type { MapNode } from "@tangent/client";

export interface Point {
  x: number;
  y: number;
}

/** How far a relation bows out to the right of the nodes it joins (so it never runs through the tree's own edges). */
const BOW = 56;
/** Room the layer needs right of the layout for that bow and its notes. */
export const RELATION_ROOM = BOW + 120;

const rightMid = (node: MapNode): Point => ({ x: node.x + node.width, y: node.y + node.height / 2 });
const leftMid = (node: MapNode): Point => ({ x: node.x, y: node.y + node.height / 2 });

function bezierMid(p0: Point, p1: Point, p2: Point, p3: Point): Point {
  return { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 };
}

/**
 * The curve from `a` to `b`: from a's right edge into b's left edge when b
 * is in a later column, else bowing out right of both right edges (a
 * bracket, like XMind's). Returns the SVG path and its midpoint (the note).
 */
export function relationCurve(a: MapNode, b: MapNode): { d: string; mid: Point } {
  const start = rightMid(a);
  if (b.x > a.x + a.width) {
    const end = leftMid(b);
    const dx = (end.x - start.x) / 2;
    const c1 = { x: start.x + dx, y: start.y };
    const c2 = { x: end.x - dx, y: end.y };
    return { d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, mid: bezierMid(start, c1, c2, end) };
  }
  const end = rightMid(b);
  const out = Math.max(start.x, end.x) + BOW;
  const c1 = { x: out, y: start.y };
  const c2 = { x: out, y: end.y };
  return { d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, mid: bezierMid(start, c1, c2, end) };
}

/** A straight dragged line from a's dot to the pointer. */
export function dragLine(a: MapNode, to: Point): string {
  const start = rightMid(a);
  return `M ${start.x} ${start.y} L ${to.x} ${to.y}`;
}

/** The node under a point, if any. */
export function nodeAt(nodes: readonly MapNode[], point: Point): MapNode | null {
  return nodes.find((node) => point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height) ?? null;
}

/** Every node that may be the other end of a relation from `from` (not itself, not one already related), nearest first. */
export function candidateKeys(nodes: readonly MapNode[], from: string, related: ReadonlySet<string>): string[] {
  const source = nodes.find((node) => node.key === from);
  if (!source) return [];
  const distance = (node: MapNode) => Math.hypot(node.x - source.x, node.y - source.y);
  return nodes
    .filter((node) => node.key !== from && !related.has(node.key))
    .sort((a, b) => distance(a) - distance(b) || a.y - b.y)
    .map((node) => node.key);
}
