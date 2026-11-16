import { normalizeBranchView, normalizeFold, normalizeMessage, type Message } from "@tangent/client";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer } from "../markdown";
import { mockClient, tangentWrapper } from "../test-utils";
import { MessageList } from "./message-list";

beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const msg = (id: string, seq: number, over: Record<string, unknown>): Message => normalizeMessage({ id, seq, lineId: "l1", status: "done", ...over });
const MESSAGES = [
  msg("u1", 1, { role: "user", content: "Question" }),
  msg("a1", 2, { role: "assistant", content: "Answer", meta: { suggestions: [{ purpose: "Dig deeper", kind: "investigate" }] } }),
  msg("c1", 3, { role: "system", kind: "branch_card", content: "x", meta: { card: { conclusion: "Use ZFS" } } }),
  msg("u2", 4, { role: "user", content: "Next" }),
  msg("a2", 5, { role: "assistant", status: "pending", content: "" }),
];
const BRANCHES = [normalizeBranchView({ lineId: "b1", parentLineId: "l1", anchorMessageId: "a1", status: "open" })];

/** The toolbars render their buttons once their message is pointed at (F8 S1): point at every one. */
const armToolbars = () =>
  act(() => {
    for (const bar of document.querySelectorAll("[data-tg-actions]")) bar.parentElement?.dispatchEvent(new Event("pointerenter"));
  });

/** F8 S1: actions beyond the three in view sit in the row's 「⋯」 menu (lazy). */
async function menuAction(row: HTMLElement, name: string | RegExp) {
  armToolbars();
  await userEvent.click(moreOf(row));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
/** The toolbar's 「⋯」 (the touch sheet's twin is hidden by CSS, which jsdom does not apply). */
const moreOf = (row: HTMLElement) => within(row).getAllByRole("button", { name: "More actions" }).find((button) => button.getAttribute("aria-haspopup") === "menu")!;
const rowOf = (text: string) => screen.getByText(text).closest("[data-message-id]") as HTMLElement;

function renderList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
  const client = mockClient();
  vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
  render(<MessageList lineId="l1" messages={MESSAGES} branches={BRANCHES} showSuggestions onBranch={vi.fn()} onSuggestion={vi.fn()} {...props} />, { wrapper: tangentWrapper(client) });
  armToolbars();
  return client;
}

