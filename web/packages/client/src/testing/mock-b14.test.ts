import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { Message } from "../types";
import { mockDivergePurpose } from "./mock-b14";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";
import { fixture, type MockScenario } from "./scenario";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function setup(features: "all" | "core" = "all", scenario: MockScenario = nasScenario({ features })) {
  const events: TangentEvent[] = [];
  client = createMockTangentClient({ scenario, latencyMs: 0, chunkMs: 1, draftMs: 1 });
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  return { c: client, events };
}

const code = async (promise: Promise<unknown>) => promise.then(() => "", (error: unknown) => (error instanceof TangentError ? error.code : String(error)));
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-4-5" };

async function lastReply(c: MockTangentClient, lineId = NAS_ROOT_ID): Promise<Message> {
  return (await c.listMessages(lineId)).messages.filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done").at(-1)!;
}

describe("mock export (B14)", () => {
  it("reads the whole tree from any of its lines: every line's messages, asides included, and the features' parts", async () => {
    const { c } = setup();
    const fromBranch = await c.exportTree("nas-b1a");
    const fromRoot = await c.exportTree(NAS_ROOT_ID);
    expect(fromBranch.rootLineId).toBe(NAS_ROOT_ID);
    expect(fromBranch.rootLine.id).toBe(NAS_ROOT_ID);
    expect(fromBranch.branches.map((branch) => branch.lineId)).toEqual(fromRoot.branches.map((branch) => branch.lineId));
    expect(fromRoot.branches.some((branch) => branch.kind === "aside")).toBe(true);
    expect(Object.keys(fromRoot.messagesByLine).sort()).toEqual([NAS_ROOT_ID, ...fromRoot.branches.map((branch) => branch.lineId)].sort());
    const main = fromRoot.messagesByLine[NAS_ROOT_ID]!;
    expect(main.map((message) => message.seq)).toEqual([...main].map((message) => message.seq).sort((a, b) => a - b));
    expect(fromRoot.truncated).toBe(false);
    expect(fromRoot.notes.length).toBeGreaterThan(0);
    expect(fromRoot.chapters.length).toBeGreaterThan(0);
    expect(fromRoot.goal?.rootLineId).toBe(NAS_ROOT_ID);
  });

  it("leaves the parts of features that are off empty, never feature_disabled", async () => {
    const { c } = setup("core");
    const tree = await c.exportTree(NAS_ROOT_ID);
    expect(tree).toMatchObject({ notes: [], memos: [], chapters: [], goal: null, comparisons: [], links: [], foldsByLine: {} });
    expect(tree.messagesByLine[NAS_ROOT_ID]!.length).toBeGreaterThan(0);
  });

  it("keeps a line's oldest 500 messages and says it was cut", async () => {
    const base = nasScenario();
    const extra = Array.from({ length: 501 }, (_, index) =>
      fixture.message({ id: `bulk-${index}`, seq: 10_000 + index, lineId: "nas-b2", role: index % 2 ? "assistant" : "user", content: `bulk ${index}` }),
    );
    const { c } = setup("all", { ...base, messages: [...base.messages, ...extra] });
    const tree = await c.exportTree(NAS_ROOT_ID);
    expect(tree.truncated).toBe(true);
    expect(tree.messagesByLine["nas-b2"]!.length).toBe(500);
    expect(tree.messagesByLine["nas-b2"]![0]!.seq).toBeLessThan(10_000);
  });

  it("groups the folds that are not removed by line", async () => {
    const { c } = setup();
    const chat = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
    const kept = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "kept" });
    const gone = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[2]!.id, toMessageId: chat[3]!.id, summary: "gone" });
    await c.deleteFold(gone.fold.id);
    const tree = await c.exportTree(NAS_ROOT_ID);
    expect(tree.foldsByLine).toEqual({ [NAS_ROOT_ID]: [expect.objectContaining({ id: kept.fold.id })] });
  });
});

