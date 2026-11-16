import { describe, expect, it } from "vitest";
import { EXPORT_MAX_MESSAGES_PER_LINE, normalizeTreeExport, type TreeExport } from "./b14-routes";
import { routeSample } from "./contract-samples";
import {
  exportScope,
  flashcardCounts,
  flashcardsMarkdown,
  flashcardsTsv,
  quoteBody,
  treeAdrMarkdown,
  treeBackupJson,
  treeFlashcards,
  treeReportMarkdown,
  truncatedLines,
  type TreeExportLabels,
} from "./tree-export";

const labels: TreeExportLabels = {
  truncated: "TRUNCATED",
  exportedAt: (time) => `Exported ${time}`,
  goal: "Goal",
  notes: "Notes",
  section: (section) => `S:${section}`,
  mainLine: "Main line",
  branches: "Branches",
  user: "You",
  ai: "AI",
  kind: (kind) => `K:${kind}`,
  status: (status) => `St:${status}`,
  leafKind: (kind) => `L:${kind}`,
  forkedFrom: (parent, n) => `from ${parent} #${n ?? "?"}`,
  card: "Card",
  cardQuestion: "Question",
  cardConclusion: "Conclusion",
  cardImpact: "Impact",
  cardOpenItems: "Open",
  folded: (from, to) => `Folded #${from}–#${to}`,
  noMessages: "No messages",
  comparisons: "Comparisons",
  criterion: "Criterion",
  recommended: (option, reason) => `Recommended ${option}: ${reason}`,
  decided: (option) => `Decided ${option}`,
  relations: "Relations",
  relation: (from, to, label) => `${from} → ${to}: ${label}`,
  memos: "Memos",
  memosNote: "Never sent to the AI",
  adrTitle: (title) => `ADR: ${title}`,
  adrStatus: "Status",
  adrStatusDecided: "Decided",
  adrStatusOpen: "Proposed",
  adrDate: "Date",
  adrContext: "Context",
  adrQuestion: "Question",
  adrOptions: "Options",
  adrRejected: "Rejected",
  adrDecision: "Decision",
  adrOpenItems: "Open items",
  adrNone: "None",
  cardsTitle: (title) => `Cards: ${title}`,
  front: "Front",
  back: "Back",
  source: (source) => `src:${source}`,
};

const msg = (id: string, lineId: string, seq: number, role: string, content: string, extra: Record<string, unknown> = {}) => ({ id, lineId, seq, role, kind: "chat", status: "done", content, meta: {}, ...extra });
const branch = (lineId: string, extra: Record<string, unknown>) => ({ lineId, parentLineId: "root", rootLineId: "root", anchorMessageId: "m2", kind: "investigate", status: "open", purpose: lineId, createdAt: "2026-01-01T00:00:00Z", ...extra });

