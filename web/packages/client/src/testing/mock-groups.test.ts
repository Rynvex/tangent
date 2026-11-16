/** The mock's B9 phase C simulation: groups, combining, group suggestions, relation labels and job.failed (docs/devlog/B9-p2.md 階段 C). */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make() {
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ scenario: nasScenario(), chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(TangentError);
  return error as TangentError;
}

describe("groups", () => {
  it("groups ended branches; the summary drafts and lands with group.changed", async () => {
    const { client: c, events } = make();
    const made = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "  Hardware  " });
    expect(made.group).toMatchObject({ title: "Hardware", summaryStatus: "drafting", status: "active", memberLineIds: ["nas-b5", "nas-b4"] });
    expect(made.job?.kind).toBe("group_summary");
    await sleep(10);
    expect((await c.getGroup(made.group.id)).group).toMatchObject({ summaryStatus: "ready", summary: expect.stringContaining("fake runner") });
    expect(events.filter((event) => event.type === "group.changed").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses open, unfinished or already grouped members, and too few", async () => {
    const { client: c } = make();
    expect((await rejection(c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4"], title: "x" }))).code).toBe("invalid_group");
    expect((await rejection(c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b3"], title: "x" }))).code).toBe("invalid_group");
    await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "x" });
    expect((await rejection(c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b1"], title: "y" }))).code).toBe("invalid_group");
  });

  it("R8: a promoted branch is no member", async () => {
    const { client: c } = make();
    const last = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat").at(-1)!.id;
    const open = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: last, purpose: "P", kind: "investigate" });
    await c.promoteBranch(open.line.id);
    expect((await rejection(c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", open.line.id], title: "x" }))).code).toBe("invalid_group");
  });

  it("R8: detaching a subtree dissolves the groups it takes members of, with group.changed", async () => {
    const { client: c, events } = make();
    const parent = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Parent", kind: "investigate" });
    await c.sendMessage(parent.line.id, { content: "go" });
    for (let i = 0; i < 300 && (await c.getLine(parent.line.id)).status === "thinking"; i += 1) await sleep(2);
    const fork = (await c.listMessages(parent.line.id)).messages.at(-1)!.id;
    const child = await c.createBranch(parent.line.id, { anchorMessageId: fork, purpose: "Child", kind: "investigate" });
    await c.discardBranch(child.line.id, { leaf: { kind: "dead_end", line: "no" } });
    const { group } = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", child.line.id], title: "x" });
    events.length = 0;
    await c.spinoff(parent.line.id, { mode: "detach" });
    expect((await c.listGroups(NAS_ROOT_ID)).groups).toEqual([]);
    expect(events.find((event) => event.type === "group.changed")?.data).toMatchObject({ group: { id: group.id, status: "dissolved" } });
  });

  it("keepBoth writes a 待確認 note; a conflict without a choice is refused", async () => {
    const { client: c } = make();
    const conflict = { branch: { lineId: "nas-b5", claim: "yes" }, other: { lineId: "nas-b4", claim: "no" } };
    expect((await rejection(c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "x", conflicts: [conflict] }))).code).toBe("invalid_group");
    const made = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "x", conflicts: [{ ...conflict, choice: "keepBoth" }] });
    expect(made.notes?.created[0]).toMatchObject({ section: "to_confirm" });
  });

  it("renames, re-summarizes and dissolves; a dissolved group is not active", async () => {
    const { client: c } = make();
    const { group } = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "x" });
    expect((await c.renameGroup(group.id, { title: "y" })).group.title).toBe("y");
    expect((await c.summarizeGroup(group.id)).kind).toBe("group_summary");
    expect((await c.dissolveGroup(group.id)).group.status).toBe("dissolved");
    expect((await rejection(c.dissolveGroup(group.id))).code).toBe("group_not_active");
    expect((await c.listGroups(NAS_ROOT_ID)).groups).toEqual([]);
    expect((await c.listGroups(NAS_ROOT_ID, { status: "all" })).groups).toHaveLength(1);
  });

  it("[fake:job-error] in a member's ending fails the summary with job.failed", async () => {
    const { client: c, events } = make();
    await c.putLeaf("nas-b5", { kind: "dead_end", line: "broken [fake:job-error]" });
    const { group } = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "x" });
    await sleep(10);
    expect((await c.getGroup(group.id)).group.summaryStatus).toBe("failed");
    expect(events.find((event) => event.type === "job.failed")?.data).toMatchObject({ kind: "group_summary", error: { code: "run_failed" } });
  });

  it("a ready group stands for its members in the fisheye report", async () => {
    const { client: c } = make();
    const { group } = await c.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b4", "nas-b5"], title: "Hardware" });
    await sleep(10);
    const items = (await c.previewTurn(NAS_ROOT_ID, { content: "x" })).fisheye!.items;
    expect(items.find((item) => item.kind === "group")).toMatchObject({ id: group.id, level: "leaf_only", lineId: "" });
    expect(items.some((item) => item.lineId === "nas-b5")).toBe(false);
  });
});

