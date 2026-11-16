import { TangentError } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryNotesSeen } from "../data/note-reads";
import { mockClient, tangentWrapper } from "../test-utils";
import { NotesPanel } from "./notes-panel";

afterEach(cleanup);

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});
function setup(options: Parameters<typeof mockClient>[0] = {}, props: { readOnly?: boolean } = {}) {
  const client = mockClient(options);
  clients.push(client);
  const onGoToSource = vi.fn();
  const seenStore = createMemoryNotesSeen({ "": { [NAS_ROOT_ID]: "2026-10-12T14:00:00.000Z" } });
  render(<NotesPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onGoToSource={onGoToSource} seenStore={seenStore} />, {
    wrapper: tangentWrapper(client, undefined, { locale: "en", ...props }),
  });
  return { client, onGoToSource };
}

const section = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });

describe("NotesPanel (A9)", () => {
  it("shows the four sections with their active counts and says the page goes to the AI every turn", async () => {
    setup();
    await waitFor(() => expect(section("Decided")).toBeInTheDocument());
    expect(within(section("Decided")).getAllByRole("listitem")).toHaveLength(3);
    expect(within(section("Confirmed facts")).getByText("現有資料 2.1TB、每年成長約 400GB")).toBeInTheDocument();
    expect(within(section("To confirm")).getByText("ECC 記憶體是否必要")).toBeInTheDocument();
    expect(within(section("To do")).getByRole("checkbox", { name: "Done: 列出 3 款支援 ECC 的主機板" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByText(/This page goes to the AI every turn · about \d+ of 2k tokens/)).toBeInTheDocument());
    expect(screen.getByText("6 of 200 active")).toBeInTheDocument();
  });

  it("keeps replaced notes collapsed under their section, struck through and pointing to the replacement", async () => {
    setup();
    const decided = await waitFor(() => section("Decided"));
    expect(within(decided).queryByText("檔案系統用 Btrfs")).toBeNull();
    const toggle = within(decided).getByRole("button", { name: "Show 1 replaced" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(within(decided).getByText("檔案系統用 Btrfs").tagName).toBe("S");
    expect(within(decided).getByText("Replaced by “檔案系統用 ZFS mirror”")).toBeInTheDocument();
    expect(within(decided).getByRole("button", { name: "Hide 1 replaced" })).toHaveAttribute("aria-expanded", "true");
  });

  it("adds a note to the chosen section", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    const form = screen.getByRole("group", { name: "New note" });
    await userEvent.click(within(form).getByRole("radio", { name: "To do" }));
    await userEvent.type(within(form).getByRole("textbox", { name: "Note" }), "Buy a UPS{Enter}");
    await waitFor(() => expect(within(section("To do")).getByText("Buy a UPS")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toHaveFocus();
  });

  it("edits, ticks and replaces through the server", async () => {
    const { client } = setup();
    const decided = await waitFor(() => section("Decided"));
    await userEvent.click(within(decided).getByRole("button", { name: "預算上限 3 萬" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Edit the note" }), "（含稅）{Enter}");
    await waitFor(async () => expect((await client.listNotes(NAS_ROOT_ID)).notes.find((note) => note.id === "n2")?.text).toBe("預算上限 3 萬（含稅）"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Done: 列出 3 款支援 ECC 的主機板" }));
    await waitFor(async () => expect((await client.listNotes(NAS_ROOT_ID)).notes.find((note) => note.id === "n6")?.status).toBe("done"));
    const fact = section("Confirmed facts");
    await userEvent.click(within(fact).getByRole("button", { name: "Replace" }));
    const box = within(fact).getByRole("textbox", { name: "New text (the old note stays, struck through)" });
    await userEvent.clear(box);
    await userEvent.type(box, "現有資料 2.3TB");
    await userEvent.click(within(fact).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(section("Confirmed facts")).getByRole("button", { name: "現有資料 2.3TB" })).toBeInTheDocument());
    expect(within(section("Confirmed facts")).getByRole("button", { name: "Show 1 replaced" })).toBeInTheDocument();
  });

  it("replaces a to-confirm note with a confirmed fact; the old one collapses under to confirm (R5)", async () => {
    const { client } = setup();
    const toConfirm = await waitFor(() => section("To confirm"));
    await userEvent.click(within(toConfirm).getByRole("button", { name: "Replace" }));
    const box = within(toConfirm).getByRole("textbox", { name: "New text (the old note stays, struck through)" });
    await userEvent.clear(box);
    await userEvent.type(box, "ECC 記憶體必要");
    await userEvent.click(within(toConfirm).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(section("Confirmed facts")).getByRole("button", { name: "ECC 記憶體必要" })).toBeInTheDocument());
    expect((await client.listNotes(NAS_ROOT_ID)).notes.find((note) => note.text === "ECC 記憶體必要")?.section).toBe("fact");
    expect(within(section("To confirm")).queryByRole("button", { name: "ECC 記憶體是否必要" })).toBeNull();
    await userEvent.click(within(section("To confirm")).getByRole("button", { name: "Show 1 replaced" }));
    expect(within(section("To confirm")).getByText("ECC 記憶體是否必要").tagName).toBe("S");
    expect(within(section("To confirm")).getByText("Replaced by “ECC 記憶體必要”")).toBeInTheDocument();
  });

  it("says why a to-do could not be ticked and keeps it unticked (R5)", async () => {
    const { client } = setup();
    vi.spyOn(client, "updateNote").mockRejectedValue(new TangentError(409, "superseded", "note_superseded"));
    const todo = await waitFor(() => section("To do"));
    const box = within(todo).getByRole("checkbox", { name: "Done: 列出 3 款支援 ECC 的主機板" });
    await userEvent.click(box);
    expect(await within(section("To do")).findByRole("alert")).toHaveTextContent(/Not saved/);
    await waitFor(() => expect(within(section("To do")).getByRole("checkbox", { name: "Done: 列出 3 款支援 ECC 的主機板" })).not.toBeChecked());
  });

  it("marks notes written since the last visit and links their sources", async () => {
    const { onGoToSource } = setup();
    // The scenario's notes are from 22:03 local (14:03Z), after the recorded visit at 14:00Z.
    await waitFor(() => expect(screen.getAllByText("New").length).toBeGreaterThan(0));
    await userEvent.click(within(section("Decided")).getByRole("button", { name: /Go to the source: Conclusion card · ZFS mirror/ }));
    expect(onGoToSource).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-c1");
  });

  it("says which notes the prompt leaves out over the budget", async () => {
    setup({ scenario: { ...nasScenario(), noteLimits: { ...nasScenario().noteLimits, tokenBudget: 1 } } });
    await waitFor(() => expect(screen.getByText(/the 3 oldest are left out of this turn/)).toBeInTheDocument());
    expect(within(section("To confirm")).getByText("Not sent this turn")).toBeInTheDocument();
    expect(within(section("Decided")).queryByText("Not sent this turn")).toBeNull();
  });

  it("stops adding at the server's active limit", async () => {
    setup({ scenario: { ...nasScenario(), noteLimits: { ...nasScenario().noteLimits, maxActive: 6 } } });
    expect(await screen.findByText(/6 active notes is the limit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
  });

  it("is read-only for viewers", async () => {
    setup({}, { readOnly: true });
    await waitFor(() => expect(section("Decided")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "預算上限 3 萬" })).toBeNull();
  });
});
