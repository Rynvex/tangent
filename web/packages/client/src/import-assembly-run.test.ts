/** Sending an assembly against the mock (the server's B19 rules): order, relations on and off, a partial failure, undo. */
import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "./errors";
import { buildAssemblyBlueprint } from "./import-assembly-build";
import type { ImportConversationInput } from "./b18-routes";
import { relationPairs, runAssembly, UNDO_CONCURRENCY, undoAssembly } from "./import-assembly-run";
import { RATE_LIMIT_MAX_ATTEMPTS } from "./rate-limit-retry";
import { designSessions } from "./import-fixtures";
import { createMockTangentClient, type MockTangentClient } from "./testing";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

const make = () => {
  client = createMockTangentClient({ chunkMs: 1, draftMs: 1, now: () => new Date("2026-11-02T00:00:00Z") });
  return client;
};
const options = { title: "Postgres 連線池與高併發", folder: "資料庫與儲存", tags: ["postgres"] };
const relationLinks = (c: MockTangentClient) => c.mock.snapshot().links.filter((link) => link.kind === "relation");

describe("runAssembly", () => {
  it("imports the tree in one call: chapters, the merged branch's card in place and the history's dates", async () => {
    // Arrange
    const c = make();
    const blueprint = buildAssemblyBlueprint({ mode: "tree", sessions: designSessions(), edits: {}, options, relations: true });
    const progress: Array<[number, number]> = [];
    // Act
    const run = await runAssembly(c, blueprint.imports, { relate: true, onProgress: (done, total) => progress.push([done, total]) });
    // Assert
    expect(run.failures).toEqual([]);
    expect(run.lineIds).toHaveLength(1);
    expect(progress).toEqual([[1, 1]]);
    const line = run.results[0]!.line;
    expect(line).toMatchObject({ title: "Postgres 連線池與高併發", folder: "資料庫與儲存", createdAt: "2026-08-12T14:20:00.000Z" });
    const kinds = (await c.listMessages(line.id, { limit: 200 })).messages.map((message) => message.kind);
    expect(kinds.indexOf("branch_card")).toBe(4);
    expect(relationLinks(c)).toHaveLength(0);
  });

  it("imports a batch in order and relates each main line to the next when relations are on", async () => {
    const c = make();
    const blueprint = buildAssemblyBlueprint({ mode: "batch", sessions: designSessions(), edits: {}, options, relations: true });
    const run = await runAssembly(c, blueprint.imports, { relate: true });
    expect(run.lineIds.every(Boolean)).toBe(true);
    expect(run.relations).toEqual({ made: 4, failed: 0 });
    const ends = relationLinks(c).map((link) => [link.fromLineId, link.toLineId]);
    expect(ends).toEqual(relationPairs(run.lineIds));
  });

  it("makes no relation when relations are off (batch still imports)", async () => {
    const c = make();
    const blueprint = buildAssemblyBlueprint({ mode: "batch", sessions: designSessions(), edits: {}, options, relations: false });
    const run = await runAssembly(c, blueprint.imports, { relate: false });
    expect(run.lineIds.filter(Boolean)).toHaveLength(5);
    expect(relationLinks(c)).toHaveLength(0);
  });

  it("keeps going after a failed import, then retries it alone and relates it to its neighbours", async () => {
    // Arrange: the third import is refused (no messages).
    const c = make();
    const imports = buildAssemblyBlueprint({ mode: "batch", sessions: designSessions(), edits: {}, options, relations: true }).imports;
    const broken = imports.map((input, index) => (index === 2 ? { ...input, messages: [] } : input));
    // Act
    const first = await runAssembly(c, broken, { relate: true });
    const retry = await runAssembly(c, imports, { relate: true, only: [2], made: first.lineIds });
    // Assert
    expect(first.failures.map((failure) => failure.index)).toEqual([2]);
    expect(first.failures[0]!.error).toBeInstanceOf(TangentError);
    expect(first.lineIds.filter(Boolean)).toHaveLength(4);
    expect(first.relations.made).toBe(2);
    expect(retry.failures).toEqual([]);
    expect(retry.relations.made).toBe(2);
    expect(relationLinks(c)).toHaveLength(4);
  });
});

