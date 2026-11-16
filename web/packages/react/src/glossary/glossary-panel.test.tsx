import { NAS_ROOT_ID, type MockTangentClient } from "@tangent/client/testing";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import GlossaryPanel, { type GlossaryToast } from "./glossary-panel";
import { TERM_DELETE_UNDO_MS, undoTermDeletes, waitingTermDeletes } from "./pending-term-deletes";

/** F19 §2.2: the side panel's 名詞表 — the list, its filter, a term's explanation, source, edit and delayed delete. */

const clients: MockTangentClient[] = [];
afterEach(() => {
  // Nothing may be left waiting for the next test.
  undoTermDeletes();
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
  vi.useRealTimers();
});

async function setup({ readOnly = false, seed = true }: { readOnly?: boolean; seed?: boolean } = {}) {
  const client = mockClient();
  clients.push(client);
  if (seed) {
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "A copy-on-write filesystem.\nSnapshots are cheap.", sourceMessageId: "nas-m17" });
    await client.createTerm("nas-b3", { term: "ECC", explanation: "Memory that corrects single-bit errors." });
    await client.createTerm(NAS_ROOT_ID, { term: "scrub", explanation: "Reads every block of a ZFS pool to find silent corruption." });
  }
  const onGoToSource = vi.fn();
  const toast = vi.fn<GlossaryToast>();
  const view = render(<GlossaryPanel rootLineId={NAS_ROOT_ID} readOnly={readOnly} onGoToSource={onGoToSource} toast={toast} />, { wrapper: tangentWrapper(client) });
  return { client, onGoToSource, toast, view };
}