describe("combining", () => {
  it("combines open siblings into one new branch; the old ones end, pointing to it, and their open children move under it", async () => {
    const { client: c } = make();
    const a = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "A", kind: "investigate" });
    const b = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m19", purpose: "B", kind: "investigate" });
    const child = await c.createBranch(a.line.id, { anchorMessageId: "nas-m17", purpose: "under A", kind: "investigate" }).catch(() => null);
    const result = await c.combineBranches(NAS_ROOT_ID, { lineIds: [a.line.id, b.line.id], purpose: "Both" });
    expect(result.branch).toMatchObject({ origin: "merge", parentLineId: NAS_ROOT_ID, anchorMessageId: "nas-m19", status: "open" });
    expect(result.combined.map((item) => [item.status, item.mergedIntoLineId])).toEqual([
      ["discarded", result.line.id],
      ["discarded", result.line.id],
    ]);
    if (child) expect(result.reparented).toEqual([child.line.id]);
  });

  it("B9.1: a moved child keeps its anchor; branch.changed{moved} then line.updated of the old branch; reparented is always sent", async () => {
    const { client: c, events } = make();
    const a = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "A", kind: "investigate" });
    const b = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m19", purpose: "B", kind: "investigate" });
    const plain = await c.combineBranches(NAS_ROOT_ID, { lineIds: [a.line.id, b.line.id], purpose: "Both" });
    expect(plain.reparented).toEqual([]);
    const x = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "X", kind: "investigate" });
    const y = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Y", kind: "investigate" });
    await c.sendMessage(x.line.id, { content: "hello" });
    for (let i = 0; i < 300 && (await c.getLine(x.line.id)).status === "thinking"; i += 1) await sleep(2);
    const fork = (await c.listMessages(x.line.id)).messages.at(-1)!.id;
    const child = await c.createBranch(x.line.id, { anchorMessageId: fork, purpose: "under X", kind: "investigate" });
    events.length = 0;
    const result = await c.combineBranches(NAS_ROOT_ID, { lineIds: [x.line.id, y.line.id], purpose: "XY" });
    expect(result.reparented).toEqual([child.line.id]);
    const moved = (await c.getBranch(child.line.id)).branch;
    expect(moved).toMatchObject({ parentLineId: result.line.id, anchorMessageId: fork });
    const order = events.map((event) => `${event.type}:${(event.data as { change?: string }).change ?? (event.data as { id?: string }).id ?? ""}`);
    const movedAt = order.indexOf("branch.changed:moved");
    expect(movedAt).toBeGreaterThan(order.lastIndexOf("branch.changed:discarded"));
    expect(order.slice(movedAt)).toContain(`line.updated:${x.line.id}`);
  });

  it("R8: re-hung children combine under the newest finished reply of their new parent, or not before it has one", async () => {
    const { client: c } = make();
    const reply = async (lineId: string, content: string) => {
      await c.sendMessage(lineId, { content });
      for (let i = 0; i < 300 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
      return (await c.listMessages(lineId)).messages.at(-1)!.id;
    };
    const x = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "X", kind: "investigate" });
    const y = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Y", kind: "investigate" });
    const c1 = await c.createBranch(x.line.id, { anchorMessageId: await reply(x.line.id, "x?"), purpose: "C1", kind: "investigate" });
    const c2 = await c.createBranch(y.line.id, { anchorMessageId: await reply(y.line.id, "y?"), purpose: "C2", kind: "investigate" });
    const n1 = await c.combineBranches(NAS_ROOT_ID, { lineIds: [x.line.id, y.line.id], purpose: "N1" });
    expect((await rejection(c.combineBranches(n1.line.id, { lineIds: [c1.line.id, c2.line.id], purpose: "C" }))).code).toBe("anchor_not_found");
    const at = await reply(n1.line.id, "n1?");
    expect((await c.combineBranches(n1.line.id, { lineIds: [c1.line.id, c2.line.id], purpose: "C" })).branch.anchorMessageId).toBe(at);
  });

  it("refuses ended or non-sibling branches", async () => {
    const { client: c } = make();
    expect((await rejection(c.combineBranches(NAS_ROOT_ID, { lineIds: ["nas-b3", "nas-b4"], purpose: "x" }))).code).toBe("invalid_group");
  });
});

describe("group suggestions", () => {
  it("after a branch ends, proposes the newest two ended ones (with a conflict) and the newest two open siblings; accepting groups them", async () => {
    const { client: c } = make();
    await c.discardBranch("nas-b3");
    const proposals = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.filter((item) => item.feature === "group");
    const ended = proposals.find((item) => (item.payload.members as Array<{ ended: boolean }>).every((member) => member.ended))!;
    expect((ended.payload.conflicts as unknown[]).length).toBe(1);
    const accepted = await c.acceptSuggestion(ended.id, { choices: { c1: "keepBoth" } });
    expect(accepted.result).toMatchObject({ action: "group", group: { status: "active" } });
  });
});

describe("relation label and goal job failure", () => {
  it("changes a relation's label with link.changed", async () => {
    const { client: c, events } = make();
    const made = await c.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3" });
    expect((await c.updateRelation(NAS_ROOT_ID, made.relation.id, { label: "  same budget " })).relation.label).toBe("same budget");
    expect(events.filter((event) => event.type === "link.changed").at(-1)?.data).toMatchObject({ link: { label: "same budget" } });
  });

  it("[fake:job-error] in the main line makes a goal proposal fail with job.failed", async () => {
    const { client: c, events } = make();
    await c.sendMessage(NAS_ROOT_ID, { content: "[fake:job-error] please" });
    for (let i = 0; i < 300 && (await c.getLine(NAS_ROOT_ID)).status === "thinking"; i += 1) await sleep(2);
    await c.proposeGoal(NAS_ROOT_ID);
    await sleep(10);
    expect(events.filter((event) => event.type === "job.failed").map((event) => (event.data as { kind: string }).kind)).toContain("goal_propose");
  });
});
