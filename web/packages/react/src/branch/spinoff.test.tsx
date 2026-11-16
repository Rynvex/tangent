import { TangentError, normalizeMessage, normalizeSuggestion, type LineView, type Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../conversation/message-list";
import { SpinoffOrigin } from "../conversation/spinoff-origin";
import { SuggestionCard } from "../inbox/suggestion-card";
import { mockClient, tangentWrapper } from "../test-utils";
import { BranchBar } from "./branch-bar";
import { PromoteBranchDialog } from "./promote-branch-dialog";
import { RebalanceHint } from "./rebalance-hint";
import { SpinoffDialog } from "./spinoff-dialog";

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

function tracked(features: "all" | "c1" = "all") {
  const client = mockClient({ scenario: nasScenario({ features }) });
  clients.push(client);
  return client;
}

async function openDialog(lineId: string, props: { atMessageId?: string; suggestionId?: string } = {}, features: "all" | "c1" = "all") {
  const client = tracked(features);
  const line: LineView = await client.getLine(lineId);
  const messages: Message[] = (await client.listMessages(lineId)).messages;
  const onDone = vi.fn();
  render(<SpinoffDialog open onOpenChange={() => undefined} line={line} messages={messages} atMessageId={props.atMessageId ?? ""} {...(props.suggestionId ? { suggestionId: props.suggestionId } : {})} onDone={onDone} />, {
    wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }),
  });
  const dialog = await screen.findByRole("dialog", { name: "獨立成新對話" });
  return { client, onDone, dialog };
}

