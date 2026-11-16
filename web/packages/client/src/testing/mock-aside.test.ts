import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

/** B23 in the mock: keeping an aside, continuing it as a branch, deleting an ended branch — with the server's refusals and events. */

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
  client = createMockTangentClient({ latencyMs: 0, chunkMs: 5 });
  events = [];
  client.subscribe({ handlers: {}, onEvent: (event) => void events.push(event) });
});
afterEach(() => {
  client.mock.dispose();
  vi.useRealTimers();
});

/** An aside on the main line, asked and (unless `answered` is false) answered. */
async function aside(purpose = "What is a scrub?", options: { answered?: boolean; keep?: boolean; target?: MockTangentClient } = {}) {
  const c = options.target ?? client;
  const made = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside", ...(options.keep ? { keep: true } : {}) });
  if (options.answered === false) return made.line.id;
  await c.sendMessage(made.line.id, { content: purpose });
  await vi.runAllTimersAsync();
  return made.line.id;
}

const kinds = () => events.map((event) => (event.type === "branch.changed" ? `branch.changed:${event.data.change}` : event.type));

describe("mock keepBranch", () => {
  it("keeps an answered aside and lets it go again, with one branch.changed{kept} per change", async () => {
    const id = await aside();
    events = [];
    const kept = await client.keepBranch(id, true);
    expect(kept.branch.keptAt).toEqual(expect.any(String));
    expect((await client.getBranch(id)).branch.keptAt).toBe(kept.branch.keptAt);
    await client.keepBranch(id, true);
    await vi.runAllTimersAsync();
    expect(kinds()).toEqual(["branch.changed:kept"]);
    const released = await client.keepBranch(id, false);
    expect("keptAt" in released.branch).toBe(false);
    await vi.runAllTimersAsync();
    expect(kinds()).toEqual(["branch.changed:kept", "branch.changed:kept"]);
  });

  it("keeps an aside from the start (createBranch keep) and still when its answer ends it", async () => {
    const id = await aside("kept from the start", { keep: true });
    const branch = (await client.getBranch(id)).branch;
    expect(branch).toMatchObject({ kind: "aside", status: "discarded" });
    expect(branch.keptAt).toEqual(expect.any(String));
    const ended = events.find((event) => event.type === "branch.changed" && event.data.change === "discarded");
    expect(ended?.type === "branch.changed" && ended.data.branch.keptAt).toBe(branch.keptAt);
  });

  it("refuses keep on another kind of branch at creation (invalid_input, field keep)", async () => {
    const error = await rejection(client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "x", kind: "investigate", keep: true }));
    expect(error).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "keep" } });
  });

  it("refuses a branch that is not an aside, the main line, an unknown line, an archived tree and a tenant without asides", async () => {
    expect(await rejection(client.keepBranch("nas-b4", true))).toMatchObject({ status: 400, code: "kind_unsupported" });
    expect(await rejection(client.keepBranch(NAS_ROOT_ID, true))).toMatchObject({ status: 404, code: "branch_not_found" });
    expect(await rejection(client.keepBranch("nope", true))).toMatchObject({ status: 404, code: "branch_not_found" });
    const id = await aside();
    await client.archiveLine(NAS_ROOT_ID);
    expect(await rejection(client.keepBranch(id, true))).toMatchObject({ status: 409, code: "archived" });
    const off = createMockTangentClient({ latencyMs: 0, scenario: nasScenario({ features: "core" }) });
    expect(await rejection(off.keepBranch("nas-b1a", true))).toMatchObject({ status: 404, code: "feature_disabled", extra: { feature: "aside" } });
    off.mock.dispose();
  });

  it("keeps an aside that is still answering", async () => {
    const id = await aside("still open", { answered: false });
    expect((await client.keepBranch(id, true)).branch).toMatchObject({ status: "open", keptAt: expect.any(String) });
  });
});