describe("relationPairs", () => {
  it("pairs neighbours that both exist, and only those around a retried one", () => {
    expect(relationPairs(["a", "b", null, "d"])).toEqual([["a", "b"]]);
    expect(relationPairs(["a", "b", "c", "d"], new Set([2]))).toEqual([["b", "c"], ["c", "d"]]);
  });
});

describe("undoAssembly (decision #8)", () => {
  it("deletes every main line the import made, with its branches", async () => {
    const c = make();
    const blueprint = buildAssemblyBlueprint({ mode: "tree", sessions: designSessions(), edits: { roles: { E: "standalone" } }, options, relations: true });
    const run = await runAssembly(c, blueprint.imports, { relate: true });
    const ids = run.lineIds.filter((id): id is string => id !== null);
    const result = await undoAssembly(c, ids);
    expect(result).toEqual({ deleted: ids, kept: [], failed: [] });
    const left = c.mock.snapshot().lines.filter((line) => ids.includes(line.id) || ids.includes(line.conversationBranch?.rootLineId ?? ""));
    expect(left).toEqual([]);
    // Already gone (deleted from the list meanwhile): nothing failed.
    expect(await undoAssembly(c, ids)).toEqual({ deleted: ids, kept: [], failed: [] });
  });

  /** A deleteLine that answers per line, in call order. */
  const scripted = (answers: Record<string, Array<"ok" | string>>) => {
    const calls: string[] = [];
    const deleteLine = async (lineId: string) => {
      calls.push(lineId);
      const answer = answers[lineId]!.shift()!;
      if (answer !== "ok") throw new TangentError(answer === "line_not_found" ? 404 : 409, answer, answer);
      return { rootLineId: lineId, lineIds: [lineId] };
    };
    return { calls, client: { deleteLine } as Parameters<typeof undoAssembly>[0] };
  };

  it("(a) a line attached into another line of the import goes with it: deleted, not failed", async () => {
    const { calls, client } = scripted({ a: ["branch_not_main_line", "line_not_found"], b: ["ok"] });
    expect(await undoAssembly(client, ["a", "b"])).toEqual({ deleted: ["b", "a"], kept: [], failed: [] });
    expect(calls).toEqual(["a", "b", "a"]);
  });

  it("(b) a line attached into a conversation outside the import stays there: kept", async () => {
    const { client } = scripted({ a: ["branch_not_main_line", "branch_not_main_line"], b: ["ok"] });
    expect(await undoAssembly(client, ["a", "b"])).toEqual({ deleted: ["b"], kept: ["a"], failed: [] });
  });

  it("counts a line already gone as deleted and any other refusal as failed, on either pass", async () => {
    const { client } = scripted({ a: ["line_not_found"], b: ["session_busy"], c: ["branch_not_main_line", "session_busy"] });
    expect(await undoAssembly(client, ["a", "b", "c"])).toEqual({ deleted: ["a"], kept: [], failed: ["b", "c"] });
    const plain = { deleteLine: async () => Promise.reject(new Error("offline")) } as unknown as Parameters<typeof undoAssembly>[0];
    expect(await undoAssembly(plain, ["x"])).toEqual({ deleted: [], kept: [], failed: ["x"] });
  });

  it("on the mock: attach one imported line into another, then undo both: nothing failed (the mock refuses a branch as the server does)", async () => {
    const c = make();
    const made = await Promise.all(["A", "B"].map((title) => c.importConversation({ title, messages: [{ role: "user", content: `${title}?` }, { role: "assistant", content: "ok" }] })));
    const [a, b] = made.map((result) => result.line.id) as [string, string];
    await c.attachLine(b, { sourceLineId: a });
    await expect(c.deleteLine(a)).rejects.toMatchObject({ code: "branch_not_main_line" });
    expect(await undoAssembly(c, [a, b])).toEqual({ deleted: [b, a], kept: [], failed: [] });
    expect(c.mock.snapshot().lines.filter((line) => line.id === a || line.id === b)).toEqual([]);
  });
});

