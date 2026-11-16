import { normalizeMessage, type Message, type Term } from "@tangent/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EXCERPT_PREVIEW_DELAY_MS } from "../conversation/excerpt-anchor";
import { MessageList } from "../conversation/message-list";
import { loadMarkdownRenderer } from "../markdown";
import { mockClient, tangentWrapper } from "../test-utils";
import { forgetTermMarks, makeTermMarking } from "./term-marks";

/** F19 §2.3: a conversation's glossary terms underlined in its finished replies. */

beforeAll(() => loadMarkdownRenderer());
afterEach(() => {
  cleanup();
  forgetTermMarks();
  vi.useRealTimers();
});

const term = (name: string, explanation: string): Term => ({
  id: `t-${name}`,
  rootLineId: "l1",
  term: name,
  termKey: name.replace(/\s/g, "").toLowerCase(),
  explanation,
  sourceLineId: "l1",
  sourceMessageId: "",
  sourceLabel: "主線 #2",
  createdBy: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const msg = (id: string, seq: number, role: string, content: string, extra: Record<string, unknown> = {}): Message => normalizeMessage({ id, seq, lineId: "l1", role, kind: "chat", status: "done", content, ...extra });

const TERMS = [term("MVCC", "多版本並行控制：讀不擋寫。"), term("WAL", "Write-ahead log.")];
const marks = () => [...document.querySelectorAll("[data-tg-term-mark]")].map((mark) => [mark.getAttribute("data-tg-term-mark"), mark.textContent]);

function show(messages: readonly Message[], onOpen = vi.fn(), terms: readonly Term[] = TERMS) {
  const client = mockClient();
  const marking = makeTermMarking(terms, onOpen);
  const view = render(<MessageList lineId="l1" messages={messages} terms={marking} />, { wrapper: tangentWrapper(client) });
  return { client, marking, onOpen, view };
}

describe("known terms in a transcript", () => {
  it("underlines each term once per reply, at its first appearance, and never in the user's own message or in code", async () => {
    // Arrange
    const messages = [
      msg("u1", 1, "user", "MVCC 是什麼？"),
      msg("a1", 2, "assistant", "MVCC 讓讀不擋寫；MVCC 靠 WAL 保證持久性。\n\n```\nWAL MVCC\n```"),
      msg("a2", 3, "assistant", "沒有名詞的回覆。"),
    ];

    // Act
    const { client } = show(messages);

    // Assert
    await waitFor(() => expect(marks()).toEqual([["t-MVCC", "MVCC"], ["t-WAL", "WAL"]]));
    for (const mark of document.querySelectorAll("[data-tg-term-mark]")) expect(mark.closest('[data-message-id="a1"]')).not.toBeNull();
    client.mock.dispose();
  });

  it("leaves a reply that is still being written unmarked", async () => {
    const { client } = show([msg("u1", 1, "user", "q"), msg("a1", 2, "assistant", "MVCC so far", { status: "pending" })]);
    await screen.findByText("MVCC so far");
    expect(marks()).toEqual([]);
    client.mock.dispose();
  });

  it("shows the explanation after the pointer rests on a term, at once on keyboard focus, and Enter or a click opens it in the glossary", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, onOpen } = show([msg("a1", 1, "assistant", "用 MVCC 避免鎖。")]);
    const mark = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-tg-term-mark]");
      expect(found).not.toBeNull();
      return found!;
    });

    // Act and assert: hover waits, then shows.
    fireEvent.pointerEnter(mark.parentElement!, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(EXCERPT_PREVIEW_DELAY_MS + 10));
    expect(screen.getByRole("tooltip")).toHaveTextContent("多版本並行控制：讀不擋寫。");
    fireEvent.pointerLeave(mark.parentElement!);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Focus shows it at once; Escape hides it; Enter opens the glossary at the term.
    act(() => mark.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("MVCC");
    fireEvent.keyDown(mark, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(mark, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "t-MVCC" }));
    await userEvent.click(mark);
    expect(onOpen).toHaveBeenCalledTimes(2);
    client.mock.dispose();
  });

  it("on a touch screen a tap opens a bottom sheet with the explanation and the way to the glossary", async () => {
    // Arrange
    // jsdom has no matchMedia: a coarse pointer is put in for this test.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("coarse"), media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
    const { client, onOpen } = show([msg("a1", 1, "assistant", "用 MVCC 避免鎖。")]);
    const mark = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-tg-term-mark]");
      expect(found).not.toBeNull();
      return found!;
    });

    // Act
    await userEvent.click(mark);

    // Assert
    const sheet = await screen.findByRole("dialog", { name: "MVCC" });
    expect(sheet).toHaveTextContent("多版本並行控制：讀不擋寫。");
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open in the glossary" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "t-MVCC" }));
    window.matchMedia = original;
    client.mock.dispose();
  });
});

