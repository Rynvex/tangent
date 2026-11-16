import { describe, expect, it } from "vitest";
import type { ImportAnalyzePlan } from "./import-analyze";
import { expandSessionsToTurnUnits, turnKey } from "./import-analyze-apply";
import { analyzeImportLocal } from "./import-analyze-local";
import { moveUnitBetweenNodes } from "./import-analyze-move";
import type { NodeRole } from "./import-assembly";
import { reanchorFork, reanchorMovedForks } from "./import-mindmap-fork";
import { LABEL_BOX } from "./import-mindmap-trace";
import { MINDMAP_ROUNDS, mindmapConversation } from "./import-mindmap-fixtures";
import { buildImportMindMapLayout, MINDMAP_METRICS, type ImportMindMapInput, type ImportMindMapLayout, type ImportMindMapNodeInput, type MindMapRect } from "./import-mindmap-layout";
import { extractSessionRounds } from "./import-mindmap-rounds";
import { parseImport } from "./import-parsers";
import type { TimelineSession } from "./import-timeline";

/** A fork pill's room (its text is at most 「自 §12 的 #120 後分岔」 or 「分岔點已移動」). */
const PILL = { width: 170, height: 20 };

/** The design's nine rounds as one picked session. */
function nineRounds(): TimelineSession {
  const parsed = parseImport(JSON.stringify(mindmapConversation()), { fileName: "雜談.json" });
  if (!parsed.ok) throw new Error(parsed.error);
  return { key: "s1", conversation: parsed.value.conversations[0]!, source: parsed.value.source, fileName: "雜談.json", pickOrder: 0 };
}

/** The built-in analysis of the nine rounds (the same rules as the server's). */
function ninePlan(): { plan: ImportAnalyzePlan; units: ReturnType<typeof expandSessionsToTurnUnits>["units"] } {
  const { units } = expandSessionsToTurnUnits([nineRounds()]);
  return { plan: analyzeImportLocal({ units }), units };
}

const turnOf = (key: string) => Number(key.split("#turn-")[1]);

/** A plan as the mind map's input: rounds numbered by their unit, branches on their chapter after their round. */
function inputOf(plan: ImportAnalyzePlan, moved: readonly string[] = []): ImportMindMapInput {
  return {
    nodes: plan.nodes.map((node) => ({
      key: node.key,
      role: node.role,
      turns: node.unitKeys.map(turnOf),
      attachTo: node.attachToKey ?? null,
      forkTurn: node.attachAfterUnitKey ? turnOf(node.attachAfterUnitKey) : null,
      forkMoved: moved.includes(node.key),
    })),
  };
}

/** Every box of a layout: the root, the nodes and the fork pills. */
function boxes(layout: ImportMindMapLayout): Array<{ name: string; rect: MindMapRect }> {
  return [
    ...(layout.root ? [{ name: "root", rect: layout.root }] : []),
    ...layout.nodes.map((node) => ({ name: node.key, rect: node.rect })),
    ...layout.nodes.flatMap((node) => (node.fork ? [{ name: `fork ${node.key}`, rect: { x: node.fork.x, y: node.fork.y, ...PILL } }] : [])),
  ];
}

const overlaps = (a: MindMapRect, b: MindMapRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function expectNoOverlap(layout: ImportMindMapLayout): void {
  const all = boxes(layout);
  const clashes = all.flatMap((a, i) => all.slice(i + 1).flatMap((b) => (overlaps(a.rect, b.rect) ? [`${a.name} × ${b.name}`] : [])));
  expect(clashes).toEqual([]);
  for (const { rect } of all) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
  }
}

/** Whether any two labels' boxes overlap. */
function labelsTouch(layout: ImportMindMapLayout): boolean {
  const { labels } = layout.trace;
  return labels.some((a, i) => labels.slice(i + 1).some((b) => Math.abs(a.x - b.x) < LABEL_BOX.width - 0.2 && Math.abs(a.y - b.y) < LABEL_BOX.height - 0.2));
}

function minLabelDistance(layout: ImportMindMapLayout): number {
  const { labels } = layout.trace;
  let min = Number.POSITIVE_INFINITY;
  labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => (min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y)))));
  return min;
}

