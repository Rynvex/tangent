/** The mock's B8 phase B: spinoff (detach, fresh), links and the tree-balance suggestion (docs/devlog/B8-p1.md 階段 B). */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { rebalanceOf, rebalanceResultOf } from "../spinoff";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make(features: "all" | "c1" = "all") {
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ scenario: nasScenario({ features }), chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function turn(c: MockTangentClient, lineId: string, content = "more") {
  await c.sendMessage(lineId, { content });
  for (let i = 0; i < 300 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
}

describe("spinoff: detach", () => {
  it("turns an open branch into a main line with a back-link, a marker on its parent and a link", async () => {
    const { client: c, events } = make();
    const result = await c.spinoff("nas-b3", { mode: "detach", title: "Disk prices" });
    expect(result.mode).toBe("detach");
    expect(result.line).toMatchObject({ id: "nas-b3", title: "Disk prices", conversationBranch: null, spunOffFrom: { lineId: NAS_ROOT_ID, messageId: "nas-m17", title: "家用 NAS 與備份策略" } });
    expect(result.marker).toMatchObject({ lineId: NAS_ROOT_ID, kind: "branch_marker", meta: { spunOffTo: { lineId: "nas-b3", messageId: "nas-m17", title: "Disk prices" } } });
    expect(result.link).toMatchObject({ kind: "spinoff", fromLineId: NAS_ROOT_ID, fromMessageId: "nas-m17", toLineId: "nas-b3", toMessageId: "" });
    expect(result.branch?.lineId).toBe("nas-b3");
    expect((await c.listBranches(NAS_ROOT_ID)).branches.map((branch) => branch.lineId)).not.toContain("nas-b3");
    expect((await c.listLines()).lines.map((line) => line.id)).toContain("nas-b3");
    expect((await c.listLinks(NAS_ROOT_ID)).links).toHaveLength(1);
    expect((await c.listLinks("nas-b3")).links[0]?.id).toBe(result.link.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["line.created", "message.created", "link.changed", "branch.changed"]));
    expect(events.find((event) => event.type === "branch.changed")?.data).toMatchObject({ change: "detached" });
  });

  it("refuses an ended branch and a main line", async () => {
    const { client: c } = make();
    const ended = await c.spinoff("nas-b1", { mode: "detach" }).catch((error: unknown) => error);
    expect((ended as TangentError).code).toBe("branch_closed");
    const main = await c.spinoff(NAS_ROOT_ID, { mode: "detach" }).catch((error: unknown) => error);
    expect((main as TangentError).code).toBe("branch_not_found");
  });
});

describe("spinoff: preview and availability (B8.2)", () => {
  it("previews the capsule and the notes to copy without writing anything", async () => {
    const { client: c, events } = make();
    const preview = await c.previewSpinoff("nas-b3", { mode: "detach", copyNotes: true });
    expect(preview).toMatchObject({ mode: "detach", capsule: { tokenBudget: 6000, truncated: false } });
    expect(preview.capsule.text).toContain("家用 NAS 與備份策略");
    expect(preview.capsule.tokenEstimate).toBeGreaterThan(0);
    expect(preview.notesToCopy).toBe(6);
    expect(events).toHaveLength(0);
    const closed = await c.previewSpinoff("nas-b1", { mode: "detach" }).catch((error: unknown) => error);
    expect((closed as TangentError).code).toBe("branch_closed");
  });

  it("says when the other conversation is gone", async () => {
    const { client: c } = make();
    const result = await c.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19" });
    expect((await c.getLine(result.line.id)).spunOffFrom?.available).toBe(true);
    await c.deleteLine(result.line.id);
    const marker = (await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.meta.spunOffTo);
    expect(marker?.meta.spunOffTo?.available).toBe(false);
  });
});

describe("spinoff: fresh", () => {
  it("starts a new conversation from a message, copying the notes when asked; the source tree is unchanged", async () => {
    const { client: c } = make();
    const result = await c.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19", title: "Filesystems", copyNotes: true });
    expect(result.line).toMatchObject({ title: "Filesystems", conversationBranch: null, spunOffFrom: { lineId: NAS_ROOT_ID, messageId: "nas-m19" } });
    expect(result.notes?.created.length).toBeGreaterThan(0);
    expect(result.notes?.created[0]?.copiedFromNoteId).toBeTruthy();
    expect((await c.listNotes(result.line.id)).notes.length).toBe(result.notes?.created.length);
    expect((await c.listBranches(NAS_ROOT_ID)).branches.length).toBe(nasScenario().branches.filter((branch) => branch.kind !== "aside").length);
    const bad = await c.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nope" }).catch((error: unknown) => error);
    expect((bad as TangentError).code).toBe("anchor_not_found");
  });

  it("is a 404 feature_disabled with the spinoff feature off", async () => {
    const { client: c } = make("c1");
    const off = await c.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19" }).catch((error: unknown) => error);
    expect((off as TangentError).extra).toEqual({ feature: "spinoff" });
  });
});

describe("tree balance", () => {
  it("proposes promote or spinoff once the tree's last 5 replies are all in a branch; accepting spins it off", async () => {
    const { client: c } = make();
    const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m40", purpose: "Cloud only", kind: "alternative" });
    for (let i = 0; i < 4; i += 1) await turn(c, created.line.id);
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions.filter((item) => item.feature === "rebalance")).toHaveLength(0);
    await turn(c, created.line.id);
    const suggestion = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "rebalance");
    expect(rebalanceOf(suggestion!)).toMatchObject({ lineId: created.line.id, reason: "recent", branchTurns: 5, recentInBranch: true, actions: ["promote", "spinoff"], parentIsMain: true, parentTitle: "" });
    const accepted = await c.acceptSuggestion(suggestion!.id, { action: "spinoff", title: "Cloud plan" });
    expect(accepted.suggestion.status).toBe("accepted");
    expect(rebalanceResultOf(accepted.result)).toMatchObject({ action: "spinoff", line: { id: created.line.id, title: "Cloud plan" } });
  });

  it("dismissing (維持) is permanent for that branch; a bad action is invalid_input", async () => {
    const { client: c } = make();
    const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m40", purpose: "Cloud only", kind: "alternative" });
    for (let i = 0; i < 6; i += 1) await turn(c, created.line.id);
    const first = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "rebalance")!;
    const bad = await c.acceptSuggestion(first.id, { action: "teleport" }).catch((error: unknown) => error);
    expect((bad as TangentError).code).toBe("invalid_input");
    await c.dismissSuggestion(first.id);
    await turn(c, created.line.id);
    expect((await c.listSuggestions(NAS_ROOT_ID)).suggestions.filter((item) => item.feature === "rebalance")).toHaveLength(0);
  });

  it("promotes through the suggestion", async () => {
    const { client: c } = make();
    const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m40", purpose: "Cloud only", kind: "alternative" });
    for (let i = 0; i < 6; i += 1) await turn(c, created.line.id);
    const suggestion = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "rebalance")!;
    // The scenario's open branch nas-b2 hangs on the old tail; it has to end first.
    await c.discardBranch("nas-b2");
    const accepted = await c.acceptSuggestion(suggestion.id, { action: "promote" });
    expect(rebalanceResultOf(accepted.result)).toMatchObject({ action: "promote", line: { id: NAS_ROOT_ID } });
  });
});
