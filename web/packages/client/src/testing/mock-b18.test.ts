/** The mock's B18 routes behave as the server's (docs/devlog/B18-import-extract-organize.md, docs/API.md). */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make() {
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TangentError);
  const failure = error as TangentError;
  return { status: failure.status, code: failure.code, extra: failure.extra };
};

const conversation = [
  { externalId: "m1", role: "user" as const, content: "Explain Postgres MVCC" },
  { externalId: "m2", role: "assistant" as const, content: "Snapshots per transaction." },
  { externalId: "m3", role: "user" as const, content: "Docker cannot reach the host Postgres: connection refused error" },
  { externalId: "m4", role: "assistant" as const, content: "Use host.docker.internal instead. Or the host network." },
  { externalId: "m5", role: "user" as const, content: "Back to Postgres MVCC: when does vacuum run?" },
  { externalId: "m6", role: "assistant" as const, content: "When dead tuples pass a threshold.\n- Should the scale factor change?\nWant an example?" },
];

describe("folders and tags", () => {
  it("filters the list by folder (and unfiled) and by tag, normalised", async () => {
    const { client: c } = make();
    expect((await c.listLines({ folder: "家用設備" })).lines.map((line) => line.id)).toEqual([NAS_ROOT_ID]);
    expect((await c.listLines({ tag: "#NAS" })).lines.map((line) => line.id)).toEqual([NAS_ROOT_ID]);
    expect((await c.listLines({ tag: "nas", archived: true })).lines.map((line) => line.id)).toEqual(["arch-1"]);
    expect((await c.listLines({ folder: "__unfiled__" })).lines.map((line) => line.id)).toEqual(["rust", "okr"]);
  });

  it("PATCHes a main line's folder and tags, refuses them on a branch and the reserved name", async () => {
    const { client: c, events } = make();
    const line = await c.updateLine("rust", { folder: " 程式 ", tags: ["Rust", "#rust", "borrow"] });
    expect(line).toMatchObject({ folder: "程式", tags: ["rust", "borrow"] });
    expect(events.at(-1)).toMatchObject({ type: "line.updated", lineId: "rust" });
    expect(await refusal(c.updateLine("nas-b3", { tags: ["x"] }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "tags" } });
    expect((await c.updateLine("nas-b3", { tags: [], folder: "" })).tags).toEqual([]);
    expect(await refusal(c.updateLine("rust", { folder: "__unfiled__" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "folder" } });
    expect(await refusal(c.updateLine("rust", { tags: Array.from({ length: 13 }, (_, index) => `t${index}`) }))).toMatchObject({ code: "invalid_input" });
  });

  it("renames a folder (archived lines too) and dissolves one", async () => {
    const { client: c, events } = make();
    expect(await c.renameFolder({ from: "家用設備", to: "Home lab" })).toEqual({ updated: 2 });
    expect(events.filter((event) => event.type === "line.updated").map((event) => event.lineId).sort()).toEqual(["arch-1", NAS_ROOT_ID].sort());
    expect((await c.getLine(NAS_ROOT_ID)).folder).toBe("Home lab");
    expect(await c.renameFolder({ from: "旅行", to: "" })).toEqual({ updated: 1 });
    expect((await c.getLine("osaka")).folder).toBe("");
    expect(await c.renameFolder({ from: "Home lab", to: "Home lab" })).toEqual({ updated: 0 });
    expect(await refusal(c.renameFolder({ from: "", to: "x" }))).toMatchObject({ code: "invalid_input", extra: { field: "from" } });
  });
});

describe("import", () => {
  it("writes the main line, its branches (origin import, discarded by default) and their events, without a turn", async () => {
    const { client: c, events } = make();
    const result = await c.importConversation({
      folder: "Databases",
      tags: ["Postgres"],
      source: "chatgpt",
      messages: conversation,
      branches: [{ anchorExternalId: "m2", messages: [{ role: "user", content: "What about table locks?" }] }],
    });
    expect(result.line).toMatchObject({ title: "Explain Postgres MVCC", folder: "Databases", tags: ["postgres"], status: "idle", unread: 0, branchCounts: { discarded: 1, open: 0 } });
    expect(result.messageCount).toBe(6);
    expect(result.branches[0]).toMatchObject({ origin: "import", kind: "alternative", status: "discarded", purpose: "What about table locks?", depth: 1 });
    const messages = (await c.listMessages(result.line.id)).messages;
    expect(messages.map((message) => message.content)).toEqual(conversation.map((message) => message.content));
    expect(result.branches[0]!.anchorMessageId).toBe(messages[1]!.id);
    expect(events.map((event) => event.type)).toEqual(["line.created", "line.created", "branch.changed"]);
  });

  it("refuses what the server refuses", async () => {
    const { client: c } = make();
    expect(await refusal(c.importConversation({ messages: [] }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "messages" } });
    expect(await refusal(c.importConversation({ messages: [{ role: "system" as never, content: "x" }] }))).toMatchObject({ extra: { field: "messages[0].role" } });
    expect(await refusal(c.importConversation({ messages: [{ role: "user", content: "x".repeat(32_001) }] }))).toMatchObject({ status: 422, code: "too_long" });
    expect(await refusal(c.importConversation({ messages: conversation, branches: [{ anchorExternalId: "nope", messages: [{ role: "user", content: "x" }] }] }))).toMatchObject({
      extra: { field: "branches[0].anchorExternalId" },
    });
    const open = Array.from({ length: 9 }, () => ({ anchorExternalId: "m2", status: "open" as const, messages: [{ role: "user" as const, content: "x" }] }));
    expect(await refusal(c.importConversation({ messages: conversation, branches: open }))).toMatchObject({ status: 409, code: "branch_limit" });
  });
});

describe("extract", () => {
  async function imported(c: MockTangentClient) {
    const result = await c.importConversation({ messages: conversation });
    return { lineId: result.line.id, messages: (await c.listMessages(result.line.id)).messages };
  }

  it("moves the range into a merged branch and leaves a delivered card at the range's own seq", async () => {
    const { client: c, events } = make();
    const { lineId, messages } = await imported(c);
    const before = events.length;
    const result = await c.extractBranch(lineId, {
      fromMessageId: messages[2]!.id,
      toMessageId: messages[3]!.id,
      purpose: "Docker",
      card: { question: "Why?", conclusion: "Use host.docker.internal." },
    });
    expect(result.marker).toMatchObject({ kind: "branch_card", seq: messages[3]!.seq, meta: { delivered: true, branchLineId: result.branch.lineId } });
    expect(result.branch).toMatchObject({ status: "merged", origin: "move", cardMessageId: result.marker.id, conclusionLine: "Use host.docker.internal.", anchorMessageId: messages[1]!.id });
    expect(result.movedMessageIds).toEqual([messages[2]!.id, messages[3]!.id]);
    const source = (await c.listMessages(lineId)).messages.map((message) => message.id);
    expect(source).toEqual([messages[0]!.id, messages[1]!.id, result.marker.id, messages[4]!.id, messages[5]!.id]);
    const moved = (await c.listMessages(result.branch.lineId)).messages;
    expect(moved.map((message) => message.content)).toEqual([messages[2]!.content, messages[3]!.content]);
    expect(moved[1]!.seq).toBeGreaterThan(messages[5]!.seq);
    expect(events.slice(before).map((event) => event.type)).toEqual(expect.arrayContaining(["line.created", "message.created", "line.updated", "branch.changed"]));
  });

  it("leaves a marker and an open branch without a card", async () => {
    const { client: c } = make();
    const { lineId, messages } = await imported(c);
    const result = await c.extractBranch(lineId, { fromMessageId: messages[4]!.id, toMessageId: messages[5]!.id, purpose: "Vacuum", kind: "alternative" });
    expect(result.marker).toMatchObject({ kind: "branch_marker", seq: messages[5]!.seq });
    expect(result.branch).toMatchObject({ status: "open", kind: "alternative" });
  });

  it("refuses with the server's codes and statuses", async () => {
    const { client: c } = make();
    const { lineId, messages } = await imported(c);
    const extract = (from: number, to: number, extra = {}) => c.extractBranch(lineId, { fromMessageId: messages[from]!.id, toMessageId: messages[to]!.id, purpose: "x", ...extra });
    expect(await refusal(extract(1, 2))).toMatchObject({ status: 400, code: "move_must_start_with_user" });
    expect(await refusal(extract(0, 1))).toMatchObject({ status: 400, code: "move_no_anchor" });
    expect(await refusal(extract(3, 2))).toMatchObject({ status: 400, code: "invalid_input" });
    expect(await refusal(extract(2, 3, { kind: "aside" }))).toMatchObject({ status: 400, code: "kind_unsupported" });
    expect(await refusal(extract(2, 3, { card: { question: "", conclusion: "c" } }))).toMatchObject({ status: 422, code: "invalid_card" });
    const card = await extract(2, 3, { card: { question: "q", conclusion: "c" } });
    const after = (await c.listMessages(lineId)).messages;
    const cardIndex = after.findIndex((message) => message.id === card.marker.id);
    // The range runs over the card now.
    expect(await refusal(c.extractBranch(lineId, { fromMessageId: after[cardIndex - 1]!.id, toMessageId: after[cardIndex + 1]!.id, purpose: "x" }))).toMatchObject({ status: 400 });
    await c.sendMessage(lineId, { content: "busy now" });
    expect(await refusal(c.extractBranch(lineId, { fromMessageId: after[cardIndex + 1]!.id, toMessageId: after[cardIndex + 2]!.id, purpose: "x" }))).toMatchObject({ status: 409, code: "source_busy" });
  });

  it("refuses a range holding a branch brought back whose card stays on the line", async () => {
    const { client: c } = make();
    const { lineId, messages } = await imported(c);
    const branch = await c.createBranch(lineId, { anchorMessageId: messages[3]!.id, purpose: "side", kind: "investigate" });
    const tip = (await c.getBranch(branch.line.id)).parentTipMessageId;
    await c.mergeBranch(branch.line.id, { card: { question: "q", conclusion: "c", evidence: [], impact: "", openItems: [], needsDecision: [], excerpts: [] }, parentTipMessageId: tip });
    expect(await refusal(c.extractBranch(lineId, { fromMessageId: messages[2]!.id, toMessageId: messages[3]!.id, purpose: "x" }))).toMatchObject({ status: 400, code: "move_protected_message" });
  });
});

describe("organization (B18.1)", () => {
  it("counts every main line's folder (archived ones apart) and the tags of unarchived main lines", async () => {
    const { client: c } = make();
    expect(await c.getLineOrganization()).toEqual({
      folders: [
        { folder: "家用設備", active: 1, archived: 1 },
        { folder: "旅行", active: 1, archived: 0 },
      ],
      tags: ["nas", "rust", "zfs", "備份", "日本"].map((tag) => ({ tag, count: 1 })),
    });
    await c.importConversation({ folder: "家用設備", tags: ["NAS", "proxmox"], messages: conversation, branches: [{ anchorExternalId: "m2", messages: [{ role: "user", content: "x" }] }] });
    await c.archiveLine("osaka");
    const organization = await c.getLineOrganization();
    // A folder whose lines are all archived still shows; archived lines' tags (proxmox on arch-1, 日本 on osaka) do not count; branches never count.
    expect(organization.folders).toEqual([
      { folder: "家用設備", active: 2, archived: 1 },
      { folder: "旅行", active: 0, archived: 1 },
    ]);
    expect(organization.tags).toEqual([
      { tag: "nas", count: 2 },
      { tag: "proxmox", count: 1 },
      { tag: "rust", count: 1 },
      { tag: "zfs", count: 1 },
      { tag: "備份", count: 1 },
    ]);
  });
});

describe("extract: folds and chapter cuts (B18.1, as store/branch_extract.go)", () => {
  const longer = [...conversation, { externalId: "m7", role: "user" as const, content: "And indexes?" }, { externalId: "m8", role: "assistant" as const, content: "REINDEX CONCURRENTLY." }];

  async function imported(c: MockTangentClient) {
    const result = await c.importConversation({ messages: longer });
    return { lineId: result.line.id, messages: (await c.listMessages(result.line.id)).messages };
  }

  const foldEvents = (events: readonly TangentEvent[], from: number) => events.slice(from).filter((event) => event.type === "fold.changed");

  it("moves the folds inside the range (the one ending on its last message takes the new seq) and leaves the others", async () => {
    const { client: c, events } = make();
    const { lineId, messages: m } = await imported(c);
    const fold = async (from: number, to: number) => (await c.createFold(lineId, { fromMessageId: m[from]!.id, toMessageId: m[to]!.id, summary: `${from}-${to}` })).fold;
    const [before, first, ending, after] = [await fold(0, 1), await fold(2, 3), await fold(4, 5), await fold(6, 7)];
    const start = events.length;
    const result = await c.extractBranch(lineId, { fromMessageId: m[2]!.id, toMessageId: m[5]!.id, purpose: "detour" });
    const moved = (await c.listMessages(result.branch.lineId)).messages;
    const newSeq = moved.at(-1)!.seq;
    expect(newSeq).toBeGreaterThan(m[7]!.seq);
    const onBranch = (await c.listFolds(result.branch.lineId)).folds;
    expect(onBranch.map((item) => [item.id, item.fromSeq, item.toSeq])).toEqual([
      [first.id, m[2]!.seq, m[3]!.seq],
      [ending.id, m[4]!.seq, newSeq],
    ]);
    expect((await c.listFolds(lineId)).folds.map((item) => item.id)).toEqual([before.id, after.id]);
    const sent = foldEvents(events, start);
    expect(sent.map((event) => [event.lineId, (event.data as { fold: { id: string; toSeq: number } }).fold.id, (event.data as { fold: { toSeq: number } }).fold.toSeq])).toEqual([
      [result.branch.lineId, first.id, m[3]!.seq],
      [result.branch.lineId, ending.id, newSeq],
    ]);
  });

  it("removes the folds that cross the range's ends", async () => {
    const { client: c, events } = make();
    const { lineId, messages: m } = await imported(c);
    const fold = async (from: number, to: number) => (await c.createFold(lineId, { fromMessageId: m[from]!.id, toMessageId: m[to]!.id, summary: `${from}-${to}` })).fold;
    const [acrossStart, acrossEnd] = [await fold(0, 2), await fold(3, 4)];
    const start = events.length;
    const result = await c.extractBranch(lineId, { fromMessageId: m[2]!.id, toMessageId: m[3]!.id, purpose: "detour" });
    expect((await c.listFolds(lineId)).folds).toEqual([]);
    expect((await c.listFolds(result.branch.lineId)).folds).toEqual([]);
    const removed = c.mock.snapshot().folds.filter((item) => item.status === "removed").map((item) => [item.id, item.lineId]);
    expect(removed).toEqual([
      [acrossStart.id, lineId],
      [acrossEnd.id, lineId],
    ]);
    expect(foldEvents(events, start).map((event) => (event.data as { fold: { id: string; status: string } }).fold)).toMatchObject([
      { id: acrossStart.id, status: "removed" },
      { id: acrossEnd.id, status: "removed" },
    ]);
  });

  it("puts the newest cut of the range on the marker when the line goes on, and leaves the older one with its message", async () => {
    const { client: c, events } = make();
    const { lineId, messages: m } = await imported(c);
    const older = (await c.addMilestone(lineId, { messageId: m[2]!.id, title: "Older" })).milestone;
    const newest = (await c.addMilestone(lineId, { messageId: m[4]!.id, title: "Newest" })).milestone;
    const start = events.length;
    const result = await c.extractBranch(lineId, { fromMessageId: m[2]!.id, toMessageId: m[5]!.id, purpose: "detour" });
    expect((await c.listChapters(lineId)).milestones.map((item) => [item.id, item.messageId])).toEqual([[newest.id, result.marker.id]]);
    expect((await c.listChapters(result.branch.lineId)).milestones.map((item) => [item.id, item.messageId])).toEqual([[older.id, m[2]!.id]]);
    expect(events.slice(start).filter((event) => event.type === "chapters.changed").map((event) => event.lineId)).toEqual([lineId]);
  });

  it("moves no cut for a range at the end of the line", async () => {
    const { client: c, events } = make();
    const { lineId, messages: m } = await imported(c);
    const cut = (await c.addMilestone(lineId, { messageId: m[6]!.id, title: "Tail" })).milestone;
    const start = events.length;
    const result = await c.extractBranch(lineId, { fromMessageId: m[6]!.id, toMessageId: m[7]!.id, purpose: "tail" });
    expect((await c.listChapters(result.branch.lineId)).milestones.map((item) => [item.id, item.messageId])).toEqual([[cut.id, m[6]!.id]]);
    expect(events.slice(start).some((event) => event.type === "chapters.changed")).toBe(false);
  });
});

describe("decompose", () => {
  it("finds the detour, the parked questions and the related conversations without writing anything", async () => {
    const { client: c, events } = make();
    const result = await c.importConversation({ title: "Postgres MVCC", tags: ["nas"], messages: conversation });
    const before = events.length;
    const plan = await c.decomposeLine(result.line.id);
    const messages = (await c.listMessages(result.line.id)).messages;
    expect(plan.lineId).toBe(result.line.id);
    expect(plan.detourRanges).toEqual([
      {
        anchorMessageId: messages[1]!.id,
        fromMessageId: messages[2]!.id,
        toMessageId: messages[3]!.id,
        messageCount: 2,
        purpose: "Look into: Docker cannot reach the host Postgres:…",
        suggestedConclusion: "Use host.docker.internal instead.",
      },
    ]);
    expect(plan.seedCandidates.map((seed) => [seed.text, seed.reason])).toEqual([
      ["Should the scale factor change?", "open_item"],
      ["Want an example?", "question"],
    ]);
    expect(plan.suggestedTags).toContain("postgres");
    expect(plan.relatedLines.map((line) => line.lineId)).toEqual([NAS_ROOT_ID]);
    expect(events.length).toBe(before);
  });

  it("suggests whole Chinese words, as the server since B18.1 (domain/decompose_test.go has the same conversation)", async () => {
    const { client: c } = make();
    const result = await c.importConversation({
      title: "微分幾何在研究什麼?",
      messages: [
        { role: "user", content: "微分幾何在研究什麼?" },
        { role: "assistant", content: "微分幾何是用微積分與線性代數的工具，研究**曲線、曲面以及更一般的「流形」的形狀與性質**。\n\n**核心問題**\n- **彎曲程度**：一個空間有多彎？例如曲線的曲率、曲面的高斯曲率。" },
        { role: "user", content: "微分幾何在CV領域有什麼用途或應用?" },
        { role: "assistant", content: "微分幾何在 CV（電腦視覺）中主要出現在「形狀、變換、不確定性」這幾類問題上。\n\n**1. 3D 幾何與曲面處理**\n- **網格／點雲分析**：用曲率（平均曲率、高斯曲率）做特徵點偵測。" },
      ],
    });
    const tags = (await c.decomposeLine(result.line.id)).suggestedTags;
    expect(tags.slice(0, 2)).toEqual(["微分幾何", "研究"]);
    for (const fragment of ["分幾", "何在", "微分", "幾何"]) expect(tags).not.toContain(fragment);
  });
});
