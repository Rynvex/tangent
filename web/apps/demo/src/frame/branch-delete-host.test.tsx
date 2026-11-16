// @vitest-environment jsdom
import { TangentError, type TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "@tangent/client/testing";
import { TangentProvider, useBranches } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchDeleteHost, type BranchDeleteRequest } from "./branch-delete-host";
import type { ToastAction } from "./hooks";
import { DELETE_UNDO_MS } from "./pending-deletes";

/**
 * F18 §2.1 / §2.3: 丟掉 and a childless 刪除支線 wait five seconds with an
 * undo and are sent exactly once, whatever ends the wait; a branch with
 * branches under it is confirmed first.
 */

const mocks: MockTangentClient[] = [];
beforeEach(() => {
  // The clock moves on its own too, so `waitFor` keeps polling; the waits are jumped over by hand.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  vi.useRealTimers();
});

interface Spies {
  onGone: ReturnType<typeof vi.fn<(lineIds: readonly string[]) => void>>;
  navigate: ReturnType<typeof vi.fn<(lineId: string) => void>>;
  toast: ReturnType<typeof vi.fn<(message: string, action?: ToastAction, durationMs?: number) => void>>;
}

/** The frame's part: the outline as it reads it (asides included), handed to the host. */
function Frame({ request, rootId, spies }: { request: BranchDeleteRequest | null; rootId: string | null; spies: Spies }) {
  const outline = useBranches(rootId, true);
  return (
    <>
      <ul aria-label="outline">
        {outline.data?.branches.map((branch) => (
          <li key={branch.lineId}>{branch.lineId}</li>
        ))}
      </ul>
      {/* Mounted with the first request, as the frame does (it loads the host on first use). */}
      {request && <BranchDeleteHost request={request} rootId={rootId} outline={outline.data?.branches ?? []} onGone={spies.onGone} navigate={spies.navigate} toast={spies.toast} />}
    </>
  );
}

