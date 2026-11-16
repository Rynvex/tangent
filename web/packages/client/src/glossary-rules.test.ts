import { describe, expect, it } from "vitest";
import { TangentError } from "./errors";
import { DEFAULT_TERM_LIMITS, normalizeTermList, normalizeTermSearchPage, normalizeTermWriteResult, type Term } from "./glossary-routes";
import { askedBefore, classifyTermError, cleanTerm, cleanTermExplanation, filterTerms, isTermLookup, normalizeTermKey, paragraphWith, prefillExplanation, prefillTerm, rankTerms, termInputProblem, termPrefill } from "./glossary-rules";
import { normalizeMessage } from "./line-normalize";

const term = (name: string, explanation = "x", extra: Partial<Term> = {}): Term => ({
  id: name,
  rootLineId: "root",
  term: name,
  termKey: normalizeTermKey(name),
  explanation,
  sourceLineId: "",
  sourceMessageId: "",
  sourceLabel: "",
  createdBy: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("term keys and cleaning (domain/glossary.go)", () => {
  it("removes every space, folds full-width ASCII and lower-cases", () => {
    expect(normalizeTermKey("  Write　Ahead\tLog ")).toBe("writeaheadlog");
    expect(normalizeTermKey("ＭＶＣＣ")).toBe("mvcc");
    expect(normalizeTermKey("連線池")).toBe("連線池");
  });

  it("makes a term one line with single spaces and keeps an explanation's line breaks", () => {
    expect(cleanTerm("  write \n ahead   log ")).toBe("write ahead log");
    expect(cleanTerm("[BRANCH-CARD]MVCC")).toBe("MVCC");
    expect(cleanTermExplanation("  a\r\nb  ")).toBe("a\nb");
  });

  it("names what stops a save in the server's order", () => {
    expect(termInputProblem({ term: " ", explanation: "x" })).toEqual({ field: "term", kind: "empty" });
    expect(termInputProblem({ term: "字".repeat(61), explanation: "x" })).toEqual({ field: "term", kind: "tooLong", max: 60 });
    expect(termInputProblem({ term: "MVCC", explanation: " " })).toEqual({ field: "explanation", kind: "empty" });
    expect(termInputProblem({ term: "MVCC", explanation: "字".repeat(1001) })).toEqual({ field: "explanation", kind: "tooLong", max: 1000 });
    expect(termInputProblem({ term: "MVCC", explanation: "多版本並行控制" })).toBeNull();
  });
});

describe("prefill", () => {
  it("takes the selection as the term when it fits, else the fallback, else nothing", () => {
    expect(prefillTerm(" MVCC ", "What is MVCC?")).toBe("MVCC");
    expect(prefillTerm("字".repeat(80), "MVCC 是什麼")).toBe("MVCC 是什麼");
    expect(prefillTerm("", "字".repeat(80))).toBe("");
  });

  it("starts the explanation with the answer, cut at the limit on a sentence end when one is near", () => {
    expect(prefillExplanation("  多版本並行控制。 ")).toBe("多版本並行控制。");
    const long = `${"甲".repeat(700)}。${"乙".repeat(600)}`;
    const cut = prefillExplanation(long);
    expect(cut).toBe(`${"甲".repeat(700)}。`);
    expect(Array.from(prefillExplanation("丙".repeat(1500)))).toHaveLength(DEFAULT_TERM_LIMITS.explanationMaxRunes);
  });
});

describe("termPrefill", () => {
  const message = (id: string, role: string, content: string, seq: number) => normalizeMessage({ id, lineId: "l", seq, role, kind: "chat", status: "done", content });
  const messages = [message("q", "user", "MVCC 是什麼？", 1), message("a", "assistant", "先講背景。\n\nMVCC 是多版本並行控制：讀不擋寫。\n\n另外還有 VACUUM。", 2)];
  const aside = { kind: "aside" as const, excerpt: "MVCC", purpose: "解釋 MVCC" };

  it("names an answered aside's term by the words it was asked about and explains it with its answer", () => {
    expect(termPrefill({ branch: aside, messages })).toEqual({ term: "MVCC", explanation: messages[1]!.content, sourceMessageId: "a" });
    expect(termPrefill({ branch: { ...aside, excerpt: "" }, messages }).term).toBe("解釋 MVCC");
  });

  it("takes a short selection as the term and the paragraph around it as the explanation", () => {
    expect(termPrefill({ selection: " vacuum ", messageId: "a", branch: null, messages })).toEqual({ term: "vacuum", explanation: "另外還有 VACUUM。", sourceMessageId: "a" });
    // The user's own words explain nothing: only the term is filled.
    expect(termPrefill({ selection: "MVCC", messageId: "q", branch: null, messages })).toEqual({ term: "MVCC", explanation: "", sourceMessageId: "q" });
  });

  it("takes a long selection or a whole message as the explanation and leaves the term to write", () => {
    const long = "MVCC 是多版本並行控制：讀不擋寫。".repeat(4);
    expect(termPrefill({ selection: long, messageId: "a", branch: null, messages })).toEqual({ term: "", explanation: long, sourceMessageId: "a" });
    expect(termPrefill({ messageId: "a", branch: null, messages })).toEqual({ term: "", explanation: messages[1]!.content, sourceMessageId: "a" });
    expect(termPrefill({ messageId: "a", branch: aside, messages }).term).toBe("MVCC");
  });

  it("finds the paragraph that mentions the words, whatever their case", () => {
    expect(paragraphWith("a\n\nThe WAL comes first.\n\nb", "wal")).toBe("The WAL comes first.");
    expect(paragraphWith("nothing here", "wal")).toBe("");
  });
});

describe("classifyTermError", () => {
  it("reads the stored term out of term_exists", () => {
    const stored = term("MVCC", "多版本並行控制");
    const failure = classifyTermError(new TangentError(409, "exists", "term_exists", { term: stored }));
    expect(failure).toEqual({ kind: "exists", existing: stored });
    expect(classifyTermError(new TangentError(409, "exists", "term_exists"))).toEqual({ kind: "exists", existing: null });
  });

  it("words the other refusals", () => {
    expect(classifyTermError(new TangentError(409, "", "term_limit", { limit: 300 }))).toEqual({ kind: "limit", limit: 300 });
    expect(classifyTermError(new TangentError(404, "", "term_not_found"))).toEqual({ kind: "gone" });
    expect(classifyTermError(new TangentError(404, "", "message_not_found"))).toEqual({ kind: "sourceGone" });
    expect(classifyTermError(new TangentError(400, "", "invalid_input", { field: "explanation" }))).toEqual({ kind: "empty", field: "explanation" });
    expect(classifyTermError(new TangentError(400, "", "invalid_input"))).toEqual({ kind: "other" });
    expect(classifyTermError(new TangentError(422, "", "too_long", { field: "term", max: 60 }))).toEqual({ kind: "tooLong", field: "term", max: 60 });
    expect(classifyTermError(new TangentError(409, "", "archived"))).toEqual({ kind: "archived" });
    expect(classifyTermError(new TangentError(404, "", "feature_disabled"))).toEqual({ kind: "featureOff" });
    expect(classifyTermError(new Error("offline"))).toEqual({ kind: "other" });
  });
});

describe("filtering and search order", () => {
  const terms = [term("MVCC", "多版本並行控制"), term("VACUUM", "清掉 MVCC 留下的死 tuple"), term("WAL", "write-ahead log")];

  it("keeps the terms whose name holds the query, then the ones whose explanation does", () => {
    expect(filterTerms(terms, "mv").map((item) => item.term)).toEqual(["MVCC", "VACUUM"]);
    expect(filterTerms(terms, " ").map((item) => item.term)).toEqual(["MVCC", "VACUUM", "WAL"]);
    expect(filterTerms(terms, "zzz")).toEqual([]);
  });

  it("ranks a term that starts with the query before one that contains it", () => {
    expect(rankTerms([term("PITR via WAL"), term("WAL"), term("MVCC")], "wal").map((item) => item.term)).toEqual(["WAL", "PITR via WAL"]);
  });

  it("looks up only a short one-line selection, and answers with the same term of another conversation", () => {
    expect(isTermLookup("MVCC")).toBe(true);
    expect(isTermLookup("字".repeat(61))).toBe(false);
    expect(isTermLookup("two\nlines")).toBe(false);
    expect(isTermLookup("  ")).toBe(false);
    const hits = [term("MVCC", "old", { rootLineId: "other", updatedAt: "2026-01-01T00:00:00Z" }), term("MVCC", "new", { id: "n", rootLineId: "third", updatedAt: "2026-02-01T00:00:00Z" }), term("MVCC 快照", "x", { rootLineId: "other" }), term("MVCC", "here", { rootLineId: "root" })];
    expect(askedBefore(hits, "mvcc", "root")?.explanation).toBe("new");
    expect(askedBefore(hits.slice(3), "mvcc", "root")).toBeNull();
  });
});

describe("readers", () => {
  it("fill the limits and drop a keptBranch that is not an object", () => {
    expect(normalizeTermList({ rootLineId: "r", terms: null }).limits).toEqual(DEFAULT_TERM_LIMITS);
    expect(normalizeTermWriteResult({ term: { id: "t" }, change: "weird", keptBranch: null })).toMatchObject({ change: "created", term: { id: "t", explanation: "" } });
    expect("keptBranch" in normalizeTermWriteResult({ term: {} })).toBe(false);
    expect(normalizeTermSearchPage({ terms: [{ id: "t", rootTitle: "資料庫" }] })).toEqual({ terms: [expect.objectContaining({ id: "t", rootTitle: "資料庫" })], nextCursor: "" });
  });
});
