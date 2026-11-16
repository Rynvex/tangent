import type { TermSearchHit } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import AskedBeforeChip, { ASKED_BEFORE_DEBOUNCE_MS, AskedBeforeDialog } from "./asked-before";

/** F19 §2.4: 「之前問過」 for words another conversation's glossary already explains. */

const clients: MockTangentClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
  vi.useRealTimers();
});

/** A mock with "MVCC" explained in another conversation ("資料庫筆記"). */
async function setup(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  clients.push(client);
  const other = await client.createLine({ title: "資料庫筆記" });
  const made = await client.createTerm(other.id, { term: "MVCC", explanation: "多版本並行控制：讀不擋寫。" });
  return { client, other, hit: { ...made.term, rootTitle: "資料庫筆記" } satisfies TermSearchHit };
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(ASKED_BEFORE_DEBOUNCE_MS + 20));

describe("AskedBeforeChip", () => {
  it("looks the selection up once it has rested, and names the conversation that explained it", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, hit } = await setup();
    const searchTerms = vi.spyOn(client, "searchTerms");
    const onOpen = vi.fn();

    // Act
    render(<AskedBeforeChip text=" mvcc " rootLineId={NAS_ROOT_ID} onOpen={onOpen} />, { wrapper: tangentWrapper(client) });

    // Assert: nothing is sent before the selection rests.
    expect(searchTerms).not.toHaveBeenCalled();
    await settle();
    const chip = await screen.findByRole("button", { name: "Asked before: 資料庫筆記" });
    expect(searchTerms).toHaveBeenCalledTimes(1);
    expect(searchTerms.mock.calls[0]![0]).toMatchObject({ q: "mvcc" });
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: hit.id, rootTitle: "資料庫筆記" }));
  });

  it("says nothing for a term only this conversation has, or for words no glossary has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, other } = await setup();
    const { rerender } = render(<AskedBeforeChip text="MVCC" rootLineId={other.id} onOpen={vi.fn()} />, { wrapper: tangentWrapper(client) });
    await settle();
    await waitFor(() => expect(vi.getTimerCount()).toBeGreaterThanOrEqual(0));
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<AskedBeforeChip text="nothing known" rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is not sent for a selection over 60 characters or of more than one line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = await setup();
    const searchTerms = vi.spyOn(client, "searchTerms");
    const { rerender } = render(<AskedBeforeChip text={"字".repeat(61)} rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />, { wrapper: tangentWrapper(client) });
    await settle();
    rerender(<AskedBeforeChip text={"MVCC\nand more"} rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />);
    await settle();
    expect(searchTerms).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("only looks up what the selection settles on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = await setup();
    const searchTerms = vi.spyOn(client, "searchTerms");
    const { rerender } = render(<AskedBeforeChip text="M" rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />, { wrapper: tangentWrapper(client) });
    for (const text of ["MV", "MVC", "MVCC"]) rerender(<AskedBeforeChip text={text} rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />);
    await settle();
    await screen.findByRole("button", { name: /^Asked before/ });
    expect(searchTerms.mock.calls.map(([query]) => query?.q)).toEqual(["MVCC"]);
  });

  it("shows nothing, and throws nothing, when the lookup fails or the feature is off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = await setup();
    vi.spyOn(client, "searchTerms").mockRejectedValue(new Error("offline"));
    render(<AskedBeforeChip text="MVCC" rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />, { wrapper: tangentWrapper(client) });
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    const off = mockClient({ scenario: nasScenario({ features: "core" }) });
    clients.push(off);
    render(<AskedBeforeChip text="MVCC" rootLineId={NAS_ROOT_ID} onOpen={vi.fn()} />, { wrapper: tangentWrapper(off) });
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AskedBeforeDialog", () => {
  it("shows what was said then, and copies the term to this conversation's glossary from the line on screen", async () => {
    // Arrange
    const { client, hit } = await setup();
    const onCopied = vi.fn();
    const onOpenChange = vi.fn();
    render(<AskedBeforeDialog open onOpenChange={onOpenChange} hit={hit} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} messageId="nas-m17" onCopied={onCopied} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog", { name: "You asked about “MVCC” before" });
    expect(dialog).toHaveTextContent("In “資料庫筆記”");
    expect(dialog).toHaveTextContent("多版本並行控制：讀不擋寫。");

    // Act
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy to this conversation's glossary" }));

    // Assert
    await waitFor(() => expect(onCopied).toHaveBeenCalledOnce());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((await client.listTerms(NAS_ROOT_ID)).terms).toEqual([expect.objectContaining({ term: "MVCC", explanation: "多版本並行控制：讀不擋寫。", sourceLineId: NAS_ROOT_ID, sourceMessageId: "nas-m17" })]);
  });

  it("offers no copy when this conversation already has the term, or to a viewer", async () => {
    const { client, hit } = await setup();
    await client.createTerm(NAS_ROOT_ID, { term: "mvcc", explanation: "mine" });
    const { rerender } = render(<AskedBeforeDialog open onOpenChange={vi.fn()} hit={hit} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} onCopied={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("This conversation's glossary already has it.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Copy to/ })).toBeNull();
    rerender(<AskedBeforeDialog open onOpenChange={vi.fn()} hit={{ ...hit, term: "WAL", termKey: "wal" }} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} readOnly onCopied={vi.fn()} />);
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: /^Copy to/ })).toBeNull();
  });
});
