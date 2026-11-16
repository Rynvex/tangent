import { describe, expect, it } from "vitest";
import { divergeTargetPurpose, flowPurpose, forkPointBefore, purposeHead, replyTurn } from "./f8-turns";
import { markdownListItems, plainInline } from "./list-items";
import { isContradiction, staleBranchIds, staleReasons } from "./stale-reasons";
import { hitPlace, searchLoadedTree } from "./tree-search";
import { fixture } from "./testing/scenario";
import type { Fold } from "./fold-routes";
import type { Link, Message, Note } from "./types";

const msg = (id: string, role: "user" | "assistant" | "system", seq: number, over: Record<string, unknown> = {}): Message =>
  fixture.message({ id, role, seq, lineId: "main", kind: "chat", status: "done", content: `${id} text`, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...over });

describe("fork points (decisions #3 #10)", () => {
  const line = [msg("u1", "user", 1), msg("a1", "assistant", 2), msg("n", "system", 3), msg("u2", "user", 4), msg("a2", "assistant", 5)];

  it("forks an edit from the message before it, skipping a host's notice", () => {
    expect(forkPointBefore(line, "u2")?.id).toBe("a1");
    expect(forkPointBefore(line, "u1")).toBeNull();
    expect(forkPointBefore(line, "missing")).toBeNull();
  });

  it("re-asks a reply from before its question", () => {
    expect(replyTurn(line, "a2")).toMatchObject({ question: { id: "u2" }, before: { id: "a1" } });
    expect(replyTurn(line, "a1")).toMatchObject({ question: { id: "u1" }, before: null });
    expect(replyTurn([msg("a0", "assistant", 1)], "a0")).toBeNull();
  });

  it("orders by seq, not by list order", () => {
    expect(forkPointBefore([line[3]!, line[0]!, line[1]!], "u2")?.id).toBe("a1");
  });

  it("does not fork from a failed or pending reply", () => {
    expect(forkPointBefore([msg("u1", "user", 1), msg("a1", "assistant", 2, { status: "error" }), msg("u2", "user", 3)], "u2")?.id).toBe("u1");
  });
});

describe("purposes", () => {
  it("keeps the model's name when the prefix is cut (the server's DivergeTargetPurpose)", () => {
    expect(divergeTargetPurpose("Queue design", "fake-1")).toBe("Queue design · fake-1");
    const long = divergeTargetPurpose("字".repeat(300), "claude-sonnet-4-5");
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("… · claude-sonnet-4-5")).toBe(true);
    expect(divergeTargetPurpose("  ", "m")).toBe("m");
  });

  it("writes a flow's purpose on one line within the limit", () => {
    expect(purposeHead("line one\nline two", 40)).toBe("line one line two");
    expect(Array.from(purposeHead("x".repeat(50), 40))).toHaveLength(40);
    expect(Array.from(flowPurpose(`改問：${"字".repeat(300)}`))).toHaveLength(200);
  });
});

describe("markdown list items (S11)", () => {
  it("reads top-level bullet and numbered items as plain text", () => {
    const text = ["Options:", "", "1. **Benchmark** both", "2. Check the [allocator](https://x)", "   - nested detail", "", "- `ring` buffer", "* [ ] task"].join("\n");
    expect(markdownListItems(text)).toEqual(["Benchmark both", "Check the allocator nested detail", "ring buffer", "task"]);
  });

  it("skips code blocks and needs real items", () => {
    expect(markdownListItems("```\n- not an item\n- nor this\n```\n- one")).toEqual(["one"]);
    expect(markdownListItems("No list here.")).toEqual([]);
    expect(plainInline("_a_ and *b*")).toBe("a and b");
  });
});

