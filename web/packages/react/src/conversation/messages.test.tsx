import { normalizeBranchView, normalizeMessage, type Message } from "@tangent/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer } from "../markdown";
import { AssistantMessage, pendingText } from "./assistant-message";
import { BranchSuggestions } from "./branch-suggestions";
import { ForkMarker } from "./fork-marker";
import { MessageActions } from "./message-actions";
import { UserMessage } from "./user-message";

/** The toolbars render their buttons once their message is pointed at (F8 S1): point at every one. */
const armToolbars = () =>
  act(() => {
    for (const bar of document.querySelectorAll("[data-tg-actions]")) bar.parentElement?.dispatchEvent(new Event("pointerenter"));
  });


beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const ai = (over: Record<string, unknown> = {}): Message => normalizeMessage({ id: "a1", seq: 2, lineId: "l1", role: "assistant", status: "done", content: "## Plan\n\n- one", ...over });

describe("UserMessage", () => {
  it("shows the text as typed (no Markdown) with its label", () => {
    render(<UserMessage message={normalizeMessage({ id: "u1", role: "user", content: "# not a heading\n<b>x</b>" })} label="You · #3" />);
    expect(screen.getByText("You · #3")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/# not a heading/)).toHaveTextContent("<b>x</b>");
  });
});

describe("AssistantMessage", () => {
  it("renders a finished reply as Markdown", () => {
    render(<AssistantMessage message={ai()} label="AI · #4" />);
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("article")).not.toHaveAttribute("aria-busy");
  });

  it("sets the reply in the reading font with loose leading, a little tracking and 12px between paragraphs (F10 §1)", () => {
    const { container } = render(<AssistantMessage message={ai({ content: "one\n\ntwo" })} />);
    const body = container.querySelector("[data-tg-markdown]")!;
    for (const name of ["font-tg-serif", "leading-tg-reading", "tracking-[0.01em]", "[&_p+p]:mt-3"]) expect(body, name).toHaveClass(name);
  });

  it("says it is thinking before the first delta, then streams the text", () => {
    const pending = ai({ status: "pending", content: "" });
    const { rerender } = render(<AssistantMessage message={pending} stream={null} />);
    expect(screen.getAllByText("Preparing context and sending…").length).toBeGreaterThan(0);
    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
    rerender(<AssistantMessage message={pending} stream={{ turnId: "a1", deltas: [], textStarts: [], text: "Hello **wor**ld", reasoning: "", lastSeq: 1, gap: false }} />);
    expect(screen.queryByText("Preparing context and sending…")).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("Hello world");
    expect(screen.getByText("wor").tagName).toBe("STRONG");
  });

  it("builds a pending reply from the stored content plus the stream, marking a lost start", () => {
    const stream = (text: string, gap: boolean) => ({ turnId: "a1", deltas: [], textStarts: [], text, reasoning: "", lastSeq: 1, gap });
    expect(pendingText(ai({ status: "pending", content: "" }), stream("abc", false))).toBe("abc");
    expect(pendingText(ai({ status: "pending", content: "" }), stream("tail", true))).toBe("… tail");
    expect(pendingText(ai({ status: "pending", content: "Stored " }), stream("more", true))).toBe("Stored more");
    expect(pendingText(ai({ status: "pending", content: "Stored" }), null)).toBe("Stored");
  });

  it("appends only the deltas after the stored base's streamSeq, so saved text is not repeated", () => {
    const deltas = [
      { turnId: "a1", seq: 10, kind: "text" as const, text: "Half " },
      { turnId: "a1", seq: 11, kind: "text" as const, text: "of the " },
      { turnId: "a1", seq: 12, kind: "reasoning" as const, text: "thinking" },
      { turnId: "a1", seq: 13, kind: "text" as const, text: "answer" },
    ];
    const stream = { turnId: "a1", deltas, textStarts: [0, 5, 12, 12], text: "Half of the answer", reasoning: "thinking", lastSeq: 13, gap: false };
    const stored = ai({ status: "pending", content: "Half of the ", meta: { streamSeq: 11 } });
    expect(pendingText(stored, stream)).toBe("Half of the answer");
    expect(pendingText(ai({ status: "pending", content: "Half of the answer", meta: { streamSeq: 13 } }), stream)).toBe("Half of the answer");
  });

  it("marks text lost between the saved base and the stream, and drops the mark once a newer base covers it", () => {
    const tail = { turnId: "a1", deltas: [{ turnId: "a1", seq: 20, kind: "text" as const, text: "end" }], textStarts: [0], text: "end", reasoning: "", lastSeq: 20, gap: true };
    expect(pendingText(ai({ status: "pending", content: "Start ", meta: { streamSeq: 11 } }), tail)).toBe("Start  … end");
    expect(pendingText(ai({ status: "pending", content: "Start middle end", meta: { streamSeq: 20 } }), tail)).toBe("Start middle end");
    expect(pendingText(ai({ status: "pending", content: "" }), tail)).toBe("… end");
  });

  it("marks a stopped reply as partial", () => {
    render(<AssistantMessage message={ai({ content: "half", meta: { cancelled: true } })} />);
    expect(screen.getByText("Stopped. This is what came before the stop.")).toBeInTheDocument();
  });

  it("shows a failed reply with its reason and a retry button", async () => {
    const onRetry = vi.fn();
    render(<AssistantMessage message={ai({ status: "error", content: "Turn failed: boom", meta: { error: "boom" } })} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The reply failed: boom");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders slots for actions and what follows the reply", () => {
    render(<AssistantMessage message={ai()} actions={<button type="button">act</button>} footer={<span>fork</span>} />);
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument();
    expect(screen.getByText("fork")).toBeInTheDocument();
  });
});

describe("MessageActions", () => {
  it("offers branch and copy; notes and park only when wired", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onBranch = vi.fn();
    const { rerender } = render(<MessageActions text="hello" onBranch={onBranch} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
    armToolbars();
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Open a branch here", "Copy message"]);
    await userEvent.click(screen.getByRole("button", { name: "Open a branch here" }));
    expect(onBranch).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith("hello");
    rerender(<MessageActions text="hello" onBranch={onBranch} onNote={vi.fn()} onPark={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});

describe("ForkMarker", () => {
  const branch = (status: string, unread = 0) => normalizeBranchView({ lineId: `b-${status}-${unread}`, status, unread, anchorMessageId: "a1", parentLineId: "l1" });

  it("shows the count, one dot per branch and a status summary", () => {
    render(<ForkMarker branches={[branch("open", 2), branch("merged")]} />);
    const marker = screen.getByText("2 branches").closest("[data-tg-fork]")!;
    expect(marker).toHaveTextContent("Open: 1・Brought back: 1・2 unread");
    expect(marker.querySelectorAll("[data-tg-fork-dot]")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is a disclosure button when its branches can be entered", async () => {
    render(<ForkMarker branches={[branch("open")]} onSelect={() => undefined} />);
    const toggle = screen.getByRole("button", { name: /1 branches/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("BranchSuggestions", () => {
  it("lists at most three, opens one and can be dismissed", async () => {
    const onOpen = vi.fn();
    const suggestions = ["a", "b", "c", "d"].map((purpose) => ({ purpose, kind: "investigate" as const }));
    render(<BranchSuggestions suggestions={suggestions} onOpen={onOpen} />);
    const group = screen.getByRole("group", { name: "AI suggests a branch" });
    expect(group.querySelectorAll("[data-tg-suggestion]")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: /a$/ }));
    expect(onOpen).toHaveBeenCalledWith({ purpose: "a", kind: "investigate" });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss the suggestions" }));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
