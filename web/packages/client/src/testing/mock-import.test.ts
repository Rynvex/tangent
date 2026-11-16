/** The mock's `POST /lines/import` keeps B19's server behaviour (docs/devlog/B19-import-timestamps-and-assembly.md). */
import { afterEach, describe, expect, it } from "vitest";
import { IMPORT_MAX_CHAPTER_CUTS, type ImportConversationInput } from "../b18-routes";
import type { FeatureMode } from "../capabilities";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, nasScenario, type MockTangentClient } from "./index";
import { dateImportLine } from "./mock-import";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

const NOW = "2026-11-02T00:00:00.000Z";

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
  const made = createMockTangentClient({ scenario, chunkMs: 1, draftMs: 1, now: () => new Date(NOW) });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TangentError);
  const failure = error as TangentError;
  return { status: failure.status, code: failure.code, extra: failure.extra };
}

/** Two sessions joined (the contract sample's shape): §1 and §2 cuts, a merged branch with its card on s1-2. */
const assembled = (): ImportConversationInput => ({
  title: "MVCC 筆記（組裝）",
  source: "chatgpt",
  createdAt: "2026-08-12T06:20:00Z",
  messages: [
    { externalId: "s1-1", role: "user", content: "請解釋 MVCC", createdAt: "2026-08-12T14:20:00+08:00" },
    { externalId: "s1-2", role: "assistant", content: "每個交易看到自己的快照。", createdAt: "2026-08-12T06:21:00Z" },
    { externalId: "s1-3", role: "user", content: "VACUUM 什麼時候跑？", createdAt: "2026-08-12T06:00:00Z" },
    { externalId: "s1-4", role: "assistant", content: "dead tuples 超過門檻時。" },
    { externalId: "s2-1", role: "user", content: "索引膨脹怎麼處理？", createdAt: "2026-08-15T02:05:00Z" },
    { externalId: "s2-2", role: "assistant", content: "用 REINDEX CONCURRENTLY。", createdAt: "2026-08-15T02:06:00Z" },
  ],
  branches: [
    {
      anchorExternalId: "s1-2",
      purpose: "改用 Table Lock 會怎樣？",
      status: "merged",
      card: { conclusion: "讀寫會互相阻塞。", openItems: ["量測鎖等待"] },
      createdAt: "2026-08-12T07:10:00Z",
      messages: [
        { role: "user", content: "改用 Table Lock？", createdAt: "2026-08-12T07:10:00Z" },
        { role: "assistant", content: "讀寫會互相阻塞。", createdAt: "2026-08-12T07:22:00Z" },
      ],
    },
  ],
  chapterCuts: [
    { anchorExternalId: "s1-1", title: "§1 MVCC" },
    { anchorExternalId: "s2-1", title: "  §2\n索引  " },
  ],
});

