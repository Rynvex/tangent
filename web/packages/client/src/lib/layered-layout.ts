/**
 * Generic layered-layout core of the conversation map: callers decide each node's `depth` (column) and `row`; this module turns
 * them into pixel boxes, bezier edge paths and the canvas size.
 */
export type LayoutDirection = "horizontal" | "vertical";

export interface LayoutMetrics {
  cardWidth: number;
  cardHeight: number;
  /** Distance between depth columns (rows when vertical). */
  columnStep: number;
  /** Distance between rows (columns when vertical). */
  rowStep: number;
  padding: number;
}

export interface Slot {
  key: string;
  depth: number;
  /** May be fractional so a parent can sit centred over its children. */
  row: number;
}

export interface PlacedNode extends Slot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Horizontal distance of the bezier control points from each card edge. */
const EDGE_CURVE_OFFSET = 25;

export function placeSlots(
  slots: readonly Slot[],
  direction: LayoutDirection,
  m: LayoutMetrics,
): { nodes: PlacedNode[]; width: number; height: number } {
  const horizontal = direction === "horizontal";
  const nodes = slots.map((slot) => ({
    ...slot,
    x: m.padding + (horizontal ? slot.depth * m.columnStep : slot.row * m.rowStep),
    y: m.padding + (horizontal ? slot.row * m.rowStep : slot.depth * m.columnStep),
    width: m.cardWidth,
    height: m.cardHeight,
  }));
  const maxDepth = slots.reduce((max, s) => Math.max(max, s.depth), 0);
  const maxRow = slots.reduce((max, s) => Math.max(max, s.row), 0);
  const depthExtent = (maxDepth + 1) * m.columnStep;
  const rowExtent = (maxRow + 1) * m.rowStep;
  return {
    nodes,
    width: m.padding * 2 + (horizontal ? depthExtent : rowExtent),
    height: m.padding * 2 + (horizontal ? rowExtent : depthExtent),
  };
}

/** Bezier path from the trailing edge of `from` to the leading edge of `to`. */
export function edgePath(from: PlacedNode, to: PlacedNode, direction: LayoutDirection): string {
  const horizontal = direction === "horizontal";
  const x1 = horizontal ? from.x + from.width : from.x + from.width / 2;
  const y1 = horizontal ? from.y + from.height / 2 : from.y + from.height;
  const x2 = horizontal ? to.x : to.x + to.width / 2;
  const y2 = horizontal ? to.y + to.height / 2 : to.y;
  return horizontal
    ? `M ${x1} ${y1} C ${x1 + EDGE_CURVE_OFFSET} ${y1}, ${x2 - EDGE_CURVE_OFFSET} ${y2}, ${x2} ${y2}`
    : `M ${x1} ${y1} C ${x1} ${y1 + EDGE_CURVE_OFFSET}, ${x2} ${y2 - EDGE_CURVE_OFFSET}, ${x2} ${y2}`;
}
