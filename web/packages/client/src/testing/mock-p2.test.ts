/** The mock's B9 phase A simulation: goal, drift, relations, open loops and pins behave like the server's (docs/devlog/B9-p2.md). */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { FeatureMode } from "../capabilities";
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

async function turn(c: MockTangentClient, lineId: string, content: string) {
  await c.sendMessage(lineId, { content });
  for (let i = 0; i < 300 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
}

describe("goal", () => {
  it("serves the scenario's goal, writes the user's and clears it", async () => {
    const { client: c, events } = make();
    expect((await c.getGoal("nas-b3")).goal).toMatchObject({ rootLineId: NAS_ROOT_ID, source: "manual" });
    const put = await c.putGoal("nas-b3", { text: "  Keep the data\n safe  " });
    expect(put.goal).toMatchObject({ rootLineId: NAS_ROOT_ID, text: "Keep the data safe", source: "manual" });
    await c.deleteGoal(NAS_ROOT_ID);
    expect((await c.getGoal(NAS_ROOT_ID)).goal).toBeNull();
    expect((await rejection(c.deleteGoal(NAS_ROOT_ID))).code).toBe("goal_not_found");
    expect(events.filter((event) => event.type === "goal.changed").map((event) => (event.data as { goal: unknown }).goal === null)).toEqual([false, true]);
  });

  it("refuses an empty or too long goal", async () => {
    const { client: c } = make();
    expect((await rejection(c.putGoal(NAS_ROOT_ID, { text: " \n" }))).code).toBe("invalid_input");
    const long = await rejection(c.putGoal(NAS_ROOT_ID, { text: "x".repeat(301) }));
    expect([long.code, long.extra]).toEqual(["too_long", { field: "text", max: 300 }]);
  });

  it("proposes on request into the inbox; accepting it unchanged is AI's, edited is the user's", async () => {
    const { client: c } = make();
    await c.deleteGoal(NAS_ROOT_ID);
    const job = await c.proposeGoal("nas-b3");
    expect(job).toMatchObject({ kind: "goal_propose", lineId: NAS_ROOT_ID });
    await sleep(10);
    const proposal = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "goal_propose");
    expect(proposal).toMatchObject({ feature: "goal", lineId: NAS_ROOT_ID, targetKey: `goal:${NAS_ROOT_ID}` });
    const accepted = await c.acceptSuggestion(proposal!.id, {});
    expect(accepted.result).toMatchObject({ goal: { source: "ai", text: proposal!.payload.text } });
    await c.proposeGoal(NAS_ROOT_ID);
    await sleep(10);
    const next = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "goal_propose");
    const edited = await c.acceptSuggestion(next!.id, { text: "My own words" });
    expect(edited.result).toMatchObject({ goal: { source: "manual", text: "My own words" } });
  });

  it("refuses a proposal before the main line has a finished turn", async () => {
    const { client: c } = make();
    const line = await c.createLine({ title: "Empty" });
    expect((await rejection(c.proposeGoal(line.id))).code).toBe("no_messages");
  });

  it("a goal the user writes ends the open proposals", async () => {
    const { client: c } = make();
    await c.deleteGoal(NAS_ROOT_ID);
    await c.proposeGoal(NAS_ROOT_ID);
    await sleep(10);
    await c.putGoal(NAS_ROOT_ID, { text: "Mine" });
    const all = (await c.listSuggestions(NAS_ROOT_ID, { status: "all" })).suggestions;
    expect(all.find((item) => item.kind === "goal_propose")?.status).toBe("expired");
  });

  it("suggest mode proposes once after the second main-line reply", async () => {
    const { client: c } = make();
    const line = await c.createLine({ title: "New" });
    await turn(c, line.id, "one");
    expect((await c.listSuggestions(line.id)).suggestions).toHaveLength(0);
    await turn(c, line.id, "two");
    expect((await c.listSuggestions(line.id)).suggestions.map((item) => item.kind)).toEqual(["goal_propose"]);
    await turn(c, line.id, "three");
    expect((await c.listSuggestions(line.id, { status: "all" })).suggestions).toHaveLength(1);
  });

  it("auto mode writes the proposal as the goal", async () => {
    const { client: c } = make({ goal: "auto" });
    const line = await c.createLine({ title: "New" });
    await turn(c, line.id, "one");
    await turn(c, line.id, "two");
    expect((await c.getGoal(line.id)).goal).toMatchObject({ source: "ai" });
  });

  it("manual mode proposes nothing by itself and detects no drift", async () => {
    const { client: c } = make({ goal: "manual" });
    await turn(c, NAS_ROOT_ID, "[fake:drift] off topic");
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions.some((item) => item.feature === "goal")).toBe(false);
  });
});

