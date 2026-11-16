import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer";

afterEach(cleanup);

/** A composer that owns its draft like a host would. */
function Harness(props: Partial<ComposerProps> & { initial?: string }) {
  const { initial = "", ...rest } = props;
  const [value, setValue] = useState(initial);
  return <Composer value={value} onValueChange={setValue} onSend={vi.fn()} {...rest} />;
}

const box = () => screen.getByRole("textbox", { name: "Message" });

describe("Composer", () => {
  it("sends with Enter, trims, clears, and makes a new line with Shift+Enter", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await userEvent.type(box(), "  hello");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}world");
    expect(box()).toHaveValue("  hello\nworld");
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello\nworld");
    expect(box()).toHaveValue("");
  });

  it("does not send while an input method is composing", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} initial="注音" />);
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("注音");
  });

  it("ignores an empty draft and keeps the send button disabled", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} initial="   " />);
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("puts the text back when the send fails, unless the user typed something new", async () => {
    let fail: (error: Error) => void = () => undefined;
    const onSend = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    render(<Harness onSend={onSend} />);
    await userEvent.type(box(), "keep me{Enter}");
    expect(box()).toHaveValue("");
    await act(async () => fail(new Error("offline")));
    expect(box()).toHaveValue("keep me");
  });

  it("keeps one focused button when a reply starts and ends (send ⇄ stop)", () => {
    const { rerender } = render(<Composer value="hi" onValueChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Send" });
    button.focus();
    rerender(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} streaming />);
    expect(screen.getByRole("button", { name: "Stop the reply" })).toBe(button);
    rerender(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Send" })).toBe(button);
    expect(button).toHaveFocus();
  });

  it("keeps the draft when onSend throws synchronously", async () => {
    const onSend = vi.fn(() => {
      throw new Error("host bug");
    });
    render(<Harness onSend={onSend} />);
    await userEvent.type(box(), "do not lose me{Enter}");
    expect(box()).toHaveValue("do not lose me");
  });

  it("turns the send button into a stop button while streaming; Esc stops too", async () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(<Harness onSend={onSend} onStop={onStop} streaming initial="next" />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Stop the reply" }));
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows tokens for a draft, and the cost in the warning colour only above the threshold", () => {
    const { rerender } = render(<Composer value="x" onValueChange={vi.fn()} onSend={vi.fn()} onPreview={vi.fn()} estimate={{ tokens: 1234, costUsd: 0.01 }} costThreshold={0.05} />);
    expect(screen.getByRole("button", { name: /Preview before sending/ })).toHaveTextContent("1.2k");
    expect(screen.queryByText(/US\$/)).toBeNull();
    rerender(<Composer value="x" onValueChange={vi.fn()} onSend={vi.fn()} onPreview={vi.fn()} estimate={{ tokens: 30_000, costUsd: 0.09 }} costThreshold={0.05} />);
    const cost = screen.getByText("This turn ≈ US$0.09");
    expect(cost.className).toContain("text-tg-warning");
  });

  it("offers branch, park and preview buttons only when the host wires them", async () => {
    const onBranch = vi.fn();
    const onPreview = vi.fn();
    const { rerender } = render(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Open a branch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Park/ })).toBeNull();
    rerender(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} onBranch={onBranch} onPreview={onPreview} />);
    await userEvent.click(screen.getByRole("button", { name: /Open a branch/ }));
    await userEvent.click(screen.getByRole("button", { name: /Preview before sending/ }));
    expect(onBranch).toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalled();
  });

  it("offers 存成備忘 only with a memo handler and a draft (F10)", async () => {
    const { rerender } = render(<Composer value="an idea" onValueChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Save as memo" })).toBeNull();
    rerender(<Composer value="   " onValueChange={vi.fn()} onSend={vi.fn()} onMemo={vi.fn(async () => true)} />);
    expect(screen.queryByRole("button", { name: "Save as memo" })).toBeNull();
    rerender(<Composer value="an idea" onValueChange={vi.fn()} onSend={vi.fn()} onMemo={vi.fn(async () => true)} />);
    expect(screen.getByRole("button", { name: "Save as memo" })).toBeInTheDocument();
  });

  it("saves the trimmed draft as a memo and clears the box once it is written", async () => {
    let done: (value: boolean) => void = () => undefined;
    const onMemo = vi.fn(() => new Promise<boolean>((resolve) => (done = resolve)));
    const onSend = vi.fn();
    render(<Harness onSend={onSend} onMemo={onMemo} />);
    await userEvent.type(box(), "  my own words ");
    await userEvent.click(screen.getByRole("button", { name: "Save as memo" }));
    expect(onMemo).toHaveBeenCalledWith("my own words");
    // Not cleared before the host says it was written.
    expect(box()).toHaveValue("  my own words ");
    await act(async () => done(true));
    expect(box()).toHaveValue("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft when the memo is refused, or when something new was typed meanwhile", async () => {
    const refused = vi.fn(async () => false);
    const { unmount } = render(<Harness initial="keep me" onMemo={refused} />);
    await userEvent.click(screen.getByRole("button", { name: "Save as memo" }));
    await act(async () => undefined);
    expect(box()).toHaveValue("keep me");
    unmount();

    const rejected = vi.fn(() => Promise.reject(new Error("offline")));
    const second = render(<Harness initial="still here" onMemo={rejected} />);
    await userEvent.click(screen.getByRole("button", { name: "Save as memo" }));
    await act(async () => undefined);
    expect(box()).toHaveValue("still here");
    second.unmount();

    let done: (value: boolean) => void = () => undefined;
    const slow = vi.fn(() => new Promise<boolean>((resolve) => (done = resolve)));
    render(<Harness initial="first" onMemo={slow} />);
    await userEvent.click(screen.getByRole("button", { name: "Save as memo" }));
    await userEvent.type(box(), " and more");
    await act(async () => done(true));
    expect(box()).toHaveValue("first and more");
  });

  it("can be disabled and shows an error under the box", () => {
    render(<Composer value="x" onValueChange={vi.fn()} onSend={vi.fn()} disabled error="Not sent: offline" />);
    expect(box()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent: offline");
  });

  it("places the host's model control first in the toolbar, and nothing without one (G1)", () => {
    const { container, rerender } = render(<Harness onBranch={vi.fn()} modelControl={<button type="button">Claude Opus 5.5 · high</button>} />);
    const toolbar = container.querySelector("textarea")?.nextElementSibling;
    expect(toolbar?.firstElementChild).toHaveTextContent("Claude Opus 5.5 · high");
    expect(screen.getByRole("button", { name: "Claude Opus 5.5 · high" })).toBeInTheDocument();
    rerender(<Harness onBranch={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Claude Opus/ })).toBeNull();
  });
});