const panel = () => screen.findByRole("region", { name: "Glossary" });
const names = (region: HTMLElement) => within(region).getAllByRole("listitem").map((item) => item.getAttribute("data-tg-term") && within(item).getAllByRole("button")[0]!.textContent);
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("GlossaryPanel: reading", () => {
  it("lists the terms by name, closed, each with the start of its explanation", async () => {
    await setup();
    const region = await panel();
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(3));
    expect(names(region)).toEqual([expect.stringMatching(/^ECC/), expect.stringMatching(/^scrub/), expect.stringMatching(/^ZFS/)]);
    for (const row of within(region).getAllByRole("button", { expanded: false })) expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("filters by name first, then by explanation, and says when nothing matches", async () => {
    await setup();
    const region = await panel();
    const filter = within(region).getByRole("searchbox", { name: "Filter terms" });
    await userEvent.type(filter, "zfs");
    expect(names(region)).toEqual([expect.stringMatching(/^ZFS/), expect.stringMatching(/^scrub/)]);
    await userEvent.clear(filter);
    await userEvent.type(filter, "nothing like it");
    expect(within(region).getByText("No term matches “nothing like it”.")).toBeInTheDocument();
  });

  it("opens a term to its whole explanation and where it came from, and goes there", async () => {
    // Arrange
    const { onGoToSource } = await setup();
    const region = await panel();

    // Act
    await userEvent.click(await within(region).findByRole("button", { name: /^ZFS/ }));

    // Assert
    const row = within(region).getByRole("button", { name: /^ZFS/ }).closest("li")!;
    expect(row).toHaveTextContent("Snapshots are cheap.");
    await userEvent.click(within(row).getByRole("button", { name: /^Go to where “ZFS” came from: 主線 #\d+$/ }));
    expect(onGoToSource).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-m17");
  });

  it("names a source that is gone by its snapshot, without a way there", async () => {
    // Arrange: a term saved from an aside that is then thrown away.
    const client = mockClient();
    clients.push(client);
    const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "What is a scrub?", kind: "aside" });
    await client.sendMessage(made.line.id, { content: "What is a scrub?" });
    await waitFor(async () => expect((await client.getBranch(made.line.id)).branch.status).toBe("discarded"));
    await client.createTerm(made.line.id, { term: "scrub", explanation: "A full read." });
    await client.deleteBranch(made.line.id);
    render(<GlossaryPanel rootLineId={NAS_ROOT_ID} onGoToSource={vi.fn()} toast={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const region = await panel();

    // Act
    await userEvent.click(await within(region).findByRole("button", { name: /^scrub/ }));

    // Assert
    const gone = region.querySelector("[data-tg-term-source-gone]");
    expect(gone).toHaveTextContent("順口問・What is a scrub? (no longer there)");
    expect(within(region).queryByRole("button", { name: /^Go to where/ })).toBeNull();
  });

  it("says in one line what belongs here while there is no term, with no filter", async () => {
    await setup({ seed: false });
    await waitFor(() => expect(document.querySelector("[data-tg-glossary-empty]")).not.toBeNull());
    expect(document.querySelector("[data-tg-glossary-empty]")).toHaveTextContent(/For example “MVCC/);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("offers neither 編輯 nor 刪除 to a viewer", async () => {
    await setup({ readOnly: true });
    const region = await panel();
    await userEvent.click(await within(region).findByRole("button", { name: /^ECC/ }));
    expect(within(region).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(region).queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("shows the term asked for from a reply open, whatever the filter says", async () => {
    const { client, view } = await setup();
    const region = await panel();
    await userEvent.type(within(region).getByRole("searchbox", { name: "Filter terms" }), "ecc");
    const zfs = (await client.listTerms(NAS_ROOT_ID)).terms.find((term) => term.term === "ZFS")!;
    view.rerender(<GlossaryPanel rootLineId={NAS_ROOT_ID} onGoToSource={vi.fn()} toast={vi.fn()} focus={{ termId: zfs.id, n: 1 }} />);
    expect(await within(region).findByRole("button", { name: /^ZFS/, expanded: true })).toBeInTheDocument();
    expect(within(region).getByRole("searchbox", { name: "Filter terms" })).toHaveValue("");
  });
});

describe("GlossaryPanel: editing", () => {
  it("edits the explanation in place, and refuses a rename onto another term with its name", async () => {
    // Arrange
    const { client } = await setup();
    const region = await panel();
    await userEvent.click(await within(region).findByRole("button", { name: /^ECC/ }));
    await userEvent.click(within(region).getByRole("button", { name: "Edit" }));
    const form = within(region).getByRole("form", { name: "Edit “ECC”" });

    // Act: a rename onto ZFS.
    await userEvent.clear(within(form).getByRole("textbox", { name: "Term" }));
    await userEvent.type(within(form).getByRole("textbox", { name: "Term" }), "zfs");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));

    // Assert
    expect(await within(form).findByRole("alert")).toHaveTextContent("This conversation's glossary already has “ZFS”.");

    // Act: the explanation alone.
    await userEvent.clear(within(form).getByRole("textbox", { name: "Term" }));
    await userEvent.type(within(form).getByRole("textbox", { name: "Term" }), "ECC");
    await userEvent.clear(within(form).getByRole("textbox", { name: "Explanation" }));
    await userEvent.type(within(form).getByRole("textbox", { name: "Explanation" }), "Corrects bit flips.");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));

    // Assert
    await waitFor(() => expect(within(region).queryByRole("form")).toBeNull());
    expect(within(region).getByRole("button", { name: /^ECC/ }).closest("li")).toHaveTextContent("Corrects bit flips.");
    expect((await client.listTerms(NAS_ROOT_ID)).terms.find((term) => term.term === "ECC")?.explanation).toBe("Corrects bit flips.");
  });
});

describe("GlossaryPanel: deleting waits five seconds", () => {
  const remove = async (region: HTMLElement, name: string) => {
    await userEvent.click(await within(region).findByRole("button", { name: new RegExp(`^${name}`) }));
    await userEvent.click(within(region).getByRole("button", { name: `Delete “${name}”` }));
  };

  it("hides the term at once with 復原, sends nothing until the wait is over, then deletes it once", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, toast } = await setup();
    const deleteTerm = vi.spyOn(client, "deleteTerm");
    const region = await panel();

    // Act
    await remove(region, "ECC");

    // Assert
    expect(names(region)).toEqual([expect.stringMatching(/^scrub/), expect.stringMatching(/^ZFS/)]);
    expect(toast).toHaveBeenLastCalledWith("Deleted “ECC” from the glossary.", expect.objectContaining({ label: "Undo" }), TERM_DELETE_UNDO_MS);
    // The clock also moves on its own here (`shouldAdvanceTime`), so the check leaves it some room.
    await wait(TERM_DELETE_UNDO_MS - 500);
    expect(deleteTerm).not.toHaveBeenCalled();
    expect((await client.listTerms(NAS_ROOT_ID)).terms).toHaveLength(3);
    await wait(600);
    expect(deleteTerm).toHaveBeenCalledTimes(1);
    await wait(TERM_DELETE_UNDO_MS * 2);
    expect(deleteTerm).toHaveBeenCalledTimes(1);
    expect((await client.listTerms(NAS_ROOT_ID)).terms.map((term) => term.term)).toEqual(["scrub", "ZFS"]);
  });

  it("復原 brings it back and nothing is ever sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, toast } = await setup();
    const deleteTerm = vi.spyOn(client, "deleteTerm");
    const region = await panel();
    await remove(region, "ECC");
    await wait(TERM_DELETE_UNDO_MS - 500);
    act(() => toast.mock.calls.at(-1)?.[1]?.run());
    expect(toast).toHaveBeenLastCalledWith("Restored.");
    expect(names(region)).toHaveLength(3);
    await wait(TERM_DELETE_UNDO_MS * 3);
    expect(deleteTerm).not.toHaveBeenCalled();
  });

  it("two deletes within the wait share one toast, and its 復原 brings both back", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, toast } = await setup();
    const deleteTerm = vi.spyOn(client, "deleteTerm");
    const region = await panel();
    await remove(region, "ECC");
    await wait(3000);

    // Act
    await remove(region, "scrub");

    // Assert
    expect(toast).toHaveBeenLastCalledWith("Deleted 2 terms from the glossary.", expect.objectContaining({ label: "Undo" }), TERM_DELETE_UNDO_MS);
    expect(waitingTermDeletes().map((term) => term.term).sort()).toEqual(["ECC", "scrub"]);
    await wait(TERM_DELETE_UNDO_MS - 500);
    // The first one's wait started again with the second.
    expect(deleteTerm).not.toHaveBeenCalled();
    act(() => toast.mock.calls.at(-1)?.[1]?.run());
    expect(names(region)).toHaveLength(3);
    await wait(TERM_DELETE_UNDO_MS * 2);
    expect(deleteTerm).not.toHaveBeenCalled();
  });

  it("keeps waiting when the panel goes away (another tab of the side panel) and still deletes once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, view } = await setup();
    const deleteTerm = vi.spyOn(client, "deleteTerm");
    await remove(await panel(), "ECC");
    view.unmount();
    await wait(TERM_DELETE_UNDO_MS);
    expect(deleteTerm).toHaveBeenCalledTimes(1);
  });

  it("a refused delete brings the term back and says why", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, toast } = await setup();
    const region = await panel();
    await remove(region, "ECC");
    await client.archiveLine(NAS_ROOT_ID);

    // Act
    await wait(TERM_DELETE_UNDO_MS);

    // Assert
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("This conversation is archived, so its glossary cannot change."));
    await waitFor(() => expect(names(region)).toHaveLength(3));
  });
});
