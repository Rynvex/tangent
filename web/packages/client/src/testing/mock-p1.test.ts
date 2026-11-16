/** The mock's B8 phase A simulation: leaves, seeds and suggestions behave like the server's (docs/devlog/B8-p1.md). */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, mockCapabilities, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

/** B9's goal, relations and groups stay manual here (like httpapi's harness), so they propose nothing into these P1 flows. */
const P1_ONLY_MODES: Readonly<Record<string, "manual" | "suggest" | "auto">> = { goal: "manual", relations: "manual", group: "manual" };

function make(features: Parameters<typeof mockCapabilities>[0] = "all", leafMode?: "manual" | "suggest" | "auto") {
  const scenario = nasScenario({ features });
  const modes: Readonly<Record<string, "manual" | "suggest" | "auto">> = { ...P1_ONLY_MODES, ...(leafMode ? { leaf: leafMode } : {}) };
  scenario.capabilities = {
    ...scenario.capabilities,
    features: scenario.capabilities.features.map((feature) => (feature.enabled && modes[feature.name] ? { ...feature, mode: modes[feature.name] } : feature)),
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

async function openBranch(c: MockTangentClient, purpose = "Check ryokan prices") {
  const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "investigate" });
  await c.sendMessage(created.line.id, { content: "Compare them" });
  for (let i = 0; i < 200 && (await c.getLine(created.line.id)).status === "thinking"; i += 1) await sleep(2);
  return created.line.id;
}

describe("leaves", () => {
  it("serves the scenario's leaves on the branch views", async () => {
    const { client: c } = make();
    const outline = await c.listBranches(NAS_ROOT_ID, { includeAside: true });
    expect(outline.branches.find((branch) => branch.lineId === "nas-b5")?.leaf).toEqual({ kind: "dead_end", line: "只能接一顆碟、沒有 ECC", status: "confirmed" });
    expect((await c.getLeaf("nas-b3")).leaf).toBeNull();
    expect((await rejection(c.getLeaf(NAS_ROOT_ID))).code).toBe("branch_not_found");
  });

  it("writes a discard's reason as a dead end, after branch.changed and line.updated", async () => {
    const { client: c, events } = make();
    const lineId = await openBranch(c);
    events.length = 0;
    const result = await c.discardBranch(lineId, { leaf: { line: "Too expensive\nfor this trip" } });
    expect(result.branch.leaf).toEqual({ kind: "dead_end", line: "Too expensive for this trip", status: "confirmed" });
    expect(events.map((event) => event.type)).toEqual(["branch.changed", "line.updated", "leaf.changed"]);
  });

  it("refuses a bad leaf before the discard happens", async () => {
    const { client: c } = make();
    const lineId = await openBranch(c);
    const error = await rejection(c.discardBranch(lineId, { leaf: { line: "x".repeat(201) } }));
    expect(error.code).toBe("invalid_leaf");
    expect(error.extra.problems).toEqual([{ field: "line", message: "is longer than 200 characters" }]);
    expect((await c.getBranch(lineId)).branch.status).toBe("open");
  });

  it("drafts after a discard without a reason in suggest mode, as a draft to confirm", async () => {
    const { client: c } = make("all", "suggest");
    const lineId = await openBranch(c);
    await c.discardBranch(lineId);
    await sleep(10);
    expect((await c.getLeaf(lineId)).leaf).toMatchObject({ status: "draft", aiDrafted: true });
    const confirmed = await c.putLeaf(lineId, { kind: "decision", line: "Skip the ryokan" });
    expect(confirmed.leaf).toMatchObject({ status: "confirmed", aiDrafted: false, kind: "decision" });
  });

  it("confirms an auto-mode draft but marks it as AI's; manual mode never drafts on its own", async () => {
    const auto = make("all", "auto").client;
    const autoLine = await openBranch(auto);
    await auto.discardBranch(autoLine);
    await sleep(10);
    expect((await auto.getLeaf(autoLine)).leaf).toMatchObject({ status: "confirmed", aiDrafted: true });
    auto.mock.dispose();

    const manual = make("all", "manual").client;
    const manualLine = await openBranch(manual);
    await manual.discardBranch(manualLine);
    await sleep(10);
    expect((await manual.getLeaf(manualLine)).leaf).toBeNull();
    await manual.startLeafDraft(manualLine);
    await sleep(10);
    expect((await manual.getLeaf(manualLine)).leaf).toMatchObject({ status: "draft" });
  });

  it("reports a failed draft (B8.1 draftError) until the leaf is written", async () => {
    const { client: c, events } = make("all", "manual");
    const lineId = await openBranch(c);
    await c.sendMessage(lineId, { content: "[fake:error] please" });
    await sleep(20);
    await c.discardBranch(lineId).catch(() => undefined);
    await c.startLeafDraft(lineId);
    await sleep(10);
    expect((await c.getLeaf(lineId)).draftError).toEqual({ code: "run_failed", message: "the leaf draft run failed" });
    expect(events.some((event) => event.type === "leaf.changed" && "draftError" in event.data)).toBe(true);
    await c.putLeaf(lineId, { kind: "dead_end", line: "Never mind" });
    expect((await c.getLeaf(lineId)).draftError).toBeUndefined();
  });

  it("leaves the card's conclusion when a branch is merged", async () => {
    const { client: c } = make();
    const lineId = await openBranch(c);
    const tip = (await c.getBranch(lineId)).parentTipMessageId;
    const card = { question: "Which?", conclusion: "Stay one night in a ryokan", evidence: [{ messageId: "", note: "Dinner is included" }], impact: "", openItems: [], needsDecision: [], excerpts: [] };
    const merged = await c.mergeBranch(lineId, { card, parentTipMessageId: tip });
    expect(merged.branch.leaf).toEqual({ kind: "conclusion", line: "Stay one night in a ryokan", status: "confirmed" });
    expect((await c.getLeaf(lineId)).leaf?.body).toBe("Which?\n- Dinner is included");
  });

  it("is a 404 feature_disabled while the leaf feature is off, and a discard then ignores nothing silently", async () => {
    const { client: c } = make("c1");
    const lineId = await openBranch(c);
    expect((await rejection(c.getLeaf(lineId))).code).toBe("feature_disabled");
    expect((await rejection(c.discardBranch(lineId, { leaf: { line: "x" } }))).extra).toEqual({ feature: "leaf" });
  });
});