/** A deterministic pseudo-random sequence (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `rounds` rounds dealt over chapters, branches and separate conversations at random, interleaved like a chat that wanders. */
function denseInput(rounds: number, seed: number): ImportMindMapInput {
  const next = random(seed);
  const chapters = 2 + Math.floor(next() * 3);
  const branches = 3 + Math.floor(next() * 6);
  const separate = 1 + Math.floor(next() * 3);
  const keys = [...Array.from({ length: chapters }, (_, i) => `c${i}`), ...Array.from({ length: branches }, (_, i) => `b${i}`), ...Array.from({ length: separate }, (_, i) => `s${i}`)];
  const turns = new Map(keys.map((key) => [key, [] as number[]]));
  // Every node gets a round first, then the rest are dealt at random.
  for (let turn = 1; turn <= rounds; turn += 1) turns.get(turn <= keys.length ? keys[turn - 1]! : keys[Math.floor(next() * keys.length)]!)!.push(turn);
  const roleOf = (key: string): NodeRole => (key.startsWith("c") ? "chapter" : key.startsWith("b") ? (next() < 0.7 ? "merged_branch" : "open_branch") : "standalone");
  const nodes = keys.map((key): ImportMindMapNodeInput => {
    const role = roleOf(key);
    const host = `c${Math.floor(next() * chapters)}`;
    const hostTurns = turns.get(host)!;
    return { key, role, turns: turns.get(key)!, ...(role !== "chapter" && role !== "standalone" ? { attachTo: host, forkTurn: hostTurns[Math.floor(next() * hostTurns.length)] ?? null } : {}) };
  });
  return { nodes: [...nodes].sort((a, b) => Math.min(...a.turns) - Math.min(...b.turns)) };
}

