import { describe, expect, it, vi } from "vitest";
import { createTangentClient, retryAfterSeconds } from "./api";
import { TangentError } from "./errors";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; body?: unknown; text?: string; statusText?: string; contentType?: string }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    const headers = next.contentType ? { "Content-Type": next.contentType } : undefined;
    return new Response(status === 204 ? null : text, { status, statusText: next.statusText ?? "", ...(headers ? { headers } : {}) });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("createTangentClient", () => {
  it("joins the base url, encodes ids and sends JSON with the host headers", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 201, body: { branch: {}, line: {}, pack: {} } }]);
    const client = createTangentClient({ baseUrl: "/api/", fetch: fetchFn, headers: () => ({ "X-Tenant": "t1" }) });
    await client.createBranch("a/b", { purpose: "why", kind: "investigate", anchorMessageId: "m1" });
    expect(calls[0]).toMatchObject({ url: "/api/lines/a%2Fb/branches", method: "POST", body: { purpose: "why", kind: "investigate", anchorMessageId: "m1" } });
    expect(calls[0]!.headers.get("X-Tenant")).toBe("t1");
    expect(calls[0]!.headers.get("Content-Type")).toBe("application/json");
  });

  it("builds query strings and skips undefined values", async () => {
    const { fetchFn, calls } = fakeFetch([{ body: { lines: [], nextCursor: "" } }, { body: { messages: [] } }, { body: { branches: [] } }]);
    const client = createTangentClient({ baseUrl: "http://x/api", fetch: fetchFn });
    await client.listLines({ archived: true, limit: 20 });
    await client.listMessages("l1", { afterSeq: 5 });
    await client.listBranches("l1");
    expect(calls.map((c) => c.url)).toEqual([
      "http://x/api/lines?archived=true&limit=20",
      "http://x/api/lines/l1/messages?afterSeq=5",
      "http://x/api/lines/l1/branches",
    ]);
    expect(calls[0]!.headers.has("Content-Type")).toBe(false);
  });

  it("B10.1: sends the memory list's cursor with its filters and reads nextCursor", async () => {
    const { fetchFn, calls } = fakeFetch([{ body: { memories: [{ id: "m" }], nextCursor: "next" } }, { body: { memories: [] } }]);
    const client = createTangentClient({ baseUrl: "http://x/api", fetch: fetchFn });
    expect((await client.listMemories({ kind: "fact", status: "all", limit: 1, cursor: "abc_1" })).nextCursor).toBe("next");
    expect((await client.listMemories()).nextCursor).toBe("");
    expect(calls.map((c) => c.url)).toEqual(["http://x/api/memories?kind=fact&status=all&limit=1&cursor=abc_1", "http://x/api/memories"]);
  });

  it("maps every route to its method and path", async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const c = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await c.getLine("l");
    await c.updateLine("l", { title: "t" });
    await c.deleteLine("l");
    await c.archiveLine("l");
    await c.unarchiveLine("l");
    await c.markRead("l");
    await c.sendMessage("l", { content: "hi" });
    await c.getStream("l", 3);
    await c.cancelTurn("l");
    await c.compact("l");
    await c.moveToBranch("l", { purpose: "p", count: 2 });
    await c.getBranch("l");
    await c.startDraft("l");
    await c.mergeBranch("l", { card: {}, parentTipMessageId: "m" });
    await c.discardBranch("l");
    await c.promoteBranch("l");
    await c.listNotes("l");
    await c.createNote("l", { section: "fact", text: "x" });
    await c.updateNote("l", "n", { status: "done" });
    await c.supersedeNote("l", "n", { text: "y" });
    await c.listChapters("l");
    await c.addMilestone("l", { messageId: "m" });
    await c.deleteMilestone("l", "ms");
    await c.getCapabilities();
    await c.previewTurn("l", { content: "x" });
    await c.createLine({ title: "t" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /lines/l",
      "PATCH /lines/l",
      "DELETE /lines/l",
      "POST /lines/l/archive",
      "POST /lines/l/unarchive",
      "POST /lines/l/read",
      "POST /lines/l/messages",
      "GET /lines/l/stream?afterSeq=3",
      "POST /lines/l/cancel",
      "POST /lines/l/compact",
      "POST /lines/l/branches/move",
      "GET /lines/l/branch",
      "POST /lines/l/branch/draft",
      "POST /lines/l/branch/merge",
      "POST /lines/l/branch/discard",
      "POST /lines/l/branch/promote",
      "GET /lines/l/notes",
      "POST /lines/l/notes",
      "PATCH /lines/l/notes/n",
      "POST /lines/l/notes/n/supersede",
      "GET /lines/l/chapters",
      "POST /lines/l/chapters/milestones",
      "DELETE /lines/l/chapters/milestones/ms",
      "GET /capabilities",
      "POST /lines/l/preview",
      "POST /lines",
    ]);
  });

  it("returns undefined for 204 and parses JSON bodies", async () => {
    const { fetchFn } = fakeFetch([{ status: 204 }, { body: { turnId: "t", userMessage: {}, pendingMessage: {} }, status: 202 }]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await expect(client.deleteMilestone("l", "m")).resolves.toBeUndefined();
    await expect(client.sendMessage("l", { content: "hi" })).resolves.toMatchObject({ turnId: "t" });
  });

  it("turns the error envelope into a TangentError with code and extra", async () => {
    const { fetchFn } = fakeFetch([{ status: 409, body: { error: "too deep", code: "depth_soft_limit", depth: 4, limit: 3 } }]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    const error = await client.createBranch("l", { purpose: "p", kind: "aside", anchorMessageId: "m" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TangentError);
    expect(error).toMatchObject({ status: 409, code: "depth_soft_limit", message: "too deep", extra: { depth: 4, limit: 3 } });
  });

  it("adds Retry-After to a rate-limited error and refuses an empty line patch", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: "slow down", code: "rate_limited" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "7" } }),
    ) as unknown as typeof fetch;
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await expect(client.listLines()).rejects.toMatchObject({ status: 429, code: "rate_limited", extra: { retryAfterSeconds: 7 } });
    await expect(client.updateLine("l", {})).rejects.toMatchObject({ status: 0, code: "invalid_input" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterSeconds("12", now)).toBe(12);
    expect(retryAfterSeconds("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });

  it("never puts an HTML error page into the message (review M2)", async () => {
    const { fetchFn } = fakeFetch([
      { status: 502, text: "<html>bad gateway</html>", statusText: "Bad Gateway", contentType: "text/html" },
      { status: 500, text: "", statusText: "" },
      { status: 503, text: "x".repeat(500), contentType: "text/plain; charset=utf-8" },
    ]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await expect(client.getLine("l")).rejects.toMatchObject({ status: 502, code: "", message: "Bad Gateway" });
    await expect(client.getLine("l")).rejects.toMatchObject({ status: 500, code: "", message: "HTTP 500" });
    const plain = await client.getLine("l").then(
      () => null,
      (e: unknown) => e,
    );
    expect(plain).toBeInstanceOf(TangentError);
    expect(Array.from((plain as TangentError).message)).toHaveLength(201);
  });

  it("rejects a 2xx body that is not JSON with invalid_response (review M1)", async () => {
    const { fetchFn } = fakeFetch([{ status: 200, text: "<html>login page</html>" }]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await expect(client.listLines()).rejects.toMatchObject({ status: 200, code: "invalid_response", message: "invalid JSON response" });
  });

  it("normalizes every body, so Go nil slices arrive as empty arrays (review H1)", async () => {
    const { fetchFn } = fakeFetch([
      { body: { lines: null } },
      { body: { id: "l", summary: { decisions: null }, branchCounts: null } },
      { body: { branches: null } },
      { body: { branch: { lineId: "b" }, pack: { recent: null }, draft: { warnings: null } } },
      { body: { chapters: null, milestones: [{ id: "m" }] } },
      { body: { messages: [{ id: "m", meta: null }] } },
    ]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    expect((await client.listLines()).lines).toEqual([]);
    const line = await client.getLine("l");
    expect(line.summary.decisions).toEqual([]);
    expect(line.conversationBranch).toBeNull();
    expect((await client.listBranches("l")).branches).toEqual([]);
    const detail = await client.getBranch("b");
    expect(detail.pack.recent).toEqual([]);
    expect(detail.draft.warnings).toEqual([]);
    const chapters = await client.listChapters("l");
    expect(chapters.chapters).toEqual([]);
    expect(chapters.milestones[0]!.kind).toBe("milestone");
    expect((await client.listMessages("l")).messages[0]!.meta).toEqual({});
  });

  it.each(["", ".", ".."])("refuses the id %j before sending anything (review LOW)", async (id) => {
    const { fetchFn, calls } = fakeFetch([]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    await expect(client.getLine(id)).rejects.toMatchObject({ status: 0, code: "invalid_id" });
    await expect(client.updateNote("l", id, { text: "x" })).rejects.toMatchObject({ code: "invalid_id" });
    await expect(client.deleteMilestone("l", id)).rejects.toMatchObject({ code: "invalid_id" });
    expect(calls).toHaveLength(0);
    await client.getLine("...");
    expect(calls[0]!.url).toBe("/lines/...");
  });

  it("sends the credentials mode it was given (review M5)", async () => {
    const { fetchFn } = fakeFetch([{ body: {} }]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn, credentials: "include" });
    await client.getLine("l");
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("normalizes capabilities and passes the abort signal", async () => {
    const { fetchFn } = fakeFetch([{ body: { features: [{ name: "notes", enabled: true }, { name: "future", enabled: true }] } }]);
    const client = createTangentClient({ baseUrl: "", fetch: fetchFn });
    const controller = new AbortController();
    await expect(client.getCapabilities({ signal: controller.signal })).resolves.toEqual({ features: [{ name: "notes", enabled: true }] });
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("exposes the events url", () => {
    expect(createTangentClient({ baseUrl: "/api/" }).eventsUrl()).toBe("/api/events");
  });
});
