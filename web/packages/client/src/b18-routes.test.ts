import { describe, expect, it } from "vitest";
import {
  classifyExtractError,
  decomposeSuggestionCount,
  normalizeDecomposePlan,
  normalizeFolder,
  normalizeTag,
  normalizeTags,
  TAGS_MAX,
} from "./b18-routes";
import { TangentError } from "./errors";
import { folderNames, groupByFolder, tagCounts, visibleTags } from "./line-organization";
import { normalizeLine } from "./line-normalize";

describe("folders and tags as the server stores them", () => {
  it("normalises a tag: controls, '#', case, spaces", () => {
    expect(normalizeTag("  ##Postgres\u0007 ")).toBe("postgres");
    expect(normalizeTag("#")).toBe("");
  });

  it("drops repeats and refuses long tags or more than 12", () => {
    expect(normalizeTags(["A", "#a", "", "b"])).toEqual({ tags: ["a", "b"], problem: null });
    expect(normalizeTags(["x".repeat(25)]).problem).toBe("tooLong");
    expect(normalizeTags(Array.from({ length: TAGS_MAX + 1 }, (_, index) => `t${index}`)).problem).toBe("tooMany");
  });

  it("checks a folder name: trimmed, at most 40 characters, never __unfiled__", () => {
    expect(normalizeFolder(" 資料庫\n ")).toEqual({ folder: "資料庫", problem: null });
    expect(normalizeFolder("x".repeat(41)).problem).toBe("tooLong");
    expect(normalizeFolder("__unfiled__").problem).toBe("reserved");
  });

  it("lines always carry a folder and a tag list", () => {
    expect(normalizeLine({ id: "x" })).toMatchObject({ folder: "", tags: [] });
    expect(normalizeLine({ id: "x", folder: "f", tags: ["a", 3] })).toMatchObject({ folder: "f", tags: ["a"] });
  });
});

describe("classifyExtractError", () => {
  it("maps the server's refusals", () => {
    const failure = (code: string, status = 400, extra: Record<string, unknown> = {}) => classifyExtractError(new TangentError(status, code, code, extra));
    expect(failure("move_must_start_with_user")).toEqual({ kind: "notUserStart" });
    expect(failure("move_no_anchor")).toEqual({ kind: "noAnchor" });
    expect(failure("move_protected_message")).toEqual({ kind: "protected" });
    expect(failure("source_busy", 409)).toEqual({ kind: "busy" });
    expect(failure("archived", 409)).toEqual({ kind: "archived" });
    expect(failure("parent_closed", 409)).toEqual({ kind: "closed" });
    expect(failure("invalid_count", 400, { max: 40 })).toEqual({ kind: "count", max: 40 });
    expect(failure("invalid_card", 422)).toEqual({ kind: "invalidCard" });
    expect(failure("kind_unsupported").kind).toBe("other");
    expect(classifyExtractError(new Error("x")).kind).toBe("other");
  });
});

describe("normalizeDecomposePlan", () => {
  it("fills every list and keeps the server's tags untouched", () => {
    expect(normalizeDecomposePlan({ lineId: "L", suggestedTags: ["分幾", 1] })).toEqual({
      chapterCuts: [],
      detourRanges: [],
      lineId: "L",
      relatedLines: [],
      seedCandidates: [],
      suggestedTags: ["分幾"],
      truncated: false,
    });
  });

  it("counts the suggestions: each detour, seed and related line, the cuts and the tags once", () => {
    const plan = normalizeDecomposePlan({
      detourRanges: [{}, {}],
      chapterCuts: [{}, {}],
      seedCandidates: [{}],
      relatedLines: [{}],
      suggestedTags: ["a"],
    });
    expect(decomposeSuggestionCount(plan)).toBe(6);
    expect(decomposeSuggestionCount(plan, [])).toBe(5);
  });
});

describe("line organization", () => {
  const line = (id: string, folder: string, tags: string[]) => normalizeLine({ id, folder, tags });
  const lines = [line("1", "db", ["postgres", "mvcc"]), line("2", "db", ["postgres"]), line("3", "", ["rust"]), line("4", "net", [])];

  it("counts tags over the loaded lines, most used first", () => {
    expect(tagCounts(lines)).toEqual([
      { tag: "postgres", count: 2 },
      { tag: "mvcc", count: 1 },
      { tag: "rust", count: 1 },
    ]);
  });

  it("groups by folder, keeping named folders with no line here", () => {
    expect(folderNames(lines)).toEqual(["db", "net"]);
    const groups = groupByFolder(lines.slice(0, 3), ["archive-only"]);
    expect(groups.folders.map((group) => [group.folder, group.lines.map((item) => item.id)])).toEqual([
      ["archive-only", []],
      ["db", ["1", "2"]],
    ]);
    expect(groups.unfiled.map((item) => item.id)).toEqual(["3"]);
  });

  it("shows two tags and a count of the rest", () => {
    expect(visibleTags(["a", "b"])).toEqual({ shown: ["a", "b"], more: 0 });
    expect(visibleTags(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], more: 2 });
  });
});
