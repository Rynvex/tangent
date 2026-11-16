import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { Message } from "../types";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

/** B7.2 in the mock: a host's system messages (role system, kind chat) after a reply, also a failed or a still-streaming one. */

let client: MockTangentClient;
let events: TangentEvent[];
beforeEach(() => {
  vi.useFakeTimers();
  client = createMockTangentClient({ latencyMs: 0, chunkMs: 5 });
  events = [];
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
});
afterEach(() => {
  client.mock.dispose();
  vi.useRealTimers();
});

const tail = async (n: number) => (await client.listMessages("okr")).messages.slice(-n).map((message: Message) => `${message.role}/${message.kind}/${message.status}`);

describe("mock host notices (B7.2)", () => {
  it("[fake:notice] writes a notice while the reply streams: after the pending reply by seq, which keeps streaming", async () => {
    const sent = await client.sendMessage("okr", { content: "[fake:notice] hi" });
    await vi.advanceTimersByTimeAsync(5);
    const notice = events.find((event) => event.type === "message.created" && (event.data as Message).role === "system")?.data as Message;
    expect(notice).toMatchObject({ role: "system", kind: "chat", status: "done", content: "Host notice (fake runner)" });
    expect(notice.seq).toBeGreaterThan(sent.pendingMessage.seq);
    await vi.runAllTimersAsync();
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(await tail(3)).toEqual(["user/chat/done", "assistant/chat/done", "system/chat/done"]);
  });

  it("a failed reply followed by a notice can still be retried (retry skips notices, like the server's RetryTurn)", async () => {
    const failed = await client.sendMessage("okr", { content: "[fake:error] [fake:notice] go" });
    await vi.runAllTimersAsync();
    expect(await tail(3)).toEqual(["user/chat/done", "assistant/chat/error", "system/chat/done"]);
    const notice = (await client.listMessages("okr")).messages.at(-1)!;
    const retried = await client.retryTurn("okr");
    expect(retried.userMessage.id).toBe(failed.userMessage.id);
    // The new reply comes after the notice (the same user message carries the directives, so it fails again).
    expect(retried.pendingMessage.seq).toBeGreaterThan(notice.seq);
  });

  it("mock.appendSystemMessage writes one at the end (as Engine.AppendSystemMessage) and refuses an archived conversation", async () => {
    const before = (await client.listMessages(NAS_ROOT_ID)).messages.at(-1)!;
    const notice = client.mock.appendSystemMessage(NAS_ROOT_ID, "Sync finished");
    expect(notice).toMatchObject({ role: "system", kind: "chat", content: "Sync finished", lineId: NAS_ROOT_ID });
    expect(notice.seq).toBeGreaterThan(before.seq);
    await vi.runAllTimersAsync();
    expect(events.filter((event) => event.type === "message.created").map((event) => (event.data as Message).id)).toContain(notice.id);
    expect(() => client.mock.appendSystemMessage("arch-1", "x")).toThrow(TangentError);
  });
});
