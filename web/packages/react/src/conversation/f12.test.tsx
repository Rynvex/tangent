import { normalizeBranchView, normalizeMessage, TangentError, type BranchView, type Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BranchCard } from "../branch/branch-card";
import { BranchCardEditDialog } from "../branch/card-edit-dialog";
import { UsageMeter, usageLevel } from "../components/usage-meter";
import { StaleBadge } from "../f8/stale-badge";
import { InboxPanel } from "../inbox/inbox-panel";
import { loadMarkdownRenderer, Markdown } from "../markdown";
import { firstFitZoom } from "../structure/branch-map";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import AsideInlineCard from "./aside-inline-card";
import { AssistantMessage } from "./assistant-message";
import { ForkMarker } from "./fork-marker";
import { MessageList } from "./message-list";
import { replyStage } from "./reply-stage";

beforeAll(() => loadMarkdownRenderer());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const msg = (id: string, seq: number, over: Record<string, unknown>): Message => normalizeMessage({ id, seq, lineId: "l1", status: "done", createdAt: new Date().toISOString(), ...over });
const branch = (over: Record<string, unknown>): BranchView => normalizeBranchView({ parentLineId: "l1", rootLineId: "l1", createdAt: "2026-01-01T00:00:00Z", ...over });

describe("S4 reply stages (decision #2)", () => {
  it("has no gaps: under 3 s, 3 s up to 8 s, and from 8 s on", () => {
    expect([0, 2999, 3000, 7999, 8000, 14_000].map(replyStage)).toEqual(["preparing", "preparing", "thinking", "thinking", "deepThinking", "deepThinking"]);
  });

  it("puts the stage and 停止生成 in the label row before the first word, and the stop under streamed text", async () => {
    const onStop = vi.fn();
    const client = mockClient();
    const pending = msg("a1", 1, { role: "assistant", status: "pending", content: "", createdAt: new Date(Date.now() - 9000).toISOString() });
    const { rerender } = render(<AssistantMessage message={pending} label="AI · #1" onStop={onStop} />, { wrapper: tangentWrapper(client) });
    expect(document.querySelector("[data-tg-reply-stage]")?.getAttribute("data-tg-reply-stage")).toBe("deepThinking");
    expect(screen.getAllByText(/Thinking deeply \(9s\)/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalledOnce();
    rerender(<AssistantMessage message={{ ...pending, content: "Partial" }} label="AI · #1" onStop={onStop} stopping />);
    expect(document.querySelector("[data-tg-reply-stage]")).toBeNull();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    rerender(<AssistantMessage message={{ ...pending, status: "done", content: "", meta: { cancelled: true } }} label="AI · #1" />);
    expect(screen.getByText("Stopped · no answer")).toBeInTheDocument();
    client.mock.dispose();
  });
});

describe("S2 excerpt marks", () => {
  it("marks the first appearance outside code, and leaves text it cannot find", async () => {
    render(
      <Markdown marks={[{ text: "Koch", key: "k" }, { text: "missing words", key: "m" }]} renderMark={(mark, children) => <mark data-key={mark.key}>{children}</mark>}>
        {"`Koch` in code, then Koch outside and Koch again."}
      </Markdown>,
    );
    const marks = await screen.findAllByText("Koch", { selector: "mark" });
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("code")).toBeNull();
    expect(document.querySelector('[data-key="m"]')).toBeNull();
  });

  it("an aside's words open it in place; another branch's enter it; Enter works too", async () => {
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    const messages = [msg("u1", 1, { role: "user", content: "Q" }), msg("a1", 2, { role: "assistant", content: "Use the Hausdorff dimension and the box method." })];
    const branches = [
      branch({ lineId: "as1", kind: "aside", status: "discarded", anchorMessageId: "a1", excerpt: "Hausdorff dimension", purpose: "What is it" }),
      branch({ lineId: "b1", kind: "investigate", status: "open", anchorMessageId: "a1", excerpt: "box method", purpose: "How to count" }),
    ];
    const onToggleAside = vi.fn();
    const onEnterBranch = vi.fn();
    render(<MessageList lineId="l1" messages={messages} branches={branches} onToggleAside={onToggleAside} onEnterBranch={onEnterBranch} />, { wrapper: tangentWrapper(client) });
    const aside = await screen.findByRole("button", { name: /Hausdorff dimension/, description: /What is it/ }, { timeout: 3000 });
    await userEvent.click(aside);
    expect(onToggleAside).toHaveBeenCalledWith(expect.objectContaining({ lineId: "as1" }));
    const other = screen.getByRole("button", { name: /box method/ });
    other.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Click or press Enter to go to the branch");
    await userEvent.keyboard("{Enter}");
    expect(onEnterBranch).toHaveBeenCalledWith(expect.objectContaining({ lineId: "b1" }));
    client.mock.dispose();
  });
});

describe("S1 fork rows and the inline card", () => {
  it("an aside's fork row opens it in place (原地展開中 / 已回答・在這裡展開)", async () => {
    const onToggle = vi.fn();
    const asides = [branch({ lineId: "as1", kind: "aside", status: "discarded", purpose: "Hausdorff" }), branch({ lineId: "b1", kind: "investigate", status: "open", purpose: "Box" })];
    const { rerender } = render(<ForkMarker branches={asides} onSelect={vi.fn()} onToggleAside={onToggle} defaultOpen />, { wrapper: tangentWrapper(mockClient()) });
    expect(screen.getByText("2 branches")).toBeInTheDocument();
    expect(screen.getByText(/1 asides/)).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Hausdorff/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("Answered · open here");
    await userEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ lineId: "as1" }));
    rerender(<ForkMarker branches={asides} onSelect={vi.fn()} onToggleAside={onToggle} inlineOpen={new Set(["as1"])} defaultOpen />);
    expect(screen.getByRole("button", { name: /Hausdorff/ })).toHaveTextContent("Open here");
  });

  it("shows the answer, keeps it once in the notes, and collapses on Esc", async () => {
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    const created = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "RAID-Z?", kind: "aside" });
    await client.sendMessage(created.line.id, { content: "What is RAID-Z?" });
    await waitFor(async () => expect((await client.getLine(created.line.id)).status).toBe("idle"));
    const aside = (await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches.find((item) => item.lineId === created.line.id)!;
    const create = vi.spyOn(client, "createNote");
    const onCollapse = vi.fn();
    render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={onCollapse} autoFocus />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    expect(await within(region).findByText("You: What is RAID-Z?")).toBeInTheDocument();
    // F19 (追加 B.2): 記進紀要 moved from the footer's row into the card's 「⋯」; kept once all the same.
    await userEvent.click(await within(region).findByRole("button", { name: "More for this aside" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save to notes" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await userEvent.click(within(region).getByRole("button", { name: "More for this aside" }));
    const saved = await screen.findByRole("menuitem", { name: "Saved to notes" });
    expect(saved).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(saved);
    expect(create).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    fireEvent.keyDown(region, { key: "Escape" });
    expect(onCollapse).toHaveBeenCalledOnce();
    client.mock.dispose();
  });
});