describe("MessageList", () => {
  it("numbers chat messages and renders cards, forks, suggestions and the pending reply", async () => {
    const client = renderList();
    const list = screen.getByRole("list", { name: "Messages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("You · #1")).toBeInTheDocument();
    expect(screen.getByText("AI · #2")).toBeInTheDocument();
    expect(screen.getByText("You · #3")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Conclusion card" })).toHaveTextContent("Use ZFS");
    expect(screen.getByText("1 branches")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "AI suggests a branch" })).toBeInTheDocument();
    expect(screen.getAllByText("Preparing context and sending…").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Open a branch here" })).toHaveLength(1);
    client.mock.dispose();
  });

  it("hides writing actions and suggestions for read-only identities", () => {
    const client = renderList({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Open a branch here" })).toBeNull();
    expect(screen.queryByRole("group", { name: "AI suggests a branch" })).toBeNull();
    expect(screen.getByText("1 branches")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("passes the message to the handlers", async () => {
    const onBranch = vi.fn();
    const onSuggestion = vi.fn();
    const client = renderList({ onBranch, onSuggestion });
    await userEvent.click(screen.getByRole("button", { name: "Open a branch here" }));
    expect(onBranch.mock.calls[0]![0].id).toBe("a1");
    await userEvent.click(screen.getByRole("button", { name: /Dig deeper/ }));
    expect(onSuggestion.mock.calls[0]![1]).toEqual({ purpose: "Dig deeper", kind: "investigate" });
    client.mock.dispose();
  });

  it("announces politely when a reply finishes, without putting the reply text in the live region", () => {
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    const pending = msg("a9", 9, { role: "assistant", status: "pending", content: "" });
    const { rerender } = render(<MessageList lineId="l1" messages={[pending]} />, { wrapper: tangentWrapper(client) });
    // The list's own region (the reply's stage has one of its own, F12 S4).
    const region = screen.getAllByRole("status").filter((element) => element.getAttribute("aria-live") === "polite").at(-1)!;
    expect(region).toHaveTextContent("");
    rerender(<MessageList lineId="l1" messages={[{ ...pending, status: "done", content: "The long answer" }]} />);
    expect(region).toHaveTextContent("Reply finished");
    expect(region).not.toHaveTextContent("The long answer");
    client.mock.dispose();
  });

  it("offers retry only on the last reply when it failed", () => {
    const client = mockClient();
    const failed = (id: string, seq: number) => msg(id, seq, { role: "assistant", status: "error", content: "Turn failed", meta: { error: "boom" } });
    render(<MessageList lineId="l1" messages={[failed("e1", 1), msg("u2", 2, { role: "user", content: "again" }), failed("e2", 3)]} onRetry={vi.fn()} />, {
      wrapper: tangentWrapper(client),
    });
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getAllByRole("article")[1]).toContainElement(screen.getByRole("button", { name: "Retry" }));
    client.mock.dispose();
  });

  it("B7.2: a failed reply followed by a host's system message still offers retry (the server skips notices too)", () => {
    const client = mockClient();
    const notice = msg("n1", 3, { role: "system", kind: "chat", content: "Sync failed: disk full" });
    render(
      <MessageList
        lineId="l1"
        messages={[msg("u1", 1, { role: "user", content: "go" }), msg("e1", 2, { role: "assistant", status: "error", content: "Turn failed", meta: { error: "boom" } }), notice]}
        onRetry={vi.fn()}
      />,
      { wrapper: tangentWrapper(client) },
    );
    expect(screen.getByRole("article", { name: /^AI/ })).toContainElement(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Sync failed: disk full")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("B7.2: a notice that arrives while the reply streams sits after it (by seq) and the reply keeps streaming", async () => {
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [{ turnId: "p1", seq: 10, kind: "text", text: "Half an answer" }], seq: 10, truncated: false });
    const notice = msg("n1", 3, { role: "system", kind: "chat", content: "Host: build started" });
    // Handed over out of order: the list follows seq, never the array's order or "the pending one is last".
    render(<MessageList lineId="l1" messages={[msg("u1", 1, { role: "user", content: "go" }), notice, msg("p1", 2, { role: "assistant", status: "pending", content: "" })]} />, {
      wrapper: tangentWrapper(client),
    });
    expect(screen.getAllByRole("listitem").map((row) => row.getAttribute("data-message-id"))).toEqual(["u1", "p1", "n1"]);
    expect(await screen.findByText("Half an answer")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /^AI/ })).toHaveAttribute("aria-busy", "true");
    client.mock.dispose();
  });

  it("marks every row with its message id (selections resolve against it)", () => {
    const client = renderList();
    const rows = screen.getAllByRole("listitem").map((row) => row.getAttribute("data-message-id"));
    expect(rows).toEqual(["u1", "a1", "c1", "u2", "a2"]);
    // R2: only user and assistant chat messages can be forked from; a card's text is not an anchor.
    expect(screen.getAllByRole("listitem").map((row) => row.getAttribute("data-forkable"))).toEqual(["true", "true", "false", "true", "true"]);
    client.mock.dispose();
  });

  it("enters a branch from the fork list, moves from a user message and opens a marker's branch (F2)", async () => {
    const onEnterBranch = vi.fn();
    const onMove = vi.fn();
    const onOpenBranch = vi.fn();
    const marker = msg("k1", 6, { role: "system", kind: "branch_marker", content: "2 message(s) moved to a branch: Later", meta: { branchLineId: "b9" } });
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    render(<MessageList lineId="l1" messages={[...MESSAGES.slice(0, 4), marker]} branches={BRANCHES} onEnterBranch={onEnterBranch} onMove={onMove} onOpenBranch={onOpenBranch} />, {
      wrapper: tangentWrapper(client),
    });
    await userEvent.click(screen.getByRole("button", { name: /1 branches/ }));
    await userEvent.click(within(screen.getByRole("list", { name: "Branches from this message" })).getByRole("button"));
    expect(onEnterBranch.mock.calls[0]![0].lineId).toBe("b1");
    await menuAction(rowOf("Next"), "Move from here into a branch");
    expect(onMove.mock.calls[0]![0].id).toBe("u2");
    await userEvent.click(screen.getByRole("button", { name: "Open the branch" }));
    expect(onOpenBranch).toHaveBeenCalledWith("b9", undefined);
    client.mock.dispose();
  });

  it("offers no move to a read-only identity", () => {
    const client = renderList({ readOnly: true, onMove: vi.fn() });
    expect(screen.queryByRole("button", { name: "Move from here into a branch" })).toBeNull();
    client.mock.dispose();
  });
});

describe("MessageList: unread divider (F3)", () => {
  it("draws “n unread” right before the first unread message, as a separator", () => {
    renderList({ unread: { messageId: "a1", count: 2 } });
    const divider = screen.getByRole("separator", { name: "2 unread" });
    const row = divider.closest("[data-message-id]");
    expect(row).toHaveAttribute("data-message-id", "a1");
    expect(divider).toHaveTextContent("2 unread");
  });

  it("draws none without unread messages", () => {
    renderList({ unread: null });
    expect(screen.queryByRole("separator", { name: /unread/ })).toBeNull();
  });

  it("offers “save to notes” on replies only when wired", async () => {
    const onNote = vi.fn();
    renderList({ onNote });
    await menuAction(rowOf("Answer"), "Add to notes");
    expect(onNote).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });
});

describe("MessageList: pins, relate and reply extras (F5)", () => {
  const pinnedList = [msg("u1", 1, { role: "user", content: "Question", pinned: true }), msg("a1", 2, { role: "assistant", content: "Answer" })];

  it("offers Pin / Unpin on the user's and AI's messages, shows the pinned mark, and passes the new state", async () => {
    const onPin = vi.fn();
    const client = renderList({ messages: pinnedList, onPin });
    expect(screen.getByText(/^Pinned/)).toBeInTheDocument();
    const unpin = screen.getByRole("button", { name: "Unpin" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    const pin = screen.getByRole("button", { name: "Pin" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(pin);
    expect([onPin.mock.calls[0]![0].id, onPin.mock.calls[0]![1]]).toEqual(["a1", true]);
    await userEvent.click(unpin);
    expect([onPin.mock.calls[1]![0].id, onPin.mock.calls[1]![1]]).toEqual(["u1", false]);
    client.mock.dispose();
  });

  it("a viewer sees the pinned mark but no pin or relate actions", () => {
    const client = renderList({ messages: pinnedList, onPin: vi.fn(), onRelate: vi.fn(), readOnly: true });
    expect(screen.getByText(/^Pinned/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pin|Unpin|Relate/ })).toBeNull();
    client.mock.dispose();
  });

  it("offers Relate… on chat messages", async () => {
    const onRelate = vi.fn();
    const client = renderList({ messages: pinnedList, onRelate });
    await menuAction(rowOf("Answer"), "Relate…");
    expect(onRelate.mock.calls[0]![0].id).toBe("a1");
    client.mock.dispose();
  });

  it("puts a host's extra under the reply it belongs to (the drift hint)", () => {
    const client = renderList({ messages: pinnedList, replyExtras: new Map([["a1", <p key="x">extra under a1</p>]]) });
    const reply = screen.getByRole("article", { name: "AI · #2" });
    expect(within(reply).getByText("extra under a1")).toBeInTheDocument();
    client.mock.dispose();
  });
});

describe("MessageList: the pinned mark and fisheye (C1, F5 phase 2)", () => {
  const pinned = [msg("a1", 1, { role: "assistant", content: "Answer", pinned: true })];

  it("says a pinned message is always sent while fisheye is on", async () => {
    const client = renderList({ messages: pinned });
    expect(await screen.findByText("Pinned · always sent")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("says only 「Pinned」 while fisheye is off (pins do not change the prompt then)", async () => {
    const scenario = (await import("@tangent/client/testing")).nasScenario();
    scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "fisheye" ? { name: "fisheye", enabled: false } : feature)) };
    const client = mockClient({ scenario });
    render(<MessageList lineId="l1" messages={pinned} />, { wrapper: tangentWrapper(client) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("D2 / F8 S1: only a message with a type shows it (lazy); the 「⋯」 menu sets one; off, neither", async () => {
    const tagged = [msg("u1", 1, { role: "user", content: "Question", tag: { kind: "question", source: "ai", status: "draft" } }), msg("a1", 2, { role: "assistant", content: "Answer" })];
    const client = renderList({ messages: tagged, tags: { rootLineId: "l1" } });
    const badge = await screen.findByText("Question", { selector: "[data-tg-arg-badge] *, [data-tg-arg-badge]" });
    expect(badge.closest("[data-tg-arg-badge]")).toHaveAttribute("data-tg-arg-badge", "draft");
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.click(moreOf(rowOf("Answer")));
    expect(await screen.findByRole("menuitem", { name: "Set argument type…" })).toBeInTheDocument();
    client.mock.dispose();
    cleanup();
    const off = renderList({ messages: tagged });
    expect(document.querySelector("[data-tg-arg-badge]")).toBeNull();
    off.mock.dispose();
  });

  it("D4: a fold's messages collapse into one block at the first of them; expanding shows them; Fold from here… is offered", async () => {
    const onFold = vi.fn();
    const fold = normalizeFold({ id: "f1", lineId: "l1", fromSeq: 1, toSeq: 2, fromMessageId: "u1", toMessageId: "a1", status: "active", summary: "Asked and answered", tokensOriginal: 40, tokensSummary: 8, messageCount: 2 });
    const client = renderList({ folds: [fold], onFold });
    const list = screen.getByRole("list", { name: "Messages" });
    const block = await screen.findByRole("region", { name: "Folded #1–#2" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByText("Question")).toBeNull();
    await userEvent.click(within(block).getByRole("button", { name: /^Folded #1–#2/ }));
    expect(within(block).getByText("Question")).toBeInTheDocument();
    await menuAction(rowOf("Next"), "Fold from here…");
    expect(onFold).toHaveBeenCalledWith(expect.objectContaining({ id: "u2" }));
    client.mock.dispose();
  });

  it("D4: another fold starting at the same message starts collapsed and not editing (R11 J1 sweep)", async () => {
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    const fold = (id: string) => normalizeFold({ id, lineId: "l1", fromSeq: 1, toSeq: 2, fromMessageId: "u1", toMessageId: "a1", status: "active", summary: `Summary ${id}`, tokensOriginal: 40, tokensSummary: 8, messageCount: 2 });
    const list = (folds: ReturnType<typeof normalizeFold>[]) => <MessageList lineId="l1" messages={MESSAGES} branches={BRANCHES} folds={folds} onBranch={vi.fn()} />;
    const view = render(list([fold("f1")]), { wrapper: tangentWrapper(client) });
    const block = await screen.findByRole("region", { name: "Folded #1–#2" });
    await userEvent.click(within(block).getByRole("button", { name: /^Folded #1–#2/ }));
    await userEvent.click(within(block).getByRole("button", { name: "Edit the summary" }));
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue("Summary f1");
    view.rerender(list([fold("f2")]));
    expect(await screen.findByText("Summary: Summary f2")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Summary" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Folded #1–#2/ })).toHaveAttribute("aria-expanded", "false");
    client.mock.dispose();
  });

  it("D3: a reply's diverged directions show as one marker (not in the fork list); Give me directions… is offered", async () => {
    const onDiverge = vi.fn();
    const diverged = ["d1", "d2"].map((id) => normalizeBranchView({ lineId: id, parentLineId: "l1", anchorMessageId: "a1", status: "open", origin: "diverge", kind: "alternative", purpose: id }));
    const client = renderList({ branches: [...BRANCHES, ...diverged], showDiverge: true, onDiverge });
    expect(await screen.findByRole("region", { name: "Diverged: 2 directions" })).toBeInTheDocument();
    expect(screen.getByText("1 branches")).toBeInTheDocument();
    await menuAction(rowOf("Answer"), "Give me directions…");
    expect(onDiverge).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    client.mock.dispose();
  });
});