describe("seeds", () => {
  it("parks a thought, counts it on the main line and publishes seeds.changed then line.updated", async () => {
    const { client: c, events } = make();
    expect((await c.getLine(NAS_ROOT_ID)).openSeeds).toBe(3);
    events.length = 0;
    const { seed } = await c.createSeed(NAS_ROOT_ID, { text: "  Is a  rail pass\nworth it? " });
    expect(seed).toMatchObject({ text: "Is a rail pass worth it?", status: "open", anchorMessageId: "nas-m40", anchorLineId: NAS_ROOT_ID, sourceLabel: "主線 #8" });
    expect(events.map((event) => event.type)).toEqual(["seeds.changed", "line.updated"]);
    expect((await c.getLine(NAS_ROOT_ID)).openSeeds).toBe(4);
    expect((await c.listSeeds("nas-b3")).seeds[0]?.id).toBe(seed.id);
  });

  it("refuses empty, too long and over-the-limit seeds", async () => {
    const { client: c } = make();
    expect((await rejection(c.createSeed(NAS_ROOT_ID, { text: " " }))).code).toBe("invalid_input");
    expect((await rejection(c.createSeed(NAS_ROOT_ID, { text: "x".repeat(501) }))).extra).toEqual({ field: "text", max: 500 });
    for (let i = 0; i < 97; i += 1) await c.createSeed(NAS_ROOT_ID, { text: `idea ${i}` });
    const full = await rejection(c.createSeed(NAS_ROOT_ID, { text: "one more" }));
    expect(full.code).toBe("seed_limit");
    expect(full.extra).toEqual({ limit: 100 });
  });

  it("expands a seed into a branch from its message (origin seed)", async () => {
    const { client: c } = make();
    const result = await c.expandSeed("nas-s1", { purpose: "Do I need a UPS?" });
    expect(result.branch).toMatchObject({ origin: "seed", anchorMessageId: "nas-m18", purpose: "Do I need a UPS?", kind: "investigate" });
    expect(result.seed).toMatchObject({ status: "expanded", expandedLineId: result.line.id });
    expect((await c.getLine(NAS_ROOT_ID)).openSeeds).toBe(2);
    expect((await rejection(c.expandSeed("nas-s1"))).code).toBe("seed_not_open");
  });

  it("expands a seed parked in an ended branch from the nearest open ancestor's fork point (B8 phase B)", async () => {
    const { client: c } = make();
    const { seed } = await c.createSeed("nas-b1", { text: "Is ECC needed?", anchorMessageId: "nas-b1-3" });
    const result = await c.expandSeed(seed.id);
    expect(result.branch).toMatchObject({ parentLineId: NAS_ROOT_ID, anchorMessageId: "nas-m19", origin: "seed" });
  });

  it("notes a seed under 待確認 with its message as the source, and drops one", async () => {
    const { client: c } = make();
    const noted = await c.noteSeed("nas-s2");
    expect(noted.note).toMatchObject({ section: "to_confirm", text: "NAS 要不要開外網存取？", sourceMessageId: "nas-m26", sourceLabel: "主線 #6" });
    expect(noted.seed).toMatchObject({ status: "noted", noteId: noted.note.id });
    expect((await c.dropSeed("nas-s3")).seed.status).toBe("dropped");
    expect((await c.listSeeds(NAS_ROOT_ID, { status: "all" })).seeds.map((seed) => seed.status).sort()).toEqual(["dropped", "noted", "open"]);
    expect((await rejection(c.dropSeed("nope"))).code).toBe("seed_not_found");
  });

  it("needs the notes feature to note a seed, and the parking feature for every route", async () => {
    const scenario = nasScenario();
    scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "notes" ? { name: "notes", enabled: false } : feature)) };
    client = createMockTangentClient({ scenario });
    expect((await rejection(client.noteSeed("nas-s1"))).extra).toEqual({ feature: "notes" });
    client.mock.dispose();
    const { client: off } = make("c1");
    expect((await rejection(off.listSeeds(NAS_ROOT_ID))).extra).toEqual({ feature: "parking" });
  });
});

