import { describe, expect, it } from "vitest";
import { normalizeTagDraftList } from "./b15-routes";
import { normalizeLink } from "./spinoff-routes";

describe("B15 wire readers", () => {
  it("keeps a relation's kind, falls back to related for an unknown one and leaves it out when the server sent none", () => {
    expect(normalizeLink({ kind: "relation", relationKind: "contradicts" }).relationKind).toBe("contradicts");
    expect(normalizeLink({ kind: "relation", relationKind: "opposes" }).relationKind).toBe("related");
    expect("relationKind" in normalizeLink({ kind: "spinoff" })).toBe(false);
  });

  it("reads tag drafts and drops a draft without a known kind", () => {
    const list = normalizeTagDraftList({
      rootLineId: "r",
      truncated: true,
      drafts: [
        { lineId: "r", messageId: "m1", seq: 3, role: "assistant", content: "x", tag: { kind: "idea", source: "ai", status: "draft", updatedAt: "t" } },
        { lineId: "r", messageId: "m2", seq: 4, role: "user", content: "y", tag: { kind: "someday" } },
        "junk",
      ],
    });
    expect(list).toEqual({ rootLineId: "r", truncated: true, drafts: [{ lineId: "r", messageId: "m1", seq: 3, role: "assistant", content: "x", tag: { kind: "idea", source: "ai", status: "draft", updatedAt: "t" } }] });
    expect(normalizeTagDraftList(null)).toEqual({ rootLineId: "", drafts: [], truncated: false });
  });
});
