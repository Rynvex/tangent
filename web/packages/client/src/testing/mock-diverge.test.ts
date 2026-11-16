/** The mock's B10 phase B simulation: diverge, converge and decide, and fold summary edits (docs/devlog/B10-p3.md 階段 B). */
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureMode } from "../capabilities";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make(modes: Readonly<Record<string, FeatureMode>> = {}) {
  const scenario = nasScenario();
  scenario.capabilities = {
    ...scenario.capabilities,
    features: scenario.capabilities.features.map((feature) => {
      const mode = modes[feature.name];
      if (mode === undefined) return feature;
      return mode === "off" ? { name: feature.name, enabled: false } : { ...feature, enabled: true, mode };
    }),
  };
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ scenario, chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(TangentError);
  return error as TangentError;
}

const lastReply = async (c: MockTangentClient) => (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.role === "assistant" && message.kind === "chat").at(-1)!;

async function diverged(c: MockTangentClient, count = 3) {
  const anchor = await lastReply(c);
  await c.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count });
  await sleep(10);
  return (await c.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge" && branch.anchorMessageId === anchor.id);
}

describe("diverge", () => {
  it("opens the asked number of sibling directions after the job (alternative, origin diverge, same anchor)", async () => {
    const { client: c, events } = make({ diverge: "manual" });
    const anchor = await lastReply(c);
    const job = await c.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 3 });
    expect(job.kind).toBe("diverge");
    await sleep(10);
    const branches = (await c.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge");
    expect(branches.map((branch) => [branch.purpose, branch.kind, branch.anchorMessageId])).toEqual([1, 2, 3].map((n) => [`Direction ${n} (fake runner)`, "alternative", anchor.id]));
    expect(events.filter((event) => event.type === "branch.changed").length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a bad count, a foreign anchor, too many open branches, and a turned-off feature", async () => {
    const { client: c } = make({ diverge: "manual" });
    const anchor = await lastReply(c);
    expect((await rejection(c.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 1 }))).code).toBe("invalid_input");
    expect((await rejection(c.diverge(NAS_ROOT_ID, { anchorMessageId: "nope", count: 2 }))).code).toBe("anchor_not_found");
    await diverged(c, 5);
    expect((await rejection(c.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 2 }))).code).toBe("branch_limit");
    expect((await rejection(make({ diverge: "off" }).client.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 2 }))).code).toBe("feature_disabled");
  });
});

describe("converge and decide", () => {
  it("compares open siblings: drafting, then a ready table (the user's criteria, 5 / 4 / …, O1 recommended)", async () => {
    const { client: c, events } = make({ diverge: "manual" });
    const [a, b] = await diverged(c, 2);
    const started = await c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId, b!.lineId], criteria: ["Safety", "Speed"] });
    expect(started.comparison).toMatchObject({ status: "drafting", matrix: null, lineIds: [a!.lineId, b!.lineId] });
    expect(started.job.kind).toBe("converge");
    await sleep(10);
    const ready = (await c.getComparison(started.comparison.id)).comparison;
    expect(ready.status).toBe("ready");
    expect(ready.matrix?.criteria).toEqual(["Safety", "Speed"]);
    expect(ready.matrix?.scores.map((row) => row.map((cell) => cell.score))).toEqual([
      [5, 4],
      [5, 4],
    ]);
    expect(ready.matrix?.recommendation.lineId).toBe(a!.lineId);
    expect(events.filter((event) => event.type === "comparison.changed").length).toBeGreaterThanOrEqual(2);
    const plain = await c.converge(NAS_ROOT_ID, { lineIds: [b!.lineId, a!.lineId] });
    await sleep(10);
    expect((await c.listComparisons(NAS_ROOT_ID)).comparisons.map((item) => item.id)).toEqual([plain.comparison.id, started.comparison.id]);
    expect((await c.getComparison(plain.comparison.id)).comparison.matrix?.criteria).toEqual(["Fit (fake runner)"]);
  });

  it("refuses too few or ended options; [fake:job-error] in an option fails the table", async () => {
    const { client: c, events } = make({ diverge: "manual" });
    const [a, b] = await diverged(c, 2);
    expect((await rejection(c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId] }))).code).toBe("invalid_comparison");
    expect((await rejection(c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId, "nas-b4"] }))).code).toBe("branch_closed");
    await c.sendMessage(a!.lineId, { content: "[fake:job-error] hmm" });
    for (let i = 0; i < 300 && (await c.getLine(a!.lineId)).status === "thinking"; i += 1) await sleep(2);
    const started = await c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId, b!.lineId] });
    await sleep(10);
    expect((await c.getComparison(started.comparison.id)).comparison.status).toBe("failed");
    expect(events.filter((event) => event.type === "job.failed").map((event) => (event.data as { kind: string }).kind)).toContain("converge");
    expect((await rejection(c.decideComparison(started.comparison.id, { lineId: a!.lineId }))).code).toBe("comparison_not_ready");
  });

  it("decides: the chosen branch keeps going with a decision leaf; the others end with a dead end; once only", async () => {
    const { client: c } = make({ diverge: "manual" });
    const [a, b, d] = await diverged(c, 3);
    const started = await c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId, b!.lineId, d!.lineId] });
    await sleep(10);
    const decided = await c.decideComparison(started.comparison.id, { lineId: b!.lineId, line: "Take the second" });
    expect(decided.comparison).toMatchObject({ status: "decided", decidedLineId: b!.lineId });
    expect(decided.chosen).toMatchObject({ lineId: b!.lineId, status: "open", leaf: { kind: "decision", line: "Take the second" } });
    expect(decided.decision).toMatchObject({ kind: "decision", line: "Take the second" });
    expect(decided.discarded.map((branch) => [branch.lineId, branch.status, branch.leaf?.kind, branch.leaf?.line])).toEqual([
      [a!.lineId, "discarded", "dead_end", "沒選：改走「Direction 2 (fake runner)」"],
      [d!.lineId, "discarded", "dead_end", "沒選：改走「Direction 2 (fake runner)」"],
    ]);
    expect((await rejection(c.decideComparison(started.comparison.id, { lineId: a!.lineId }))).code).toBe("comparison_decided");
    expect((await rejection(c.getComparison("nope"))).code).toBe("comparison_not_found");
  });
});

describe("fold summary edits", () => {
  it("the user's summary makes a fold active and theirs; a drafting job no longer writes it; a removed one is gone", async () => {
    const { client: c } = make({ fold: "manual" });
    const chat = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
    const made = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id });
    const edited = await c.updateFold(made.fold.id, { summary: "Mine" });
    expect(edited.fold).toMatchObject({ status: "active", summary: "Mine", aiDrafted: false });
    await sleep(10);
    expect((await c.listFolds(NAS_ROOT_ID)).folds[0]?.summary).toBe("Mine");
    expect((await rejection(c.updateFold(made.fold.id, { summary: " " }))).code).toBe("invalid_input");
    await c.deleteFold(made.fold.id);
    expect((await rejection(c.updateFold(made.fold.id, { summary: "x" }))).code).toBe("fold_not_found");
  });
});