describe("stale reasons (S12)", () => {
  const branch = fixture.branch({ lineId: "b1", parentLineId: "main", rootLineId: "main", status: "merged", cardMessageId: "card1", purpose: "ZFS" });
  const note = (id: string, over: Partial<Note>): Note => ({ id, section: "decided", text: id, status: "active", sourceLineId: "", sourceMessageId: "", sourceCardMessageId: "", supersededBy: "", createdBy: "", createdAt: "", updatedAt: "", ...over });
  const link = (id: string, over: Partial<Link>): Link => ({ id, kind: "relation", fromLineId: "x", fromMessageId: "", toLineId: "b1", toMessageId: "", label: "", fromTitle: "", toTitle: "", createdBy: "", createdAt: "", ...over });
  const notes = [note("n1", { status: "superseded", sourceLineId: "b1", supersededBy: "n2" }), note("n2", {}), note("n3", { status: "superseded", sourceCardMessageId: "card1", supersededBy: "gone" }), note("n4", { status: "superseded", sourceLineId: "other" })];
  const relations = [link("r1", { label: "和這張卡矛盾" }), link("r2", { label: "related" }), link("r3", { label: "Contradicts it", toLineId: "", toMessageId: "card1" }), link("r4", { kind: "spinoff", label: "矛盾" })];

  it("lists replaced notes and contradicting relations of a returned branch", () => {
    const reasons = staleReasons(branch, notes, relations);
    expect(reasons.map((reason) => reason.id)).toEqual(["note:n1", "note:n3", "relation:r1", "relation:r3"]);
    expect(reasons[0]).toMatchObject({ kind: "noteSuperseded", replacement: { id: "n2" } });
    expect(reasons[1]).toMatchObject({ replacement: null });
  });

  it("leaves dismissed reasons and other statuses out", () => {
    expect(staleReasons(branch, notes, relations, new Set(["note:n1", "note:n3", "relation:r1", "relation:r3"]))).toEqual([]);
    expect(staleReasons({ ...branch, status: "open" }, notes, relations)).toEqual([]);
    expect(isContradiction(relations[3]!)).toBe(false);
    expect(isContradiction(link("r5", { label: "兩者不矛盾" }))).toBe(false);
    expect(isContradiction(link("r6", { label: "does not contradict this" }))).toBe(false);
    expect([...staleBranchIds([branch, { ...branch, lineId: "b2", cardMessageId: "" }], notes, relations)]).toEqual(["b1"]);
  });

  it("prefers the relation's kind (B15) and reads the label only without one", () => {
    expect(isContradiction(link("k1", { label: "", relationKind: "contradicts" }))).toBe(true);
    expect(isContradiction(link("k2", { label: "和這張卡矛盾", relationKind: "supports" }))).toBe(false);
    expect(isContradiction(link("k3", { label: "和這張卡矛盾", relationKind: "related" }))).toBe(false);
    expect(isContradiction(link("k4", { kind: "spinoff", relationKind: "contradicts" }))).toBe(false);
  });
});

describe("in-tree search (S3)", () => {
  const branches = [fixture.branch({ lineId: "b1", parentLineId: "main", rootLineId: "main", purpose: "Queue design", kind: "aside", lastActivityAt: "2026-01-02T00:00:00Z" })];
  const main = [msg("u1", "user", 1, { content: "Ring buffer or linked list for the queue?" }), msg("a1", "assistant", 2, { content: "A ring buffer." }), msg("a2", "assistant", 3, { content: "Queue again", status: "pending" })];
  const tree = { rootLineId: "main", rootTitle: "Events", branches, messagesByLine: { main } };

  it("searches loaded purposes and finished messages, at least two characters", () => {
    expect(searchLoadedTree(tree, "q")).toEqual([]);
    const hits = searchLoadedTree(tree, "queue");
    expect(hits.map((hit) => [hit.kind, hit.lineId, hit.messageId ?? ""])).toEqual([
      ["purpose", "b1", ""],
      ["message", "main", "u1"],
    ]);
    expect(hits[1]!.snippet.slice(hits[1]!.highlights[0]!.start, hits[1]!.highlights[0]!.end).toLowerCase()).toBe("queue");
  });

  it("places a hit on its line and inside its fold", () => {
    const fold = { id: "f1", lineId: "main", fromSeq: 1, toSeq: 2, status: "active" } as Fold;
    const [, hit] = searchLoadedTree(tree, "queue");
    expect(hitPlace(hit!, "main", branches, main, [fold])).toEqual({ line: { kind: "main" }, n: 1, fold: { id: "f1", from: 1, to: 2 } });
    expect(hitPlace({ ...hit!, lineId: "b1", messageId: undefined } as never, "main", branches, undefined, undefined)).toEqual({ line: { kind: "branch", purpose: "Queue design", aside: true }, n: null, fold: null });
  });
});
