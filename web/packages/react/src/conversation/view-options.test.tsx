import { normalizeMessage, type Message } from "@tangent/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer } from "../markdown";
import { mockClient, tangentWrapper } from "../test-utils";
import { AssistantMessage } from "./assistant-message";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { ConversationOptionsProvider } from "./view-options";

beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const ai = (over: Record<string, unknown> = {}): Message => normalizeMessage({ id: "a1", seq: 2, lineId: "l1", role: "assistant", status: "done", content: "Answer", ...over });
const STREAM = { turnId: "a1", deltas: [], textStarts: [], text: "Hello world", reasoning: "", lastSeq: 1, gap: false };

/** G2: a host's reader settings reach the conversation components below the provider. */
describe("ConversationOptionsProvider: streaming text", () => {
  it("shows a reply's words as they arrive by default", () => {
    render(<AssistantMessage message={ai({ status: "pending", content: "" })} stream={STREAM} />);
    expect(screen.getByRole("article")).toHaveTextContent("Hello world");
  });

  it("off: a pending reply shows its progress and the stop, not its words; done, the whole text", () => {
    const onStop = vi.fn();
    const tree = (message: Message) => (
      <ConversationOptionsProvider streamText={false}>
        <AssistantMessage message={message} stream={STREAM} onStop={onStop} />
      </ConversationOptionsProvider>
    );
    const { rerender } = render(tree(ai({ status: "pending", content: "" })));
    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("article")).not.toHaveTextContent("Hello world");
    expect(screen.getAllByText("Preparing context and sending…").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    rerender(tree(ai({ status: "done", content: "Hello world, done." })));
    expect(screen.getByRole("article")).toHaveTextContent("Hello world, done.");
    expect(screen.getByRole("article")).not.toHaveAttribute("aria-busy");
  });
});

describe("ConversationOptionsProvider: the clock and the cards", () => {
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 52).toISOString();
  const messages = [
    normalizeMessage({ id: "u1", seq: 1, lineId: "l1", role: "user", status: "done", content: "Question", createdAt: at }),
    normalizeMessage({ id: "c1", seq: 2, lineId: "l1", role: "system", kind: "branch_card", status: "done", content: "x", meta: { card: { conclusion: "Use ZFS", openItems: ["Check the UPS"] } } }),
  ];
  const list = (options: { hour12?: boolean; expandCards?: boolean }) => (
    <ConversationOptionsProvider {...options}>
      <MessageList lineId="l1" messages={messages} />
    </ConversationOptionsProvider>
  );

  it("reads message times on the 24-hour clock by default and with AM / PM when asked", () => {
    const client = mockClient();
    const { rerender } = render(list({}), { wrapper: tangentWrapper(client) });
    expect(document.querySelector("[data-tg-message-time]")).toHaveTextContent("· 14:52");
    rerender(list({ hour12: true }));
    expect(document.querySelector("[data-tg-message-time]")).toHaveTextContent("· 2:52 PM");
    expect(document.querySelector("[data-tg-message-time]")).toHaveAttribute("datetime", at);
    client.mock.dispose();
  });

  it("starts conclusion cards open when asked, closed otherwise; changing the default applies to cards on screen", async () => {
    const client = mockClient();
    const { rerender } = render(list({}), { wrapper: tangentWrapper(client) });
    expect(await screen.findByRole("button", { name: "Show all fields" })).toHaveAttribute("aria-expanded", "false");
    rerender(list({ expandCards: true }));
    expect(await screen.findByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");
    // Still the reader's to close.
    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: "Show all fields" })).toHaveAttribute("aria-expanded", "false");
    client.mock.dispose();
  });
});

describe("Composer: a host's hint and a follow-up while a reply streams (G2)", () => {
  it("shows the host's hint in place of the bundled one", () => {
    const { rerender } = render(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByText(/^Enter to send · Shift\+Enter for a new line/)).toBeInTheDocument();
    rerender(<Composer value="" onValueChange={vi.fn()} onSend={vi.fn()} hint="Ctrl+Enter to send · Enter for a new line" />);
    expect(screen.getByText("Ctrl+Enter to send · Enter for a new line")).toBeInTheDocument();
    expect(screen.queryByText(/^Enter to send/)).toBeNull();
  });

  it("with a draft, sends while streaming (the host stops the reply); without one the button still stops", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onValueChange = vi.fn();
    const { rerender } = render(<Composer value="next question" onValueChange={onValueChange} onSend={onSend} onStop={onStop} streaming sendWhileStreaming />);
    expect(screen.queryByRole("button", { name: "Stop the reply" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("next question");
    expect(onValueChange).toHaveBeenCalledWith("");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onStop).not.toHaveBeenCalled();
    // Esc still stops the reply.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<Composer value="  " onValueChange={onValueChange} onSend={onSend} onStop={onStop} streaming sendWhileStreaming />);
    await userEvent.click(screen.getByRole("button", { name: "Stop the reply" }));
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("without the option, a draft waits while a reply streams, as ever", () => {
    const onSend = vi.fn();
    render(<Composer value="next question" onValueChange={vi.fn()} onSend={onSend} onStop={vi.fn()} streaming />);
    expect(screen.getByRole("button", { name: "Stop the reply" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
