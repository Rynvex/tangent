import { TangentError } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangentEvents } from "../../data/live-hooks";
import { mockClient, tangentWrapper } from "../../test-utils";
import { BranchCardReview } from "./branch-card-review";

/** The host mounts the event stream once; `branch.changed` reports the draft. */
function Events() {
  useTangentEvents();
  return null;
}

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup(options: { features?: "all" | "core"; draftMs?: number } = {}) {
  const client = mockClient({ draftMs: options.draftMs ?? 30, scenario: nasScenario({ features: options.features ?? "all" }) });
  clients.push(client);
  const onMerged = vi.fn();
  const onDiscard = vi.fn();
  const merge = vi.spyOn(client, "mergeBranch");
  const startDraft = vi.spyOn(client, "startDraft");
  const view = () =>
    render(
      <>
        <Events />
        <BranchCardReview open onOpenChange={() => undefined} lineId="nas-b3" onMerged={onMerged} onDiscard={onDiscard} />
      </>,
      { wrapper: tangentWrapper(client) },
    );
  return { client, onMerged, onDiscard, merge, startDraft, view };
}

const dialog = () => screen.findByRole("dialog", { name: /Conclusion card/ });

const PURPOSE = "4TB 與 8TB 硬碟的每 TB 成本與保固";
const LAST_REPLY = "整理一下：兩顆 8TB 比四顆 4TB 便宜約 NT$ 400，每 TB 成本也較低，保固相同。";
const DRAFT_CONCLUSION = "8TB 每 TB 成本最低（約 NT$ 825–850），保固與 4TB 同為 3 年；兩顆 8TB 比四顆 4TB 便宜約 NT$ 400。";
const ASK_AI = "✨ Ask the AI to condense a draft";
const conclusion = (review: HTMLElement) => within(review).getByRole("textbox", { name: /Conclusion/ });
const advancedToggle = (review: HTMLElement) => within(review).getByRole("button", { name: /optional/ });