describe("mock continueAside", () => {
  it("turns the aside into an open branch at the same place: same message ids and seq, a new line, the aside gone", async () => {
    const id = await aside("What is a connection pool?");
    const before = (await client.listMessages(id)).messages;
    events = [];
    const result = await client.continueAside(id, { purpose: "How big should the pool be?" });
    expect(result.replacedLineId).toBe(id);
    expect(result.line.id).not.toBe(id);
    expect(result.branch).toMatchObject({ lineId: result.line.id, kind: "investigate", status: "open", purpose: "How big should the pool be?", parentLineId: NAS_ROOT_ID, anchorMessageId: "nas-m17", unread: 0, messageCount: 2 });
    expect(result.line).toMatchObject({ title: "How big should the pool be?", unread: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
    expect(result.line.conversationBranch).toMatchObject({ kind: "investigate", status: "open" });
    const after = (await client.listMessages(result.line.id)).messages;
    expect(after.map((message) => [message.id, message.seq, message.content])).toEqual(before.map((message) => [message.id, message.seq, message.content]));
    expect(after.every((message) => message.lineId === result.line.id)).toBe(true);
    expect((await rejection(client.getLine(id))).code).toBe("line_not_found");
    expect((await rejection(client.continueAside(id))).code).toBe("branch_not_found");
    // The new branch takes another turn.
    await client.sendMessage(result.line.id, { content: "And for 200 clients?" });
    await vi.runAllTimersAsync();
    expect((await client.listMessages(result.line.id)).messages).toHaveLength(4);
  });

  it("publishes line.deleted (the tree stays), line.created, the parent's line.updated, then branch.changed{created}", async () => {
    const id = await aside();
    events = [];
    const result = await client.continueAside(id);
    await vi.runAllTimersAsync();
    expect(kinds().slice(0, 4)).toEqual(["line.deleted", "line.created", "line.updated", "branch.changed:created"]);
    const deleted = events[0]!;
    expect(deleted).toMatchObject({ lineId: id, rootLineId: NAS_ROOT_ID, data: { rootLineId: NAS_ROOT_ID, lineIds: [id] } });
    expect(events[1]).toMatchObject({ type: "line.created", lineId: result.line.id });
    expect(events[2]).toMatchObject({ type: "line.updated", lineId: NAS_ROOT_ID });
    expect(events.some((event) => event.type.startsWith("message."))).toBe(false);
  });

  it("keeps the aside's purpose by default, takes alternative, and refuses any other kind", async () => {
    const result = await client.continueAside(await aside("the same purpose"), { kind: "alternative" });
    expect(result.branch).toMatchObject({ kind: "alternative", purpose: "the same purpose" });
    const error = await rejection(client.continueAside(await aside("another"), { kind: "aside" as never }));
    expect(error).toMatchObject({ status: 400, code: "kind_unsupported" });
  });

  it("leaves a memo written on the aside in the tree, with no node", async () => {
    const id = await aside();
    const memo = (await client.createMemo(NAS_ROOT_ID, { lineId: id, text: "remember this" })).memo;
    await client.continueAside(id);
    expect((await client.listMemos(NAS_ROOT_ID)).memos.find((item) => item.id === memo.id)).toMatchObject({ lineId: "", text: "remember this" });
  });

  it("refuses an aside still answering or whose answer failed (branch_busy), a branch of another kind and the main line", async () => {
    const open = await aside("not answered", { answered: false });
    expect(await rejection(client.continueAside(open))).toMatchObject({ status: 409, code: "branch_busy" });
    const failed = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "fails", kind: "aside" });
    await client.sendMessage(failed.line.id, { content: "[fake:error] fail" });
    await vi.runAllTimersAsync();
    // A failed answer leaves the aside open (it can be retried): still busy.
    expect(await rejection(client.continueAside(failed.line.id))).toMatchObject({ status: 409, code: "branch_busy" });
    expect(await rejection(client.continueAside("nas-b4"))).toMatchObject({ status: 400, code: "kind_unsupported" });
    expect(await rejection(client.continueAside(NAS_ROOT_ID))).toMatchObject({ status: 404, code: "branch_not_found" });
  });

  it("refuses an ended aside with no finished answer (no_messages)", async () => {
    // Not reachable through the mock's own turns (a failed answer keeps the aside open): the server's state after a purge race, set by hand.
    const id = await aside();
    const scenario = nasScenario();
    const state = client.mock.snapshot();
    const copy = createMockTangentClient({
      latencyMs: 0,
      scenario: { ...scenario, lines: [...state.lines], branches: [...state.branches], messages: state.messages.map((message) => (message.lineId === id && message.role === "assistant" ? { ...message, status: "error" as const } : message)) },
    });
    expect(await rejection(copy.continueAside(id))).toMatchObject({ status: 409, code: "no_messages" });
    copy.mock.dispose();
  });

  it("refuses when the line above cannot take another open branch (branch_limit), and changes nothing", async () => {
    const id = await aside();
    const open = client.mock.snapshot().branches.filter((branch) => branch.parentLineId === NAS_ROOT_ID && branch.status === "open").length;
    for (let i = open; i < 8; i += 1) await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: `open ${i}`, kind: "investigate" });
    expect(await rejection(client.continueAside(id))).toMatchObject({ status: 409, code: "branch_limit" });
    expect((await client.getBranch(id)).branch).toMatchObject({ kind: "aside", status: "discarded" });
    expect((await client.listMessages(id)).messages).toHaveLength(2);
  });

  it("refuses under an ended parent (parent_closed), in an archived tree and with asides off", async () => {
    expect(await rejection(client.continueAside("nas-b1a"))).toMatchObject({ status: 409, code: "parent_closed" });
    const id = await aside();
    await client.archiveLine(NAS_ROOT_ID);
    expect(await rejection(client.continueAside(id))).toMatchObject({ status: 409, code: "archived" });
    const off = createMockTangentClient({ latencyMs: 0, scenario: nasScenario({ features: "core" }) });
    expect(await rejection(off.continueAside("nas-b1a"))).toMatchObject({ status: 404, code: "feature_disabled" });
    off.mock.dispose();
  });
});