describe("SpinoffDialog (B2)", () => {
  it("offers both ways for an open branch, previews the capsule and copies the notes when asked", async () => {
    const { client, onDone, dialog } = await openDialog("nas-b3", { atMessageId: "nas-b3-5" });
    const spin = vi.spyOn(client, "spinoff");
    const modes = within(dialog).getByRole("radiogroup", { name: "方式" });
    expect(within(modes).getByRole("radio", { name: /整條支線變成新對話/ })).toHaveAttribute("aria-checked", "true");
    expect(within(modes).getByRole("radio", { name: /從最後一則開全新對話/ })).toBeInTheDocument();
    const capsule = within(dialog).getByRole("group", { name: /新對話一開始會帶/ });
    // B8.2: the server's own capsule and its tokens, not an estimate.
    const preview = await client.previewSpinoff("nas-b3", { mode: "detach" });
    await waitFor(() => expect(capsule).toHaveTextContent(`≈ ${preview.capsule.tokenEstimate} token`));
    expect(capsule).toHaveTextContent(/訊息 \d+ 則與子支線一起搬過去/);
    await userEvent.click(within(capsule).getByRole("button", { name: "看起始膠囊的內容" }));
    expect(within(capsule).getByText(/This conversation was spun off/)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "新對話的標題" })).toHaveValue("4TB 與 8TB 硬碟的每 TB 成本與保固");
    await waitFor(() => expect(dialog).toHaveTextContent("新對話頂端顯示「來自：家用 NAS 與備份策略」"));
    const copy = within(dialog).getByRole("checkbox", { name: "複製目前的紀要到新對話" });
    await userEvent.click(copy);
    await waitFor(() => expect(capsule).toHaveTextContent("紀要 6 條會複製過去"));
    await userEvent.click(within(dialog).getByRole("button", { name: "建立新對話" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(spin).toHaveBeenCalledWith("nas-b3", { mode: "detach", title: "4TB 與 8TB 硬碟的每 TB 成本與保固", copyNotes: true });
    expect(onDone.mock.calls[0]![0]).toMatchObject({ line: { id: "nas-b3" } });
  });

  it("from a message: only a fresh start there, with the path in the capsule", async () => {
    const { client, onDone, dialog } = await openDialog(NAS_ROOT_ID, { atMessageId: "nas-m19" });
    const spin = vi.spyOn(client, "spinoff");
    expect(within(dialog).queryByRole("radiogroup", { name: "方式" })).toBeNull();
    const expected = await client.previewSpinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19" });
    await waitFor(() => expect(within(dialog).getByRole("group", { name: /新對話一開始會帶/ })).toHaveTextContent(`≈ ${expected.capsule.tokenEstimate} token`));
    await userEvent.click(within(dialog).getByRole("button", { name: "建立新對話" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(spin.mock.calls[0]![1]).toMatchObject({ mode: "fresh", atMessageId: "nas-m19" });
  });

  it("says when the server cut the capsule", async () => {
    const client = tracked();
    vi.spyOn(client, "previewSpinoff").mockResolvedValue({ mode: "fresh", capsule: { text: "x", tokenEstimate: 6000, tokenBudget: 6000, truncated: true }, notesToCopy: 0 });
    const line = await client.getLine(NAS_ROOT_ID);
    render(<SpinoffDialog open onOpenChange={() => undefined} line={line} messages={(await client.listMessages(NAS_ROOT_ID)).messages} atMessageId="nas-m19" onDone={vi.fn()} />, {
      wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }),
    });
    expect(await screen.findByText("超過上限：已先捨棄背景或截斷路徑。")).toBeInTheDocument();
  });

  it("a refusal is explained", async () => {
    const { client, dialog } = await openDialog("nas-b3", { atMessageId: "nas-b3-5" });
    vi.spyOn(client, "spinoff").mockRejectedValueOnce(new TangentError(409, "busy", "branch_busy"));
    await userEvent.click(within(dialog).getByRole("button", { name: "建立新對話" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("這條支線正在回覆");
  });

  it("through a tree-balance suggestion it accepts the suggestion instead", async () => {
    const client = tracked();
    const created = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m40", purpose: "Cloud only", kind: "alternative" });
    for (let i = 0; i < 5; i += 1) {
      await client.sendMessage(created.line.id, { content: "more" });
      await waitFor(async () => expect((await client.getLine(created.line.id)).status).toBe("idle"), { timeout: 3000 });
    }
    const suggestion = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "rebalance")!;
    const accept = vi.spyOn(client, "acceptSuggestion");
    const onDone = vi.fn();
    render(
      <SpinoffDialog open onOpenChange={() => undefined} line={await client.getLine(created.line.id)} messages={(await client.listMessages(created.line.id)).messages} atMessageId="" suggestionId={suggestion.id} onDone={onDone} />,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    await userEvent.click(await screen.findByRole("button", { name: "建立新對話" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith(suggestion.id, { action: "spinoff", title: "Cloud only" });
  });
});

describe("RebalanceHint (B4: on the branch bar, no popup, no focus taken)", () => {
  const suggestion = normalizeSuggestion({ id: "g", feature: "rebalance", kind: "promote_or_spinoff", lineId: "b", status: "open", payload: { reason: "share", branchTurns: 7, parentTurns: 2, actions: ["promote", "spinoff"] } });

  it("says why and offers 升為主線 / 獨立 / 維持 by keyboard; it does not take focus when it appears", async () => {
    const client = tracked();
    const onPromote = vi.fn();
    const onSpinoff = vi.fn();
    const onKeep = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    render(<RebalanceHint suggestion={suggestion} onPromote={onPromote} onSpinoff={onSpinoff} onKeep={onKeep} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const hint = screen.getByRole("group", { name: "樹平衡" });
    expect(outside).toHaveFocus();
    expect(hint).toHaveTextContent("這條支線分岔後已有 7 則回覆，主線分岔後只有 2 則。");
    expect(hint.className).toContain("border-dashed");
    within(hint).getByRole("button", { name: "升為主線" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect([onPromote.mock.calls.length, onSpinoff.mock.calls.length, onKeep.mock.calls.length]).toEqual([1, 1, 1]);
    outside.remove();
  });

  it("joins the reason and the question with a space in English and none in Chinese (R7 D4)", () => {
    const client = tracked();
    render(<RebalanceHint suggestion={suggestion} onPromote={vi.fn()} onSpinoff={vi.fn()} onKeep={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "en" }) });
    expect(screen.getByRole("group", { name: "Tree balance" })).toHaveTextContent("only 2 since then. Make it the main line");
    cleanup();
    render(<RebalanceHint suggestion={suggestion} onPromote={vi.fn()} onSpinoff={vi.fn()} onKeep={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    expect(screen.getByRole("group", { name: "樹平衡" }).textContent).toContain("只有 2 則。要升為主線");
  });

  it("names the parent: 主線, or the parent branch's title (B8.2)", () => {
    const client = tracked();
    const main = normalizeSuggestion({ ...suggestion, payload: { ...suggestion.payload, parentIsMain: true, parentTitle: "" } });
    render(<RebalanceHint suggestion={main} onPromote={vi.fn()} onSpinoff={vi.fn()} onKeep={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    expect(screen.getByRole("group", { name: "樹平衡" })).toHaveTextContent("主線分岔後只有 2 則");
    cleanup();
    const deep = normalizeSuggestion({ ...suggestion, payload: { ...suggestion.payload, parentIsMain: false, parentTitle: "Disks", actions: ["spinoff"] } });
    render(<RebalanceHint suggestion={deep} onPromote={vi.fn()} onSpinoff={vi.fn()} onKeep={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    expect(screen.getByRole("group", { name: "樹平衡" })).toHaveTextContent("「Disks」分岔後只有 2 則");
  });

  it("offers only the actions the server lists", () => {
    const client = tracked();
    const deep = normalizeSuggestion({ ...suggestion, payload: { reason: "recent", branchTurns: 5, parentTurns: 0, recentInBranch: true, actions: ["spinoff"] } });
    render(<RebalanceHint suggestion={deep} onPromote={vi.fn()} onSpinoff={vi.fn()} onKeep={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    expect(screen.getByRole("group", { name: "樹平衡" })).toHaveTextContent("最近 5 則回覆都在這條支線。");
    expect(screen.queryByRole("button", { name: "升為主線" })).toBeNull();
    expect(screen.getByRole("button", { name: "獨立" })).toBeInTheDocument();
  });

  it("the same suggestion in the inbox has the same three choices", async () => {
    const client = tracked();
    const onAction = vi.fn();
    render(<SuggestionCard suggestion={suggestion} target="另一條路・Cloud only" onAction={onAction} onDismiss={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const card = screen.getByRole("article", { name: "建議：樹平衡" });
    expect(card).toHaveTextContent("這條支線分岔後已有 7 則回覆");
    await userEvent.click(within(card).getByRole("button", { name: "升為主線" }));
    await userEvent.click(within(card).getByRole("button", { name: "獨立" }));
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(["promote", "spinoff"]);
    expect(within(card).getByRole("button", { name: "維持" })).toBeInTheDocument();
  });
});

describe("links between the conversations", () => {
  it("the source line's marker says 已獨立 → and goes to the new conversation", async () => {
    const client = tracked();
    const marker = normalizeMessage({ id: "mk", seq: 50, lineId: NAS_ROOT_ID, role: "system", kind: "branch_marker", content: "Spun off", meta: { spunOffTo: { lineId: "new", messageId: "nas-m19", title: "Filesystems", available: true } } });
    const onOpenBranch = vi.fn();
    render(<MessageList lineId={NAS_ROOT_ID} messages={[marker]} onOpenBranch={onOpenBranch} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    await userEvent.click(screen.getByRole("button", { name: "已獨立 →「Filesystems」" }));
    expect(onOpenBranch).toHaveBeenCalledWith("new", undefined);
    expect(screen.getByText("已獨立成新對話")).toBeInTheDocument();
  });

  it("a gone conversation is named, not linked (B8.2 available)", async () => {
    const client = tracked();
    const marker = normalizeMessage({ id: "mk", seq: 50, lineId: NAS_ROOT_ID, role: "system", kind: "branch_marker", meta: { spunOffTo: { lineId: "new", messageId: "nas-m19", title: "Filesystems", available: false } } });
    render(
      <>
        <MessageList lineId={NAS_ROOT_ID} messages={[marker]} onOpenBranch={vi.fn()} />
        <SpinoffOrigin origin={{ lineId: "old", messageId: "m", title: "Trip", available: false }} onGo={vi.fn()} />
      </>,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    expect(screen.getByText("已獨立 →「Filesystems」（對話已刪除）")).toBeInTheDocument();
    expect(screen.getByText("來自：Trip（對話已刪除）")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("the new conversation says where it came from and goes back to that message", async () => {
    const client = tracked();
    const onGo = vi.fn();
    render(<SpinoffOrigin origin={{ lineId: NAS_ROOT_ID, messageId: "nas-m19", title: "家用 NAS 與備份策略", available: true }} onGo={onGo} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    await userEvent.click(screen.getByRole("button", { name: "來自：家用 NAS 與備份策略" }));
    expect(onGo).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-m19");
  });
});

describe("the branch bar and the promote dialog (B2, B4)", () => {
  it("offers 獨立成新對話 on an open branch and shows 「已獨立 →」 once one was spun off from it", async () => {
    const client = tracked();
    const branch = (await client.getBranch("nas-b3")).branch;
    const onSpinoff = vi.fn();
    const onOpenSpinoff = vi.fn();
    render(<BranchBar branch={branch} parentMessages={[]} onBack={vi.fn()} onGoToFork={vi.fn()} onSpinoff={onSpinoff} spunOffTo={{ title: "Disk prices", available: true }} onOpenSpinoff={onOpenSpinoff} hint={<p>the hint</p>} />, {
      wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }),
    });
    await userEvent.click(screen.getByRole("button", { name: "獨立成新對話" }));
    await userEvent.click(screen.getByRole("button", { name: "已獨立 →「Disk prices」" }));
    expect([onSpinoff.mock.calls.length, onOpenSpinoff.mock.calls.length]).toEqual([1, 1]);
    expect(screen.getByText("the hint")).toBeInTheDocument();
  });

  it("promotes through a tree-balance suggestion when given one", async () => {
    const client = tracked();
    const created = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m40", purpose: "Cloud only", kind: "alternative" });
    for (let i = 0; i < 5; i += 1) {
      await client.sendMessage(created.line.id, { content: "more" });
      await waitFor(async () => expect((await client.getLine(created.line.id)).status).toBe("idle"), { timeout: 3000 });
    }
    const suggestion = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "rebalance")!;
    const accept = vi.spyOn(client, "acceptSuggestion");
    const onPromoted = vi.fn();
    const branch = (await client.getBranch(created.line.id)).branch;
    render(
      <PromoteBranchDialog open onOpenChange={vi.fn()} branch={branch} mainMessages={(await client.listMessages(NAS_ROOT_ID)).messages} branches={(await client.listBranches(NAS_ROOT_ID)).branches} suggestionId={suggestion.id} onPromoted={onPromoted} />,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "升為主線" }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith(suggestion.id, { action: "promote" });
    expect(onPromoted.mock.calls[0]![0]).toMatchObject({ line: { id: NAS_ROOT_ID }, branch: { lineId: created.line.id } });
  });
});