describe("BranchCardReview", () => {
  it("opens at once with the question and conclusion prefilled, no draft started, and brings them back", async () => {
    const { onMerged, merge, startDraft, view } = setup();
    view();
    const review = await dialog();
    expect(await within(review).findByRole("textbox", { name: /Question/ })).toHaveValue(PURPOSE);
    expect(conclusion(review)).toHaveValue(LAST_REPLY);
    expect(within(review).queryByText("AI draft · for you to check")).toBeNull();
    expect(within(review).queryByText("The AI is reading the branch and drafting the card")).toBeNull();
    expect(startDraft).not.toHaveBeenCalled();
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(merge.mock.calls[0]![1].card).toEqual({ question: PURPOSE, conclusion: LAST_REPLY });
    expect(startDraft).not.toHaveBeenCalled();
  });

  it("prefills the conclusion from the branch's pinned AI reply first", async () => {
    const { client, view } = setup();
    await client.pinMessage("nas-b3-4");
    view();
    const review = await dialog();
    await waitFor(() => expect(conclusion(review)).toHaveValue("WD Red Plus 與 IronWolf 的 8TB 都是 CMR，沒有 SMR 的問題。要避開的是不帶 Plus 的 WD Red（2–6TB 有 SMR 型號）。"));
  });

  it("keeps the optional fields folded until asked for", async () => {
    const { view } = setup({ features: "core" });
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    const toggle = advancedToggle(review);
    expect(toggle).toHaveAccessibleName("Show more fields (optional)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(review).queryByRole("textbox", { name: "Impact on the main line" })).toBeNull();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide the optional fields");
    expect(within(review).getByRole("textbox", { name: "Impact on the main line" })).toBeVisible();
    await userEvent.click(toggle);
    expect(within(review).queryByRole("textbox", { name: "Impact on the main line" })).toBeNull();
  });

  it("unfolds the optional fields when one of them stops the card", async () => {
    const { merge, view } = setup({ features: "core" });
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    await userEvent.click(advancedToggle(review));
    await userEvent.click(within(review).getAllByRole("button", { name: "Add one" })[1]!);
    await userEvent.click(advancedToggle(review));
    expect(advancedToggle(review)).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(within(review).getByRole("textbox", { name: "Unresolved item 1" })).toHaveFocus());
    expect(advancedToggle(review)).toHaveAttribute("aria-expanded", "true");
    expect(merge).not.toHaveBeenCalled();
  });

  it("drafts with the AI only when asked, fills the form with the draft and opens the optional fields", async () => {
    const { onMerged, merge, startDraft, view } = setup();
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    expect(advancedToggle(review)).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(review).getByRole("button", { name: ASK_AI }));
    await waitFor(() => expect(startDraft).toHaveBeenCalledTimes(1));
    await within(review).findByText("AI draft · for you to check", {}, { timeout: 3000 });
    expect(conclusion(review)).toHaveValue(DRAFT_CONCLUSION);
    expect(advancedToggle(review)).toHaveAttribute("aria-expanded", "true");
    expect(within(review).getByRole("textbox", { name: "The branch says" })).toHaveValue("2 × 8TB mirror 總價較低、擴充只要再加 2 顆");
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(merge.mock.calls[0]![1].card.conclusion).toBe(DRAFT_CONCLUSION);
    expect(merge.mock.calls[0]![1].parentTipMessageId).toBe("nas-m40");
  });

  it("keeps what the user typed when the AI draft cannot start", async () => {
    const { startDraft, view } = setup();
    startDraft.mockRejectedValueOnce(new TangentError(500, "provider down", "internal"));
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    await userEvent.clear(conclusion(review));
    await userEvent.type(conclusion(review), "Two 8TB disks.");
    await userEvent.click(within(review).getByRole("button", { name: ASK_AI }));
    expect(await within(review).findByText(/Could not start the draft \(provider down\)/)).toBeInTheDocument();
    expect(conclusion(review)).toHaveValue("Two 8TB disks.");
    expect(conclusion(review)).toBeEnabled();
  });

  it("never brings back a card without a conclusion", async () => {
    const { merge, view } = setup({ features: "core" });
    view();
    const review = await dialog();
    await userEvent.clear(await within(review).findByRole("textbox", { name: /Question/ }));
    await userEvent.clear(conclusion(review));
    await userEvent.click(await within(review).findByRole("button", { name: "Accept all and bring back" }));
    expect(await within(review).findByText("Write a conclusion before bringing the card back.")).toBeInTheDocument();
    expect(within(review).getByText("Write the question the branch set out to answer.")).toBeInTheDocument();
    // R2: the first field with a problem gets the focus, so the reason is never off screen.
    await waitFor(() => expect(within(review).getByRole("textbox", { name: /Question/ })).toHaveFocus());
    expect(merge).not.toHaveBeenCalled();
  });

  it("offers no AI draft when drafting is off; the prefilled card is the user's to edit", async () => {
    const { startDraft, onMerged, merge, view } = setup({ features: "core" });
    view();
    const review = await dialog();
    const question = await within(review).findByRole("textbox", { name: /Question/ });
    expect(question).toHaveValue(PURPOSE);
    expect(within(review).queryByRole("button", { name: ASK_AI })).toBeNull();
    expect(within(review).queryByText("AI draft · for you to check")).toBeNull();
    expect(startDraft).not.toHaveBeenCalled();
    await userEvent.clear(question);
    await userEvent.type(question, "Which disks?");
    await userEvent.clear(conclusion(review));
    await userEvent.type(conclusion(review), "Two 8TB disks.");
    expect(within(review).queryByRole("button", { name: "Bring back with ticked changes" })).toBeNull();
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(merge.mock.calls[0]![1].card).toEqual({ question: "Which disks?", conclusion: "Two 8TB disks." });
  });

  it("shows the form waiting while the AI drafts, and stopping keeps the card", async () => {
    // A slow draft, so it cannot finish before the user gives up on it.
    const { view } = setup({ draftMs: 60_000 });
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    await userEvent.click(within(review).getByRole("button", { name: ASK_AI }));
    expect(await within(review).findByText("The AI is reading the branch and drafting the card")).toBeInTheDocument();
    expect(conclusion(review)).toBeDisabled();
    expect(within(review).getByRole("button", { name: "Accept all and bring back" })).toBeDisabled();
    await userEvent.click(within(review).getByRole("button", { name: "Don't wait, write it myself" }));
    expect(conclusion(review)).toHaveValue(LAST_REPLY);
    expect(conclusion(review)).toBeEnabled();
    expect(within(review).queryByText("The AI is reading the branch and drafting the card")).toBeNull();
  });

  it("offers to bring the card back anyway when the main line moved on", async () => {
    const { merge, onMerged, view } = setup({ features: "core" });
    merge.mockRejectedValueOnce(new TangentError(409, "moved", "parent_moved", { movedMessages: 2, movedCards: 0 }));
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    const notice = await within(review).findByText("The main line has 2 new message(s) since you opened this card.");
    await userEvent.click(within(notice.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Bring back as it is" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(merge.mock.calls[1]![1]).toMatchObject({ confirmParentMoved: true });
  });

  it("says the main line moved on since the draft and drafts again on request", async () => {
    const { client, startDraft, view } = setup();
    await client.startDraft("nas-b3");
    await waitFor(async () => expect((await client.getBranch("nas-b3")).draft.status).toBe("ready"));
    await client.sendMessage(NAS_ROOT_ID, { content: "[fake:error] one more" });
    await waitFor(async () => expect((await client.getLine(NAS_ROOT_ID)).status).toBe("error"));
    startDraft.mockClear();
    view();
    const review = await dialog();
    expect(await within(review).findByText("The main line has 2 new message(s) since this draft.")).toBeInTheDocument();
    await userEvent.click(within(review).getByRole("button", { name: "Draft again" }));
    await waitFor(() => expect(startDraft).toHaveBeenCalledTimes(1));
  });

  it("writes only the ticked note changes, or all of them", async () => {
    const { merge, view } = setup();
    view();
    const review = await dialog();
    await within(review).findByRole("textbox", { name: /Question/ });
    await userEvent.click(within(review).getByRole("button", { name: "Add a line" }));
    await userEvent.type(within(review).getByRole("textbox", { name: "Text" }), "Disks: 2 × 8TB mirror");
    await userEvent.click(within(review).getByRole("checkbox", { name: "Include this change" }));
    merge.mockRejectedValueOnce(new TangentError(409, "busy", "parent_busy"));
    await userEvent.click(within(review).getByRole("button", { name: "Bring back with ticked changes" }));
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
    expect(merge.mock.calls[0]![1].noteChanges).toBeUndefined();
    expect(await within(review).findByText("The main line is replying; wait for it to finish, then bring the card back.")).toBeInTheDocument();
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(2));
    expect(merge.mock.calls[1]![1].noteChanges).toEqual([{ op: "add", section: "decided", text: "Disks: 2 × 8TB mirror" }]);
  });

  it("can turn into a discard", async () => {
    const { onDiscard, view } = setup({ features: "core" });
    view();
    const review = await dialog();
    await userEvent.click(await within(review).findByRole("button", { name: "Don't bring back instead…" }));
    expect(onDiscard).toHaveBeenCalled();
  });
});

describe("BranchCardReview: the draft's note proposals (B5)", () => {
  it("lists the AI's proposals ticked and marked; 全部接受 sends them with the card", async () => {
    const { onMerged, merge, view } = setup();
    view();
    const review = await dialog();
    await userEvent.click(await within(review).findByRole("button", { name: ASK_AI }));
    await within(review).findByText("AI draft · for you to check", {}, { timeout: 3000 });
    const proposal = within(review).getByText("Proposed by the AI").closest("[data-proposal]") as HTMLElement;
    expect(within(proposal).getByRole("checkbox", { name: "Include this change" })).toBeChecked();
    expect(within(proposal).getByRole("textbox", { name: /Text/ })).toHaveValue("8TB 每 TB 成本最低（約 NT$ 825–850），保固與 4TB 同為 3 年；兩顆 8TB 比四顆 4TB 便宜約 NT$ 400。");
    await userEvent.click(within(review).getByRole("button", { name: "Accept all and bring back" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(merge.mock.calls[0]![1].noteChanges).toEqual([expect.objectContaining({ op: "add", section: "decided" })]);
  });
});