describe("drift", () => {
  it("[fake:drift] on the main line proposes a hint under that reply; accepting opens the branch there", async () => {
    const { client: c } = make();
    await turn(c, NAS_ROOT_ID, "[fake:drift] what about remote access?");
    const reply = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.role === "assistant").at(-1)!;
    const drift = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "drift");
    expect(drift).toMatchObject({ feature: "goal", lineId: NAS_ROOT_ID, targetKey: `drift:${reply.id}`, payload: { anchorMessageId: reply.id, kind: "investigate" } });
    const accepted = await c.acceptSuggestion(drift!.id, { kind: "investigate" });
    expect(accepted.result).toMatchObject({ branch: { anchorMessageId: reply.id, kind: "investigate", parentLineId: NAS_ROOT_ID } });
  });

  it("a branch's turn never drifts", async () => {
    const { client: c } = make();
    await turn(c, "nas-b3", "[fake:drift] elsewhere");
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions.some((item) => item.kind === "drift")).toBe(false);
  });
});

describe("relations", () => {
  it("creates across conversations, lists from both, refuses duplicates either way, deletes", async () => {
    const { client: c, events } = make();
    const made = await c.createRelation(NAS_ROOT_ID, { fromMessageId: "nas-m17", toLineId: "osaka", label: "Same trip" });
    expect(made.rootLineIds.sort()).toEqual([NAS_ROOT_ID, "osaka"].sort());
    expect(made.relation).toMatchObject({ kind: "relation", fromLineId: NAS_ROOT_ID, fromMessageId: "nas-m17", toLineId: "osaka", toTitle: "日本行程：大阪 4 天" });
    expect(events.filter((event) => event.type === "link.changed")).toHaveLength(2);
    expect((await c.listRelations("osaka")).relations.map((item) => item.id)).toEqual([made.relation.id]);
    expect((await rejection(c.createRelation("osaka", { toLineId: NAS_ROOT_ID, toMessageId: "nas-m17" }))).code).toBe("relation_exists");
    expect((await c.listLinks(NAS_ROOT_ID)).links.some((link) => link.kind === "relation")).toBe(true);
    await c.deleteRelation(NAS_ROOT_ID, made.relation.id);
    expect((await c.listRelations(NAS_ROOT_ID)).relations).toEqual([]);
    expect(events.filter((event) => event.type === "link.changed").at(-1)?.data).toMatchObject({ deleted: true });
    expect((await rejection(c.deleteRelation(NAS_ROOT_ID, made.relation.id))).code).toBe("relation_not_found");
  });

  it("refuses the same end twice, a start in another tree and a message on another line", async () => {
    const { client: c } = make();
    expect((await rejection(c.createRelation(NAS_ROOT_ID, { toLineId: NAS_ROOT_ID }))).code).toBe("invalid_input");
    expect((await rejection(c.createRelation(NAS_ROOT_ID, { fromLineId: "osaka", toLineId: NAS_ROOT_ID }))).code).toBe("invalid_input");
    expect((await rejection(c.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", toMessageId: "nas-m17" }))).code).toBe("message_not_found");
    const long = await rejection(c.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "x".repeat(201) }));
    expect([long.code, long.extra]).toEqual(["too_long", { field: "label", max: 200 }]);
  });

  it("suggests relating an ended branch to the newest other one; accepting draws it", async () => {
    const { client: c } = make();
    await c.discardBranch("nas-b3");
    const suggestion = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "relation");
    expect(suggestion).toMatchObject({ feature: "relations", lineId: NAS_ROOT_ID, payload: { fromLineId: "nas-b3", toLineId: "nas-b2" } });
    const accepted = await c.acceptSuggestion(suggestion!.id, {});
    expect(accepted.result).toMatchObject({ link: { kind: "relation", fromLineId: "nas-b3", toLineId: "nas-b2" } });
  });

  it("the relations feature off: no routes, and /links keeps only spinoffs", async () => {
    const { client: c } = make({ relations: "off" });
    expect((await rejection(c.listRelations(NAS_ROOT_ID))).code).toBe("feature_disabled");
    expect((await c.listLinks(NAS_ROOT_ID)).links).toEqual([]);
  });
});

