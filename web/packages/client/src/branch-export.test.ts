// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { branchesToFreeMind, branchesToMarkdown, branchesToMermaid, branchesToOpml, exportFileName, singleLine, type ExportLabels } from "./branch-export";
import type { BranchView } from "./types";

const labels: ExportLabels = { status: (s) => `S:${s}`, conclusion: "C", line: "id" };
let seq = 0;
function view(id: string, parent: string, extra: Partial<BranchView> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: `p-${id}`, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}

describe("branchesToMarkdown", () => {
  it("writes only the heading for no branches", () => {
    expect(branchesToMarkdown("Main", [], labels)).toBe("# Main\n\n");
  });

  it("indents nested branches and carries status, conclusion and id", () => {
    const text = branchesToMarkdown("Main", [view("a", "root", { status: "merged", conclusionLine: "done" }), view("b", "a")], labels);
    const lines = text.split("\n");
    expect(lines[2]).toBe("- p-a (S:merged) — C: done `id a`");
    expect(lines[3]).toBe("  - p-b (S:open) `id b`");
  });

  it("flattens newlines and escapes markdown characters in the purpose", () => {
    const text = branchesToMarkdown("T", [view("a", "root", { purpose: "# big *bold*\n- [x](y)\r\n<b>" })], labels);
    const item = text.split("\n")[2]!;
    expect(item).not.toContain("\n");
    expect(item).toContain("\\# big \\*bold\\* - \\[x\\]\\(y\\) \\<b\\>");
  });
});

describe("branchesToFreeMind", () => {
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  it("escapes markup, quotes and control characters so the file parses", () => {
    const nasty = `a < b & "c" 'd' > \u0001\u0000 \n line2`;
    const doc = parse(branchesToFreeMind(nasty, [view("a", "root", { purpose: nasty, status: "merged", conclusionLine: nasty })], labels));
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.getElementsByTagName("node")).toHaveLength(2);
    expect(doc.getElementsByTagName("node")[1]!.getAttribute("TEXT")).toBe(`a < b & "c" 'd' > line2`);
  });

  it("keeps the tree structure", () => {
    const doc = parse(branchesToFreeMind("M", [view("a", "root"), view("b", "a"), view("c", "root")], labels));
    const root = doc.getElementsByTagName("node")[0]!;
    const direct = Array.from(root.children).filter((c) => c.tagName === "node");
    expect(direct.map((n) => n.getAttribute("TEXT"))).toEqual(["p-a", "p-c"]);
    expect(Array.from(direct[0]!.children).filter((c) => c.tagName === "node")).toHaveLength(1);
  });

  it("bounds a very long purpose", () => {
    const doc = parse(branchesToFreeMind("M", [view("a", "root", { purpose: "x".repeat(50000) })], labels));
    expect(doc.getElementsByTagName("node")[1]!.getAttribute("TEXT")!.length).toBeLessThanOrEqual(300);
  });
});

describe("exportFileName", () => {
  it("strips path characters and dots", () => {
    expect(exportFileName("../../etc/passwd", "md")).toBe("etc passwd.md");
    expect(exportFileName('a:b*c?"d', "mm")).toBe("a b c d.mm");
  });
  it("falls back when nothing is left", () => {
    expect(exportFileName(" ../ ", "md")).toBe("conversation-map.md");
  });
});

describe("singleLine", () => {
  it("joins lines", () => expect(singleLine("a\n\nb\tc")).toBe("a b c"));
});

describe("branchesToMermaid (F2 phase 2)", () => {
  it("writes a mindmap: the main line as root, branches indented by level, statuses and conclusions as text", () => {
    const text = branchesToMermaid("Main", [view("a", "root", { status: "merged", conclusionLine: "done" }), view("b", "a")], labels);
    expect(text.split("\n")).toEqual(["mindmap", '  root["Main"]', '    b_a["p-a (S:merged) — C: done"]', '      b_b["p-b (S:open)"]', ""]);
  });

  it("keeps user text from breaking the syntax: quotes, brackets and newlines", () => {
    const text = branchesToMermaid('Say "hi"', [view("x-1", "root", { purpose: 'a "q" [b]\nc' })], labels);
    expect(text).toContain('root["Say #quot;hi#quot;"]');
    expect(text).toContain('b_x_1["a #quot;q#quot; #91;b#93; c (S:open)"]');
    expect(text.split("\n")).toHaveLength(4);
  });

  it("prefixes node ids so ids that start with a digit (UUIDs) stay valid, and keeps them unique", () => {
    const text = branchesToMermaid("Main", [view("1f2e-3", "root"), view("1f2e_3", "root"), view("root", "root")], labels);
    const ids = text
      .split("\n")
      .slice(2, -1)
      .map((line) => line.trim().split("[")[0]);
    expect([...ids].sort()).toEqual(["b_1f2e_3", "b_1f2e_3_2", "b_root"]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_]\w*$/);
  });
});

describe("branchesToOpml (F2 phase 2)", () => {
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  it("nests outline elements under the main line, with status, conclusion and line id", () => {
    const doc = parse(branchesToOpml("Main", [view("a", "root", { status: "merged", conclusionLine: "done" }), view("b", "a")], labels));
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.querySelector("opml")?.getAttribute("version")).toBe("2.0");
    expect(doc.querySelector("head > title")?.textContent).toBe("Main");
    const main = doc.querySelector("body > outline")!;
    expect(main.getAttribute("text")).toBe("Main");
    const a = main.querySelector(":scope > outline")!;
    expect([a.getAttribute("text"), a.getAttribute("_status"), a.getAttribute("_conclusion"), a.getAttribute("_line")]).toEqual(["p-a", "S:merged", "done", "a"]);
    expect(a.querySelector(":scope > outline")?.getAttribute("text")).toBe("p-b");
  });

  it("escapes markup so the file always parses", () => {
    const doc = parse(branchesToOpml("a < b & \"c\"", [view("a", "root", { purpose: "x > y 'z'" })], labels));
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.querySelector("body > outline > outline")?.getAttribute("text")).toBe("x > y 'z'");
  });
});