describe("dates (B19)", () => {
  it("starts at the earlier of createdAt and the first dated message, clamps going back, fills the undated, in UTC", async () => {
    // Arrange
    const { client: c } = make();
    // Act
    const result = await c.importConversation(assembled());
    const messages = (await c.listMessages(result.line.id)).messages;
    // Assert
    expect(result.line.createdAt).toBe("2026-08-12T06:20:00.000Z");
    expect(result.line.lastActivityAt).toBe("2026-08-15T02:06:00.000Z");
    expect(result.line.updatedAt).toBe("2026-08-15T02:06:00.000Z");
    const chat = messages.filter((message) => message.kind === "chat").map((message) => message.createdAt);
    expect(chat).toEqual(["2026-08-12T06:20:00.000Z", "2026-08-12T06:21:00.000Z", "2026-08-12T06:21:00.000Z", "2026-08-12T06:21:00.000Z", "2026-08-15T02:05:00.000Z", "2026-08-15T02:06:00.000Z"]);
  });

  it("dates the branch's line and closes an ended branch at its last message", async () => {
    const { client: c } = make();
    const result = await c.importConversation(assembled());
    expect(result.branches[0]).toMatchObject({ createdAt: "2026-08-12T07:10:00.000Z", lastActivityAt: "2026-08-12T07:22:00.000Z", closedAt: "2026-08-12T07:22:00.000Z" });
  });

  it("dates everything now when nothing carries a date (as before B19)", async () => {
    const { client: c } = make();
    const result = await c.importConversation({ messages: [{ role: "user", content: "hi" }] });
    expect(result.line.createdAt).toBe(NOW);
    expect((await c.listMessages(result.line.id)).messages[0]!.createdAt).toBe(NOW);
  });

  it("refuses a date that is not RFC 3339 or is out of range, naming the field", async () => {
    const { client: c } = make();
    const base = assembled();
    expect(await refusal(c.importConversation({ ...base, createdAt: "2026-08-12 14:20" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "createdAt" } });
    const before1970 = { ...base, messages: base.messages.map((message, i) => (i === 2 ? { ...message, createdAt: "1969-12-31T23:59:59Z" } : message)) };
    expect(await refusal(c.importConversation(before1970))).toMatchObject({ extra: { field: "messages[2].createdAt" } });
    const future = { ...base, branches: [{ ...base.branches![0]!, createdAt: "2026-11-03T00:00:01Z" }] };
    expect(await refusal(c.importConversation(future))).toMatchObject({ extra: { field: "branches[0].createdAt" } });
    const branchMessage = { ...base, branches: [{ ...base.branches![0]!, messages: [{ role: "user" as const, content: "x", createdAt: "soon" }] }] };
    expect(await refusal(c.importConversation(branchMessage))).toMatchObject({ extra: { field: "branches[0].messages[0].createdAt" } });
    // One day from now is still fine.
    expect((await c.importConversation({ messages: [{ role: "user", content: "hi", createdAt: "2026-11-03T00:00:00Z" }] })).line.createdAt).toBe("2026-11-03T00:00:00.000Z");
  });

  it("dateImportLine never goes down and starts at now without any date", () => {
    expect(dateImportLine([null, 5, 3, null, 9], null, 100)).toEqual({ dates: [5, 5, 5, 5, 9], start: 5, last: 9 });
    expect(dateImportLine([null], null, 100)).toEqual({ dates: [100], start: 100, last: 100 });
    expect(dateImportLine([10], 4, 100)).toEqual({ dates: [10], start: 4, last: 10 });
  });
});

describe("merged branches with their card (B19)", () => {
  it("writes the card right after its anchor, delivered and dated as the anchor; messageCount leaves it out", async () => {
    // Arrange
    const { client: c } = make();
    // Act
    const result = await c.importConversation(assembled());
    const messages = (await c.listMessages(result.line.id)).messages;
    // Assert
    expect(result.messageCount).toBe(6);
    expect(messages.map((message) => message.kind)).toEqual(["chat", "chat", "branch_card", "chat", "chat", "chat", "chat"]);
    const card = messages[2]!;
    expect(card).toMatchObject({ role: "system", createdAt: messages[1]!.createdAt, meta: { delivered: true, branchLineId: result.branches[0]!.lineId } });
    expect((card.meta as { card: { question: string } }).card.question).toBe("改用 Table Lock 會怎樣？");
    expect(result.branches[0]).toMatchObject({ status: "merged", cardMessageId: card.id, conclusionLine: "讀寫會互相阻塞。", origin: "import" });
    expect(result.line.branchCounts.merged).toBe(1);
  });

  it("writes a confirmed leaf while the leaf feature is on, and publishes in the server's order", async () => {
    const { client: c, events } = make();
    const result = await c.importConversation(assembled());
    expect(result.branches[0]!.leaf).toMatchObject({ kind: "conclusion", line: "讀寫會互相阻塞。", status: "confirmed" });
    expect(events.map((event) => event.type)).toEqual(["line.created", "line.created", "branch.changed", "leaf.changed", "chapters.changed"]);
  });

  it("writes no leaf with the leaf feature off and no chapters.changed with chapters off (the cuts are still written)", async () => {
    const { client: c, events } = make({ leaf: "off", chapters: "off" });
    const result = await c.importConversation(assembled());
    expect(result.branches[0]!.leaf).toBeNull();
    expect(events.map((event) => event.type)).toEqual(["line.created", "line.created", "branch.changed"]);
    expect(c.mock.snapshot().chaptersByLine[result.line.id]!.milestones).toHaveLength(2);
  });

  it("refuses a merged branch without a card, a card on another status, and a card without a conclusion", async () => {
    const { client: c } = make();
    const base = assembled();
    const branch = base.branches![0]!;
    const { card: _card, ...noCard } = branch;
    expect(await refusal(c.importConversation({ ...base, branches: [noCard] }))).toMatchObject({ status: 400, extra: { field: "branches[0].card" } });
    expect(await refusal(c.importConversation({ ...base, branches: [{ ...branch, status: "discarded" }] }))).toMatchObject({ status: 400, extra: { field: "branches[0].card" } });
    const empty = await refusal(c.importConversation({ ...base, branches: [{ ...branch, card: { conclusion: " " } }] }));
    expect(empty).toMatchObject({ status: 422, code: "invalid_card" });
    expect((empty.extra.problems as Array<{ field: string }>)[0]!.field).toBe("branches[0].card.conclusion");
  });
});

describe("chapter cuts (B19)", () => {
  it("writes milestones on the named messages with flattened titles; the chapters show them", async () => {
    const { client: c } = make();
    const result = await c.importConversation(assembled());
    const milestones = c.mock.snapshot().chaptersByLine[result.line.id]!.milestones;
    const messages = (await c.listMessages(result.line.id)).messages.filter((message) => message.kind === "chat");
    expect(milestones.map((item) => [item.messageId, item.title, item.kind])).toEqual([
      [messages[0]!.id, "§1 MVCC", "milestone"],
      [messages[4]!.id, "§2 索引", "milestone"],
    ]);
    // A cut on the first message names the first chapter (as domain.chapterBoundaries).
    expect((await c.listChapters(result.line.id)).chapters.map((chapter) => [chapter.title, chapter.kind])).toEqual([
      ["§1 MVCC", "milestone"],
      ["§2 索引", "milestone"],
    ]);
  });

  it("refuses an unknown anchor, two cuts on one message, an empty title and more than 50 cuts", async () => {
    const { client: c } = make();
    const base = assembled();
    expect(await refusal(c.importConversation({ ...base, chapterCuts: [{ anchorExternalId: "nope", title: "x" }] }))).toMatchObject({ extra: { field: "chapterCuts[0].anchorExternalId" } });
    expect(await refusal(c.importConversation({ ...base, chapterCuts: [{ anchorExternalId: "s1-1", title: "a" }, { anchorExternalId: "s1-1", title: "b" }] }))).toMatchObject({ extra: { field: "chapterCuts[1].anchorExternalId" } });
    expect(await refusal(c.importConversation({ ...base, chapterCuts: [{ anchorExternalId: "s1-1", title: "  " }] }))).toMatchObject({ extra: { field: "chapterCuts[0].title" } });
    const many = Array.from({ length: IMPORT_MAX_CHAPTER_CUTS + 1 }, (_, i) => ({ externalId: `m${i}`, role: "user" as const, content: `q${i}` }));
    expect(await refusal(c.importConversation({ messages: many, chapterCuts: many.map((message) => ({ anchorExternalId: message.externalId, title: "t" })) }))).toMatchObject({ extra: { field: "chapterCuts" } });
  });
});

describe("decompose reads the imported dates (B19)", () => {
  it("suggests a time_gap cut where the imported conversation paused for 30 minutes or more", async () => {
    const { client: c } = make();
    // Without cuts of its own (a message already cut gets no suggestion, as the server's).
    const result = await c.importConversation({ ...assembled(), chapterCuts: [] });
    const plan = await c.decomposeLine(result.line.id);
    const second = (await c.listMessages(result.line.id)).messages.find((message) => message.content.startsWith("索引膨脹"))!;
    expect(plan.chapterCuts.filter((cut) => cut.reason === "time_gap").map((cut) => cut.messageId)).toContain(second.id);
  });
});
