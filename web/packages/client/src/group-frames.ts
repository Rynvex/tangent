/**
 * Geometry of the map's group layer (C2, XMind's 外框 + 摘要): a frame
 * around each active group's visible members, a bracket on its right, and
 * the shared summary in a column right of the tree, level with the frame
 * (stacked when two would overlap). Layout pixels, before zoom.
 */
import type { MapLayout, MapNode } from "./branch-map-layout";
import type { Group } from "./group-routes";

/** Space between a frame and the nodes it surrounds. */
const FRAME_PAD = 6;
/** The bracket's reach right of the frame (its tip). */
const BRACKET_REACH = 14;
/** Gap between the tree (or the relation layer's room) and the summaries. */
const COLUMN_GAP = 16;
const BOX_GAP = 8;
/** One summary box on the map. */
export const GROUP_BOX = { width: 176, height: 92 } as const;
/** Room the layer needs right of the layout. */
export const GROUP_ROOM = COLUMN_GAP + GROUP_BOX.width + 8;

export interface GroupFrame {
  groupId: string;
  group: Group;
  /** The members on the map now, in the group's order. */
  members: string[];
  /** Members folded away (or not on the map). */
  hidden: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The bracket right of the frame, as an SVG path. */
  bracket: string;
  /** From the bracket's tip to the summary box. */
  connector: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface GroupFrames {
  frames: GroupFrame[];
  /** The map's height with the summaries in it. */
  height: number;
  /** The width the layer adds right of the layout (0 without frames). */
  room: number;
}

function bounds(nodes: readonly MapNode[]) {
  const left = Math.min(...nodes.map((node) => node.x)) - FRAME_PAD;
  const top = Math.min(...nodes.map((node) => node.y)) - FRAME_PAD;
  const right = Math.max(...nodes.map((node) => node.x + node.width)) + FRAME_PAD;
  const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + FRAME_PAD;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A curly bracket (XMind's summary) from the frame's top right to its bottom right, its tip at the middle. */
function bracketPath(right: number, top: number, bottom: number): string {
  const mid = (top + bottom) / 2;
  const arm = right + BRACKET_REACH / 2;
  const tip = right + BRACKET_REACH;
  const bend = Math.min(6, (bottom - top) / 4);
  return [
    `M ${right} ${top}`,
    `Q ${arm} ${top} ${arm} ${top + bend}`,
    `L ${arm} ${mid - bend}`,
    `Q ${arm} ${mid} ${tip} ${mid}`,
    `Q ${arm} ${mid} ${arm} ${mid + bend}`,
    `L ${arm} ${bottom - bend}`,
    `Q ${arm} ${bottom} ${right} ${bottom}`,
  ].join(" ");
}

export function groupFrames(layout: MapLayout, groups: readonly Group[], options: { offsetX?: number } = {}): GroupFrames {
  const boxX = layout.width + (options.offsetX ?? 0) + COLUMN_GAP;
  const placed = groups
    .filter((group) => group.status === "active")
    .flatMap((group) => {
      const nodes = group.memberLineIds.flatMap((lineId) => layout.byKey.get(lineId) ?? []);
      if (nodes.length === 0) return [];
      return [{ group, nodes, frame: bounds(nodes) }];
    })
    .sort((a, b) => a.frame.y + a.frame.height / 2 - (b.frame.y + b.frame.height / 2));
  let floor = 0;
  const frames = placed.map(({ group, nodes, frame }) => {
    const mid = frame.y + frame.height / 2;
    const boxY = Math.max(floor, mid - GROUP_BOX.height / 2);
    floor = boxY + GROUP_BOX.height + BOX_GAP;
    const right = frame.x + frame.width;
    const tip = right + BRACKET_REACH;
    const boxMid = boxY + GROUP_BOX.height / 2;
    return {
      groupId: group.id,
      group,
      members: nodes.map((node) => node.key),
      hidden: group.memberLineIds.length - nodes.length,
      ...frame,
      bracket: bracketPath(right, frame.y, frame.y + frame.height),
      connector: `M ${tip} ${mid} C ${(tip + boxX) / 2} ${mid}, ${(tip + boxX) / 2} ${boxMid}, ${boxX} ${boxMid}`,
      box: { x: boxX, y: boxY, ...GROUP_BOX },
    };
  });
  const lowest = frames.reduce((max, frame) => Math.max(max, frame.box.y + frame.box.height + BOX_GAP), 0);
  return { frames, height: Math.max(layout.height, lowest), room: frames.length > 0 ? GROUP_ROOM : 0 };
}
