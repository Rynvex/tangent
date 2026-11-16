import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import type { EventStreamStatus, TangentEvent } from "../events";
import { isFeatureOn } from "../capabilities";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const NOW = new Date("2026-10-15T08:00:00Z");
const CHUNK_MS = 10;

function record(client: MockTangentClient) {
  const events: TangentEvent[] = [];
  const statuses: EventStreamStatus[] = [];
  const subscription = client.subscribe({ handlers: {}, onEvent: (event) => events.push(event), onStatus: (status) => statuses.push(status) });
  return { events, statuses, subscription, types: () => events.map((event) => event.type) };
}

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof TangentError)) throw new Error(`expected a TangentError, got ${String(error)}`);
  return error;
}

describe("createMockTangentClient: reads (scenario 1)", () => {
  const client = createMockTangentClient({ now: () => NOW });

  it("lists main lines newest first, archived ones separately, with branch counts", async () => {
    const page = await client.listLines();
    expect(page.lines.map((line) => line.title)).toEqual(["家用 NAS 與備份策略", "日本行程：大阪 4 天", "學習 Rust 的所有權與借用", "週報的 OKR 用語"]);
    const nas = page.lines.find((line) => line.id === NAS_ROOT_ID)!;
    expect(nas.branchCounts).toEqual({ open: 2, merged: 1, discarded: 2, promoted: 0 });
    expect(nas.branchUnread).toBe(2);
    expect((await client.listLines({ archived: true })).lines).toHaveLength(2);
    const first = await client.listLines({ limit: 3 });
    expect(first.nextCursor).toBe("3");
    expect((await client.listLines({ limit: 3, cursor: first.nextCursor })).lines).toHaveLength(1);
  });

  it("returns a line's messages in seq order, including the merged conclusion card", async () => {
    const { messages } = await client.listMessages(NAS_ROOT_ID);
    const seqs = messages.map((message) => message.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const card = messages.find((message) => message.kind === "branch_card")!;
    expect(card.meta.card?.conclusion).toBe("兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟。");
    expect((await client.listMessages(NAS_ROOT_ID, { afterSeq: 26 })).messages.map((message) => message.id)).toEqual(["nas-m39", "nas-m40"]);
  });

  it("lists the tree's branches, asides only on request", async () => {
    expect((await client.listBranches(NAS_ROOT_ID)).branches).toHaveLength(5);
    const all = (await client.listBranches("nas-b1", { includeAside: true })).branches;
    expect(all).toHaveLength(6);
    expect(all.find((branch) => branch.lineId === "nas-b4")?.conclusionLine).toContain("通電時數");
  });

  it("serves notes, chapters and every capability", async () => {
    const notes = await client.listNotes("nas-b3");
    expect(notes.rootLineId).toBe(NAS_ROOT_ID);
    expect(notes.notes.filter((note) => note.status === "active").map((note) => note.section)).toContain("to_confirm");
    expect((await client.listChapters(NAS_ROOT_ID)).chapters.map((chapter) => chapter.title)).toEqual(["需求盤點", "硬體選擇", "檔案系統", "備份策略"]);
    const capabilities = await client.getCapabilities();
    expect(capabilities.features.every((feature) => feature.enabled)).toBe(true);
    expect(capabilities.features.find((feature) => feature.name === "branch_suggest")?.mode).toBe("suggest");
  });

  it("rejects unknown lines with the domain code", async () => {
    const missing = await rejection(client.getLine("nope"));
    expect([missing.status, missing.code]).toEqual([404, "line_not_found"]);
  });
});

describe("createMockTangentClient: turns and events", () => {
  let client: MockTangentClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockTangentClient({ now: () => NOW, chunkMs: CHUNK_MS });
  });

  afterEach(() => {
    client.mock.dispose();
    vi.useRealTimers();
  });

  it("reports connecting then open, and closed on close", async () => {
    const { statuses, subscription } = record(client);
    await Promise.resolve();
    subscription.close();
    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });

  it("streams a reply as deltas and completes it, in the Engine's event order", async () => {
    const { events, types } = record(client);
    const result = await client.sendMessage(NAS_ROOT_ID, { content: "UPS 要不要買？" });
    expect(result.userMessage.content).toBe("UPS 要不要買？");
    expect(result.pendingMessage.status).toBe("pending");
    expect(types()).toEqual(["message.created", "message.created", "line.updated"]);
    expect((events[2]!.data as { status: string }).status).toBe("thinking");

    await vi.advanceTimersByTimeAsync(CHUNK_MS * 3);
    const streamed = await client.getStream(NAS_ROOT_ID);
    expect(streamed.deltas.length).toBeGreaterThan(0);
    expect(streamed.deltas.every((delta) => delta.turnId === result.turnId)).toBe(true);
    // Delta seqs are global and far above message seqs, like the server's; afterSeq is exclusive.
    const second = streamed.deltas[1]!.seq;
    expect(streamed.seq).toBe(streamed.deltas.at(-1)!.seq);
    expect((await client.getStream(NAS_ROOT_ID, second - 1)).deltas[0]?.seq).toBe(second);
    expect(second).toBeGreaterThan(1000);
    expect((await rejection(client.sendMessage(NAS_ROOT_ID, { content: "again" }))).code).toBe("turn_pending");

    await vi.runAllTimersAsync();
    // The turn ends with the reply's message.updated then line.updated; AI's tags (ibis suggest) come after, as their own updates.
    const done = events.findIndex((event) => event.type === "message.updated" && (event.data as { id: string; status: string }).id === result.pendingMessage.id && (event.data as { status: string }).status === "done");
    const updated = events[done]!;
    expect((updated.data as { content: string }).content).toContain("UPS 建議買一台 600VA");
    expect(events[done + 1]?.type).toBe("line.updated");
    expect(types().slice(done + 2).every((type) => type === "message.updated")).toBe(true);
    // Like the server's buffer, the finished turn's deltas stay readable (filter by turnId).
    expect((await client.getStream(NAS_ROOT_ID)).deltas.every((delta) => delta.turnId === result.turnId)).toBe(true);
    expect((await client.getLine(NAS_ROOT_ID)).status).toBe("idle");
  });

  it("cancels a running turn, keeping what streamed so far", async () => {
    const { events } = record(client);
    const result = await client.sendMessage(NAS_ROOT_ID, { content: "hi" });
    await vi.advanceTimersByTimeAsync(CHUNK_MS * 2);
    const outcome = await client.cancelTurn(NAS_ROOT_ID);
    const cancelled = events.find((event) => event.type === "message.updated")!.data;
    // Like the server: a cancelled reply is "done" with meta.cancelled and keeps the streamed text.
    expect(cancelled).toMatchObject({ id: result.pendingMessage.id, status: "done", meta: { cancelled: true } });
    expect((cancelled as { content: string }).content.length).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ cancelled: true, line: { status: "idle" }, message: { id: result.pendingMessage.id } });
    // Nothing running: no error, nothing cancelled.
    expect(await client.cancelTurn(NAS_ROOT_ID)).toMatchObject({ cancelled: false, message: null });
  });

  it("follows the fake runner's directives: retry reports turn.retrying, slow waits, error fails", async () => {
    const { events, types } = record(client);
    const retry = await client.sendMessage(NAS_ROOT_ID, { content: "[fake:retry] [fake:slow] hi" });
    expect(types()).toContain("turn.retrying");
    expect(events.find((event) => event.type === "turn.retrying")?.data).toMatchObject({ turnId: retry.turnId, attempt: 1, maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(types()).not.toContain("message.delta");
    await vi.runAllTimersAsync();
    expect(types()).toContain("message.delta");

    const failed = await client.sendMessage(NAS_ROOT_ID, { content: "[fake:error]" });
    await vi.runAllTimersAsync();
    const done = events.filter((event) => event.type === "message.updated").at(-1)!.data;
    expect(done).toMatchObject({ id: failed.turnId, status: "error", meta: { error: "the fake runner was told to fail" } });
    expect(await client.getLine(NAS_ROOT_ID)).toMatchObject({ status: "error", statusDetail: "the fake runner was told to fail" });
  });

  it("retries the last failed turn under the same user message (B4.1 POST /retry)", async () => {
    expect((await rejection(client.retryTurn(NAS_ROOT_ID))).code).toBe("nothing_to_retry");
    const failed = await client.sendMessage(NAS_ROOT_ID, { content: "[fake:error]" });
    await vi.runAllTimersAsync();
    const retried = await client.retryTurn(NAS_ROOT_ID);
    expect(retried.userMessage.id).toBe(failed.userMessage.id);
    expect(retried.turnId).not.toBe(failed.turnId);
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    expect(messages.filter((message) => message.id === failed.turnId)[0]?.status).toBe("error");
    expect(messages.at(-1)).toMatchObject({ id: retried.turnId, status: "pending" });
  });

  it("refuses turns on ended branches", async () => {
    expect((await rejection(client.sendMessage("nas-b1", { content: "more" }))).code).toBe("branch_closed");
  });

  it("opens a branch and updates the parent's counts", async () => {
    const { types } = record(client);
    const result = await client.createBranch(NAS_ROOT_ID, { purpose: "UPS 的容量怎麼算", kind: "investigate", anchorMessageId: "nas-m40" });
    expect(result.branch).toMatchObject({ parentLineId: NAS_ROOT_ID, depth: 1, status: "open", purpose: "UPS 的容量怎麼算" });
    expect(result.line.conversationBranch?.rootLineId).toBe(NAS_ROOT_ID);
    expect(types()).toEqual(["line.created", "branch.changed", "line.updated"]);
    expect((await client.getLine(NAS_ROOT_ID)).branchCounts.open).toBe(3);
    expect((await rejection(client.createBranch(NAS_ROOT_ID, { purpose: "x", kind: "aside", anchorMessageId: "nope" }))).code).toBe("anchor_not_found");
  });

  it("drafts a card, then merges it into the parent as a branch_card message", async () => {
    const { events } = record(client);
    await client.startDraft("nas-b3");
    expect((await client.getBranch("nas-b3")).draft.status).toBe("drafting");
    await vi.advanceTimersByTimeAsync(5000);
    const detail = await client.getBranch("nas-b3");
    expect(detail.draft.status).toBe("ready");
    expect(detail.draft.card?.conclusion).toContain("8TB 每 TB 成本最低");
    const merged = await client.mergeBranch("nas-b3", { card: detail.draft.card!, parentTipMessageId: detail.parentTipMessageId });
    expect(merged.message).toMatchObject({ lineId: NAS_ROOT_ID, kind: "branch_card" });
    expect(merged.branch.status).toBe("merged");
    expect(events.filter((event) => event.type === "branch.changed").map((event) => (event.data as { change: string }).change)).toEqual(["draft", "draft", "merged"]);
    expect((await rejection(client.mergeBranch("nas-b2", { card: { conclusion: " " }, parentTipMessageId: "" }))).code).toBe("invalid_card");
  });

  it("writes notes immutably and publishes the new revision", async () => {
    const { events } = record(client);
    const before = await client.listNotes(NAS_ROOT_ID);
    const created = await client.createNote(NAS_ROOT_ID, { section: "fact", text: "8TB NAS 碟每 TB 約 NT$ 825–850" });
    expect(created.revision).toBe(before.revision + 1);
    const superseded = await client.supersedeNote(NAS_ROOT_ID, "n3", { text: "硬碟：2 × 8TB mirror" });
    expect(superseded.superseded).toMatchObject({ id: "n3", status: "superseded", supersededBy: superseded.note.id });
    expect(before.notes.find((note) => note.id === "n3")?.status).toBe("active");
    expect(events.filter((event) => event.type === "notes.changed")).toHaveLength(2);
    expect((await rejection(client.updateNote(NAS_ROOT_ID, "n3", { text: "x" }))).code).toBe("note_superseded");
  });

  it("replaces a note into another section, keeping the old one where it was (R5)", async () => {
    const result = await client.supersedeNote(NAS_ROOT_ID, "n5", { text: "ECC 記憶體必要", section: "fact" });
    expect(result.note).toMatchObject({ section: "fact", text: "ECC 記憶體必要", status: "active" });
    expect(result.superseded).toMatchObject({ id: "n5", section: "to_confirm", status: "superseded", supersededBy: result.note.id });
    const kept = await client.supersedeNote(NAS_ROOT_ID, "n2", { text: "預算上限 3.5 萬" });
    expect(kept.note.section).toBe("decided");
  });

  it("deletes a whole tree and reports every line id", async () => {
    const { events } = record(client);
    await client.deleteLine(NAS_ROOT_ID);
    const deleted = events.find((event) => event.type === "line.deleted")!.data as { lineIds: string[] };
    expect(deleted.lineIds).toEqual(expect.arrayContaining([NAS_ROOT_ID, "nas-b1", "nas-b1a"]));
    expect((await rejection(client.getLine("nas-b1"))).code).toBe("line_not_found");
  });
});

