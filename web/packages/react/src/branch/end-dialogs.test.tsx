import { TangentError, type BranchView } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { AsideNoteDialog } from "./aside-note-dialog";
import { DiscardBranchDialog } from "./discard-branch-dialog";
import { MoveBranchDialog } from "./move-branch-dialog";
import { PromoteBranchDialog } from "./promote-branch-dialog";

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});
function tracked() {
  const client = mockClient();
  clients.push(client);
  return client;
}
const branchOf = async (client: ReturnType<typeof tracked>, lineId: string): Promise<BranchView> => (await client.getBranch(lineId)).branch;

describe("DiscardBranchDialog", () => {
  it("ends the branch without a card", async () => {
    const client = tracked();
    const onDiscarded = vi.fn();
    render(<DiscardBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b3")} onDiscarded={onDiscarded} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "End the branch without bringing anything back" });
    await userEvent.click(within(dialog).getByRole("button", { name: "End, don't bring back" }));
    await waitFor(() => expect(onDiscarded).toHaveBeenCalled());
    expect((await client.getBranch("nas-b3")).branch.status).toBe("discarded");
  });

  it("writes the optional reason as the branch's dead-end leaf (leaf on, B1)", async () => {
    const client = tracked();
    const spy = vi.spyOn(client, "discardBranch");
    render(<DiscardBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b3")} onDiscarded={() => undefined} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "End the branch without bringing anything back" });
    const reason = await within(dialog).findByRole("textbox", { name: "Reason (optional)" });
    expect(within(dialog).getByText("Becomes this branch's “dead end” ending")).toBeInTheDocument();
    await userEvent.type(reason, "Over budget,{Enter}not worth it");
    await userEvent.click(within(dialog).getByRole("button", { name: "End, don't bring back" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("nas-b3", { leaf: { line: "Over budget, not worth it" } }));
    await waitFor(async () => expect((await client.getBranch("nas-b3")).branch.leaf).toEqual({ kind: "dead_end", line: "Over budget, not worth it", status: "confirmed" }));
  });

  it("refuses a reason over 200 characters before sending", async () => {
    const client = tracked();
    const spy = vi.spyOn(client, "discardBranch");
    render(<DiscardBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b3")} onDiscarded={() => undefined} />, { wrapper: tangentWrapper(client) });
    const reason = await screen.findByRole("textbox", { name: "Reason (optional)" });
    await userEvent.click(reason);
    await userEvent.paste("x".repeat(201));
    expect(screen.getByText("At most 200 characters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "End, don't bring back" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("has no reason field and sends no leaf while the leaf feature is off", async () => {
    const client = mockClient({ scenario: nasScenario({ features: "c1" }) });
    clients.push(client);
    const spy = vi.spyOn(client, "discardBranch");
    render(<DiscardBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b3")} onDiscarded={() => undefined} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "End the branch without bringing anything back" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "End, don't bring back" })).toBeEnabled());
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "End, don't bring back" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("nas-b3", undefined));
  });

  it("explains a refusal", async () => {
    const client = tracked();
    vi.spyOn(client, "discardBranch").mockRejectedValue(new TangentError(409, "busy", "branch_busy"));
    render(<DiscardBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b3")} onDiscarded={() => undefined} />, { wrapper: tangentWrapper(client) });
    await userEvent.click(await screen.findByRole("button", { name: "End, don't bring back" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This branch is replying");
  });
});

describe("PromoteBranchDialog", () => {
  async function open(client: ReturnType<typeof tracked>, lineId: string, onPromoted = vi.fn(), onOpenBranch = vi.fn()) {
    const branches = (await client.listBranches(NAS_ROOT_ID)).branches;
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    render(
      <PromoteBranchDialog open onOpenChange={() => undefined} branch={await branchOf(client, lineId)} mainMessages={messages} branches={branches} onPromoted={onPromoted} onOpenBranch={onOpenBranch} />,
      { wrapper: tangentWrapper(client) },
    );
    return { dialog: await screen.findByRole("dialog", { name: "Make this branch the main line" }), onPromoted, onOpenBranch };
  }

  it("shows the before / after and names the open branches that block it, focus on Cancel", async () => {
    const client = tracked();
    const created = await client.createBranch(NAS_ROOT_ID, { purpose: "Cloud only", kind: "alternative", anchorMessageId: "nas-m26" });
    const { dialog, onOpenBranch } = await open(client, created.line.id);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(within(dialog).getByRole("figure", { name: "Now" })).toHaveTextContent("#6 fork point");
    expect(within(dialog).getByRole("figure", { name: "After the promotion" })).toHaveTextContent("Previous main line #7…");
    expect(dialog).toHaveTextContent("Branches on that part must end first: 1 still open.");
    await userEvent.click(within(dialog).getByRole("button", { name: /改用雲端備份/ }));
    expect(onOpenBranch).toHaveBeenCalledWith("nas-b2");
  });

  it("promotes, and lists the blockers the server names", async () => {
    const client = tracked();
    await client.discardBranch("nas-b2");
    const created = await client.createBranch(NAS_ROOT_ID, { purpose: "Cloud only", kind: "alternative", anchorMessageId: "nas-m26" });
    const promote = vi.spyOn(client, "promoteBranch").mockRejectedValueOnce(new TangentError(409, "open", "open_branches_on_old_tail", { lineIds: ["nas-b3"] }));
    const { dialog, onPromoted } = await open(client, created.line.id);
    await userEvent.click(within(dialog).getByRole("button", { name: "Make main line" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("End these first:");
    expect(within(alert).getByRole("button", { name: /4TB 與 8TB/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Make main line" }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalled());
    expect(promote).toHaveBeenCalledTimes(2);
  });
});

describe("MoveBranchDialog", () => {
  it("previews the moved messages and moves them", async () => {
    const client = tracked();
    const line = await client.getLine(NAS_ROOT_ID);
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    const onMoved = vi.fn();
    render(<MoveBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} startMessageId="nas-m39" onMoved={onMoved} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "Move the last 2 message(s) into a branch" });
    expect(within(dialog).getByRole("list")).toHaveTextContent("那備份呢？");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move into a branch" }));
    expect(within(dialog).getByText("A purpose is required.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Purpose of the new branch" }), "異地備份");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move into a branch" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(onMoved.mock.calls[0]![0].movedMessageIds).toEqual(["nas-m39", "nas-m40"]);
  });

  it("says why a range cannot move and does not send it", async () => {
    const client = tracked();
    const move = vi.spyOn(client, "moveToBranch");
    const line = await client.getLine(NAS_ROOT_ID);
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    render(<MoveBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} startMessageId="nas-m18" onMoved={() => undefined} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("A conclusion card or a move marker is in that range.");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Purpose of the new branch" }), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move into a branch" }));
    expect(move).not.toHaveBeenCalled();
  });
});

describe("AsideNoteDialog", () => {
  it("prefills the answer and saves it as a confirmed fact sourced from the aside", async () => {
    const client = tracked();
    const create = vi.spyOn(client, "createNote");
    const messages = (await client.listMessages("nas-b1a")).messages;
    const onSaved = vi.fn();
    render(<AsideNoteDialog open onOpenChange={() => undefined} branch={await branchOf(client, "nas-b1a")} messages={messages} onSaved={onSaved} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "Keep the answer in the notes" });
    expect(within(dialog).getByRole("textbox", { name: "Note" })).toHaveValue("一般建議每月一次。2TB 的資料約跑 3 小時，可以排在半夜。");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save to notes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(create.mock.calls[0]).toEqual([NAS_ROOT_ID, { section: "fact", text: "一般建議每月一次。2TB 的資料約跑 3 小時，可以排在半夜。", sourceLineId: "nas-b1a", sourceMessageId: "nas-b1a-2" }]);
  });
});