describe("mock diverge across models (B14)", () => {
  it("opens one alternative branch per model, in order, with their models and purposes, and publishes each", async () => {
    const { c, events } = setup();
    const anchor = await lastReply(c);
    const before = events.length;
    const result = await c.divergeModels(NAS_ROOT_ID, { anchorMessageId: anchor.id, purpose: "Pick the disks", targets: [HAIKU, { ...SONNET, purpose: "The careful take" }] });
    expect(result.parentLineId).toBe(NAS_ROOT_ID);
    expect(result.branches.map(({ branch }) => [branch.kind, branch.origin, branch.model, branch.purpose])).toEqual([
      ["alternative", "diverge", "claude-haiku-4-5", "Pick the disks · claude-haiku-4-5"],
      ["alternative", "diverge", "claude-sonnet-4-5", "The careful take"],
    ]);
    expect(result.branches[0]!.line.model).toBe("claude-haiku-4-5");
    expect(result.branches[0]!.pack.rendered).toContain("## Parallel answers");
    expect(result.branches[0]!.pack.rendered).toContain("The careful take (anthropic/claude-sonnet-4-5)");
    const created = events.slice(before).filter((event) => event.type === "branch.changed").map((event) => (event.data as { change: string }).change);
    expect(created).toEqual(["created", "created"]);
  });

  it("names a target from the anchor's start when no purpose is given", async () => {
    const { c } = setup();
    const anchor = await lastReply(c);
    const result = await c.divergeModels(NAS_ROOT_ID, { anchorMessageId: anchor.id, targets: [HAIKU, SONNET] });
    const start = Array.from(anchor.content.replace(/\s+/g, " ").trim());
    const prefix = start.length <= 40 ? start.join("") : `${start.slice(0, 39).join("").trim()}…`;
    expect(result.branches[0]!.branch.purpose).toBe(`${prefix} · claude-haiku-4-5`);
  });

  it("cuts a long shared purpose but keeps the model name; a target's own too-long purpose is invalid_input", () => {
    const long = "字".repeat(300);
    const purpose = mockDivergePurpose({ ...HAIKU }, long, "");
    expect(Array.from(purpose).length).toBe(200);
    expect(purpose.endsWith("… · claude-haiku-4-5")).toBe(true);
    expect(() => mockDivergePurpose({ ...HAIKU, purpose: long }, "", "")).toThrow(TangentError);
  });

  it("refuses a wrong count, a missing or unlisted model, a bad anchor, the feature off; all or none at the branch limit", async () => {
    const { c } = setup();
    const anchor = await lastReply(c);
    const at = (targets: { provider: string; model: string }[]) => c.divergeModels(NAS_ROOT_ID, { anchorMessageId: anchor.id, targets });
    expect(await code(at([HAIKU]))).toBe("invalid_input");
    expect(await code(at([HAIKU, SONNET, HAIKU, SONNET, HAIKU, SONNET]))).toBe("invalid_input");
    expect(await code(at([HAIKU, { provider: "anthropic", model: " " }]))).toBe("invalid_input");
    expect(await code(at([HAIKU, { provider: "openai", model: "o3" }]))).toBe("model_not_allowed");
    expect(await code(at([HAIKU, { provider: "fake", model: "anything" }]))).toBe("");
    expect(await code(c.divergeModels(NAS_ROOT_ID, { anchorMessageId: "nope", targets: [HAIKU, SONNET] }))).toBe("anchor_not_found");
    const open = (await c.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.parentLineId === NAS_ROOT_ID && branch.status === "open").length;
    const room = 8 - open;
    const before = (await c.listBranches(NAS_ROOT_ID)).branches.length;
    expect(await code(at(Array.from({ length: Math.min(5, room + 1) }, () => HAIKU)))).toBe(room + 1 <= 5 ? "branch_limit" : "");
    if (room + 1 <= 5) expect((await c.listBranches(NAS_ROOT_ID)).branches.length).toBe(before);
    await c.archiveLine(NAS_ROOT_ID);
    expect(await code(at([HAIKU, SONNET]))).toBe("archived");
    expect(await code(setup("core").c.divergeModels(NAS_ROOT_ID, { anchorMessageId: anchor.id, targets: [HAIKU, SONNET] }))).toBe("feature_disabled");
  });
});

