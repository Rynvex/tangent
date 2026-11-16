import { TangentError } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { NodePanel, type NodePanelProps } from "./node-panel";

afterEach(cleanup);

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup(lineId: string, props: Partial<NodePanelProps> = {}, options: { readOnly?: boolean } = {}) {
  const client = mockClient();
  clients.push(client);
  const handlers = { onClose: vi.fn(), onGo: vi.fn(), onAction: vi.fn(), onBringIn: vi.fn(), onContinue: vi.fn(), onShowAllNotes: vi.fn() };
  render(<NodePanel rootLineId={NAS_ROOT_ID} lineId={lineId} currentLineId={NAS_ROOT_ID} {...handlers} {...props} />, {
    wrapper: tangentWrapper(client, undefined, { locale: "en", ...options }),
  });
  return { client, ...handlers };
}

const panel = () => screen.getByRole("region", { name: "Node panel" });

describe("NodePanel: an open branch (FOCUS_MODE.md §7)", () => {
  it("names the node, where it forks and what can be done; 到這條 enters it", async () => {
    const { onGo, onAction } = setup("nas-b3");
    await screen.findByRole("heading", { name: "4TB 與 8TB 硬碟的每 TB 成本與保固" });
    expect(within(panel()).getByText(/^Forks from main line #\d+$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to this line" }));
    expect(onGo).toHaveBeenCalledWith("nas-b3");
    for (const name of ["End and bring back", "Don't bring back…", "Make it the main line…", "Open a branch…"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Don't bring back…" }));
    expect(onAction).toHaveBeenCalledWith("discard", { lineId: "nas-b3", lastMessageId: expect.any(String) });
  });

  it("renames on Enter and refuses an empty purpose", async () => {
    const { client } = setup("nas-b3");
    const rename = vi.spyOn(client, "renameBranch");
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Branch purpose" });
    await userEvent.clear(box);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("A purpose is required.");
    await userEvent.type(box, "硬碟的每 TB 成本{Enter}");
    await waitFor(() => expect(rename).toHaveBeenCalledWith("nas-b3", { purpose: "硬碟的每 TB 成本" }));
    await screen.findByRole("heading", { name: "硬碟的每 TB 成本" });
  });

  it("keeps the typed title in the box when the save is refused, and offers to save again", async () => {
    const { client } = setup("nas-b3");
    vi.spyOn(client, "renameBranch").mockRejectedValue(new TangentError(500, "boom", "internal"));
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Branch purpose" });
    await userEvent.clear(box);
    await userEvent.type(box, "新的目的{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Couldn't save: .+The title hasn't changed/);
    expect(box).toHaveValue("新的目的");
    expect(screen.getByRole("button", { name: "Save again" })).toBeInTheDocument();
  });

  it("Esc gives up the edit and the old title comes back", async () => {
    setup("nas-b3");
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Branch purpose" }), "xx{Escape}");
    expect(screen.queryByRole("textbox", { name: "Branch purpose" })).toBeNull();
    expect(screen.getByRole("heading", { name: "4TB 與 8TB 硬碟的每 TB 成本與保固" })).toHaveFocus();
  });

  it("writes a new note on the node into 待確認 with the node as its source", async () => {
    const { client } = setup("nas-b3");
    const create = vi.spyOn(client, "createNote");
    await userEvent.click(await screen.findByRole("button", { name: "New note (to confirm)" }));
    expect(screen.getByRole("radio", { name: "To confirm" })).toBeChecked();
    await userEvent.type(screen.getByRole("textbox", { name: /note/i }), "保固要看 RMA 流程{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, expect.objectContaining({ section: "to_confirm", text: "保固要看 RMA 流程", sourceLineId: "nas-b3" })));
  });
});

describe("NodePanel: an ended branch", () => {
  it("shows the conclusion (not editable) and the notes written from it", async () => {
    const { onGo } = setup("nas-b1");
    await screen.findByRole("heading", { name: /ZFS mirror 與 Btrfs/ });
    expect(screen.getByText("Conclusion cards are a record. To correct one, write a note.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to the card" }));
    expect(onGo).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-c1");
    const notes = screen.getByRole("region", { name: /^Notes \(sent to AI\)/ });
    expect(within(notes).getByText("檔案系統用 ZFS mirror")).toBeInTheDocument();
    expect(within(notes).getByText("ECC 記憶體是否必要")).toBeInTheDocument();
    expect(within(notes).queryByText("預算上限 3 萬")).toBeNull();
    expect(within(notes).getByText("Attaching here only marks the source; the AI sees the whole notes page.")).toBeInTheDocument();
  });

  it("brings a note into this turn in the agreed wording", async () => {
    const { onBringIn } = setup("nas-b1");
    const notes = await screen.findByRole("region", { name: /^Notes \(sent to AI\)/ });
    const item = within(notes).getByText("檔案系統用 ZFS mirror").closest("li")!;
    await userEvent.click(within(item).getByRole("button", { name: "Actions for this note" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Bring into this turn" }));
    expect(onBringIn).toHaveBeenCalledWith("A note on “ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異”: 檔案系統用 ZFS mirror");
  });

  it("continues an ended branch's note from where the branch forked, and says why", async () => {
    const { onContinue } = setup("nas-b1");
    const notes = await screen.findByRole("region", { name: /^Notes \(sent to AI\)/ });
    const item = within(notes).getByText("ECC 記憶體是否必要").closest("li")!;
    await userEvent.click(within(item).getByRole("button", { name: "Actions for this note" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Continue from here…" }));
    expect(onContinue).toHaveBeenCalledWith({
      lineId: NAS_ROOT_ID,
      anchorMessageId: "nas-m19",
      purpose: "ECC 記憶體是否必要",
      excerpt: "ECC 記憶體是否必要",
      notice: "“ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異” has ended, so the new branch forks where it did.",
    });
  });
});

describe("NodePanel: renaming an ended branch (B13)", () => {
  it("renames a brought-back branch and says the card's source will use the new name", async () => {
    const { client } = setup("nas-b1");
    const rename = vi.spyOn(client, "renameBranch");
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect(screen.getByText("After renaming, the main line's next turns name this conclusion card's source with the new name.")).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Branch purpose" });
    await userEvent.clear(box);
    await userEvent.type(box, "ZFS 或 Btrfs{Enter}");
    await waitFor(() => expect(rename).toHaveBeenCalledWith("nas-b1", { purpose: "ZFS 或 Btrfs" }));
  });

  it("a discarded branch gets the general hint", async () => {
    setup("nas-b4");
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect(screen.getByText(/the AI sees this branch under the new name from now on/)).toBeInTheDocument();
  });
});

describe("NodePanel: memos (B13)", () => {
  const openMemos = async () => {
    await userEvent.click(await screen.findByRole("radio", { name: /^Memos \(not sent\)/ }));
    return screen.getByRole("region", { name: /^Memos \(not sent to AI\)/ });
  };

  it("switches between notes and memos, each with this node's count", async () => {
    setup("nas-b1");
    expect(await screen.findByRole("radio", { name: "Notes (sent to AI) 2" })).toBeChecked();
    const memos = await openMemos();
    expect(within(memos).getByText("Not sent to the AI. Anyone who can see this conversation can see it.")).toBeInTheDocument();
    expect(within(memos).getByText(/問一下小陳/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Memos (not sent) 1" })).toBeChecked();
  });

  it("says what memos are when a node has none, and writes one on the node", async () => {
    const { client } = setup("nas-b3");
    const create = vi.spyOn(client, "createMemo");
    const memos = await openMemos();
    expect(within(memos).getByText(/^No memos yet\. Write thoughts the AI won't see/)).toBeInTheDocument();
    await userEvent.click(within(memos).getByRole("button", { name: "New memo" }));
    await userEvent.type(within(memos).getByRole("textbox", { name: "Memo" }), "line one{Shift>}{Enter}{/Shift}line two{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, { lineId: "nas-b3", text: "line one\nline two" }));
    expect(await within(memos).findByText(/line one/)).toBeInTheDocument();
  });

  it("deletes a memo with five seconds to undo, and undo writes it back", async () => {
    const { client } = setup("nas-b1");
    const create = vi.spyOn(client, "createMemo");
    const memos = await openMemos();
    await userEvent.click(within(memos).getByRole("button", { name: "Actions for this memo" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await within(memos).findByText("Memo deleted.")).toBeInTheDocument();
    expect(within(memos).queryByText(/問一下小陳/)).toBeNull();
    await userEvent.click(within(memos).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, expect.objectContaining({ lineId: "nas-b1", text: expect.stringContaining("問一下小陳") })));
    expect(await within(memos).findByText(/問一下小陳/)).toBeInTheDocument();
  });

  it("keeps a node's undo to that node when another node is chosen", async () => {
    const client = mockClient();
    clients.push(client);
    const props = { rootLineId: NAS_ROOT_ID, currentLineId: NAS_ROOT_ID, onClose: vi.fn(), onGo: vi.fn() };
    const { rerender } = render(<NodePanel lineId="nas-b1" {...props} />, { wrapper: tangentWrapper(client, undefined, { locale: "en" }) });
    const memos = await openMemos();
    await userEvent.click(within(memos).getByRole("button", { name: "Actions for this memo" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await within(memos).findByText("Memo deleted.")).toBeInTheDocument();
    rerender(<NodePanel lineId="nas-b3" {...props} />);
    await screen.findByRole("heading", { name: "4TB 與 8TB 硬碟的每 TB 成本與保固" });
    expect(screen.queryByText("Memo deleted.")).toBeNull();
  });

  it("turns a memo into a note with the node as source, and keeps the memo marked", async () => {
    const { client } = setup("nas-b1");
    const note = vi.spyOn(client, "createNote");
    const memos = await openMemos();
    await userEvent.click(within(memos).getByRole("button", { name: "Actions for this memo" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Turn into a note…" }));
    await userEvent.click(within(memos).getByRole("button", { name: "Turn into a note" }));
    await waitFor(() => expect(note).toHaveBeenCalledWith(NAS_ROOT_ID, expect.objectContaining({ section: "to_confirm", sourceLineId: "nas-b1" })));
    expect(await within(memos).findByText("Turned into a note")).toBeInTheDocument();
    expect(within(memos).getByText(/問一下小陳/)).toBeInTheDocument();
  });

  it("brings a memo into this turn in the notes' wording", async () => {
    const { onBringIn } = setup("nas-b1");
    const memos = await openMemos();
    await userEvent.click(within(memos).getByRole("button", { name: "Actions for this memo" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Bring into this turn" }));
    expect(onBringIn).toHaveBeenCalledWith(expect.stringMatching(/^A note on “ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異”: 問一下小陳/));
  });
});

describe("NodePanel: main line and viewers", () => {
  it("the main line's title is the conversation's; it has no fork place", async () => {
    setup(NAS_ROOT_ID);
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Conversation title" })).toBeInTheDocument();
    expect(within(panel()).queryByText(/^Forks from/)).toBeNull();
    expect(within(panel()).getByText("You are here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to this line" })).toBeNull();
  });

  it("a viewer reads everything and changes nothing", async () => {
    setup("nas-b3", {}, { readOnly: true });
    await screen.findByText("You can only view.");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New note (to confirm)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End and bring back" })).toBeNull();
  });

  it("close asks the host to close it", async () => {
    const { onClose } = setup("nas-b3");
    await screen.findByRole("heading", { name: "4TB 與 8TB 硬碟的每 TB 成本與保固" });
    await userEvent.click(screen.getByRole("button", { name: "Close the node panel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