describe("open loops", () => {
  it("counts the scenario's stale branch on the main line and lists the groups of the features that are on", async () => {
    const { client: c } = make();
    expect((await c.getLine(NAS_ROOT_ID)).staleBranches).toBe(1);
    const loops = await c.listOpenLoops({ root: "nas-b3" });
    expect(loops).toMatchObject({ rootLineId: NAS_ROOT_ID, staleDays: 3 });
    expect(loops.staleBranches.items.map((item) => [item.lineId, item.rootTitle])).toEqual([["nas-b2", "家用 NAS 與備份策略"]]);
    expect(loops.toConfirm?.items.map((item) => item.id)).toEqual(["n5"]);
    expect(loops.seeds?.total).toBe(3);
    expect(loops.suggestions?.total).toBe(1);
    expect((await c.listOpenLoops({ staleDays: 1 })).staleBranches.total).toBe(2);
  });

  it("leaves out the groups of turned-off features and refuses a bad staleDays", async () => {
    const { client: c } = make({ notes: "off", parking: "off" });
    const loops = await c.listOpenLoops();
    expect("toConfirm" in loops).toBe(false);
    expect("seeds" in loops).toBe(false);
    expect((await rejection(c.listOpenLoops({ staleDays: 0 }))).code).toBe("invalid_input");
  });
});

describe("pins", () => {
  it("pins and unpins a reply, with message.updated only on a change", async () => {
    const { client: c, events } = make();
    expect((await c.pinMessage("nas-m17")).message.pinned).toBe(true);
    await c.pinMessage("nas-m17");
    expect((await c.unpinMessage("nas-m17")).message.pinned).toBe(false);
    expect(events.filter((event) => event.type === "message.updated")).toHaveLength(2);
    expect((await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === "nas-m17")?.pinned).toBe(false);
  });

  it("refuses an unknown message", async () => {
    const { client: c } = make();
    expect((await rejection(c.pinMessage("nope"))).code).toBe("message_not_found");
  });
});

describe("preview: the shared budget and the fisheye report (B9 phase B)", () => {
  it("always reports the budget; its shares add up to what was used", async () => {
    const { client: c } = make({ fisheye: "off" });
    const preview = await c.previewTurn(NAS_ROOT_ID, { content: "next" });
    expect(preview.budget.total).toBe(40000);
    expect(preview.budget.shares.map((share) => share.owner)).toEqual(expect.arrayContaining(["history"]));
    expect(preview.budget.used).toBe(preview.budget.shares.reduce((sum, share) => sum + share.tokens, 0));
    expect("fisheye" in preview).toBe(false);
  });

  it("with fisheye on: the newest and pinned messages in full, older ones condensed, other branches by their leaf", async () => {
    const { client: c } = make();
    await c.pinMessage("nas-m17");
    const preview = await c.previewTurn(NAS_ROOT_ID, { content: "next" });
    const items = preview.fisheye!.items;
    const messages = items.filter((item) => item.kind === "message");
    expect(messages.at(-1)?.level).toBe("full");
    expect(messages.find((item) => item.id === "nas-m17")).toMatchObject({ level: "full" });
    expect(messages.find((item) => item.id === "nas-m17")!.score).toBeGreaterThanOrEqual(90);
    expect(messages.some((item) => item.level === "summary")).toBe(true);
    const branches = items.filter((item) => item.kind === "branch");
    expect(branches.find((item) => item.lineId === "nas-b5")).toMatchObject({ level: "leaf_only" });
    expect(branches.find((item) => item.lineId === "nas-b3")?.level ?? "hidden").toBe("hidden");
    expect(preview.blocks.some((block) => block.key === "branch_conclusions")).toBe(true);
  });

  it("a branch's own line and its ancestors are not listed (their background goes whole)", async () => {
    const { client: c } = make();
    const preview = await c.previewTurn("nas-b1a", { content: "x" });
    const branchIds = preview.fisheye!.items.filter((item) => item.kind === "branch").map((item) => item.lineId);
    expect(branchIds).not.toContain("nas-b1");
    expect(branchIds).not.toContain("nas-b1a");
  });
});