describe("makeTermMarking", () => {
  it("answers what marks a message from memory until its text changes, and null when no term appears", () => {
    // Arrange
    const marking = makeTermMarking(TERMS, vi.fn());
    const text = "MVCC here";
    const startsWith = vi.spyOn(String.prototype, "startsWith");

    // Act
    const first = marking.forMessage("m1", text);
    const calls = startsWith.mock.calls.length;
    const again = marking.forMessage("m1", text);
    const callsAgain = startsWith.mock.calls.length;
    const changed = marking.forMessage("m1", "no term now");
    startsWith.mockRestore();

    // Assert: the second question did no matching at all.
    expect(first).not.toBeNull();
    expect(again).toBe(first);
    expect(changed).toBeNull();
    expect(calls).toBeGreaterThan(0);
    expect(callsAgain).toBe(calls);
  });

  it("gives each reply its own scan (a term marked in one reply is marked in the next too) and at most 20 marks", () => {
    const many = Array.from({ length: 30 }, (_, index) => term(`term${index}x`, "x"));
    const text = many.map((item) => item.term).join(" ");
    const { scan } = makeTermMarking(many, vi.fn()).forMessage("m1", text)!;
    expect(scan()(text)).toHaveLength(20);
    expect(scan()(text)).toHaveLength(20);
    const one = scan();
    expect(one("term0x and term1x")).toHaveLength(2);
    expect(one("term0x again, term2x new").map((range) => range.key)).toEqual(["term:t-term2x"]);
  });

  it("a changed glossary leaves a message alone unless the terms it uses changed", () => {
    // Arrange: two replies, one about MVCC and one about WAL.
    const first = makeTermMarking(TERMS, vi.fn());
    const mvccBefore = first.forMessage("about-mvcc", "MVCC keeps versions.");
    const walBefore = first.forMessage("about-wal", "The WAL comes first.");
    const noneBefore = first.forMessage("about-nothing", "Nothing known here.");

    // Act: a term neither uses is added, and WAL's explanation is edited.
    const edited = TERMS.map((item) => (item.term === "WAL" ? { ...item, explanation: "Changed.", updatedAt: "2026-02-02T00:00:00Z" } : item));
    const second = makeTermMarking([...edited, term("VACUUM", "Cleans dead rows.")], vi.fn());

    // Assert: MVCC's reply keeps the very object it had; WAL's gets a new one; the third still has none.
    expect(second.forMessage("about-mvcc", "MVCC keeps versions.")).toBe(mvccBefore);
    expect(second.forMessage("about-wal", "The WAL comes first.")).not.toBe(walBefore);
    expect(second.forMessage("about-nothing", "Nothing known here.")).toBe(noneBefore);
    expect(noneBefore).toBeNull();

    // A new term the reply does use, or one it used that is gone, changes it too.
    const third = makeTermMarking([...edited, term("versions", "Row versions.")], vi.fn());
    expect(third.forMessage("about-mvcc", "MVCC keeps versions.")).not.toBe(mvccBefore);
    const fourth = makeTermMarking(edited.filter((item) => item.term !== "MVCC"), vi.fn());
    expect(fourth.forMessage("about-mvcc", "MVCC keeps versions.")).toBeNull();
  });
});

describe("a glossary that changes under a transcript", () => {
  it("re-renders only the replies whose terms changed", async () => {
    // Arrange
    const messages = [msg("a1", 1, "assistant", "MVCC keeps versions."), msg("a2", 2, "assistant", "The WAL comes first."), msg("a3", 3, "assistant", "Nothing known here.")];
    const { client, view } = show(messages);
    await waitFor(() => expect(marks()).toHaveLength(2));
    const nodes = [...document.querySelectorAll("[data-tg-markdown]")];

    // Act: a term only the third reply uses.
    const next = makeTermMarking([...TERMS, term("Nothing", "An absence.")], vi.fn());
    view.rerender(<MessageList lineId="l1" messages={messages} terms={next} />);

    // Assert: the third reply is marked now; the first two kept their very marks (their Markdown was not rendered again).
    await waitFor(() => expect(marks()).toHaveLength(3));
    const after = [...document.querySelectorAll("[data-tg-term-mark]")];
    expect(after.map((mark) => mark.textContent)).toEqual(["MVCC", "WAL", "Nothing"]);
    expect([...document.querySelectorAll("[data-tg-markdown]")].slice(0, 2)).toEqual(nodes.slice(0, 2));
    client.mock.dispose();
  });
});
