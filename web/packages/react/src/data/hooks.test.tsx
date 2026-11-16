import type React from "react";
import { createTangentClient, normalizeMessage, TangentError, type TangentClient } from "@tangent/client";
import { pendingText } from "../conversation/assistant-message";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangent } from "../provider";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useConversationBanner, useReadOnly, useReconnect, useStreamingReply, useTangentEvents } from "./live-hooks";
import { isOptimisticMessage } from "./message-cache";
import { useCancelTurn, useCreateLine, useSendMessage } from "./mutations";
import { fetchAllMessages, MESSAGE_PAGE_LIMIT, useCapabilities, useLine, useLines, useMessages, usePreview } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

/** A conversation view in hook form: events, the line, its messages and the actions. */
function useConversation(lineId: string) {
  useTangentEvents();
  const messages = useMessages(lineId);
  const pending = messages.data?.messages.find((message) => message.status === "pending");
  return {
    line: useLine(lineId),
    messages,
    send: useSendMessage(lineId),
    cancel: useCancelTurn(lineId),
    banner: useConversationBanner(lineId),
    readOnly: useReadOnly(),
    pending,
  };
}

function useStreamOf(lineId: string) {
  const conversation = useConversation(lineId);
  const placeholder = { id: "", status: "done" } as Parameters<typeof useStreamingReply>[1];
  const stream = useStreamingReply(lineId, conversation.pending ?? placeholder);
  return { ...conversation, stream };
}

describe("queries", () => {
  it("read capabilities, lines, one line and its messages from the client", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ caps: useCapabilities(), lines: useLines(), line: useLine(NAS_ROOT_ID), messages: useMessages(NAS_ROOT_ID) }), {
      wrapper: tangentWrapper(client),
    });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.caps.isSuccess && result.current.lines.isSuccess && result.current.line.isSuccess).toBe(true));
    expect(result.current.line.data?.title).toBe("家用 NAS 與備份策略");
    const seqs = result.current.messages.data!.messages.map((message) => message.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("reads every page of a long line", async () => {
    const page = (from: number, count: number) => ({ messages: Array.from({ length: count }, (_, i) => ({ id: `m${from + i}`, seq: from + i })) });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(page(1, MESSAGE_PAGE_LIMIT))
      .mockResolvedValueOnce(page(MESSAGE_PAGE_LIMIT + 1, 2));
    const all = await fetchAllMessages({ listMessages } as unknown as TangentClient, "l1");
    expect(all.messages).toHaveLength(MESSAGE_PAGE_LIMIT + 2);
    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([
      { afterSeq: 0, limit: MESSAGE_PAGE_LIMIT },
      { afterSeq: MESSAGE_PAGE_LIMIT, limit: MESSAGE_PAGE_LIMIT },
    ]);
  });

  it("previews the next turn only when enabled", async () => {
    const client = tracked();
    const spy = vi.spyOn(client, "previewTurn");
    const { result, rerender } = renderHook(({ enabled }) => usePreview(NAS_ROOT_ID, "UPS?", enabled), { wrapper: tangentWrapper(client), initialProps: { enabled: false } });
    expect(spy).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.blocks.at(-1)).toMatchObject({ key: "user_message", content: "UPS?" });
  });
});

