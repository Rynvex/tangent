/**
 * The branch flow of the mock client (F2): limits and origins of new
 * branches, asides that end with their answer, card delivery, moving the
 * tail into a branch and promoting a branch, the way the Engine does them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { BranchView } from "../types";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

const NOW = new Date("2026-10-15T08:00:00Z");

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof TangentError)) throw new Error(`expected a TangentError, got ${String(error)}`);
  return error;
}

let client: MockTangentClient;
let events: TangentEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  client = createMockTangentClient({ now: () => NOW, chunkMs: 5, draftMs: 50 });
  events = [];
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
});

afterEach(() => {
  client.mock.dispose();
  vi.useRealTimers();
});

const changes = () => events.filter((event) => event.type === "branch.changed").map((event) => (event.data as { change: string }).change);

describe("opening branches", () => {
  it("records a suggestion's origin and a pack that brings in the later messages", async () => {
    const result = await client.createBranch(NAS_ROOT_ID, { purpose: "B2 與 Wasabi", kind: "investigate", anchorMessageId: "nas-m26", suggestionMessageId: "nas-m26", includeLater: true });
    expect(result.branch.origin).toBe("suggestion");
    expect(result.pack).toMatchObject({ laterIncluded: true, laterMessages: 2 });
  });

  it("asks before a branch deeper than three levels and opens it once confirmed", async () => {
    let parent = NAS_ROOT_ID;
    let anchor = "nas-m40";
    for (let depth = 1; depth <= 3; depth += 1) {
      const created = await client.createBranch(parent, { purpose: `level ${depth}`, kind: "investigate", anchorMessageId: anchor });
      const turn = await client.sendMessage(created.line.id, { content: "go" });
      await vi.runAllTimersAsync();
      parent = created.line.id;
      anchor = turn.turnId;
    }
    const refused = await rejection(client.createBranch(parent, { purpose: "level 4", kind: "investigate", anchorMessageId: anchor }));
    expect([refused.status, refused.code, refused.extra]).toEqual([409, "depth_soft_limit", { depth: 4, limit: 3 }]);
    const deeper = await client.createBranch(parent, { purpose: "level 4", kind: "investigate", anchorMessageId: anchor, confirmDeeper: true });
    expect(deeper.branch.depth).toBe(4);
  });

  it("checks the limits in the Engine's order: a full line refuses before the deeper-branch prompt (R2)", async () => {
    let parent = NAS_ROOT_ID;
    let anchor = "nas-m40";
    for (let depth = 1; depth <= 3; depth += 1) {
      const created = await client.createBranch(parent, { purpose: `level ${depth}`, kind: "investigate", anchorMessageId: anchor });
      const turn = await client.sendMessage(created.line.id, { content: "go" });
      await vi.runAllTimersAsync();
      parent = created.line.id;
      anchor = turn.turnId;
    }
    for (let i = 0; i < 8; i += 1) await client.createBranch(parent, { purpose: `deep ${i}`, kind: "investigate", anchorMessageId: anchor, confirmDeeper: true });
    // domain.CheckBranchCreate: hard depth, open per parent, per tree, then the soft depth last.
    const refused = await rejection(client.createBranch(parent, { purpose: "one more", kind: "investigate", anchorMessageId: anchor }));
    expect([refused.code, refused.extra]).toEqual(["branch_limit", { limit: 8 }]);
  });

  it("caps the open branches under one line", async () => {
    for (let i = 0; i < 6; i += 1) await client.createBranch(NAS_ROOT_ID, { purpose: `b${i}`, kind: "investigate", anchorMessageId: "nas-m40" });
    const refused = await rejection(client.createBranch(NAS_ROOT_ID, { purpose: "one too many", kind: "investigate", anchorMessageId: "nas-m40" }));
    expect([refused.code, refused.extra]).toEqual(["branch_limit", { limit: 8 }]);
  });
});

describe("turns in branches", () => {
  it("ends an aside once it is answered", async () => {
    const aside = await client.createBranch(NAS_ROOT_ID, { purpose: "--fast-list?", kind: "aside", anchorMessageId: "nas-m40" });
    await client.sendMessage(aside.line.id, { content: "what is it?" });
    await vi.runAllTimersAsync();
    const detail = await client.getBranch(aside.line.id);
    expect(detail.branch.status).toBe("discarded");
    expect(detail.branch.closedAt).not.toBeNull();
    expect((await client.getLine(aside.line.id)).conversationBranch?.status).toBe("discarded");
    expect(changes()).toEqual(["created", "discarded"]);
  });

  it("delivers a merged card with the parent's next turn", async () => {
    await client.startDraft("nas-b3");
    await vi.runAllTimersAsync();
    const detail = await client.getBranch("nas-b3");
    expect(detail.draft.parentTipMessageId).toBe("nas-m40");
    const merged = await client.mergeBranch("nas-b3", { card: detail.draft.card!, parentTipMessageId: detail.parentTipMessageId });
    expect(merged.message.meta.delivered).toBeUndefined();
    const turn = await client.sendMessage(NAS_ROOT_ID, { content: "next" });
    expect(turn.pendingMessage.meta.deliversCards).toEqual([merged.message.id]);
    await vi.runAllTimersAsync();
    const card = (await client.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === merged.message.id);
    expect(card?.meta.delivered).toBe(true);
  });
});

describe("moving the tail into a branch", () => {
  it("moves the messages, leaves a marker and re-hangs the branches that forked from them", async () => {
    const result = await client.moveToBranch(NAS_ROOT_ID, { count: 2, purpose: "異地備份", kind: "investigate" });
    expect(result.movedMessageIds).toEqual(["nas-m39", "nas-m40"]);
    expect(result.branch).toMatchObject({ origin: "move", anchorMessageId: "nas-m26", messageCount: 2, depth: 1, purpose: "異地備份" });
    expect(result.marker).toMatchObject({ lineId: NAS_ROOT_ID, kind: "branch_marker", meta: { branchLineId: result.line.id } });
    expect(result.reparented).toEqual(["nas-b2"]);
    const main = (await client.listMessages(NAS_ROOT_ID)).messages.map((message) => message.id);
    expect(main.slice(-2)).toEqual(["nas-m26", result.marker.id]);
    expect((await client.listMessages(result.line.id)).messages.map((message) => message.id)).toEqual(["nas-m39", "nas-m40"]);
    const rehung = (await client.listBranches(NAS_ROOT_ID)).branches.find((branch) => branch.lineId === "nas-b2");
    expect(rehung).toMatchObject({ parentLineId: result.line.id, depth: 2 });
    expect(changes()).toEqual(["moved"]);
  });

  it("refuses what the server refuses", async () => {
    expect((await rejection(client.moveToBranch(NAS_ROOT_ID, { count: 41, purpose: "x" }))).code).toBe("invalid_count");
    expect((await rejection(client.moveToBranch(NAS_ROOT_ID, { count: 1, purpose: "x" }))).code).toBe("move_must_start_with_user");
    expect((await rejection(client.moveToBranch(NAS_ROOT_ID, { count: 7, purpose: "x" }))).code).toBe("move_protected_message");
  });
});

describe("promoting a branch", () => {
  async function alternativeAt(anchor: string): Promise<string> {
    const created = await client.createBranch(NAS_ROOT_ID, { purpose: "改用雲端", kind: "alternative", anchorMessageId: anchor });
    await client.sendMessage(created.line.id, { content: "go cloud" });
    await vi.runAllTimersAsync();
    return created.line.id;
  }

  it("refuses while a branch on the put-away tail is open, naming it", async () => {
    const id = await alternativeAt("nas-m26");
    const refused = await rejection(client.promoteBranch(id));
    expect([refused.code, refused.extra.lineIds]).toEqual(["open_branches_on_old_tail", ["nas-b2"]]);
  });

  it("swaps the transcripts: the old tail becomes the previous main line", async () => {
    await client.discardBranch("nas-b2");
    const id = await alternativeAt("nas-m26");
    const result = await client.promoteBranch(id);
    expect(result.branch).toMatchObject({ lineId: id, status: "promoted" });
    expect(result.previousMainLine).toMatchObject({ origin: "previous_main_line", status: "discarded", kind: "alternative", anchorMessageId: "nas-m26", messageCount: 2 });
    expect(result.line.id).toBe(NAS_ROOT_ID);
    const main = (await client.listMessages(NAS_ROOT_ID)).messages;
    expect(main.at(-2)?.content).toBe("go cloud");
    expect((await client.listMessages(result.previousMainLine.lineId)).messages.map((message) => message.id)).toEqual(["nas-m39", "nas-m40"]);
    const branches = (await client.listBranches(NAS_ROOT_ID)).branches;
    const byId = (lineId: string) => branches.find((branch: BranchView) => branch.lineId === lineId);
    expect(byId("nas-b2")).toMatchObject({ parentLineId: result.previousMainLine.lineId, depth: 2 });
    expect(changes()).toContain("promoted");
  });

  it("only promotes an open branch of the main line", async () => {
    const nested = await client.createBranch("nas-b3", { purpose: "nested", kind: "alternative", anchorMessageId: "nas-b3-5" });
    expect((await rejection(client.promoteBranch(nested.line.id))).code).toBe("promote_not_top_level");
    expect((await rejection(client.promoteBranch("nas-b1"))).code).toBe("branch_closed");
  });
});

describe("chapters and milestones (F2 phase 2)", () => {
  it("starts a milestone chapter at the message, splitting the chapter it falls in", async () => {
    const before = (await client.listChapters(NAS_ROOT_ID)).chapters.map((chapter) => chapter.title);
    await client.addMilestone(NAS_ROOT_ID, { messageId: "nas-m26", title: "Decided ZFS" });
    const after = await client.listChapters(NAS_ROOT_ID);
    expect(after.chapters.map((chapter) => chapter.title)).toEqual([...before.slice(0, 3), "Decided ZFS", before[3]]);
    const added = after.chapters.find((chapter) => chapter.title === "Decided ZFS")!;
    expect(added).toMatchObject({ kind: "milestone", titleSource: "milestone", startMessageId: "nas-m26", milestoneId: after.milestones[0]!.id });
    expect(after.chapters.map((chapter) => chapter.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives a line without stored chapters a start chapter, and a milestone chapter once one is added", async () => {
    const line = await client.createLine({ title: "Fresh" });
    for (const text of ["one", "two"]) {
      await client.sendMessage(line.id, { content: text });
      await vi.runAllTimersAsync();
    }
    const messages = (await client.listMessages(line.id)).messages;
    expect((await client.listChapters(line.id)).chapters.map((chapter) => chapter.kind)).toEqual(["start"]);
    await client.addMilestone(line.id, { messageId: messages[2]!.id, title: "Second" });
    const chapters = (await client.listChapters(line.id)).chapters;
    expect(chapters.map((chapter) => [chapter.kind, chapter.startMessageId, chapter.messageCount])).toEqual([
      ["start", messages[0]!.id, 2],
      ["milestone", messages[2]!.id, 2],
    ]);
  });
});