async function setup({ strict = false }: { strict?: boolean } = {}) {
  const client = createMockTangentClient({ latencyMs: 0 });
  mocks.push(client);
  const spies: Spies = { onGone: vi.fn(), navigate: vi.fn(), toast: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const deleteBranch = vi.spyOn(client, "deleteBranch");
  const Mode = strict ? StrictMode : Fragment;
  const tree = (request: BranchDeleteRequest | null, rootId: string | null = NAS_ROOT_ID) => (
    <Mode>
      <QueryClientProvider client={queryClient}>
        <TangentProvider client={client as TangentClient} locale="en">
          <Frame request={request} rootId={rootId} spies={spies} />
        </TangentProvider>
      </QueryClientProvider>
    </Mode>
  );
  const view = render(tree(null));
  await waitFor(() => expect(shown()).toContain("nas-b4"));
  let n = 0;
  const ask = (lineId: string, rootId: string | null = NAS_ROOT_ID) => {
    n += 1;
    act(() => view.rerender(tree({ lineId, n }, rootId)));
    return { lineId, n };
  };
  const show = (request: BranchDeleteRequest | null, rootId: string | null) => act(() => view.rerender(tree(request, rootId)));
  /** The outline read again (this frame has no event stream to tell it). */
  const reload = () => act(() => queryClient.invalidateQueries());
  return { client, spies, deleteBranch, ask, show, view, reload };
}

/** The outline's lines (read from the DOM directly: behind an open dialog it is hidden from the accessibility tree). */
const shown = () => [...document.querySelectorAll('ul[aria-label="outline"] > li')].map((item) => item.textContent);
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** The last toast's action (復原). */
const lastAction = (spies: Spies) => spies.toast.mock.calls.at(-1)?.[1];

describe("two deletes within the wait share one toast and one undo (追加 B.3)", () => {
  it("the second toast counts both, and its 復原 brings both back; nothing is ever sent", async () => {
    // Arrange
    const { spies, deleteBranch, ask } = await setup();
    ask("nas-b4");
    await wait(3000);

    // Act
    ask("nas-b5");

    // Assert
    expect(spies.toast).toHaveBeenLastCalledWith("Deleted 2 branches.", expect.objectContaining({ label: "Undo" }), DELETE_UNDO_MS);
    expect(shown()).not.toContain("nas-b4");
    expect(shown()).not.toContain("nas-b5");
    await wait(DELETE_UNDO_MS - 100);
    // The first one's wait started again with the second: it is still undoable now.
    expect(deleteBranch).not.toHaveBeenCalled();
    act(() => lastAction(spies)?.run());
    expect(shown()).toEqual(expect.arrayContaining(["nas-b4", "nas-b5"]));
    expect(spies.toast).toHaveBeenLastCalledWith("2 back again.");
    await wait(DELETE_UNDO_MS * 3);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("without an undo both are sent, once each, five seconds after the second", async () => {
    const { deleteBranch, ask } = await setup();
    ask("nas-b4");
    await wait(3000);
    ask("nas-b5");
    await wait(DELETE_UNDO_MS - 1);
    expect(deleteBranch).not.toHaveBeenCalled();
    await wait(1);
    expect(deleteBranch.mock.calls.map(([lineId]) => lineId).sort()).toEqual(["nas-b4", "nas-b5"]);
    await wait(DELETE_UNDO_MS * 2);
    expect(deleteBranch).toHaveBeenCalledTimes(2);
  });

  it("two asides read 已丟掉 2 則順口問, and the first toast's own undo still takes back what it spoke for", async () => {
    // Arrange
    const { client, spies, deleteBranch, ask, reload } = await setup();
    const second = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "another quick one", kind: "aside" });
    await client.sendMessage(second.line.id, { content: "another quick one" });
    await waitFor(async () => expect((await client.getBranch(second.line.id)).branch.status).not.toBe("open"));
    await reload();
    await waitFor(() => expect(shown()).toContain(second.line.id));

    // Act
    ask("nas-b1a");
    const firstUndo = lastAction(spies);
    ask(second.line.id);

    // Assert
    expect(spies.toast).toHaveBeenLastCalledWith("2 quick questions thrown away.", expect.objectContaining({ label: "Undo" }), DELETE_UNDO_MS);
    act(() => firstUndo?.run());
    expect(shown()).toContain("nas-b1a");
    expect(shown()).not.toContain(second.line.id);
    expect(spies.toast).toHaveBeenLastCalledWith("Back again.");
    await wait(DELETE_UNDO_MS);
    expect(deleteBranch.mock.calls.map(([lineId]) => lineId)).toEqual([second.line.id]);
  });
});

describe("a branch with nothing under it: hidden, then sent after five seconds", () => {
  it("hides it at once with an undo, sends nothing until the wait is over, then sends once", async () => {
    const { spies, deleteBranch, ask, client } = await setup();
    ask("nas-b4");
    expect(shown()).not.toContain("nas-b4");
    expect(spies.onGone).toHaveBeenCalledWith(["nas-b4"]);
    expect(spies.toast).toHaveBeenCalledWith("Deleted branch “二手企業碟可不可靠”.", expect.objectContaining({ label: "Undo" }), DELETE_UNDO_MS);
    await wait(DELETE_UNDO_MS - 1);
    expect(deleteBranch).not.toHaveBeenCalled();
    // Still there on the server: nothing was sent.
    expect((await client.getBranch("nas-b4")).branch.lineId).toBe("nas-b4");
    await wait(1);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith("nas-b4", undefined);
    await wait(DELETE_UNDO_MS * 3);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(shown()).not.toContain("nas-b4");
    await expect(client.getLine("nas-b4")).rejects.toMatchObject({ code: "line_not_found" });
  });

  it("an aside's toast says 已丟掉順口問", async () => {
    const { spies, ask } = await setup();
    ask("nas-b1a");
    expect(spies.toast).toHaveBeenCalledWith("Quick question thrown away.", expect.objectContaining({ label: "Undo" }), DELETE_UNDO_MS);
  });

  it("復原 within the wait brings it back and nothing is ever sent", async () => {
    const { spies, deleteBranch, ask } = await setup();
    ask("nas-b4");
    await wait(DELETE_UNDO_MS - 100);
    act(() => lastAction(spies)?.run());
    expect(shown()).toContain("nas-b4");
    expect(spies.toast).toHaveBeenLastCalledWith("Back again.");
    await wait(DELETE_UNDO_MS * 3);
    expect(deleteBranch).not.toHaveBeenCalled();
    // Asked again after the undo: a new wait of its own.
    ask("nas-b4");
    expect(shown()).not.toContain("nas-b4");
    await wait(DELETE_UNDO_MS);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("復原 after it was sent does nothing (no second request, no false 「已復原」)", async () => {
    const { spies, deleteBranch, ask } = await setup();
    ask("nas-b4");
    const undo = lastAction(spies);
    await wait(DELETE_UNDO_MS);
    spies.toast.mockClear();
    act(() => undo?.run());
    expect(spies.toast).not.toHaveBeenCalled();
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(shown()).not.toContain("nas-b4");
  });

  it("the frame showing another conversation sends it at once, and the timer sends nothing after", async () => {
    const { deleteBranch, ask, show } = await setup();
    const request = ask("nas-b4");
    await wait(1000);
    show(request, "osaka");
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith("nas-b4", undefined);
    await wait(DELETE_UNDO_MS * 2);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("staying in the same conversation (another line of it on screen) keeps waiting", async () => {
    const { deleteBranch, ask, show } = await setup();
    const request = ask("nas-b4");
    show(request, NAS_ROOT_ID);
    await wait(DELETE_UNDO_MS - 1);
    expect(deleteBranch).not.toHaveBeenCalled();
    await wait(1);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("unmounting sends what is waiting, once", async () => {
    const { deleteBranch, ask, view } = await setup();
    ask("nas-b4");
    ask("nas-b5");
    view.unmount();
    // A microtask later (see the StrictMode test below).
    await Promise.resolve();
    expect(deleteBranch.mock.calls.map(([lineId]) => lineId).sort()).toEqual(["nas-b4", "nas-b5"]);
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2);
    expect(deleteBranch).toHaveBeenCalledTimes(2);
  });

  it("the page going away sends it at once, marked to outlive the page, and not again on unmount or by the timer", async () => {
    const { deleteBranch, ask, view } = await setup();
    ask("nas-b4");
    await wait(2000);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith("nas-b4", { keepalive: true });
    await wait(DELETE_UNDO_MS);
    view.unmount();
    await Promise.resolve();
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode (development's double mount) the first delete still waits, and its undo works", async () => {
    const { spies, deleteBranch, ask } = await setup({ strict: true });
    // The host mounts with this very request, as in the frame: its effects are set up, cleaned up and set up again.
    ask("nas-b4");
    await wait(0);
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(shown()).not.toContain("nas-b4");
    expect(spies.toast).toHaveBeenCalledTimes(1);
    await wait(DELETE_UNDO_MS - 1);
    expect(deleteBranch).not.toHaveBeenCalled();
    act(() => lastAction(spies)?.run());
    expect(shown()).toContain("nas-b4");
    await wait(DELETE_UNDO_MS * 2);
    expect(deleteBranch).not.toHaveBeenCalled();
    ask("nas-b5");
    await wait(DELETE_UNDO_MS);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith("nas-b5", undefined);
  });

  it("asking twice for the same branch while it waits changes nothing: one wait, one request", async () => {
    const { spies, deleteBranch, ask } = await setup();
    ask("nas-b4");
    await wait(3000);
    // It is hidden, so the outline no longer offers it; a stale ask is ignored.
    ask("nas-b4");
    expect(spies.toast).toHaveBeenCalledTimes(1);
    await wait(2000);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    await wait(DELETE_UNDO_MS);
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("a refusal brings the branch back and says why", async () => {
    const { spies, deleteBranch, ask } = await setup();
    deleteBranch.mockRejectedValueOnce(new TangentError(409, "this branch cannot be deleted", "branch_not_deletable"));
    ask("nas-b4");
    await wait(DELETE_UNDO_MS);
    await waitFor(() => expect(shown()).toContain("nas-b4"));
    expect(spies.toast).toHaveBeenLastCalledWith("This branch cannot be deleted (only an answered quick question or a branch that was not brought back).", undefined);
  });

  it("already gone on the server (cleared, or deleted elsewhere) is what was asked for: no error, it stays gone", async () => {
    const { spies, deleteBranch, ask } = await setup();
    deleteBranch.mockRejectedValueOnce(new TangentError(404, "line nas-b4 not found", "line_not_found"));
    ask("nas-b4");
    await wait(DELETE_UNDO_MS);
    expect(spies.toast).toHaveBeenCalledTimes(1);
    expect(shown()).not.toContain("nas-b4");
  });
});

describe("a branch with branches under it: confirmed first, deleted at once", () => {
  /** nas-b2 not brought back, with one branch under it (ended too, unless `open`). */
  async function withChild(client: MockTangentClient, open = false) {
    const anchor = client.mock.snapshot().messages.find((message) => message.lineId === "nas-b2")!.id;
    const child = await client.createBranch("nas-b2", { anchorMessageId: anchor, purpose: "Glacier pricing", kind: "investigate" });
    if (!open) await client.discardBranch(child.line.id);
    await client.discardBranch("nas-b2");
    return child.line.id;
  }

  it("says how many go with it, starts on 取消, and deletes only when confirmed", async () => {
    const { client, spies, deleteBranch, ask, reload } = await setup();
    const child = await withChild(client);
    await reload();
    await waitFor(() => expect(shown()).toContain(child));
    ask("nas-b2");
    const dialog = await screen.findByRole("dialog", { name: /Delete branch “改用雲端備份/ });
    expect(dialog).toHaveTextContent("1 branch(es) under it are deleted with it.");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Nothing hidden, nothing waiting: it has not been confirmed.
    expect(shown()).toContain("nas-b2");
    await wait(DELETE_UNDO_MS * 2);
    expect(deleteBranch).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete branch" }));
    await waitFor(() => expect(spies.onGone).toHaveBeenCalledWith(["nas-b2", child]));
    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(spies.toast).toHaveBeenLastCalledWith(expect.stringMatching(/^Deleted branch “改用雲端備份.*” and 1 under it\.$/));
    await waitFor(() => expect(shown()).not.toContain("nas-b2"));
    expect(shown()).not.toContain(child);
  });

  it("cancelling deletes nothing", async () => {
    const { client, deleteBranch, ask, reload } = await setup();
    const child = await withChild(client);
    await reload();
    await waitFor(() => expect(shown()).toContain(child));
    ask("nas-b2");
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await wait(DELETE_UNDO_MS * 2);
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(shown()).toContain("nas-b2");
  });

  it("refused because a branch under it is still in progress: says so and offers the way there", async () => {
    const { client, spies, ask, reload } = await setup();
    const child = await withChild(client, true);
    await reload();
    await waitFor(() => expect(shown()).toContain(child));
    ask("nas-b2");
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete branch" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("A branch under it is still in progress.");
    expect(spies.onGone).not.toHaveBeenCalled();
    await userEvent.click(within(alert).getByRole("button", { name: "Go to “Glacier pricing”" }));
    expect(spies.navigate).toHaveBeenCalledWith(child);
    expect((await client.getBranch("nas-b2")).branch.lineId).toBe("nas-b2");
  });
});