function tree(overrides: Record<string, unknown> = {}): TreeExport {
  return normalizeTreeExport({
    rootLineId: "root",
    exportedAt: "2026-10-25T08:00:00Z",
    truncated: false,
    rootLine: { id: "root", title: "# API GraphQL? #" },
    goal: { rootLineId: "root", text: "Pick an API style" },
    branches: [
      branch("b-alt", { kind: "alternative", status: "merged", purpose: "Stay on REST", conclusionLine: "REST is enough" }),
      branch("b-dead", { status: "discarded", purpose: "Use SOAP", leaf: { kind: "dead_end", line: "Too heavy", status: "confirmed" } }),
      branch("b-child", { parentLineId: "b-dead", purpose: "SOAP tooling" }),
      branch("b-aside", { kind: "aside", status: "merged", purpose: "What is N+1?" }),
      branch("b-dec", { purpose: "Federation", leaf: { kind: "decision", line: "Adopt Apollo Federation", status: "confirmed" } }),
      branch("b-ans", { purpose: "Latency budget", leaf: { kind: "answer", line: "Under 200 ms", status: "confirmed" } }),
    ],
    messagesByLine: {
      root: [
        msg("m1", "root", 1, "user", "Should we move to GraphQL?\n# not a heading"),
        msg("m2", "root", 2, "assistant", "It depends.\n\n```sh\n# a comment\n```"),
        { id: "card1", lineId: "root", seq: 3, role: "system", kind: "branch_card", status: "done", content: "", meta: { branchLineId: "b-alt", card: { question: "REST or GraphQL?", conclusion: "REST is enough", evidence: [], impact: "", openItems: [], needsDecision: [], excerpts: [] } } },
        msg("n1", "root", 4, "system", "Host notice"),
      ],
      "b-aside": [msg("a1", "b-aside", 5, "user", "What is N+1?"), msg("a2", "b-aside", 6, "assistant", "One query per row.\tSlow.")],
      "b-dead": [msg("d1", "b-dead", 7, "user", "SOAP?")],
    },
    notes: [
      { id: "n-fact", section: "fact", text: "Clients cache by URL", status: "active", sourceLineId: "b-alt" },
      { id: "n-todo", section: "todo", text: "Ask the mobile team", status: "active" },
      { id: "n-dec", section: "decided", text: "Keep REST for v3", status: "active" },
      { id: "n-old", section: "fact", text: "Old fact", status: "superseded", supersededBy: "n-fact" },
    ],
    memos: [{ id: "memo1", lineId: "root", rootLineId: "root", text: "My own reminder" }],
    comparisons: [
      {
        id: "c1",
        parentLineId: "root",
        lineIds: ["b-alt", "b-dec"],
        status: "decided",
        decidedLineId: "b-dec",
        matrix: { criteria: ["Speed"], options: [{ lineId: "b-alt", label: "REST" }, { lineId: "b-dec", label: "Federation" }], scores: [[{ score: 4, why: "" }, { score: 5, why: "" }]], recommendation: { lineId: "b-dec", reason: "Scales" } },
      },
    ],
    links: [{ id: "l1", kind: "relation", fromLineId: "b-alt", toLineId: "b-dec", label: "contradicts", fromTitle: "Stay on REST", toTitle: "Federation" }],
    foldsByLine: { root: [{ id: "f1", lineId: "root", fromMessageId: "m1", toMessageId: "m2", summary: "Asked and answered", status: "active" }] },
    ...overrides,
  });
}

describe("treeReportMarkdown", () => {
  it("writes the title, goal, active notes, transcripts and comparisons; no host notices", () => {
    const text = treeReportMarkdown(tree(), labels, { includeMemos: false, includeEnded: true });
    expect(text.startsWith("# # API GraphQL? \\#\n")).toBe(true);
    expect(text).toContain("## Goal\n\nPick an API style");
    expect(text).toContain("### S:fact\n\n- Clients cache by URL");
    expect(text).not.toContain("Old fact");
    expect(text).toContain("### #1 You");
    expect(text).toContain("\\# not a heading");
    // A comment inside a code fence stays as written.
    expect(text).toContain("```sh\n# a comment\n```");
    expect(text).toContain("> **Card**");
    expect(text).toContain("> Folded #1–#2: Asked and answered");
    expect(text).not.toContain("Host notice");
    expect(text).toContain("| Criterion | REST | Federation |");
    expect(text).toContain("| Speed | 4 | 5 |");
    expect(text).toContain("- Decided Federation");
    expect(text).toContain("- Stay on REST → Federation: contradicts");
    expect(text).toContain("_K:investigate · St:discarded · from Main line #2_");
    expect(text).toContain("#### SOAP tooling");
  });

  it("puts the truncation line first when the export was cut", () => {
    expect(treeReportMarkdown(tree({ truncated: true }), labels, { includeMemos: false, includeEnded: true }).startsWith("> TRUNCATED\n\n# ")).toBe(true);
  });

  it("drops ended subtrees and adds memos only when asked", () => {
    const without = treeReportMarkdown(tree(), labels, { includeMemos: false, includeEnded: false });
    expect(without).not.toContain("Use SOAP");
    expect(without).not.toContain("SOAP tooling");
    expect(without).not.toContain("My own reminder");
    const withMemos = treeReportMarkdown(tree(), labels, { includeMemos: true, includeEnded: false });
    expect(withMemos).toContain("### Memos\n\n_Never sent to the AI_\n\n- My own reminder");
  });

  it("reads the contract sample", () => {
    const sample = normalizeTreeExport(routeSample("route.lines.export").response);
    const text = treeReportMarkdown(sample, labels, { includeMemos: true, includeEnded: true });
    expect(text).toContain("Ring buffer or linked list for the event queue?");
    expect(text).toContain("Ask the team which one they know");
    expect(JSON.parse(treeBackupJson(sample))).toStrictEqual(JSON.parse(JSON.stringify(sample)));
  });
});

