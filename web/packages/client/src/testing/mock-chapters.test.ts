/** The mock's chapters cut a line as domain/chapters.go does (the same cases as domain/chapters_test.go). */
import { afterEach, describe, expect, it } from "vitest";
import type { Message, Milestone } from "../types";
import { createMockTangentClient, type MockTangentClient } from "./index";
import { computeChapters, MOCK_CHAPTER_MAX_COUNT, MOCK_IDLE_GAP_MS } from "./mock-chapters";
import { fixture } from "./scenario";

const BASE = Date.parse("2026-10-14T09:00:00Z");

/** n messages a minute apart; gaps adds milliseconds before an index (domain chapterMsgs). */
function messages(n: number, gaps: Record<number, number> = {}): Message[] {
  let at = BASE;
  return Array.from({ length: n }, (_, i) => {
    at += 60_000 + (gaps[i] ?? 0);
    const id = `m${String(i).padStart(2, "0")}`;
    return fixture.message({ id, seq: i + 1, lineId: "l", role: i % 2 === 0 ? "user" : "assistant", kind: "chat", status: "done", content: id, createdAt: new Date(at).toISOString() });
  });
}

const milestone = (messageId: string, title: string, order = 0): Milestone =>
  ({ id: `ms-${messageId}`, messageId, kind: "milestone", title, createdBy: "", createdAt: new Date(BASE + order * 1000).toISOString() }) as Milestone;

const starts = (list: ReturnType<typeof computeChapters>) => list.map((chapter) => chapter.startMessageId);

describe("mock chapters (domain/chapters.go)", () => {
  it("is one time-titled chapter without cuts", () => {
    const list = computeChapters(messages(5), []);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "start", titleSource: "time", title: "2026-10-14 09:01", messageCount: 5 });
    expect(computeChapters([], [])).toEqual([]);
  });

  it("opens an idle chapter after a pause longer than 30 minutes, not at exactly 30", () => {
    const list = computeChapters(messages(8, { 4: MOCK_IDLE_GAP_MS }), []);
    expect(starts(list)).toEqual(["m00", "m04"]);
    expect(list[1]).toMatchObject({ kind: "idle", title: "2026-10-14 09:35", titleSource: "time", endMessageId: "m07", messageCount: 4 });
    expect(list[0]!.messageCount).toBe(4);
    expect(computeChapters(messages(8, { 4: MOCK_IDLE_GAP_MS - 60_000 }), [])).toHaveLength(1);
  });

  it("keeps a milestone over an idle cut closer than 3 messages, and the earlier of two idle cuts", () => {
    const list = computeChapters(messages(12, { 5: MOCK_IDLE_GAP_MS, 6: 0 }), [milestone("m06", "PG 連線池設定")]);
    expect(starts(list)).toEqual(["m00", "m06"]);
    expect(list[1]).toMatchObject({ kind: "milestone", title: "PG 連線池設定", titleSource: "milestone" });
    const idle = computeChapters(messages(12, { 5: MOCK_IDLE_GAP_MS, 6: MOCK_IDLE_GAP_MS }), []);
    expect(starts(idle)).toEqual(["m00", "m05"]);
  });

  it("drops an idle cut next to the start of the line but keeps a milestone there", () => {
    expect(computeChapters(messages(10, { 1: MOCK_IDLE_GAP_MS }), [])).toHaveLength(1);
    expect(starts(computeChapters(messages(10), [milestone("m01", "x")]))).toEqual(["m00", "m01"]);
  });

  it("lists the branches opened in each chapter", () => {
    const list = computeChapters(messages(8, { 4: MOCK_IDLE_GAP_MS }), [], [{ lineId: "b1", anchorMessageId: "m01" }, { lineId: "b2", anchorMessageId: "m05" }, { lineId: "gone", anchorMessageId: "x" }]);
    expect(list.map((chapter) => chapter.branchIds)).toEqual([["b1"], ["b2"]]);
  });

  it("counts cards, does not open an idle chapter on a late card, orders by seq and caps the chapters", () => {
    const card = fixture.message({ id: "card", seq: 3, lineId: "l", role: "system", kind: "branch_card", status: "done", content: "card", createdAt: new Date(BASE + 86_400_000).toISOString() });
    const shuffled = [...messages(2), card].reverse();
    expect(computeChapters(shuffled, [])).toHaveLength(1);
    expect(computeChapters(shuffled, [])[0]).toMatchObject({ messageCount: 3, cardMessageIds: ["card"], startMessageId: "m00" });
    const gaps = Object.fromEntries(Array.from({ length: MOCK_CHAPTER_MAX_COUNT + 5 }, (_, i) => [(i + 1) * 4, MOCK_IDLE_GAP_MS + 60_000]));
    expect(computeChapters(messages((MOCK_CHAPTER_MAX_COUNT + 6) * 4, gaps), [])).toHaveLength(MOCK_CHAPTER_MAX_COUNT);
  });
});

describe("the mock serves idle chapters for an imported history", () => {
  let client: MockTangentClient | null = null;
  afterEach(() => client?.mock.dispose());

  it("cuts an imported conversation at its pause, as :8120 does", async () => {
    client = createMockTangentClient({ chunkMs: 1, draftMs: 1 });
    const imported = await client.importConversation({
      title: "PG",
      messages: [
        { role: "user", content: "q1", createdAt: "2025-08-12T09:00:00Z" },
        { role: "assistant", content: "a1", createdAt: "2025-08-12T09:01:00Z" },
        { role: "user", content: "q2", createdAt: "2025-08-12T09:02:00Z" },
        { role: "assistant", content: "a2", createdAt: "2025-08-12T09:03:00Z" },
        { role: "user", content: "q3", createdAt: "2025-08-12T17:35:00Z" },
        { role: "assistant", content: "a3", createdAt: "2025-08-12T17:36:00Z" },
      ],
    });
    const view = await client.listChapters(imported.line.id);
    expect(view.chapters.map((chapter) => chapter.kind)).toEqual(["start", "idle"]);
    expect(view.chapters[1]).toMatchObject({ titleSource: "time", startAt: "2025-08-12T17:35:00.000Z" });
  });
});