describe("the nine-round example (decision #1)", () => {
  it("is analyzed by the built-in rules into §1 #1 #3 #5, two branches on §1, a separate #7 and §2 #8 #9", () => {
    // Act
    const { plan } = ninePlan();
    // Assert
    expect(plan.nodes.map((node) => ({ turns: node.unitKeys.map(turnOf), role: node.role, on: node.attachToKey ? turnOf(node.attachToKey) : null, after: node.attachAfterUnitKey ? turnOf(node.attachAfterUnitKey) : null }))).toEqual([
      { turns: [1, 3, 5], role: "chapter", on: null, after: null },
      { turns: [2, 6], role: "merged_branch", on: 1, after: 1 },
      { turns: [4], role: "merged_branch", on: 1, after: 3 },
      { turns: [7], role: "standalone", on: null, after: null },
      { turns: [8, 9], role: "chapter", on: null, after: null },
    ]);
  });

  it("lays the nodes out at the design's sizes and columns, none overlapping, the lane under the tree", () => {
    // Arrange
    const { plan } = ninePlan();
    // Act
    const layout = buildImportMindMapLayout(inputOf(plan));
    // Assert
    const [s1, b, c, s2, solo] = [turnKey("s1", 1), turnKey("s1", 2), turnKey("s1", 4), turnKey("s1", 8), turnKey("s1", 7)].map((key) => layout.nodes.find((node) => node.key === key)!);
    expect(layout.width).toBe(860);
    expect(layout.root).toEqual({ x: 24, y: expect.any(Number), width: 196, height: 148 });
    expect([s1!.rect, s2!.rect].map((rect) => [rect.x, rect.width, rect.height])).toEqual([[270, 240, 114], [270, 240, 114]]);
    expect([b!.rect, c!.rect].map((rect) => [rect.x, rect.width, rect.height])).toEqual([[600, 252, 140], [600, 252, 140]]);
    expect([solo!.rect.x, solo!.rect.width, solo!.rect.height]).toEqual([270, 240, 86]);
    expect([s1!.chapter, s2!.chapter, b!.parentKey, c!.parentKey]).toEqual([1, 2, s1!.key, s1!.key]);
    expect(s2!.rect.y - (s1!.rect.y + 114)).toBeGreaterThanOrEqual(MINDMAP_METRICS.chapter.gapY);
    expect(c!.rect.y - (b!.rect.y + 140)).toBe(MINDMAP_METRICS.branch.gapY);
    expect(b!.fork).toEqual({ x: 600, y: b!.rect.y - 24, turn: 1, moved: false });
    expect(c!.fork).toMatchObject({ turn: 3, moved: false });
    expect(layout.lane.y).toBeGreaterThanOrEqual(462);
    expect(solo!.rect.y).toBe(layout.lane.y + 28);
    // The root sits between the first and the last chapter.
    expect(layout.root!.y + 74).toBe((s1!.rect.y + s2!.rect.y) / 2 + 57);
    expectNoOverlap(layout);
  });

  it("puts the chips after 「跨段整合」 on a stitched chapter and draws the root, trunk and branch curves", () => {
    const { plan } = ninePlan();
    const layout = buildImportMindMapLayout(inputOf(plan));
    const s1 = layout.nodes[0]!;
    expect(s1.stitched).toBe(true);
    // Border 1.5 + padding 12 + the 96 badge + 4, then each chip's centre 14 in, 32 apart.
    expect(s1.chips.map((chip) => [chip.turn, chip.x, chip.y])).toEqual([1, 3, 5].map((turn, i) => [turn, 270 + 13.5 + 100 + i * 32 + 14, s1.rect.y + 11.5 + 74 + 10]));
    // §2's #8 #9 come one after the other: nothing was stitched.
    expect(layout.nodes.find((node) => node.chapter === 2)!.stitched).toBe(false);
    expect(layout.chipCenters.get(6)).toEqual({ x: 600 + 13.5 + 32 + 14, y: layout.nodes[1]!.rect.y + 11.5 + 70 + 10 });
    const kinds = layout.edges.map((edge) => edge.kind);
    expect(kinds).toEqual(["root-to-chapter", "root-to-chapter", "chapter-spine", "chapter-to-branch", "chapter-to-branch"]);
    const rootMid = layout.root!.y + 74;
    expect(layout.edges[0]!.d).toBe(`M 220 ${rootMid} C 245 ${rootMid}, 245 ${s1.rect.y + 57}, 270 ${s1.rect.y + 57}`);
    expect(layout.edges[2]!.d).toMatch(/^M 390 [\d.]+ L 390 [\d.]+$/);
    expect(layout.edges[2]!.head).toMatch(/^M 384 [\d.]+ L 390 [\d.]+ L 396 [\d.]+$/);
    expect(layout.edges[3]!.d).toMatch(/^M 510 [\d.]+ C 555 [\d.]+, 555 [\d.]+, 600 [\d.]+$/);
  });

  it("traces #1→#6 with five labelled curves whose labels never crowd each other", () => {
    const { plan } = ninePlan();
    const layout = buildImportMindMapLayout(inputOf(plan));
    expect(layout.trace.range).toEqual([1, 6]);
    expect(layout.trace.labels.map((label) => label.text)).toEqual(["1→2", "2→3", "3→4", "4→5", "5→6"]);
    expect(layout.trace.paths).toHaveLength(5);
    for (const path of layout.trace.paths) {
      expect(path.d).toMatch(/^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
      expect(path.head).toMatch(/^M .+ L .+ L .+ Z$/);
    }
    expect(layout.trace.paths[0]!.d.startsWith(`M ${layout.chipCenters.get(1)!.x} ${layout.chipCenters.get(1)!.y} Q`)).toBe(true);
    expect(minLabelDistance(layout)).toBeGreaterThanOrEqual(22);
  });
});

describe("a moved fork round (decision #6)", () => {
  it("re-anchors a branch after the chapter's round before it, and flags it", () => {
    // Arrange: C forks after #3; #3 is moved into Firebase's branch.
    const { plan, units } = ninePlan();
    const after = moveUnitBetweenNodes(plan, turnKey("s1", 3), turnKey("s1", 2), { units });
    // Act
    const { plan: fixed, moved } = reanchorMovedForks(plan, after, turnKey("s1", 3), units);
    // Assert
    const c = fixed.nodes.find((node) => node.key === turnKey("s1", 4))!;
    expect(moved).toEqual([turnKey("s1", 4)]);
    expect(c.attachToKey).toBe(turnKey("s1", 1));
    expect(c.attachAfterUnitKey).toBe(turnKey("s1", 1));
    const layout = buildImportMindMapLayout(inputOf(fixed, moved));
    expect(layout.nodes.find((node) => node.key === c.key)!.fork).toMatchObject({ turn: 1, moved: true });
    expect(layout.nodes.find((node) => node.key === turnKey("s1", 2))!.fork).toMatchObject({ turn: 1, moved: false });
  });

  it("re-anchors on the chapter's first round when no round came before, even when the chapter's key changes", () => {
    const { plan, units } = ninePlan();
    const after = moveUnitBetweenNodes(plan, turnKey("s1", 1), turnKey("s1", 8), { units });
    const { plan: fixed, moved } = reanchorMovedForks(plan, after, turnKey("s1", 1), units);
    const b = fixed.nodes.find((node) => node.key === turnKey("s1", 2))!;
    expect(moved).toContain(turnKey("s1", 2));
    expect(b.attachToKey).toBe(turnKey("s1", 3));
    expect(b.attachAfterUnitKey).toBe(turnKey("s1", 3));
  });

  it("leaves a plan alone when the moved round was nobody's fork", () => {
    const { plan, units } = ninePlan();
    const after = moveUnitBetweenNodes(plan, turnKey("s1", 5), "new_standalone", { units });
    expect(reanchorMovedForks(plan, after, turnKey("s1", 5), units)).toEqual({ plan: after, moved: [] });
  });

  it("picks the round before, else the first, else none", () => {
    expect(reanchorFork([1, 5], 3)).toBe(1);
    expect(reanchorFork([5, 9], 3)).toBe(5);
    expect(reanchorFork([], 3)).toBeNull();
  });
});

describe("larger and other inputs", () => {
  it.each([30, 41, 52, 60])("never overlaps nodes nor crowds labels for %i interleaved rounds", (rounds) => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const layout = buildImportMindMapLayout(denseInput(rounds, seed * 7919 + rounds));
      expectNoOverlap(layout);
      expect(layout.trace.labels.length).toBeGreaterThan(0);
      expect(minLabelDistance(layout)).toBeGreaterThanOrEqual(22);
      expect(labelsTouch(layout)).toBe(false);
      for (const label of layout.trace.labels) expect(label.y + 9).toBeLessThanOrEqual(layout.height);
      // Every chip sits on its node.
      for (const node of layout.nodes) for (const chip of node.chips) expect(overlaps({ x: chip.x, y: chip.y, width: 0.1, height: 0.1 }, node.rect)).toBe(true);
    }
  });

  it("folds the rounds that do not fit into a last 「+k」 chip, where the trace finds them", () => {
    const turns = Array.from({ length: 12 }, (_, i) => i * 2 + 1);
    const layout = buildImportMindMapLayout({ nodes: [{ key: "a", role: "chapter", turns }, { key: "b", role: "merged_branch", turns: turns.map((turn) => turn + 1), attachTo: "a", forkTurn: 1 }] });
    const [a] = layout.nodes;
    const last = a!.chips.at(-1)!;
    expect(a!.chips).toHaveLength(3);
    expect(last.turn).toBeNull();
    expect(last.hidden).toEqual(turns.slice(2));
    expect(layout.chipCenters.get(23)).toEqual({ x: last.x, y: last.y });
    expect(last.x + 14).toBeLessThanOrEqual(a!.rect.x + a!.rect.width);
  });

  it("hangs a branch whose chapter is unknown on the closest chapter before it, flagged", () => {
    const layout = buildImportMindMapLayout({ nodes: [{ key: "a", role: "chapter", turns: [] }, { key: "z", role: "chapter", turns: [] }, { key: "b", role: "open_branch", turns: [], attachTo: "gone" }] });
    expect(layout.nodes.find((node) => node.key === "b")).toMatchObject({ parentKey: "z", orphan: true, fork: { turn: null, moved: false } });
  });

  it("puts every conversation of a batch in the lane, three to a row, with no main line", () => {
    const nodes = Array.from({ length: 7 }, (_, i): ImportMindMapNodeInput => ({ key: `k${i}`, role: i === 0 ? "chapter" : "standalone", turns: [] }));
    const layout = buildImportMindMapLayout({ nodes, mode: "batch" });
    expect(layout.root).toBeNull();
    expect(layout.edges).toEqual([]);
    expect(layout.nodes.slice(0, 4).map((node) => [node.rect.x, node.rect.y])).toEqual([[24, 36], [288, 36], [552, 36], [24, 138]]);
    expectNoOverlap(layout);
  });

  it("lays out 120 conversations (the F16.1 scale) in a timeline and in a tree without overlaps", () => {
    const timeline = Array.from({ length: 120 }, (_, i): ImportMindMapNodeInput => ({ key: `t${i}`, role: i % 9 === 8 ? "standalone" : "chapter", turns: [] }));
    const started = performance.now();
    const flat = buildImportMindMapLayout({ nodes: timeline, mode: "timeline" });
    const tree = buildImportMindMapLayout({ nodes: timeline.map((node, i) => (i % 3 === 1 ? { ...node, role: "merged_branch" as const, attachTo: `t${i - 1}` } : node)), mode: "tree" });
    expect(performance.now() - started).toBeLessThan(500);
    expectNoOverlap(flat);
    expectNoOverlap(tree);
    expect(flat.nodes.filter((node) => node.kind === "chapter")).toHaveLength(107);
    expect(tree.edges.filter((edge) => edge.kind === "chapter-to-branch").length).toBeGreaterThan(30);
  });
});

describe("a session's rounds", () => {
  it("lists every question and answer with its time and the reply a branch would hang after", () => {
    const rounds = extractSessionRounds(nineRounds());
    expect(rounds).toHaveLength(9);
    expect(rounds[4]).toMatchObject({ n: 5, question: MINDMAP_ROUNDS[4]![0], answer: MINDMAP_ROUNDS[4]![1], time: "2026-11-03T06:31:00.000Z" });
    expect(rounds[4]!.anchorId).toBe(rounds[4]!.messageIds[1]);
  });

  it("leaves removed messages out and starts a round at every question", () => {
    const session = nineRounds();
    const [, firstReply] = session.conversation.messages;
    const rounds = extractSessionRounds(session, new Set([firstReply!.externalId]));
    expect(rounds[0]).toMatchObject({ answer: "", messageIds: [session.conversation.messages[0]!.externalId], anchorId: session.conversation.messages[0]!.externalId });
    expect(rounds).toHaveLength(9);
  });
});
