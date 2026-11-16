import { describe, expect, it } from "vitest";
import { TERM_MARKS_PER_MESSAGE, createTermMatcher, hasTermInMarkdown, markdownPlainRuns, matchTermsInMarkdown, newTermScan, scanTerms, type TermName } from "./term-match";
import { normalizeTermKey } from "./glossary-rules";

const term = (name: string, id = name): TermName => ({ id, term: name, termKey: normalizeTermKey(name) });
const found = (terms: readonly TermName[], text: string, max?: number) => matchTermsInMarkdown(createTermMatcher(terms), text, max).map((match) => [match.termId, text.slice(match.start, match.end)]);

describe("scanTerms", () => {
  it("finds an English term whatever its case or width, as a whole word only", () => {
    // Arrange
    const terms = [term("WAL")];

    // Act and assert
    expect(found(terms, "The wal is a log.")).toEqual([["WAL", "wal"]]);
    expect(found(terms, "ＷＡＬ 會先寫入")).toEqual([["WAL", "ＷＡＬ"]]);
    expect(found(terms, "A WALL or a NARWAL is not it")).toEqual([]);
    expect(found(terms, "WAL-based, (WAL), WAL。")).toEqual([["WAL", "WAL"]]);
  });

  it("finds a Chinese term anywhere in a sentence, and an English one right next to Chinese", () => {
    expect(found([term("連線池")], "這裡的連線池大小要調整")).toEqual([["連線池", "連線池"]]);
    expect(found([term("MVCC")], "用MVCC來避免鎖")).toEqual([["MVCC", "MVCC"]]);
  });

  it("takes the longest of the terms that match at one place", () => {
    // Arrange
    const terms = [term("連線池"), term("連線池大小"), term("log"), term("write ahead log")];

    // Act and assert
    expect(found(terms, "連線池大小決定吞吐量")).toEqual([["連線池大小", "連線池大小"]]);
    expect(found(terms, "The Write Ahead Log comes first")).toEqual([["write ahead log", "Write Ahead Log"]]);
  });

  it("reports a term once, at its first appearance, and gives a later standalone shorter term its own mark", () => {
    const terms = [term("連線池"), term("連線池大小")];
    expect(found(terms, "連線池大小先看，連線池大小再看，最後是連線池。")).toEqual([
      ["連線池大小", "連線池大小"],
      ["連線池", "連線池"],
    ]);
    expect(found([term("MVCC")], "MVCC, mvcc and MVCC again")).toEqual([["MVCC", "MVCC"]]);
  });

  it("skips a space only where the term itself has one, never across a line break", () => {
    const terms = [term("write ahead log"), term("also")];
    expect(found(terms, "the writeaheadlog and the write  ahead log")).toEqual([["write ahead log", "writeaheadlog"]]);
    expect(found(terms, "write\nahead log")).toEqual([]);
    expect(found(terms, "al so it goes")).toEqual([]);
  });

  it("stops at the limit of marks for one message", () => {
    // Arrange
    const terms = Array.from({ length: 30 }, (_, index) => term(`term${index}x`));
    const text = terms.map((item) => item.term).join(" ");

    // Act
    const matches = found(terms, text);

    // Assert
    expect(matches).toHaveLength(TERM_MARKS_PER_MESSAGE);
    expect(found(terms, text, 3)).toHaveLength(3);
  });

  it("carries what it has seen and how many are left from one run of text to the next", () => {
    // Arrange
    const matcher = createTermMatcher([term("MVCC"), term("WAL"), term("VACUUM")]);

    // Act
    const first = scanTerms(matcher, "MVCC first", newTermScan(2));
    const second = scanTerms(matcher, "MVCC again, then WAL, then VACUUM", first.state);

    // Assert
    expect(first.matches.map((match) => match.termId)).toEqual(["MVCC"]);
    expect(second.matches.map((match) => match.termId)).toEqual(["WAL"]);
    expect(second.state.left).toBe(0);
    expect(first.state.left).toBe(1);
  });

  it("finds nothing without terms and ignores a term with an empty key", () => {
    expect(found([], "anything")).toEqual([]);
    expect(createTermMatcher([{ id: "x", term: "   ", termKey: "" }]).size).toBe(0);
  });
});

describe("matchTermsInMarkdown", () => {
  const terms = [term("MVCC"), term("vacuum")];

  it("leaves fenced code, code spans, links and addresses alone", () => {
    const source = ["```sql", "VACUUM; -- MVCC", "```", "Run `VACUUM` here, see [MVCC docs](https://example.com/mvcc) or https://example.com/vacuum.", "", "~~~", "mvcc", "~~~"].join("\n");
    expect(found(terms, source)).toEqual([]);
    expect(hasTermInMarkdown(createTermMatcher(terms), source)).toBe(false);
  });

  it("finds the terms in the prose around code, with offsets into the source", () => {
    // Arrange
    const source = "```\nMVCC\n```\nThen **MVCC** needs `x` a vacuum.";

    // Act
    const matches = matchTermsInMarkdown(createTermMatcher(terms), source);

    // Assert
    expect(matches.map((match) => source.slice(match.start, match.end))).toEqual(["MVCC", "vacuum"]);
    expect(matches[0]!.start).toBe(source.indexOf("**MVCC**") + 2);
  });

  it("treats everything after an unclosed fence as code (a reply cut short)", () => {
    expect(found(terms, "MVCC first\n```\nvacuum inside")).toEqual([["MVCC", "MVCC"]]);
  });

  it("splits a source into its plain runs", () => {
    const source = "a `b` c";
    expect(markdownPlainRuns(source).map((run) => source.slice(run.start, run.end))).toEqual(["a ", " c"]);
  });
});

describe("matching a long conversation", () => {
  it("answers for 487 replies against 50 terms in a few milliseconds each way", () => {
    // Arrange: replies of about 1,500 characters, mixed Chinese and English, with code and links.
    const terms = Array.from({ length: 45 }, (_, index) => term(`名詞${index}號`)).concat([term("MVCC"), term("WAL"), term("ZFS"), term("write ahead log"), term("快照")]);
    const reply = (index: number) =>
      [
        `第 ${index} 段：ZFS 用寫入時複製做快照，資料庫的 MVCC 讓每個交易看到自己的版本。${"這是一段補充說明，沒有名詞。".repeat(40)}`,
        "",
        "```sh",
        "zfs snapshot tank/data@before # MVCC WAL",
        "```",
        "",
        `The write ahead log (WAL) comes first; see [docs](https://example.com/wal). ${"Plain filler sentence without any term. ".repeat(12)}`,
      ].join("\n");
    const replies = Array.from({ length: 487 }, (_, index) => reply(index));
    const matcher = createTermMatcher(terms);

    // Act
    const started = performance.now();
    const has = replies.filter((text) => hasTermInMarkdown(matcher, text)).length;
    const gate = performance.now() - started;
    const again = performance.now();
    const marks = replies.reduce((total, text) => total + matchTermsInMarkdown(matcher, text).length, 0);
    const full = performance.now() - again;

    // Assert
    expect(has).toBe(487);
    expect(marks).toBe(487 * 5);
    console.info(`term matching: 487 replies of ${replies[0]!.length} chars, 50 terms: "has a term" ${gate.toFixed(1)} ms, every match ${full.toFixed(1)} ms`);
    // Loose bounds: a loaded machine must not fail the suite, a quadratic slip still does.
    expect(gate).toBeLessThan(500);
    expect(full).toBeLessThan(1500);
  });
});

