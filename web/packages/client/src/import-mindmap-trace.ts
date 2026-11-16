/**
 * F17 S3: the turn order drawn back over the mind map. The interleaved stretch
 * of a conversation (from the first to the last round of every node whose
 * rounds are not consecutive: #1–#6 when §1 holds #1 #3 #5 and a branch #2 #6)
 * is strung chip to chip in time order with dashed quadratic curves, each
 * with an arrow head and a 「n→n+1」 label at its middle. Curves bend to
 * alternate sides by growing amounts (decision #8), and labels are nudged
 * apart until no two boxes of LABEL_BOX touch (so no two centres are closer
 * than its height). Pure.
 */

export interface MindMapTracePath {
  from: number;
  to: number;
  /** `M ax ay Q cx cy ex ey`, ending short of the target chip for the arrow head. */
  d: string;
  head: string;
}

export interface MindMapTraceLabel {
  from: number;
  to: number;
  x: number;
  y: number;
  text: string;
}

export interface MindMapTrace {
  /** The interleaved stretch [first, last] (#1→#6), or null when no node's rounds are interleaved. */
  range: readonly [number, number] | null;
  paths: MindMapTracePath[];
  labels: MindMapTraceLabel[];
}

/** The room a label keeps around its centre: 「10→11」 is about 42 wide and 18 high, plus a gap. */
export const LABEL_BOX = { width: 48, height: 24 } as const;
/** So no two labels' centres are closer than this. */
export const LABEL_MIN_DISTANCE = LABEL_BOX.height;
/** The first bend, how much it grows every second curve, and after how many steps it starts over. */
const BEND_BASE = 40;
const BEND_STEP = 16;
const BEND_CYCLE = 4;
/** How far short of the target chip a curve ends, and the arrow head's length and half width. */
const END_SHORT = 13;
const HEAD_LENGTH = 7;
const HEAD_HALF = 4.5;
/** Nudging: the step along the curve's normal, and how many tries before falling back to moving down. */
const NUDGE_STEP = 8;
const NUDGE_TRIES = 8;

const n1 = (value: number) => Math.round(value * 10) / 10;

interface Point {
  x: number;
  y: number;
}

/** Whether a node's rounds skip any round (#1 #3 #5): it was interleaved with another (its chapter says 「跨段整合」). */
export const isInterleaved = (turns: readonly number[]): boolean => {
  const sorted = [...turns].sort((a, b) => a - b);
  return sorted.some((turn, index) => index > 0 && turn !== sorted[index - 1]! + 1);
};

/** The interleaved stretch of the nodes' rounds, or null. */
export function traceRange(nodes: ReadonlyArray<{ turns: readonly number[] }>): readonly [number, number] | null {
  const turns = nodes.filter((node) => isInterleaved(node.turns)).flatMap((node) => node.turns);
  return turns.length === 0 ? null : [Math.min(...turns), Math.max(...turns)];
}

/** The `index`-th curve's bend: alternate sides, growing every second curve, starting over after a few. */
export const traceBend = (index: number): number => (index % 2 ? -1 : 1) * (BEND_BASE + (Math.floor(index / 2) % BEND_CYCLE) * BEND_STEP);

function segment(index: number, from: number, to: number, a: Point, b: Point): { path: MindMapTracePath; mid: Point; normal: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const off = traceBend(index);
  const c = { x: (a.x + b.x) / 2 - (dy / length) * off, y: (a.y + b.y) / 2 + (dx / length) * off };
  const toEnd = { x: b.x - c.x, y: b.y - c.y };
  const toEndLength = Math.hypot(toEnd.x, toEnd.y) || 1;
  const u = { x: toEnd.x / toEndLength, y: toEnd.y / toEndLength };
  const e = { x: b.x - u.x * END_SHORT, y: b.y - u.y * END_SHORT };
  const head = `M ${n1(e.x + u.x * 2)} ${n1(e.y + u.y * 2)} L ${n1(e.x - u.x * HEAD_LENGTH - u.y * HEAD_HALF)} ${n1(e.y - u.y * HEAD_LENGTH + u.x * HEAD_HALF)} L ${n1(e.x - u.x * HEAD_LENGTH + u.y * HEAD_HALF)} ${n1(e.y - u.y * HEAD_LENGTH - u.x * HEAD_HALF)} Z`;
  return {
    path: { from, to, d: `M ${n1(a.x)} ${n1(a.y)} Q ${n1(c.x)} ${n1(c.y)} ${n1(e.x)} ${n1(e.y)}`, head },
    mid: { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y },
    normal: { x: -dy / length, y: dx / length },
  };
}

const clear = (point: Point, placed: readonly Point[]) => placed.every((other) => Math.abs(other.x - point.x) >= LABEL_BOX.width || Math.abs(other.y - point.y) >= LABEL_BOX.height);

/**
 * Where a label goes: its curve's middle, else pushed along the curve's normal (both ways, further each try), else
 * down until clear. Moving down always ends: each placed label blocks less than two steps of the box's height.
 */
export function placeLabel(mid: Point, normal: Point, placed: readonly Point[]): Point {
  if (clear(mid, placed)) return mid;
  for (let k = 1; k <= NUDGE_TRIES; k += 1) {
    for (const sign of [1, -1]) {
      const candidate = { x: mid.x + normal.x * NUDGE_STEP * k * sign, y: mid.y + normal.y * NUDGE_STEP * k * sign };
      if (clear(candidate, placed)) return candidate;
    }
  }
  let candidate = mid;
  while (!clear(candidate, placed)) candidate = { x: candidate.x, y: candidate.y + LABEL_BOX.height };
  return candidate;
}

/** The turn order over the chips (see the file comment); `turnNode` says which node holds each round. */
export function buildMindMapTrace(nodes: ReadonlyArray<{ turns: readonly number[] }>, chips: ReadonlyMap<number, Point>, turnNode: ReadonlyMap<number, string>): MindMapTrace {
  const range = traceRange(nodes);
  if (!range) return { range: null, paths: [], labels: [] };
  const paths: MindMapTracePath[] = [];
  const labels: MindMapTraceLabel[] = [];
  for (let turn = range[0]; turn < range[1]; turn += 1) {
    const a = chips.get(turn);
    const b = chips.get(turn + 1);
    const fromNode = turnNode.get(turn);
    const toNode = turnNode.get(turn + 1);
    if (!a || !b || !fromNode || !toNode || fromNode === toNode) continue;
    const { path, mid, normal } = segment(paths.length, turn, turn + 1, a, b);
    const at = placeLabel(mid, normal, labels);
    paths.push(path);
    labels.push({ from: turn, to: turn + 1, x: n1(at.x), y: n1(at.y), text: `${turn}→${turn + 1}` });
  }
  return { range, paths, labels };
}