describe("mock seed batches (B14)", () => {
  it("parks every text in order with one label and one seeds.changed", async () => {
    const { c, events } = setup();
    const anchor = await lastReply(c);
    const before = events.length;
    const result = await c.createSeedsBatch(NAS_ROOT_ID, { anchorMessageId: anchor.id, texts: ["  Benchmark\nboth ", "Check the warranty"] });
    expect(result.rootLineId).toBe(NAS_ROOT_ID);
    expect(result.seeds.map((seed) => seed.text)).toEqual(["Benchmark both", "Check the warranty"]);
    expect(new Set(result.seeds.map((seed) => seed.sourceLabel)).size).toBe(1);
    expect(result.seeds.every((seed) => seed.anchorMessageId === anchor.id && seed.status === "open")).toBe(true);
    expect(events.slice(before).filter((event) => event.type === "seeds.changed")).toHaveLength(1);
    const listed = (await c.listSeeds(NAS_ROOT_ID)).seeds.map((seed) => seed.id);
    expect(listed).toEqual(expect.arrayContaining(result.seeds.map((seed) => seed.id)));
  });

  it("refuses none, more than 20, an empty or long text, a full lot (all or none), an archived tree and the feature off", async () => {
    const { c } = setup();
    const batch = (texts: string[]) => c.createSeedsBatch(NAS_ROOT_ID, { texts });
    expect(await code(batch([]))).toBe("invalid_input");
    expect(await code(batch(Array.from({ length: 21 }, (_, index) => `t${index}`)))).toBe("invalid_input");
    expect(await code(batch(["ok", "  "]))).toBe("invalid_input");
    expect(await code(batch(["ok", "x".repeat(501)]))).toBe("too_long");
    const open = (await c.listSeeds(NAS_ROOT_ID)).seeds.length;
    const { limits } = await c.listSeeds(NAS_ROOT_ID);
    for (let left = limits.maxOpen - open; left > 0; left -= Math.min(20, left)) await batch(Array.from({ length: Math.min(20, left) }, (_, index) => `fill ${left}-${index}`));
    expect(await code(batch(["one too many"]))).toBe("seed_limit");
    expect((await c.listSeeds(NAS_ROOT_ID)).seeds.length).toBe(limits.maxOpen);
    await c.archiveLine(NAS_ROOT_ID);
    expect(await code(batch(["x"]))).toBe("archived");
    expect(await code(setup("core").c.createSeedsBatch(NAS_ROOT_ID, { texts: ["x"] }))).toBe("feature_disabled");
  });
});

describe("mock search within one tree (B14)", () => {
  it("searches only that tree, folded messages too, archived or not; a branch or unknown root is line_not_found", async () => {
    const { c } = setup();
    const all = await c.search({ q: "ZFS" });
    const one = await c.search({ q: "ZFS", root: NAS_ROOT_ID });
    expect(one.hits.length).toBeGreaterThan(0);
    expect(one.hits.every((hit) => hit.rootLineId === NAS_ROOT_ID)).toBe(true);
    expect(all.hits.length).toBeGreaterThanOrEqual(one.hits.length);
    const hit = one.hits.find((item) => item.kind === "message" && item.lineId === NAS_ROOT_ID)!;
    const chat = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
    const at = chat.findIndex((message) => message.id === hit.messageId);
    await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[Math.max(0, at - 1)]!.id, toMessageId: chat[Math.max(1, at)]!.id, summary: "folded" });
    expect((await c.search({ q: "ZFS", root: NAS_ROOT_ID })).hits.some((item) => item.messageId === hit.messageId)).toBe(true);
    await c.archiveLine(NAS_ROOT_ID);
    expect((await c.search({ q: "ZFS", root: NAS_ROOT_ID })).hits.length).toBeGreaterThan(0);
    expect(await code(c.search({ q: "ZFS", root: "nas-b1" }))).toBe("line_not_found");
    expect(await code(c.search({ q: "ZFS", root: "nobody" }))).toBe("line_not_found");
  });
});
