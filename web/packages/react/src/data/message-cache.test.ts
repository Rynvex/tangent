import type { Message } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { isOptimisticMessage, optimisticUserMessage, removeMessage, upsertMessage, visibleMessages } from "./message-cache";

const msg = (id: string, seq: number, over: Partial<Message> = {}): Message => ({
  id,
  seq,
  lineId: "l1",
  role: "user",
  kind: "chat",
  content: id,
  status: "done",
  meta: {},
  hostMeta: {},
  createdAt: "",
  pinned: false,
  ...over,
});

describe("message cache helpers", () => {
  it("inserts by seq and replaces by id without touching the input", () => {
    const page = { messages: [msg("a", 1), msg("c", 3)] };
    const next = upsertMessage(page, msg("b", 2));
    expect(next.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(page.messages).toHaveLength(2);
    const replaced = upsertMessage(next, msg("b", 2, { content: "B" }));
    expect(replaced.messages.map((m) => m.content)).toEqual(["a", "B", "c"]);
  });

  it("returns the same page when the message is already there unchanged", () => {
    const page = { messages: [msg("a", 1)] };
    expect(upsertMessage(page, msg("a", 1))).toBe(page);
  });

  it("keeps optimistic messages last; only the send result replaces them (by the 202's message id), never a twin by text", () => {
    const optimistic = optimisticUserMessage("l1", "hello", 5);
    expect(isOptimisticMessage(optimistic)).toBe(true);
    const page = upsertMessage({ messages: [msg("a", 1)] }, optimistic);
    expect(page.messages.at(-1)?.id).toBe(optimistic.id);
    const withEvent = upsertMessage(page, msg("u", 2, { content: "hello" }));
    expect(withEvent.messages.map((m) => m.id)).toEqual(["a", "u", optimistic.id]);
    expect(removeMessage(withEvent, optimistic.id).messages.map((m) => m.id)).toEqual(["a", "u"]);
  });

  it("hides an optimistic message once the server lists a user message at or after its place", () => {
    const optimistic = optimisticUserMessage("l1", "hi", 5);
    const sending = [msg("a", 5), optimistic];
    expect(visibleMessages(sending)).toBe(sending);
    expect(visibleMessages([...sending, msg("u", 6, { content: "different text" })]).map((m) => m.id)).toEqual(["a", "u"]);
  });

  it("B7.2: shows messages in seq order whatever order they came in, keeping the array when it already is", () => {
    const ordered = [msg("u", 1, { role: "user" }), msg("p", 2, { role: "assistant", status: "pending" }), msg("n", 3, { role: "system", kind: "chat" })];
    expect(visibleMessages(ordered)).toBe(ordered);
    expect(visibleMessages([ordered[0]!, ordered[2]!, ordered[1]!]).map((m) => m.id)).toEqual(["u", "p", "n"]);
    const optimistic = optimisticUserMessage("l1", "next", 3);
    expect(visibleMessages([optimistic, ...ordered]).map((m) => m.id)).toEqual(["u", "p", "n", optimistic.id]);
  });

  it("treats any field change as a change", () => {
    const page = { messages: [msg("a", 1, { meta: { model: "x" } })] };
    expect(upsertMessage(page, msg("a", 1, { meta: { model: "y" } }))).not.toBe(page);
  });

  it("never lets a stale pending copy replace a finished reply", () => {
    const page = { messages: [msg("a", 1, { role: "assistant", status: "error", content: "Turn failed" })] };
    expect(upsertMessage(page, msg("a", 1, { role: "assistant", status: "pending", content: "" }))).toBe(page);
    // The event stream is in order, so it may say so.
    expect(upsertMessage(page, msg("a", 1, { role: "assistant", status: "pending", content: "" }), { authoritative: true }).messages[0]!.status).toBe("pending");
  });

  it("removes by id", () => {
    const page = { messages: [msg("a", 1), msg("b", 2)] };
    expect(removeMessage(page, "a").messages.map((m) => m.id)).toEqual(["b"]);
    expect(removeMessage(page, "zz")).toBe(page);
  });
});
