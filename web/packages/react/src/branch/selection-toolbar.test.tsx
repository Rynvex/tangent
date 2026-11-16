import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMessageSelection, SelectionToolbar } from "./selection-toolbar";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

type OnSelection = (selection: { messageId: string; text: string }) => void;

function Harness({ onBranch, onNote, onQuickAsk, onMemo }: { onBranch?: OnSelection; onNote?: OnSelection; onQuickAsk?: OnSelection; onMemo?: OnSelection }) {
  const ref = useRef<HTMLOListElement>(null);
  return (
    <>
      <ol ref={ref}>
        <li data-message-id="m1">
          <p>Autumn in Kyoto is lovely.</p>
        </li>
        <li data-message-id="m2">
          <p>Book early.</p>
        </li>
        <li data-message-id="c1" data-forkable="false">
          <p>Card: take the JR pass.</p>
        </li>
      </ol>
      <p data-testid="outside">Outside the thread</p>
      <SelectionToolbar containerRef={ref} {...(onBranch ? { onBranch } : {})} {...(onNote ? { onNote } : {})} {...(onQuickAsk ? { onQuickAsk } : {})} {...(onMemo ? { onMemo } : {})} />
    </>
  );
}

function select(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    fireEvent(document, new Event("selectionchange"));
  });
}

describe("SelectionToolbar: the glossary (F19)", () => {
  function GlossaryHarness({ onTerm, hint }: { onTerm?: OnSelection; hint?: (selection: { text: string }, close: () => void) => ReactNode }) {
    const ref = useRef<HTMLOListElement>(null);
    return (
      <>
        <ol ref={ref}>
          <li data-message-id="m1">
            <p>MVCC keeps old row versions.</p>
          </li>
        </ol>
        <SelectionToolbar containerRef={ref} {...(onTerm ? { onTerm } : {})} {...(hint ? { hint } : {})} />
      </>
    );
  }

  it("offers 存進名詞表 last, on its own too, and hands the host the selection", async () => {
    // Arrange
    const onTerm = vi.fn();
    render(<GlossaryHarness onTerm={onTerm} />);

    // Act
    select(screen.getByText("MVCC keeps old row versions.").firstChild!, 0, 4);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Save to glossary" }));

    // Assert
    expect(onTerm).toHaveBeenCalledWith({ messageId: "m1", text: "MVCC", forkable: true });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows the host's hint about the selection under the buttons, and the hint can close the toolbar", async () => {
    // Arrange
    const seen: string[] = [];
    const hint = (selection: { text: string }, close: () => void) => {
      seen.push(selection.text);
      return (
        <button type="button" onClick={close}>
          Asked before: Databases
        </button>
      );
    };
    render(<GlossaryHarness onTerm={vi.fn()} hint={hint} />);

    // Act
    select(screen.getByText("MVCC keeps old row versions.").firstChild!, 0, 4);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });

    // Assert
    expect(seen.at(-1)).toBe("MVCC");
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Save to glossary", "Asked before: Databases"]);
    await userEvent.click(within(toolbar).getByRole("button", { name: "Asked before: Databases" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("has neither while the host wires neither (the glossary is off)", async () => {
    render(<Harness onBranch={() => undefined} onNote={() => undefined} onMemo={() => undefined} />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(within(toolbar).queryByRole("button", { name: "Save to glossary" })).toBeNull();
    expect(within(toolbar).getAllByRole("button")).toHaveLength(3);
  });
});

describe("SelectionToolbar", () => {
  it("F10: puts Quick ask first when wired, and never inside a conclusion card", async () => {
    const onQuickAsk = vi.fn();
    render(<Harness onBranch={() => undefined} onNote={() => undefined} onQuickAsk={onQuickAsk} />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(within(toolbar).getAllByRole("button")[0]).toHaveAccessibleName("Quick ask");
    await userEvent.click(within(toolbar).getByRole("button", { name: "Quick ask" }));
    expect(onQuickAsk).toHaveBeenCalledWith({ messageId: "m2", text: "Book", forkable: true });
    select(screen.getByText("Card: take the JR pass.").firstChild!, 6, 22);
    expect(within(await screen.findByRole("toolbar")).queryByRole("button", { name: "Quick ask" })).toBeNull();
  });

  it("appears for text selected inside one message and opens a branch from it", async () => {
    const onBranch = vi.fn();
    render(<Harness onBranch={onBranch} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    select(screen.getByText("Autumn in Kyoto is lovely.").firstChild!, 0, 15);
    await screen.findByRole("toolbar", { name: "Selected text" });
    await userEvent.click(screen.getByRole("button", { name: "Branch from this" }));
    expect(onBranch).toHaveBeenCalledWith({ messageId: "m1", text: "Autumn in Kyoto", forkable: true });
    // The action used the selection; the toolbar goes away with it.
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("ignores a selection that spans messages or lies outside the thread", () => {
    render(<Harness onBranch={() => undefined} />);
    select(screen.getByText("Autumn in Kyoto is lovely.").firstChild!, 0, 4, screen.getByText("Book early.").firstChild!);
    expect(screen.queryByRole("toolbar")).toBeNull();
    select(screen.getByTestId("outside").firstChild!, 0, 7);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("offers the notes action only when the host wires it", () => {
    render(<Harness onBranch={() => undefined} onNote={() => undefined} />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    expect(screen.getByRole("button", { name: "Save to notes" })).toBeInTheDocument();
  });

  it("offers only the notes action inside a conclusion card or move marker (R5)", async () => {
    const onBranch = vi.fn();
    const onNote = vi.fn();
    render(<Harness onBranch={onBranch} onNote={onNote} />);
    select(screen.getByText("Card: take the JR pass.").firstChild!, 6, 22);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(screen.queryByRole("button", { name: "Branch from this" })).toBeNull();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Save to notes" }));
    expect(onNote).toHaveBeenCalledWith({ messageId: "c1", text: "take the JR pass", forkable: false });
    expect(onBranch).not.toHaveBeenCalled();
  });

  it("F11 §1: without 開支線 (inside an aside) offers only the notes and memo actions, and nothing when neither is wired", async () => {
    const { unmount } = render(<Harness onNote={() => undefined} onMemo={() => undefined} />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Save to notes", "Save as a memo"]);
    unmount();
    render(<Harness />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows nothing inside a card when the notes action is not wired (R5)", () => {
    render(<Harness onBranch={() => undefined} />);
    select(screen.getByText("Card: take the JR pass.").firstChild!, 0, 4);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("reads the current selection for ⌘B", () => {
    render(<Harness onBranch={() => undefined} />);
    select(screen.getByText("Book early.").firstChild!, 0, 4);
    expect(readMessageSelection(document.querySelector("ol"))).toEqual({ messageId: "m2", text: "Book", forkable: true });
  });

  it("follows the selection when the page scrolls or resizes (R2)", () => {
    let top = 300;
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 200, right: 300, width: 100, height: 20, x: 200, y: top, toJSON: () => ({}) }) as DOMRect;
    try {
      render(<Harness onBranch={() => undefined} />);
      select(screen.getByText("Book early.").firstChild!, 0, 4);
      const toolbar = screen.getByRole("toolbar");
      expect(toolbar.style.top).toBe("292px");
      top = 120;
      act(() => {
        fireEvent.scroll(screen.getByText("Book early."));
      });
      expect(screen.getByRole("toolbar").style.top).toBe("112px");
      top = 80;
      act(() => {
        fireEvent(window, new Event("resize"));
      });
      expect(screen.getByRole("toolbar").style.top).toBe("72px");
    } finally {
      Range.prototype.getBoundingClientRect = original;
    }
  });
});
