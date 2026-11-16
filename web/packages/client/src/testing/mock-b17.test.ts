import { afterEach, describe, expect, it } from "vitest";
import { cardState, isoMicros } from "../b17-routes";
import { TangentError } from "../errors";
import { cardEditReasons } from "../stale-reasons";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function setup() {
  const events: TangentEvent[] = [];
  client = createMockTangentClient({ scenario: nasScenario({ features: "all" }), latencyMs: 0, chunkMs: 1, draftMs: 1 });
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  return { c: client, events };
}

const code = async (promise: Promise<unknown>) => promise.then(() => "", (error: unknown) => (error instanceof TangentError ? error.code : String(error)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(c: MockTangentClient, lineId: string): Promise<void> {
  for (let i = 0; i < 200 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
}

async function probe(c: MockTangentClient, lineId: string, text = "[probe:suggest] go"): Promise<void> {
  await c.sendMessage(lineId, { content: text });
  await settle(c, lineId);
}

describe("mock dismiss-all (B17)", () => {
  it("dismisses every open suggestion of the tree from any of its lines, then publishes one line.updated", async () => {
    const { c, events } = setup();
    await probe(c, NAS_ROOT_ID);
    await probe(c, "nas-b3");
    const before = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.filter((item) => item.status === "open");
    expect(before.length).toBeGreaterThanOrEqual(2);
    events.length = 0;
    const result = await c.dismissAllSuggestions("nas-b3");
    expect(result.rootLineId).toBe(NAS_ROOT_ID);
    expect(result.suggestions.map((item) => item.id).sort()).toEqual(before.map((item) => item.id).sort());
    expect(result.suggestions.every((item) => item.status === "dismissed" && item.decidedAt)).toBe(true);
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions).toEqual([]);
    expect((await c.getLine(NAS_ROOT_ID)).openSuggestions).toBe(0);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "suggestion.changed")).toHaveLength(before.length);
    expect(types.at(-1)).toBe("line.updated");
    expect(types.filter((type) => type === "line.updated")).toHaveLength(1);
  });

  it("answers [] and publishes nothing when nothing is open", async () => {
    const { c, events } = setup();
    await c.dismissAllSuggestions(NAS_ROOT_ID);
    events.length = 0;
    expect((await c.dismissAllSuggestions(NAS_ROOT_ID)).suggestions).toEqual([]);
    expect(events).toEqual([]);
  });

  it("is refused while the inbox is off", async () => {
    client = createMockTangentClient({ scenario: nasScenario({ features: "core" }), latencyMs: 0 });
    expect(await code(client.dismissAllSuggestions(NAS_ROOT_ID))).toBe("feature_disabled");
  });
});