describe("createMockTangentClient: parity with the real client (F0 review)", () => {
  it("hands out clones: mutating a result never changes the mock's state", async () => {
    const client = createMockTangentClient();
    const first = await client.getLine(NAS_ROOT_ID);
    first.title = "changed";
    first.branchCounts.open = 99;
    const again = await client.getLine(NAS_ROOT_ID);
    expect(again.title).toBe("家用 NAS 與備份策略");
    expect(again.branchCounts.open).toBe(2);
  });

  it("runs the route's normalizer: every LineView field is present", async () => {
    const client = createMockTangentClient();
    const { lines } = await client.listLines();
    for (const line of lines) {
      expect(line.usage).toEqual({ inputTokens: expect.any(Number), outputTokens: expect.any(Number), costUsd: expect.any(Number) });
      expect(line.summary.decisions).toEqual([]);
    }
  });

  it("keeps a value when a PATCH body carries an explicit undefined", async () => {
    const client = createMockTangentClient();
    const updated = await client.updateLine(NAS_ROOT_ID, { title: undefined, model: "m2" });
    expect([updated.title, updated.model]).toEqual(["家用 NAS 與備份策略", "m2"]);
  });

  it("rejects with AbortError for an aborted signal, before or during the latency", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockTangentClient({ latencyMs: 100 });
      const before = new AbortController();
      before.abort();
      await expect(client.listLines({}, { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" });
      const during = new AbortController();
      const pending = client.listLines({}, { signal: during.signal });
      during.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      // An aborted write is never applied.
      const write = new AbortController();
      const create = client.createLine({ title: "x" }, { signal: write.signal });
      write.abort();
      await expect(create).rejects.toMatchObject({ name: "AbortError" });
      const all = client.listLines();
      await vi.advanceTimersByTimeAsync(100);
      expect((await all).lines.map((line) => line.title)).not.toContain("x");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() cancels requests still waiting out the latency", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockTangentClient({ latencyMs: 100 });
      const pending = client.listLines();
      client.mock.dispose();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a finished turn's usage to the line (LineView.usage, DESIGN §12)", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockTangentClient({ chunkMs: CHUNK_MS });
      const before = (await client.getLine(NAS_ROOT_ID)).usage;
      expect(before.inputTokens + before.outputTokens).toBe(38_300);
      await client.sendMessage(NAS_ROOT_ID, { content: "UPS?" });
      await vi.runAllTimersAsync();
      const after = (await client.getLine(NAS_ROOT_ID)).usage;
      expect(after.inputTokens).toBeGreaterThan(before.inputTokens);
      expect(after.costUsd).toBeGreaterThan(before.costUsd);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses notes while the feature is off, like an unmounted route", async () => {
    const client = createMockTangentClient({ scenario: nasScenario({ features: "core" }) });
    expect((await rejection(client.listNotes(NAS_ROOT_ID))).code).toBe("feature_disabled");
    expect((await rejection(client.createNote(NAS_ROOT_ID, { section: "todo", text: "x" }))).code).toBe("feature_disabled");
  });

  it("files a note under its source message's line and refuses sources from other conversations", async () => {
    const client = createMockTangentClient();
    const created = await client.createNote("nas-b3", { section: "to_confirm", text: "CMR only", sourceMessageId: "nas-m18" });
    expect(created.note).toMatchObject({ sourceLineId: NAS_ROOT_ID, sourceMessageId: "nas-m18" });
    const listed = await client.listNotes(NAS_ROOT_ID);
    expect(listed.notes.filter((note) => note.sourceMessageId).every((note) => note.sourceLineId !== "")).toBe(true);
    expect((await rejection(client.createNote(NAS_ROOT_ID, { section: "todo", text: "x", sourceLineId: "osaka" }))).code).toBe("note_source_not_found");
  });

  it("leaves the oldest notes out of the preview's notes block over its budget", async () => {
    const client = createMockTangentClient({ scenario: { ...nasScenario(), noteLimits: { ...nasScenario().noteLimits, tokenBudget: 1 } } });
    const preview = await client.previewTurn(NAS_ROOT_ID, { content: "" });
    const block = preview.blocks.find((item) => item.key === "notes")?.content ?? "";
    expect(block).toContain("older note(s) left out");
    expect(block).toContain("檔案系統用 ZFS mirror");
    expect(block).not.toContain("ECC 記憶體是否必要");
  });

  it("B5: renames an open branch with an event; B13: an ended one too", async () => {
    const client = createMockTangentClient();
    const { events, types } = record(client);
    const renamed = await client.renameBranch("nas-b3", { purpose: "  8TB only  " });
    expect(renamed.branch.purpose).toBe("8TB only");
    expect((await client.getLine("nas-b3")).conversationBranch?.purpose).toBe("8TB only");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(types()).toContain("branch.changed");
    expect(events.find((event) => event.type === "branch.changed")?.data).toMatchObject({ change: "renamed" });
    expect((await client.renameBranch("nas-b1", { purpose: "ZFS 還是 Btrfs" })).branch.purpose).toBe("ZFS 還是 Btrfs");
    expect((await rejection(client.renameBranch("nas-b3", { purpose: "字".repeat(201) }))).code).toBe("invalid_input");
    expect((await client.getLine("nas-b3")).title).toBe("8TB only");
  });

  it("B5: previews a branch's background without opening it", async () => {
    const client = createMockTangentClient();
    const before = (await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches.length;
    const preview = await client.previewBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "UPS", kind: "investigate", includeLater: true });
    expect(preview.tokenEstimate).toBeGreaterThan(0);
    expect(preview.pack.laterIncluded).toBe(true);
    expect(preview.text).toContain("UPS");
    expect((await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches).toHaveLength(before);
    expect((await rejection(client.previewBranch(NAS_ROOT_ID, { anchorMessageId: "gone", purpose: "x", kind: "investigate" }))).code).toBe("anchor_not_found");
  });

  it("B5: searches titles, purposes and messages, marking where the text matched", async () => {
    const client = createMockTangentClient();
    const result = await client.search({ q: "zfs", limit: 50 });
    expect(new Set(result.hits.map((hit) => hit.kind))).toEqual(new Set(["purpose", "message"]));
    for (const hit of result.hits) {
      const [first] = hit.highlights;
      expect(hit.snippet.slice(first!.start, first!.end).toLowerCase()).toBe("zfs");
    }
    expect((await client.search({ q: "家用", limit: 1 })).hits).toEqual([expect.objectContaining({ kind: "title", lineId: NAS_ROOT_ID })]);
    expect((await rejection(client.search({ q: "z" }))).code).toBe("invalid_input");
    expect((await rejection(client.search({ q: "z".repeat(201) }))).code).toBe("too_long");
    const off = createMockTangentClient({ scenario: nasScenario({ features: "c1" }) });
    expect((await rejection(off.search({ q: "zfs" }))).code).toBe("feature_disabled");
  });

  it("B5: a ready draft proposes notes when notes are on; jobs name their model", async () => {
    const client = createMockTangentClient({ draftMs: 1 });
    const job = await client.startDraft("nas-b3");
    expect(job).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const detail = await client.getBranch("nas-b3");
    expect(detail.draft.noteChanges).toEqual([expect.objectContaining({ op: "add", section: "decided", sourceLineId: "nas-b3" })]);
    const core = createMockTangentClient({ scenario: nasScenario({ features: "core" }) });
    expect((await core.getBranch("nas-b3")).draft.noteChanges).toEqual([]);
  });

  it("offers capability sets with and without the P1 features behind 待處理", async () => {
    const p1 = ["parking", "open_loops"] as const;
    const all = await createMockTangentClient({ scenario: nasScenario({ features: "all" }) }).getCapabilities();
    const c1 = await createMockTangentClient({ scenario: nasScenario({ features: "c1" }) }).getCapabilities();
    const core = await createMockTangentClient({ scenario: nasScenario({ features: "core" }) }).getCapabilities();
    expect(p1.every((name) => isFeatureOn(all, name))).toBe(true);
    expect(p1.some((name) => isFeatureOn(c1, name))).toBe(false);
    expect(c1.features.some((feature) => feature.mode === "suggest")).toBe(false);
    expect(isFeatureOn(c1, "notes")).toBe(true);
    expect(core.features.some((feature) => feature.enabled)).toBe(false);
  });
});
