/** The mock's B10 phase C simulation: cross-conversation memory (docs/devlog/B10-p3.md 階段 C). */
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureMode } from "../capabilities";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

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
  const made = createMockTangentClient({ scenario, chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(TangentError);
  return error as TangentError;
}

describe("memories", () => {
  it("writes, lists (newest first), recategorizes and supersedes, with memory.changed; the old one stays as history", async () => {
    const { client: c, events } = make({ memory: "manual" });
    const first = await c.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror", importance: 8, sourceLineId: NAS_ROOT_ID });
    expect(first.memory).toMatchObject({ kind: "decision", importance: 8, status: "active", aiDrafted: false, source: { lineId: NAS_ROOT_ID } });
    expect(first.memory.source.label).not.toBe("");
    await c.createMemory({ kind: "preference", text: "Quiet fans for the server" });
    expect((await c.listMemories()).memories.map((memory) => memory.text)).toEqual(["Quiet fans for the server", "The NAS uses a ZFS mirror"]);
    expect((await c.updateMemory(first.memory.id, { importance: 9, validUntil: "2030-01-01T00:00:00Z" })).memory).toMatchObject({ importance: 9, validUntil: "2030-01-01T00:00:00Z" });
    const replaced = await c.supersedeMemory(first.memory.id, { text: "The NAS uses ZFS RAIDZ1" });
    expect(replaced.memory).toMatchObject({ text: "The NAS uses ZFS RAIDZ1", kind: "decision", importance: 9 });
    expect(replaced.superseded).toEqual([expect.objectContaining({ id: first.memory.id, status: "superseded", supersededBy: replaced.memory.id })]);
    expect((await c.listMemories({ status: "superseded" })).memories.map((memory) => memory.id)).toEqual([first.memory.id]);
    expect((await rejection(c.updateMemory(first.memory.id, { importance: 1 }))).code).toBe("memory_superseded");
    expect(events.filter((event) => event.type === "memory.changed")).toHaveLength(4);
  });

  it("B10.1: pages newest first with nextCursor, keeps the filters, keeps a replaced one's place and refuses an unknown cursor", async () => {
    const { client: c } = make({ memory: "manual" });
    const ids: string[] = [];
    for (const text of ["one", "two", "three", "four", "five"]) ids.unshift((await c.createMemory({ kind: text === "three" ? "lesson" : "fact", text })).memory.id);
    const walk = async (query: { kind?: "fact"; status?: "all"; limit: number }) => {
      const seen: string[] = [];
      let cursor = "";
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await c.listMemories({ ...query, ...(cursor ? { cursor } : {}) });
        expect(page.memories.length).toBeLessThanOrEqual(query.limit);
        seen.push(...page.memories.map((memory) => memory.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    expect(await walk({ limit: 2 })).toEqual(ids);
    expect(await walk({ kind: "fact", limit: 3 })).toEqual(ids.filter((_, index) => index !== 2));
    expect((await c.listMemories({ limit: 5 })).nextCursor).toBe("");
    const first = await c.listMemories({ status: "all", limit: 2 });
    await c.updateMemory(ids[4]!, { importance: 9 });
    const replaced = await c.supersedeMemory(ids[3]!, { text: "four, again" });
    const rest = await c.listMemories({ status: "all", limit: 10, cursor: first.nextCursor });
    expect(rest.memories.map((memory) => memory.id)).toEqual([ids[2], ids[3], ids[4]]);
    expect((await c.listMemories({ status: "all", limit: 1 })).memories[0]!.id).toBe(replaced.memory.id);
    expect((await rejection(c.listMemories({ cursor: "nope" }))).code).toBe("invalid_input");
  });

  it("refuses bad memories, unknown ones, and a turned-off feature", async () => {
    const { client: c } = make({ memory: "manual" });
    expect((await rejection(c.createMemory({ kind: "fact", text: "  " }))).code).toBe("invalid_memory");
    expect((await rejection(c.createMemory({ kind: "fact", text: "x", importance: 11 }))).code).toBe("invalid_memory");
    expect((await rejection(c.createMemory({ kind: "fact", text: "x".repeat(501) }))).code).toBe("too_long");
    expect((await rejection(c.updateMemory("nope", { importance: 2 }))).code).toBe("memory_not_found");
    expect((await rejection(make({ memory: "off" }).client.listMemories())).code).toBe("feature_disabled");
  });

  it("searches like the fake embedder (shared words), leaves out superseded and expired ones", async () => {
    const { client: c } = make({ memory: "manual" });
    const old = await c.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror", importance: 9 });
    await c.supersedeMemory(old.memory.id, { text: "The NAS uses ZFS RAIDZ1" });
    await c.createMemory({ kind: "fact", text: "ZFS scrubs run monthly", validUntil: "2000-01-01T00:00:00Z" });
    await c.createMemory({ kind: "preference", text: "Quiet fans" });
    const found = await c.searchMemories({ query: "Which ZFS layout for the NAS?" });
    expect(found.results.map((result) => result.memory.text)).toEqual(["The NAS uses ZFS RAIDZ1"]);
    expect(found.results[0]!.similarity).toBeGreaterThan(0.3);
  });

  it("matches runner/fake/embedder.go: kana, hangul and any letters count, hashed onto the same 256 dimensions (R11 J5)", async () => {
    const { client: c } = make({ memory: "manual" });
    // The server's fake Embedder gives these cosines (computed with runner/fake at 974e98f).
    const pairs: Array<[memory: string, query: string, similarity: number]> = [
      ["서버는 조용해야 한다", "서버 조용", 0.666667],
      ["サーバーは静かにする", "静かなサーバー", 0.801784],
      ["Café NAS 2024", "café nas", 0.816497],
      ["The NAS uses ZFS RAIDZ1", "Which ZFS for the NAS?", 0.6],
      ["UPS 要買 1000VA 的", "UPS 該買多大的？", 0.547723],
    ];
    for (const [text] of pairs) await c.createMemory({ kind: "fact", text });
    for (const [text, query, similarity] of pairs) {
      const found = await c.searchMemories({ query, limit: 20 });
      const hit = found.results.find((result) => result.memory.text === text);
      expect(hit?.similarity, `${text} ← ${query}`).toBeCloseTo(similarity, 5);
    }
  });

  it("each turn's preview recalls the related memories as a trailing block", async () => {
    const { client: c } = make({ memory: "manual", fisheye: "off" });
    await c.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror" });
    const preview = await c.previewTurn(NAS_ROOT_ID, { content: "Should the NAS use ZFS?" });
    expect(preview.memories?.map((item) => item.memory.text)).toEqual(["The NAS uses a ZFS mirror"]);
    expect(preview.blocks.find((block) => block.key === "memory")?.content).toContain("> [decision] The NAS uses a ZFS mirror");
    expect("memories" in (await c.previewTurn(NAS_ROOT_ID, { content: "Hello there" }))).toBe(false);
  });

  it("suggest: a merged branch's conclusion is proposed as a memory; accepting it (edited) makes it the user's", async () => {
    const { client: c } = make({ memory: "suggest" });
    await c.putLeaf("nas-b3", { kind: "conclusion", line: "8TB disks are cheapest per TB" });
    await sleep(10);
    const proposal = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "memory")!;
    expect(proposal.payload).toMatchObject({ action: "add", kind: "fact", text: "Remembered: 8TB disks are cheapest per TB (fake runner)", importance: 6 });
    const accepted = await c.acceptSuggestion(proposal.id, { text: "8TB is the sweet spot" });
    expect(accepted.result).toMatchObject({ memory: { text: "8TB is the sweet spot", aiDrafted: false, source: { lineId: "nas-b3" } }, superseded: [] });
  });
});
