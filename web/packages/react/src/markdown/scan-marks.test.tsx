import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer, Markdown, type MarkdownMark, type MarkScanner } from "./index";

/** F19 §2.3: the Markdown step that marks what a scan finds in each run of plain text. */

beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const renderMark = (mark: MarkdownMark, children: ReactNode) => (
  <mark data-key={mark.key} data-text={mark.text}>
    {children}
  </mark>
);

/** Marks every `word`, and counts how many it has marked across the runs of one pass. */
function scannerFor(word: string, limit = Infinity): { scan: MarkScanner; runs: string[] } {
  const runs: string[] = [];
  const scan: MarkScanner = () => {
    let left = limit;
    return (text) => {
      runs.push(text);
      const at = text.indexOf(word);
      if (at < 0 || left <= 0) return [];
      left -= 1;
      return [{ start: at, end: at + word.length, key: `scan:${word}` }];
    };
  };
  return { scan, runs };
}

const marked = () => [...document.querySelectorAll("mark")].map((mark) => [mark.getAttribute("data-key"), mark.textContent]);

describe("Markdown scanMarks", () => {
  it("wraps what the scan finds, keeps the text around it, and hands the mark its key and words", async () => {
    // Arrange
    const { scan } = scannerFor("MVCC");

    // Act
    render(
      <Markdown scanMarks={scan} renderMark={renderMark}>
        {"PostgreSQL uses MVCC for snapshots."}
      </Markdown>,
    );

    // Assert
    const mark = await screen.findByText("MVCC", { selector: "mark" });
    expect(mark).toHaveAttribute("data-key", "scan:MVCC");
    expect(mark).toHaveAttribute("data-text", "MVCC");
    expect(mark.closest("p")).toHaveTextContent("PostgreSQL uses MVCC for snapshots.");
  });

  it("never scans code blocks, code spans or links, and scans emphasised text", async () => {
    // Arrange
    const { scan, runs } = scannerFor("MVCC");
    const source = ["```sql", "SELECT 'MVCC';", "```", "", "Inline `MVCC` and [MVCC docs](https://example.com) stay; **MVCC** in bold is marked."].join("\n");

    // Act
    render(
      <Markdown scanMarks={scan} renderMark={renderMark}>
        {source}
      </Markdown>,
    );

    // Assert
    await screen.findByText("MVCC", { selector: "mark" });
    expect(marked()).toEqual([["scan:MVCC", "MVCC"]]);
    expect(document.querySelector("mark")?.closest("strong")).not.toBeNull();
    expect(runs.some((run) => run.includes("SELECT") || run.includes("docs"))).toBe(false);
  });

  it("runs one scan over the whole text in reading order, so a limit holds across paragraphs", async () => {
    const { scan } = scannerFor("term", 2);
    render(
      <Markdown scanMarks={scan} renderMark={renderMark}>
        {"term one\n\nterm two\n\nterm three"}
      </Markdown>,
    );
    await screen.findAllByText("term", { selector: "mark" });
    expect(marked()).toHaveLength(2);
  });

  it("places the fixed marks first and leaves their words out of the scan", async () => {
    // Arrange: the excerpt anchor holds the first MVCC; the scan gets the text that is left.
    const { scan, runs } = scannerFor("MVCC");

    // Act
    render(
      <Markdown marks={[{ text: "MVCC keeps", key: "excerpt" }]} scanMarks={scan} renderMark={renderMark}>
        {"MVCC keeps old rows. Later MVCC cleans up."}
      </Markdown>,
    );

    // Assert
    await screen.findByText("MVCC keeps", { selector: "mark" });
    expect(marked()).toEqual([
      ["excerpt", "MVCC keeps"],
      ["scan:MVCC", "MVCC"],
    ]);
    expect(runs).not.toContain("MVCC keeps");
  });

  it("drops ranges that overlap or run off the text instead of breaking the reply", async () => {
    const scan: MarkScanner = () => (text) =>
      text.startsWith("abcdef")
        ? [
            { start: 0, end: 3, key: "a" },
            { start: 2, end: 5, key: "overlap" },
            { start: 4, end: 99, key: "off" },
          ]
        : [];
    render(
      <Markdown scanMarks={scan} renderMark={renderMark}>
        {"abcdef"}
      </Markdown>,
    );
    await screen.findByText("abc", { selector: "mark" });
    expect(marked()).toEqual([["a", "abc"]]);
    expect(document.querySelector("p")).toHaveTextContent("abcdef");
  });

  it("does not scan while the text is still streaming", async () => {
    const { scan, runs } = scannerFor("MVCC");
    render(
      <Markdown scanMarks={scan} renderMark={renderMark} isStreaming>
        {"MVCC so far"}
      </Markdown>,
    );
    await screen.findByText("MVCC so far");
    expect(runs).toEqual([]);
    expect(marked()).toEqual([]);
  });
});

describe("a scan that changes after the first render (the glossary changed)", () => {
  /** A stand-in for the browser's observer: nothing is in view until the test says so. */
  function fakeObserver() {
    const watched = new Set<Element>();
    let notify: IntersectionObserverCallback = () => undefined;
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe(element: Element) {
        watched.add(element);
      }
      unobserve(element: Element) {
        watched.delete(element);
      }
      disconnect() {
        watched.clear();
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const show = (element: Element) => act(() => notify([{ target: element, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    return { watched, show };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the marks it has while out of view, and takes the new scan when it comes into view", async () => {
    // Arrange: the first scan is used at once (the text is parsed anyway).
    const { watched, show } = fakeObserver();
    const first = scannerFor("MVCC");
    const text = "MVCC and WAL, both.";
    const { rerender } = render(
      <Markdown scanMarks={first.scan} renderMark={renderMark}>
        {text}
      </Markdown>,
    );
    await screen.findByText("MVCC", { selector: "mark" });
    expect(watched.size).toBe(0);

    // Act: another scan arrives while the block is not in view.
    const second = scannerFor("WAL");
    rerender(
      <Markdown scanMarks={second.scan} renderMark={renderMark}>
        {text}
      </Markdown>,
    );

    // Assert: it waits (nothing is parsed again), with the marks it had.
    await waitFor(() => expect(watched.size).toBe(1));
    expect(second.runs).toEqual([]);
    expect(marked()).toEqual([["scan:MVCC", "MVCC"]]);

    // Act: the block scrolls into view.
    show([...watched][0]!);

    // Assert
    await screen.findByText("WAL", { selector: "mark" });
    expect(marked()).toEqual([["scan:WAL", "WAL"]]);
    expect(watched.size).toBe(0);
  });

  it("does not parse again when it is rendered again with the same text and scan", async () => {
    fakeObserver();
    const { scan, runs } = scannerFor("MVCC");
    const view = (className: string) => (
      <Markdown scanMarks={scan} renderMark={renderMark} className={className}>
        {"MVCC once."}
      </Markdown>
    );
    const { rerender } = render(view("a"));
    await screen.findByText("MVCC", { selector: "mark" });
    const parses = runs.length;
    rerender(view("b"));
    expect(runs.length).toBe(parses);
  });
});