describe("quoteBody", () => {
  it("escapes headings and setext underlines outside fences only", () => {
    expect(quoteBody("Title\n===\n## Two\n~~~\n## kept\n~~~")).toBe("Title\n\\===\n\\## Two\n~~~\n## kept\n~~~");
  });
});

describe("treeAdrMarkdown", () => {
  it("has the context, options, rejected options with reasons, the decision and open items", () => {
    const text = treeAdrMarkdown(tree(), labels);
    expect(text.startsWith("# ADR: # API GraphQL? \\#\n")).toBe(true);
    expect(text).toContain("- **Status**: Decided");
    expect(text).toContain("- **Date**: 2026-10-25");
    expect(text).toContain("- **Question**: Should we move to GraphQL? # not a heading");
    expect(text).toContain("- **Stay on REST** (K:alternative · St:merged) — REST is enough");
    expect(text).toContain("## Rejected\n\n- **Use SOAP** — Too heavy");
    expect(text).toContain("- Federation: Adopt Apollo Federation");
    expect(text).toContain("- Keep REST for v3");
    expect(text).toContain("## Open items\n\n- Ask the mobile team");
    expect(text).not.toContain("What is N+1?");
  });

  it("says none where a section is empty", () => {
    const text = treeAdrMarkdown(tree({ branches: [], notes: [], comparisons: [], goal: null, messagesByLine: {} }), labels);
    expect(text).toContain("- **Status**: Proposed");
    expect(text.match(/- None/g)).toHaveLength(5);
  });
});

describe("flashcards", () => {
  it("collects asides, facts and answers", () => {
    const cards = treeFlashcards(tree());
    expect(cards.map((card) => [card.source, card.front, card.back])).toEqual([
      ["aside", "What is N+1?", "One query per row.\tSlow."],
      ["fact", "Stay on REST", "Clients cache by URL"],
      ["answer", "REST or GraphQL?", "REST is enough"],
      ["answer", "Latency budget", "Under 200 ms"],
    ]);
    expect(flashcardCounts(cards)).toEqual({ aside: 1, fact: 1, answer: 2, term: 0 });
  });

  it("writes Anki TSV with tabs and line breaks escaped, and a Markdown handout", () => {
    expect(flashcardsTsv([{ front: "Q\nline", back: "A\tB", source: "fact", lineId: "" }])).toBe("Q<br>line\tA B\n");
    const text = flashcardsMarkdown(treeFlashcards(tree()), labels, "API");
    expect(text.startsWith("# Cards: API\n")).toBe(true);
    expect(text).toContain("## 1. What is N+1?");
    expect(text).toContain("_src:aside_");
  });
});

describe("glossary terms in the export (B24)", () => {
  it("reads the tree's terms and makes one card of each, after the others", () => {
    // Arrange
    const withTerms = tree({ terms: [{ id: "t1", rootLineId: "root", term: "N+1", termKey: "n+1", explanation: "One query per row.", sourceLineId: "b-aside", sourceMessageId: "a2" }, { id: "t2", term: "REST", explanation: "  " }] });

    // Act
    const cards = treeFlashcards(withTerms);

    // Assert
    expect(withTerms.terms.map((term) => term.term)).toEqual(["N+1", "REST"]);
    expect(cards.at(-1)).toEqual({ front: "N+1", back: "One query per row.", source: "term", lineId: "b-aside", messageId: "a2" });
    expect(flashcardCounts(cards)).toEqual({ aside: 1, fact: 1, answer: 2, term: 1 });
    expect(flashcardsMarkdown(cards, labels, "API")).toContain("_src:term_");
  });

  it("reads an export without terms (an older server) as none", () => {
    expect(tree().terms).toEqual([]);
  });
});

describe("scope and truncation", () => {
  it("counts chat messages, branches, active notes and comparisons", () => {
    expect(exportScope(tree())).toEqual({ messages: 5, branches: 6, notes: 3, comparisons: 1 });
  });

  it("counts the lines that reached the cap", () => {
    const full = Array.from({ length: EXPORT_MAX_MESSAGES_PER_LINE }, (_, index) => msg(`x${index}`, "root", index + 1, "user", "x"));
    expect(truncatedLines(tree())).toBe(0);
    expect(truncatedLines(tree({ messagesByLine: { root: full, other: [] } }))).toBe(1);
  });
});