describe("sending and streaming", () => {
  it("shows the message at once, streams the reply from events and settles to the server's messages", async () => {
    const client = tracked({ chunkMs: 20, latencyMs: 300 });
    const { result } = renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    const before = result.current.messages.data!.messages.length;

    act(() => result.current.send.mutate("UPS 要買嗎？"));
    await waitFor(() => expect(result.current.messages.data!.messages.at(-1)).toMatchObject({ content: "UPS 要買嗎？" }));
    expect(isOptimisticMessage(result.current.messages.data!.messages.at(-1)!)).toBe(true);
    await waitFor(() => expect(result.current.pending).toBeDefined());
    expect(result.current.messages.data!.messages.some(isOptimisticMessage)).toBe(false);
    await waitFor(() => expect(result.current.stream?.text.length ?? 0).toBeGreaterThan(0));

    await waitFor(() => expect(result.current.pending).toBeUndefined(), { timeout: 4000 });
    const messages = result.current.messages.data!.messages;
    expect(messages).toHaveLength(before + 2);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", status: "done" });
    expect(messages.at(-1)!.content).toContain("UPS 建議買一台 600VA");
    expect(result.current.stream).toBeNull();
  });

  it("rolls the optimistic message back when the send fails", async () => {
    const client = tracked();
    const { result } = renderHook(() => useConversation("osaka"), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    const before = result.current.messages.data!.messages.length;
    const sendMessage = vi.spyOn(client, "sendMessage").mockRejectedValueOnce(new TangentError(409, "archived", "archived"));
    act(() => result.current.send.mutate("hi"));
    await waitFor(() => expect(result.current.send.isError).toBe(true));
    expect(sendMessage).toHaveBeenCalled();
    expect(result.current.messages.data!.messages).toHaveLength(before);
    expect(result.current.readOnly).toBe(false);
  });

  it("stops a reply and keeps what streamed", async () => {
    const client = tracked({ chunkMs: 30 });
    const { result } = renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    act(() => result.current.send.mutate("hi"));
    await waitFor(() => expect(result.current.stream?.text.length ?? 0).toBeGreaterThan(0));
    await act(() => result.current.cancel.mutateAsync());
    // TanStack notifies observers on its batch timer (a zero timeout), which act() does not wait
    // for; the cache is already right, the hook re-renders on the next tick.
    await waitFor(() => expect(result.current.pending).toBeUndefined());
    const last = result.current.messages.data!.messages.at(-1)!;
    expect(last).toMatchObject({ status: "done", meta: { cancelled: true } });
    expect(last.content.length).toBeGreaterThan(0);
    expect(result.current.stream).toBeNull();
  });

  it("catches up with /stream when it mounts in the middle of a reply", async () => {
    const client = tracked({ chunkMs: 15 });
    await client.sendMessage(NAS_ROOT_ID, { content: "already running" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const getStream = vi.spyOn(client, "getStream");
    const { result } = renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.stream?.text.length ?? 0).toBeGreaterThan(6));
    expect(getStream).toHaveBeenCalledWith(NAS_ROOT_ID, 0, expect.anything());
  });

  it("reloads the messages when /stream says deltas were lost", async () => {
    const client = tracked({ chunkMs: 50 });
    await client.sendMessage(NAS_ROOT_ID, { content: "x" });
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: true });
    const listMessages = vi.spyOn(client, "listMessages");
    renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(listMessages.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe("review fixes: streams, gaps and settling", () => {
  it("keeps the deltas /stream still has when it says truncated, marks the gap and reloads", async () => {
    const client = tracked({ chunkMs: 50 });
    const sent = await client.sendMessage(NAS_ROOT_ID, { content: "x" });
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [{ turnId: sent.turnId, seq: 9, kind: "text", text: "tail" }], seq: 9, truncated: true });
    const listMessages = vi.spyOn(client, "listMessages");
    const { result } = renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.stream).toMatchObject({ text: expect.stringContaining("tail"), gap: true }));
    await waitFor(() => expect(listMessages.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("reads only the tail after the saved base (meta.streamSeq) after a reload; no gap when the base covers the start", async () => {
    const client = tracked();
    const base = await client.listMessages(NAS_ROOT_ID);
    const pending = normalizeMessage({ id: "p1", seq: 999, lineId: NAS_ROOT_ID, role: "assistant", status: "pending", content: "Saved part ", meta: { streamSeq: 41 } });
    vi.spyOn(client, "listMessages").mockResolvedValue({ messages: [...base.messages, pending] });
    const getStream = vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [{ turnId: "p1", seq: 42, kind: "text", text: "and the rest" }], seq: 42, truncated: false });
    const { result } = renderHook(() => useStreamOf(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.stream?.text).toBe("and the rest"));
    expect(getStream).toHaveBeenCalledWith(NAS_ROOT_ID, 41, expect.anything());
    expect(result.current.stream?.gap).toBe(false);
    expect(pendingText(result.current.pending!, result.current.stream)).toBe("Saved part and the rest");
  });

  it("fills the deltas lost while disconnected from /stream after a reconnect", async () => {
    const client = tracked({ chunkMs: 15 });
    const subscribe = client.subscribe.bind(client);
    let drop = true;
    vi.spyOn(client, "subscribe").mockImplementation((subscription) =>
      subscribe({ ...subscription, onEvent: (event) => (drop && event.type === "message.delta" && event.data.seq % 2 === 0 ? undefined : subscription.onEvent?.(event)) }),
    );
    const { result } = renderHook(() => ({ ...useStreamOf(NAS_ROOT_ID), live: useTangent().live }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    act(() => result.current.send.mutate("gap please"));
    await waitFor(() => expect(result.current.stream?.text.length ?? 0).toBeGreaterThan(0));
    drop = false;
    act(() => result.current.live.resync());
    await waitFor(async () => {
      const page = await client.getStream(NAS_ROOT_ID, 0);
      const full = page.deltas.filter((delta) => delta.turnId === result.current.pending?.id).map((delta) => delta.text).join("");
      expect(result.current.stream?.text).toBe(full);
    });
  });

  it("clears an AI retry banner after a reconnect, and shows it only while that reply is pending", async () => {
    const client = tracked({ chunkMs: 10 });
    const { result } = renderHook(() => ({ ...useConversation(NAS_ROOT_ID), live: useTangent().live }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    act(() => result.current.live.setRetrying(NAS_ROOT_ID, { turnId: "not-pending", attempt: 1, maxAttempts: 2, nextRetryAt: "" }));
    expect(result.current.banner).toBeNull();
    act(() => result.current.send.mutate("[fake:retry] [fake:slow] hi"));
    await waitFor(() => expect(result.current.banner?.kind).toBe("aiError"));
    act(() => result.current.live.resync());
    expect(result.current.banner).toBeNull();
  });

  it("reads the messages again once a send settles", async () => {
    const client = tracked({ chunkMs: 5 });
    const { result } = renderHook(() => useConversation(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    const listMessages = vi.spyOn(client, "listMessages");
    await act(() => result.current.send.mutateAsync("hi"));
    await waitFor(() => expect(listMessages).toHaveBeenCalled());
  });

  it("reconnects the event stream on request", async () => {
    const client = tracked();
    const statuses: string[] = [];
    const subscribe = client.subscribe.bind(client);
    vi.spyOn(client, "subscribe").mockImplementation((subscription) => subscribe({ ...subscription, onStatus: (status, info) => (statuses.push(status), subscription.onStatus?.(status, info)) }));
    const { result } = renderHook(() => ({ events: useTangentEvents(), reconnect: useReconnect() }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(statuses).toContain("open"));
    act(() => result.current.reconnect());
    await waitFor(() => expect(statuses.filter((status) => status === "open")).toHaveLength(2));
  });
});

describe("banner and read-only", () => {
  it("shows the AI retry of the line's turn until it streams", async () => {
    const client = tracked({ chunkMs: 10 });
    const { result } = renderHook(() => useConversation(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    act(() => result.current.send.mutate("[fake:retry] [fake:slow] hi"));
    await waitFor(() => expect(result.current.banner).toMatchObject({ kind: "aiError", attempt: 1, maxAttempts: 2 }));
    await waitFor(() => expect(result.current.banner).toBeNull(), { timeout: 5000 });
  });

  it("shows reconnecting while the event stream is down", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ banner: useConversationBanner(NAS_ROOT_ID), live: useTangent().live }), { wrapper: tangentWrapper(client) });
    act(() => result.current.live.setConnection("reconnecting", { attempt: 2, nextRetryAt: 123 }));
    expect(result.current.banner).toEqual({ kind: "reconnecting", attempt: 2, nextRetryAt: 123 });
    act(() => result.current.live.setConnection("connecting"));
    expect(result.current.banner?.kind).toBe("reconnecting");
    act(() => result.current.live.setConnection("open"));
    expect(result.current.banner).toBeNull();
  });

  it("is read-only when the host says so, or after a 403 on a send, but not after a 403 elsewhere", async () => {
    const forbidden = () => new Response(JSON.stringify({ error: "read only", code: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith("/capabilities") ? new Response(JSON.stringify({ features: [] })) : forbidden()));
    const client = createTangentClient({ baseUrl: "/api", fetch: fetch as unknown as typeof globalThis.fetch });
    const declared = renderHook(() => useConversationBanner(null), { wrapper: tangentWrapper(client, testQueryClient(), { readOnly: true }) });
    expect(declared.result.current).toEqual({ kind: "readonly" });

    const { result } = renderHook(() => ({ create: useCreateLine(), send: useSendMessage("l1"), readOnly: useReadOnly() }), { wrapper: tangentWrapper(client) });
    await act(() => result.current.create.mutateAsync({ title: "x" }).catch(() => undefined));
    expect(result.current.readOnly).toBe(false);
    await act(() => result.current.send.mutateAsync("hi").catch(() => undefined));
    expect(result.current.readOnly).toBe(true);
  });

  it("prefers /capabilities permissions over a 403 (B4.1)", async () => {
    const body = (canWrite: boolean) => JSON.stringify({ features: [], permissions: { canWrite } });
    const make = (canWrite: boolean) =>
      createTangentClient({
        baseUrl: "/api",
        fetch: (async (input: RequestInfo | URL) =>
          String(input).endsWith("/capabilities")
            ? new Response(body(canWrite))
            : new Response(JSON.stringify({ error: "no", code: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })) as unknown as typeof globalThis.fetch,
      });
    const viewer = renderHook(() => useReadOnly(), { wrapper: tangentWrapper(make(false)) });
    await waitFor(() => expect(viewer.result.current).toBe(true));
    const writer = renderHook(() => ({ send: useSendMessage("l1"), readOnly: useReadOnly() }), { wrapper: tangentWrapper(make(true)) });
    await waitFor(() => expect(writer.result.current.readOnly).toBe(false));
    await act(() => writer.result.current.send.mutateAsync("hi").catch(() => undefined));
    expect(writer.result.current.readOnly).toBe(false);
  });

  it("starts a new identity without the previous one's read-only flag (live store per scopeKey)", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    let scopeKey = "alice";
    const wrapper = ({ children }: { children: React.ReactNode }) => tangentWrapper(client, queryClient, { scopeKey })({ children });
    const { result, rerender } = renderHook(() => useTangent().live, { wrapper });
    const first = result.current;
    act(() => first.markForbidden());
    scopeKey = "bob";
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.getState().forbidden).toBe(false);
  });
});