describe("mock deleteBranch", () => {
  it("deletes an ended aside: the tree stays, the outline loses it, the parent's counts follow", async () => {
    const id = await aside("throw me away");
    events = [];
    const result = await client.deleteBranch(id);
    expect(result).toEqual({ rootLineId: NAS_ROOT_ID, lineIds: [id] });
    expect((await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches.some((branch) => branch.lineId === id)).toBe(false);
    expect((await rejection(client.getLine(id))).code).toBe("line_not_found");
    expect((await client.getLine(NAS_ROOT_ID)).id).toBe(NAS_ROOT_ID);
    await vi.runAllTimersAsync();
    expect(kinds()).toEqual(["line.deleted", "line.updated"]);
    expect(events[0]).toMatchObject({ lineId: id, rootLineId: NAS_ROOT_ID, data: { rootLineId: NAS_ROOT_ID, lineIds: [id] } });
    expect((await rejection(client.deleteBranch(id))).code).toBe("line_not_found");
  });

  it("takes everything under a discarded branch along, the branch itself first", async () => {
    const child = await client.createBranch("nas-b2", { anchorMessageId: client.mock.snapshot().messages.find((message) => message.lineId === "nas-b2")!.id, purpose: "a child", kind: "investigate" });
    await client.discardBranch(child.line.id);
    await client.discardBranch("nas-b2");
    const result = await client.deleteBranch("nas-b2");
    expect(result.lineIds).toEqual(["nas-b2", child.line.id]);
    expect(client.mock.snapshot().lines.some((line) => result.lineIds.includes(line.id))).toBe(false);
    expect(client.mock.snapshot().messages.some((message) => result.lineIds.includes(message.lineId))).toBe(false);
  });

  it("refuses the main line, an unknown line, an open branch, a merged one and an open aside", async () => {
    expect(await rejection(client.deleteBranch(NAS_ROOT_ID))).toMatchObject({ status: 400, code: "invalid_input" });
    expect(await rejection(client.deleteBranch("nope"))).toMatchObject({ status: 404, code: "line_not_found" });
    expect(await rejection(client.deleteBranch("nas-b3"))).toMatchObject({ status: 409, code: "branch_not_deletable" });
    expect(await rejection(client.deleteBranch("nas-b1"))).toMatchObject({ status: 409, code: "branch_not_deletable" });
    const open = await aside("not answered", { answered: false });
    expect(await rejection(client.deleteBranch(open))).toMatchObject({ status: 409, code: "branch_not_deletable" });
  });

  it("refuses with branch_busy while a branch under it is still open, and in an archived tree with archived", async () => {
    const child = await client.createBranch("nas-b2", { anchorMessageId: client.mock.snapshot().messages.find((message) => message.lineId === "nas-b2")!.id, purpose: "still open", kind: "investigate" });
    // The server lets a parent be discarded with an open child only through older data; the mock state is set by hand.
    await client.discardBranch("nas-b2");
    expect(client.mock.snapshot().branches.find((branch) => branch.lineId === child.line.id)?.status).toBe("open");
    expect(await rejection(client.deleteBranch("nas-b2"))).toMatchObject({ status: 409, code: "branch_busy" });
    await client.archiveLine(NAS_ROOT_ID);
    expect(await rejection(client.deleteBranch("nas-b4"))).toMatchObject({ status: 409, code: "archived" });
  });

  it("clears mergedIntoLineId of a branch combined into the deleted one (the server's ON DELETE SET NULL)", async () => {
    const a = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router A", kind: "investigate" });
    const b = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router B", kind: "investigate" });
    const combined = await client.combineBranches(NAS_ROOT_ID, { lineIds: [a.line.id, b.line.id], purpose: "Pick the router" });
    const target = combined.branch.lineId;
    expect((await client.getBranch(a.line.id)).branch.mergedIntoLineId).toBe(target);
    expect(await rejection(client.deleteBranch(a.line.id))).toMatchObject({ code: "branch_not_deletable" });
    await client.discardBranch(target);
    await client.deleteBranch(target);
    expect((await client.getBranch(a.line.id)).branch.mergedIntoLineId).toBe("");
  });

  it("leaves a deleted branch's memos in the tree and removes its links", async () => {
    const memo = (await client.createMemo(NAS_ROOT_ID, { lineId: "nas-b4", text: "kept after the delete" })).memo;
    await client.createRelation(NAS_ROOT_ID, { fromLineId: "nas-b4", toLineId: "nas-b5", label: "both dead ends" });
    events = [];
    await client.deleteBranch("nas-b4");
    await vi.runAllTimersAsync();
    expect((await client.listMemos(NAS_ROOT_ID)).memos.find((item) => item.id === memo.id)?.lineId).toBe("");
    expect((await client.listRelations(NAS_ROOT_ID)).relations.some((link) => link.fromLineId === "nas-b4")).toBe(false);
    expect(events.some((event) => event.type === "link.changed" && event.data.deleted === true)).toBe(true);
  });
});