describe("mock card edit (B17)", () => {
  const card = { question: "Which filesystem?", conclusion: "ZFS mirror, scrub monthly", openItems: ["Check ECC"] };

  it("rewrites the card in place (delivered cleared), the branch's conclusion line and the merge's leaf, in the server's event order", async () => {
    const { c, events } = setup();
    const before = (await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === "nas-c1")!;
    expect(before.meta.delivered).toBe(true);
    events.length = 0;
    const result = await c.updateBranchCard("nas-b1", { card });
    expect(result.message).toMatchObject({ id: "nas-c1", seq: before.seq, lineId: NAS_ROOT_ID, content: "ZFS mirror, scrub monthly" });
    expect(result.message.meta.card).toMatchObject(card);
    expect(result.message.meta.delivered).toBeUndefined();
    expect(result.message.meta.editedAt).toEqual(expect.any(String));
    expect(result.message.meta.branchLineId).toBe("nas-b1");
    // The scenario's leaf is not the one a merge would write from this card: it stays.
    expect(result.branch).toMatchObject({ status: "merged", conclusionLine: "ZFS mirror, scrub monthly", leaf: { kind: "conclusion", line: "兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟" } });
    expect(events.map((event) => event.type)).toEqual(["message.updated", "branch.changed"]);
    expect(events[1]).toMatchObject({ data: { change: "merged" } });
    // The next finished turn of the parent carries it again.
    await c.sendMessage(NAS_ROOT_ID, { content: "and now?" });
    await settle(c, NAS_ROOT_ID);
    const after = (await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === "nas-c1")!;
    expect(after.meta.delivered).toBe(true);
  });

  it("rewrites the leaf the merge wrote from the old card (then leaf.changed)", async () => {
    const { c, events } = setup();
    const made = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Disks", kind: "investigate" });
    await c.sendMessage(made.line.id, { content: "which?" });
    await settle(c, made.line.id);
    const tip = (await c.getBranch(made.line.id)).parentTipMessageId;
    await c.mergeBranch(made.line.id, { card: { question: "Which disks?", conclusion: "Two 8TB" }, parentTipMessageId: tip });
    events.length = 0;
    const result = await c.updateBranchCard(made.line.id, { card: { question: "Which disks?", conclusion: "Two 8TB CMR" } });
    expect(result.branch.leaf).toMatchObject({ kind: "conclusion", line: "Two 8TB CMR" });
    expect(events.map((event) => event.type)).toEqual(["message.updated", "branch.changed", "leaf.changed"]);
  });

  it("records the edit time on the card and its branch like the server (B17.1): later than every branch so far, strictly increasing, kept after delivery", async () => {
    // A clock that stands still until moved: the edit times still move on.
    let clock = Date.parse("2026-10-30T08:00:00Z");
    client = createMockTangentClient({ scenario: nasScenario({ features: "all" }), latencyMs: 0, chunkMs: 1, draftMs: 1, now: () => new Date(clock) });
    const c = client;
    const before = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "Why monthly?", kind: "investigate" });
    const first = await c.updateBranchCard("nas-b1", { card });
    const editedAt = first.message.meta.editedAt!;
    expect(first.branch.cardEditedAt).toBe(editedAt);
    const outline = (await c.listBranches(NAS_ROOT_ID)).branches;
    expect(outline.every((item) => item.lineId === "nas-b1" || isoMicros(item.createdAt) < isoMicros(editedAt))).toBe(true);
    expect(outline.find((item) => item.lineId === "nas-b1")?.cardEditedAt).toBe(editedAt);
    expect(cardState(first.message)).toBe("editedPending");
    clock += 60_000;
    const after = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "And weekly?", kind: "investigate" });
    const tree = (await c.listBranches(NAS_ROOT_ID)).branches;
    // 前提已更新 on the follow-up opened before the edit only.
    expect(cardEditReasons(tree.find((item) => item.lineId === before.line.id)!, tree)).toHaveLength(1);
    expect(cardEditReasons(tree.find((item) => item.lineId === after.line.id)!, tree)).toEqual([]);
    // The clock stands still again: the next edit is still later than the last branch and the last edit.
    const second = await c.updateBranchCard("nas-b1", { card: { ...card, conclusion: "ZFS mirror, scrub weekly" } });
    expect(isoMicros(second.message.meta.editedAt!)).toBeGreaterThan(isoMicros(editedAt));
    expect(isoMicros(second.message.meta.editedAt!)).toBeGreaterThan(isoMicros(after.branch.createdAt));
    const third = await c.updateBranchCard("nas-b1", { card });
    expect(isoMicros(third.message.meta.editedAt!)).toBeGreaterThan(isoMicros(second.message.meta.editedAt!));
    await c.sendMessage(NAS_ROOT_ID, { content: "and now?" });
    await settle(c, NAS_ROOT_ID);
    const delivered = (await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === "nas-c1")!;
    expect(delivered.meta).toMatchObject({ delivered: true, editedAt: third.message.meta.editedAt });
    expect(cardState(delivered)).toBe("delivered");
  });

  it("keeps a leaf the user wrote", async () => {
    const { c } = setup();
    await c.putLeaf("nas-b1", { kind: "decision", line: "Going with ZFS" });
    const result = await c.updateBranchCard("nas-b1", { card });
    expect(result.branch.leaf).toMatchObject({ kind: "decision", line: "Going with ZFS" });
  });

  it("refuses what the server refuses", async () => {
    const { c } = setup();
    expect(await code(c.updateBranchCard("nas-b3", { card }))).toBe("branch_closed");
    expect(await code(c.updateBranchCard(NAS_ROOT_ID, { card }))).toBe("branch_not_found");
    expect(await code(c.updateBranchCard("nas-b1", { card: { question: "q", conclusion: " " } }))).toBe("invalid_card");
    expect(await code(c.updateBranchCard("nas-b1", { card: { question: "", conclusion: "c" } }))).toBe("invalid_card");
    await c.sendMessage(NAS_ROOT_ID, { content: "[fake:slow] wait" });
    expect(await code(c.updateBranchCard("nas-b1", { card }))).toBe("parent_busy");
    await c.cancelTurn(NAS_ROOT_ID);
    await c.archiveLine(NAS_ROOT_ID);
    expect(await code(c.updateBranchCard("nas-b1", { card }))).toBe("archived");
  });
});

describe("mock follow-up from a card (B17)", () => {
  it("opens and previews a branch on a conclusion card; its pack ends with the card as it was", async () => {
    const { c } = setup();
    const preview = await c.previewBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "Why monthly?", kind: "investigate" });
    expect(preview.pack.recent.at(-1)).toMatchObject({ id: "nas-c1", role: "system" });
    expect(preview.text).toContain("[main-line message nas-c1 · branch conclusion card]");
    const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "Why monthly?", kind: "investigate" });
    expect(created.branch.anchorMessageId).toBe("nas-c1");
    await c.updateBranchCard("nas-b1", { card: { question: "q", conclusion: "Edited later" } });
    const detail = await c.getBranch(created.line.id);
    expect(detail.pack.rendered).not.toContain("Edited later");
  });

  it("refuses other system messages and another line's card", async () => {
    const { c } = setup();
    expect(await code(c.createBranch("nas-b3", { anchorMessageId: "nas-c1", purpose: "x", kind: "investigate" }))).toBe("anchor_not_found");
    expect(await code(c.previewBranch("nas-b3", { anchorMessageId: "nas-c1", kind: "investigate" }))).toBe("anchor_not_found");
  });
});