/**
 * B21: a server that allows `burst` requests, then answers `429 rate_limited` (Retry-After 1) until the wait passes
 * (`sleep` refills it), like the reference server's limiter; it also counts how many requests ran at once.
 */
function rateLimiter(burst: number) {
  const state = { tokens: burst, running: 0, most: 0, refused: 0, waits: 0 };
  const limit =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      state.running += 1;
      state.most = Math.max(state.most, state.running);
      try {
        await Promise.resolve();
        if (state.tokens === 0) {
          state.refused += 1;
          throw new TangentError(429, "too many requests", "rate_limited", { retryAfterSeconds: 1 });
        }
        state.tokens -= 1;
        return await call(...args);
      } finally {
        state.running -= 1;
      }
    };
  const sleep = async () => {
    state.waits += 1;
    state.tokens = burst;
  };
  return { state, limit, sleep };
}

const small = (n: number): ImportConversationInput => ({ title: `Topic ${n}`, messages: [{ role: "user", content: `Question ${n}?` }, { role: "assistant", content: `Answer ${n}.` }] });

describe("the server's rate limit (B21)", () => {
  it("a batch of 70 imports and 69 relations waits out the 429s and makes every one", async () => {
    // Arrange
    const c = make();
    const limiter = rateLimiter(60);
    const limited = { importConversation: limiter.limit(c.importConversation), createRelation: limiter.limit(c.createRelation), deleteLine: limiter.limit(c.deleteLine) };
    const imports = Array.from({ length: 70 }, (_, n) => small(n));
    // Act
    const run = await runAssembly(limited, imports, { relate: true, retry: { sleep: limiter.sleep } });
    // Assert
    expect(run.failures).toEqual([]);
    expect(run.lineIds.every(Boolean)).toBe(true);
    expect(run.relations).toEqual({ made: 69, failed: 0 });
    expect(limiter.state.refused).toBeGreaterThan(0);
  });

  it("reports an import still refused after the last attempt as failed, and makes the others", async () => {
    let stuck = 0;
    const client = {
      importConversation: async (input: ImportConversationInput) => {
        if (input.title !== "Topic 1") return { line: { id: input.title }, branches: [], messageCount: 2 } as never;
        stuck += 1;
        throw new TangentError(429, "too many requests", "rate_limited", { retryAfterSeconds: 1 });
      },
      createRelation: async () => ({}) as never,
      deleteLine: async () => ({}) as never,
    };
    const run = await runAssembly(client, [small(0), small(1), small(2)], { relate: false, retry: { sleep: async () => undefined } });
    expect(run.lineIds).toEqual(["Topic 0", null, "Topic 2"]);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]).toMatchObject({ index: 1, error: { code: "rate_limited" } });
    expect(stuck).toBe(RATE_LIMIT_MAX_ATTEMPTS);
  });

  it("undoing 70 lines past a burst of 60 deletes all of them, a few at a time", async () => {
    const limiter = rateLimiter(60);
    const ids = Array.from({ length: 70 }, (_, n) => `line-${n}`);
    const gone: string[] = [];
    const deleteLine = limiter.limit(async (lineId: string) => {
      gone.push(lineId);
      return { rootLineId: lineId, lineIds: [lineId] };
    });
    const result = await undoAssembly({ deleteLine }, ids, { retry: { sleep: limiter.sleep } });
    expect(result).toEqual({ deleted: ids, kept: [], failed: [] });
    expect(new Set(gone).size).toBe(70);
    expect(limiter.state.refused).toBeGreaterThan(0);
    expect(limiter.state.most).toBeLessThanOrEqual(UNDO_CONCURRENCY);
  });
});