describe("S6 the conclusion card", () => {
  const card = msg("c1", 3, { role: "system", kind: "branch_card", content: "x", meta: { card: { question: "Which?", conclusion: "ZFS", openItems: ["ECC?"] }, branchLineId: "b1" } });
  const merged = branch({ lineId: "b1", status: "merged", purpose: "Filesystems", cardMessageId: "c1" });

  it("says 已修改・下一輪帶入 from the card's own edit time, and offers 編輯結論 and 繼續追問 to writers only", async () => {
    const onEdit = vi.fn();
    const onFollowUp = vi.fn();
    const client = mockClient();
    const { rerender } = render(<BranchCard message={card} branch={merged} onEdit={onEdit} onFollowUp={onFollowUp} />, { wrapper: tangentWrapper(client) });
    // An undelivered card without an edit time is plain pending (NoticeMaxPerTurn leaves some undelivered).
    expect(screen.getByText("The AI hears about it next turn", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Edited · sent next turn")).toBeNull();
    const edited = { ...card, meta: { ...card.meta, editedAt: "2026-01-02T00:00:00.123456Z" } };
    rerender(<BranchCard message={edited} branch={merged} onEdit={onEdit} onFollowUp={onFollowUp} />);
    expect(screen.getByText("Edited · sent next turn")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit conclusion" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask a follow-up" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onFollowUp).toHaveBeenCalledOnce();
    rerender(<BranchCard message={edited} branch={merged} />);
    expect(screen.queryByRole("button", { name: "Edit conclusion" })).toBeNull();
    client.mock.dispose();
  });

  it("with nothing stored on this device (a reload, another device), an edited card says 已修改・下一輪帶入 until a turn carries it, then 已告訴 AI", () => {
    window.localStorage.clear();
    const client = mockClient();
    const edited = normalizeMessage({ id: "c1", seq: 3, lineId: "l1", status: "done", role: "system", kind: "branch_card", content: "x", meta: { card: { question: "Which?", conclusion: "ZFS" }, branchLineId: "b1", editedAt: "2026-01-02T00:00:00Z" } });
    const { rerender } = render(<BranchCard message={edited} branch={merged} />, { wrapper: tangentWrapper(client) });
    expect(document.querySelector('[data-tg-card-state="editedPending"]')).toHaveTextContent("Edited · sent next turn");
    rerender(<BranchCard message={{ ...edited, meta: { ...edited.meta, delivered: true } }} branch={merged} />);
    expect(screen.getByText("Told the AI")).toBeInTheDocument();
    expect(screen.queryByText("Edited · sent next turn")).toBeNull();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("tangent:card-edits"))).toEqual([]);
    client.mock.dispose();
  });

  it("edits the card: the question is required, a busy parent asks to wait, a save closes it", async () => {
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    const message = messages.find((item) => item.id === "nas-c1")!;
    const source = (await client.listBranches(NAS_ROOT_ID)).branches.find((item) => item.lineId === "nas-b1")!;
    const onOpenChange = vi.fn();
    const update = vi.spyOn(client, "updateBranchCard");
    render(<BranchCardEditDialog open onOpenChange={onOpenChange} branch={source} message={message} />, { wrapper: tangentWrapper(client) });
    const question = screen.getByRole("textbox", { name: /Question/ });
    // Whitespace alone is no change: 儲存 stays off.
    await userEvent.type(question, "   ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(question);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The question can’t be empty.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await userEvent.type(question, "Which filesystem?");
    update.mockRejectedValueOnce(new TangentError(409, "busy", "parent_busy"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/wait for the reply to finish, then save/)).toBeInTheDocument();
    expect(question).toHaveValue("Which filesystem?");
    await userEvent.click(screen.getByRole("button", { name: "Add one" }));
    await userEvent.type(screen.getAllByRole("textbox", { name: /Open question/ }).at(-1)!, "Check ECC");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(update).toHaveBeenLastCalledWith("nas-b1", { card: expect.objectContaining({ question: "Which filesystem?" }) });
    client.mock.dispose();
  });
});

describe("S5 the inbox filter and 忽略全部", () => {
  it("filters to one list and dismisses every AI suggestion, then says how many for a while", async () => {
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    for (const text of ["[probe:suggest] one", "[probe:suggest] two"]) {
      await client.sendMessage(text.includes("one") ? NAS_ROOT_ID : "nas-b3", { content: text });
      await waitFor(async () => expect((await client.getLine(text.includes("one") ? NAS_ROOT_ID : "nas-b3")).status).toBe("idle"));
    }
    const open = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.length;
    render(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={vi.fn()} onGoTo={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const chips = await screen.findByRole("radiogroup", { name: "篩選" });
    await waitFor(() => expect(within(chips).getByRole("radio", { name: `AI 建議 (${open})` })).toBeInTheDocument());
    await userEvent.click(within(chips).getByRole("radio", { name: `AI 建議 (${open})` }));
    expect(screen.queryByRole("region", { name: /停車場/ })).toBeNull();
    // Arrow keys move the choice.
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(chips).getByRole("radio", { name: /停車種子/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.click(screen.getByRole("button", { name: `忽略全部 ${open} 條 AI 建議` }));
    expect(await screen.findByText(`已忽略 ${open} 條 AI 建議`)).toBeInTheDocument();
    expect((await client.listSuggestions(NAS_ROOT_ID)).suggestions).toEqual([]);
    client.mock.dispose();
  });
});

describe("S5 忽略全部 edge cases", () => {
  async function inboxWithProbe() {
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    await client.sendMessage(NAS_ROOT_ID, { content: "[probe:suggest] one" });
    await waitFor(async () => expect((await client.getLine(NAS_ROOT_ID)).status).toBe("idle"));
    const queryClient = testQueryClient();
    render(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={vi.fn()} onGoTo={vi.fn()} />, { wrapper: tangentWrapper(client, queryClient, { locale: "zh-TW" }) });
    return Object.assign(client, { queryClient });
  }

  it("says nothing when nothing was dismissed (another tab got there first)", async () => {
    const client = await inboxWithProbe();
    vi.spyOn(client, "dismissAllSuggestions").mockResolvedValueOnce({ rootLineId: NAS_ROOT_ID, suggestions: [] });
    await userEvent.click(await screen.findByRole("button", { name: /^忽略全部 \d+ 條 AI 建議$/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^忽略全部/ })).not.toBeDisabled());
    expect(screen.queryByText(/已忽略 0 條/)).toBeNull();
    client.mock.dispose();
  });

  it("shows a suggestion that arrives during the 5 s row under it", async () => {
    const client = await inboxWithProbe();
    await userEvent.click(await screen.findByRole("button", { name: /^忽略全部 \d+ 條 AI 建議$/ }));
    expect(await screen.findByText(/^已忽略 \d+ 條 AI 建議$/)).toBeInTheDocument();
    await client.sendMessage("nas-b3", { content: "[probe:suggest] two" });
    await waitFor(async () => expect((await client.getLine("nas-b3")).status).toBe("idle"));
    // The test has no event stream: read the inbox again, as suggestion.changed would.
    await act(() => client.queryClient.invalidateQueries());
    expect(await screen.findByRole("button", { name: /^忽略全部 1 條 AI 建議$/ })).toBeInTheDocument();
    expect(screen.getByText(/^已忽略 \d+ 條 AI 建議$/)).toBeInTheDocument();
    client.mock.dispose();
  });
});

describe("S2 preview placement", () => {
  it("goes under the words, flips above near the window's bottom and stays inside its sides", async () => {
    const { previewPlacement } = await import("./excerpt-anchor");
    const view = { width: 1440, height: 900 };
    const size = { width: 340, height: 140 };
    expect(previewPlacement({ left: 200, top: 300, bottom: 320 }, size, view)).toEqual({ left: 200, top: 326, above: false });
    expect(previewPlacement({ left: 200, top: 800, bottom: 820 }, size, view)).toEqual({ left: 200, top: 654, above: true });
    expect(previewPlacement({ left: 1300, top: 300, bottom: 320 }, size, view).left).toBe(1440 - 340 - 16);
    expect(previewPlacement({ left: 4, top: 300, bottom: 320 }, size, view).left).toBe(16);
  });
});

describe("S3 and S7 helpers", () => {
  it("fits on first open only when the tree is wider or taller, down to 50 %", () => {
    expect(firstFitZoom({ width: 336, height: 600 }, { width: 300, height: 400 })).toBeNull();
    expect(firstFitZoom({ width: 336, height: 600 }, { width: 640, height: 400 })).toBe(0.5);
    expect(firstFitZoom({ width: 336, height: 300 }, { width: 300, height: 400 })).toBe(0.71);
    expect(firstFitZoom({ width: 336, height: 600 }, { width: 2000, height: 400 })).toBe(0.5);
    expect(firstFitZoom({ width: 0, height: 0 }, { width: 2000, height: 400 })).toBeNull();
  });

  it("warns from 80 % of the next turn's budget and is at the limit from 95 %", () => {
    expect([usageLevel(31_999, 40_000), usageLevel(32_000, 40_000), usageLevel(38_000, 40_000), usageLevel(5, 0)]).toEqual(["normal", "warning", "danger", "normal"]);
  });

  it("is a pressed button while its breakdown is open", () => {
    render(<UsageMeter usage={{ inputTokens: 900, outputTokens: 50, costUsd: 0 }} onClick={vi.fn()} pressed level="warning" tooltip="See context" />, { wrapper: tangentWrapper(mockClient()) });
    const button = screen.getByRole("button", { name: /950 tokens/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAccessibleName(/Close to the limit/);
  });
});

describe("B17 card edits from the server's data, and the follow-up dialog", () => {
  it("an edit's message.updated brings the card's edit time into the cache (no local record)", async () => {
    const { applyEvent } = await import("../data/event-sync");
    const { createLiveStore } = await import("../data/live-store");
    const { tangentKeys } = await import("../query-keys");
    const target = { queryClient: testQueryClient(), keys: tangentKeys({ baseUrl: "/api" }), live: createLiveStore() };
    const card = msg("c9", 9, { role: "system", kind: "branch_card", meta: { card: { conclusion: "x" }, delivered: true } });
    target.queryClient.setQueryData(target.keys.messages("l1"), { messages: [card] });
    const { delivered: _delivered, ...undelivered } = card.meta;
    const edited = { ...card, content: "y", meta: { ...undelivered, card: { ...card.meta.card!, conclusion: "y" }, editedAt: "2026-01-02T00:00:00Z" } };
    act(() => applyEvent(target, { type: "message.updated", lineId: "l1", rootLineId: "l1", seq: 2, data: edited } as never));
    const cached = target.queryClient.getQueryData<{ messages: Message[] }>(target.keys.messages("l1"))?.messages[0];
    expect(cached?.meta).toMatchObject({ editedAt: "2026-01-02T00:00:00Z" });
    expect(cached?.meta.delivered).toBeUndefined();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("tangent:card-edits"))).toEqual([]);
  });

  it("with nothing stored on this device, the outline's card edit time marks 前提已更新 on the follow-up opened before the edit only", async () => {
    window.localStorage.clear();
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    const card = msg("c1", 3, { role: "system", kind: "branch_card", content: "ZFS", meta: { card: { question: "Which?", conclusion: "ZFS" }, branchLineId: "b1", editedAt: "2026-01-02T00:00:00.000200Z" } });
    const messages = [msg("u1", 1, { role: "user", content: "Q" }), msg("a1", 2, { role: "assistant", content: "A" }), card];
    const branches = [
      branch({ lineId: "b1", status: "merged", anchorMessageId: "a1", purpose: "Filesystems", cardMessageId: "c1", cardEditedAt: "2026-01-02T00:00:00.000200Z" }),
      // Opened in the same millisecond as the edit, just before it.
      branch({ lineId: "f1", status: "open", anchorMessageId: "c1", purpose: "Before the edit", createdAt: "2026-01-02T00:00:00.000100Z" }),
      branch({ lineId: "f2", status: "open", anchorMessageId: "c1", purpose: "After the edit", createdAt: "2026-01-02T00:00:01Z" }),
    ];
    render(<MessageList lineId="l1" messages={messages} branches={branches} onEnterBranch={vi.fn()} />, { wrapper: tangentWrapper(client) });
    await userEvent.click(await screen.findByRole("button", { name: /Follow-ups from this conclusion card/ }));
    const rows = [...document.querySelectorAll("[data-tg-fork-row]")];
    const row = (text: string) => rows.find((item) => item.textContent?.includes(text)) as HTMLElement;
    expect(within(row("Before the edit")).getByRole("img", { name: "Premise changed" })).toBeInTheDocument();
    expect(within(row("After the edit")).queryByRole("img", { name: "Premise changed" })).toBeNull();
    client.mock.dispose();
  });

  it("an edit made elsewhere (another device) shows on the follow-up's badge from the server's outline alone", async () => {
    window.localStorage.clear();
    let clock = Date.parse("2026-10-30T08:00:00Z");
    const client = mockClient({ scenario: nasScenario({ features: "all" }), now: () => new Date(clock) });
    const before = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "Why monthly", kind: "investigate" });
    clock += 60_000;
    // Straight through the client, as another device would: this page never sees the edit happen.
    await client.updateBranchCard("nas-b1", { card: { question: "Which filesystem?", conclusion: "ZFS mirror, scrub weekly" } });
    clock += 60_000;
    const after = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-c1", purpose: "And weekly", kind: "investigate" });
    const outline = (await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches;
    const of = (id: string) => outline.find((item) => item.lineId === id)!;
    render(
      <>
        <StaleBadge rootLineId={NAS_ROOT_ID} branch={of(before.line.id)} />
        <StaleBadge rootLineId={NAS_ROOT_ID} branch={of(after.line.id)} />
      </>,
      { wrapper: tangentWrapper(client) },
    );
    expect(await screen.findByRole("button", { name: "Why monthly: premise changed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "And weekly: premise changed" })).toBeNull();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("tangent:card-edits"))).toEqual([]);
    client.mock.dispose();
  });

  it("a follow-up says the original stays merged, quotes the conclusion and offers its open questions", async () => {
    const { OpenBranchDialog } = await import("../branch/open-branch-dialog");
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    const line = await client.getLine(NAS_ROOT_ID);
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    const create = vi.spyOn(client, "createBranch");
    render(
      <OpenBranchDialog
        open
        onOpenChange={vi.fn()}
        line={line}
        messages={messages}
        branches={[]}
        request={{ anchorMessageId: "nas-c1", fromCard: { title: "ZFS or Btrfs", conclusion: "ZFS scrubs better", openItems: ["Is ECC needed?"] } }}
        onCreated={vi.fn()}
      />,
      { wrapper: tangentWrapper(client) },
    );
    expect(await screen.findByText("Starts a new branch from this conclusion card; “ZFS or Btrfs” stays merged.")).toBeInTheDocument();
    expect(screen.getByText("ZFS scrubs better")).toBeInTheDocument();
    const chip = screen.getByRole("radio", { name: "Open: Is ECC needed?" });
    expect(chip).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "First question for the AI" })).toHaveValue("Is ECC needed?");
    await userEvent.click(screen.getByRole("button", { name: "Open branch and ask" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, { anchorMessageId: "nas-c1", kind: "investigate", purpose: "Is ECC needed" }));
    client.mock.dispose();
  });
});