describe("suggestions", () => {
  it("lists the scenario's suggestion, newest first, and counts it", async () => {
    const { client: c } = make();
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions.map((item) => item.id)).toEqual(["nas-g1"]);
    expect((await c.getLine(NAS_ROOT_ID)).openSuggestions).toBe(1);
  });

  it("proposes one on [probe:suggest], at most one open per target", async () => {
    const { client: c, events } = make();
    const line = await c.createLine({ title: "Probe" });
    for (const content of ["[probe:suggest] a", "[probe:suggest] b"]) {
      await c.sendMessage(line.id, { content });
      for (let i = 0; i < 200 && (await c.getLine(line.id)).status === "thinking"; i += 1) await sleep(2);
    }
    const open = (await c.listSuggestions(line.id)).suggestions;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ feature: "suggestion_probe", kind: "probe", lineId: line.id, targetKey: `line:${line.id}`, status: "open" });
    expect(events.some((event) => event.type === "suggestion.changed")).toBe(true);
  });

  it("accepts and dismisses once; a decided one is suggestion_not_open", async () => {
    const { client: c } = make();
    const accepted = await c.acceptSuggestion("nas-g1");
    expect(accepted).toMatchObject({ suggestion: { status: "accepted" }, result: { accepted: true } });
    expect(accepted.suggestion.decidedAt).not.toBeNull();
    expect((await rejection(c.dismissSuggestion("nas-g1"))).code).toBe("suggestion_not_open");
    expect((await c.getLine(NAS_ROOT_ID)).openSuggestions).toBe(0);
  });

  it("expires the suggestions about a branch when it ends", async () => {
    const { client: c } = make();
    await c.discardBranch("nas-b2");
    expect((await c.listSuggestions(NAS_ROOT_ID, { status: "all" })).suggestions[0]?.status).toBe("expired");
  });
});
