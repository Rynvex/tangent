// @vitest-environment jsdom
/** F14 S4 in the frame: after an import, where it goes, the panel or the phone's banner, and 復原這次匯入 (decision #8, F14.1: 10 minutes, across a reload). */
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useF13Frame } from "../f13-frame";
import { ImportedBanner } from "../f13-host";
import { IMPORT_UNDO_MS, readLastImport, rememberLastImport } from "./last-import";
import { undoText } from "./undo-words";
import type { ImportOutcome } from "./outcome";

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

const outcome = (over: Partial<ImportOutcome> = {}): ImportOutcome => ({
  lineIds: ["l1", "l2"],
  focusLineId: "l1",
  messageCount: 54,
  decompose: true,
  assembled: true,
  toast: "已匯入：2 條主線、3 個章節、2 條支線與結論卡",
  undo: { label: "復原這次匯入", run: vi.fn().mockResolvedValue("已復原：這次匯入的 2 條主線已刪除") },
  ...over,
});

function providers() {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  mocks.push(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="zh-TW">
        {children}
      </TangentProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

function setup(narrow: boolean, selected: string | null = "before") {
  const navigate = vi.fn();
  const toast = vi.fn();
  const { client, wrapper } = providers();
  const hook = renderHook(({ selected: on }) => useF13Frame({ selected: on, navigate, closeList: () => undefined, toast, narrow }), { initialProps: { selected }, wrapper });
  return { hook, navigate, toast, client };
}

describe("an import's outcome in the frame", () => {
  it("goes to the new line, opens the panel on desktop and shows the toast with its undo for 15 s", () => {
    const { hook, navigate, toast } = setup(false);
    // The frame's navigate moves the screen in the same update.
    act(() => {
      hook.result.current.onImported(outcome());
      hook.rerender({ selected: "l1" });
    });
    expect(navigate).toHaveBeenCalledWith("l1");
    expect(hook.result.current.decomposeShown).toBe(true);
    expect(hook.result.current.importedHere).toEqual({ lineId: "l1", count: 54, assembled: true });
    expect(hook.result.current.importUndo?.label).toBe("復原這次匯入");
    expect(toast).toHaveBeenCalledWith("已匯入：2 條主線、3 個章節、2 條支線與結論卡", expect.objectContaining({ label: "復原這次匯入" }), 15_000);
  });

  it("does not cover a phone with the panel: the banner offers it instead", () => {
    const { hook } = setup(true);
    // The frame's navigate moves the screen in the same update.
    act(() => {
      hook.result.current.onImported(outcome());
      hook.rerender({ selected: "l1" });
    });
    expect(hook.result.current.decomposeShown).toBe(false);
    expect(hook.result.current.importedHere?.assembled).toBe(true);
  });

  it("undoes: back to the line on screen before, the lines deleted, and says so", async () => {
    const { hook, navigate, toast } = setup(false);
    const done = outcome();
    act(() => {
      hook.result.current.onImported(done);
      hook.rerender({ selected: "l1" });
    });
    const action = toast.mock.calls[0]![1] as { run: () => void };
    await act(async () => action.run());
    expect(navigate).toHaveBeenLastCalledWith("before");
    expect(done.undo.run).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenLastCalledWith("已復原：這次匯入的 2 條主線已刪除");
    expect(hook.result.current.importedHere).toBeNull();
    expect(hook.result.current.importUndo).toBeNull();
    expect(readLastImport()).toBeNull();
    // A second press (the banner's, or the toast again) does nothing.
    await act(async () => action.run());
    expect(done.undo.run).toHaveBeenCalledOnce();
  });
});

describe("復原這次匯入 for 10 minutes (F14.1, sessionStorage)", () => {
  it("says so when the undo fails", async () => {
    const { hook, toast } = setup(false);
    act(() => {
      hook.result.current.onImported(outcome({ undo: { label: "復原這次匯入", run: vi.fn().mockRejectedValue(new Error("offline")) } }));
      hook.rerender({ selected: "l1" });
    });
    await act(async () => hook.result.current.importUndo!.run());
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("有 2 條主線沒有刪掉，請從清單刪除。"));
  });

  it("says which lines stay because they were attached into another conversation since (B20)", async () => {
    // Arrange: two imported conversations; one is then attached into a conversation outside the import.
    const { client, wrapper } = providers();
    const made = await Promise.all(["甲", "乙"].map((title) => client.importConversation({ title, messages: [{ role: "user", content: `${title}？` }, { role: "assistant", content: "好" }] })));
    const [a, b] = made.map((result) => result.line.id) as [string, string];
    rememberLastImport({ lineIds: [a, b], focusLineId: b, beforeLineId: null, messageCount: 4, assembled: false, importedAt: Date.now() });
    await client.attachLine("nas", { sourceLineId: a });
    const toast = vi.fn();
    const hook = renderHook(() => useF13Frame({ selected: b, navigate: vi.fn(), closeList: () => undefined, toast, narrow: false }), { wrapper });
    // Act
    await act(async () => hook.result.current.importUndo!.run());
    // Assert
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("已復原：這次匯入的 1 條主線已刪除；1 條已併入其他對話，保留在那裡"));
    expect((await client.getLine(a)).conversationBranch?.rootLineId).toBe("nas");
  });

  it("words an undo: failed first, then kept, else deleted", () => {
    const u = (key: string, params?: Record<string, number>) => `${key}:${JSON.stringify(params)}`;
    expect(undoText({ deleted: ["a"], kept: ["b"], failed: ["c"] }, u)).toBe('done.undoFailed:{"n":1}');
    expect(undoText({ deleted: ["a"], kept: ["b"], failed: [] }, u)).toBe('done.undoneKept:{"n":1,"m":1}');
    expect(undoText({ deleted: ["a", "b"], kept: [], failed: [] }, u)).toBe('done.undone:{"n":2}');
  });

  it("ignores a stored record that is not one", () => {
    window.sessionStorage.setItem("tangent.f14.lastImport", JSON.stringify({ lineIds: [], focusLineId: "l1", beforeLineId: null, messageCount: 1, assembled: false, importedAt: Date.now() }));
    expect(readLastImport()).toBeNull();
    window.sessionStorage.setItem("tangent.f14.lastImport", "{not json");
    expect(readLastImport()).toBeNull();
  });

  it("keeps the import in sessionStorage and, after a reload, brings the banner and its undo back on its lines", async () => {
    // Arrange: an import that made two of the scenario's conversations, then a reload on one of them.
    const first = setup(false);
    act(() => {
      first.hook.result.current.onImported(outcome({ lineIds: ["rust", "okr"], focusLineId: "rust" }));
    });
    expect(readLastImport()).toMatchObject({ lineIds: ["rust", "okr"], focusLineId: "rust", beforeLineId: "before", messageCount: 54, assembled: true });
    first.hook.unmount();
    // Act
    const { hook, navigate, toast, client } = setup(false, "okr");
    // Assert
    expect(hook.result.current.importedHere).toEqual({ lineId: "okr", count: 54, assembled: true });
    expect(hook.result.current.importUndo).not.toBeNull();
    await act(async () => hook.result.current.importUndo!.run());
    expect(navigate).toHaveBeenCalledWith("before");
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith("已復原：這次匯入的 2 條主線已刪除"));
    expect((await client.listLines()).lines.map((line) => line.id)).not.toContain("rust");
    expect(readLastImport()).toBeNull();
  });

  it("forgets an import older than 10 minutes and one whose banner was closed", () => {
    rememberLastImport({ lineIds: ["l1"], focusLineId: "l1", beforeLineId: null, messageCount: 3, assembled: false, importedAt: Date.now() - IMPORT_UNDO_MS - 1 });
    expect(setup(false, "l1").hook.result.current.importedHere).toBeNull();
    expect(window.sessionStorage.getItem("tangent.f14.lastImport")).toBeNull();
    const { hook } = setup(false, "before");
    act(() => {
      hook.result.current.onImported(outcome());
      hook.rerender({ selected: "l1" });
    });
    act(() => hook.result.current.dismissImported());
    expect(hook.result.current.importedHere).toBeNull();
    hook.unmount();
    expect(setup(false, "l1").hook.result.current.importedHere).toBeNull();
  });

  it("hides the undo once the 10 minutes are over", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { hook } = setup(false);
    act(() => {
      hook.result.current.onImported(outcome());
      hook.rerender({ selected: "l1" });
    });
    expect(hook.result.current.importUndo).not.toBeNull();
    act(() => vi.advanceTimersByTime(IMPORT_UNDO_MS + 1));
    expect(hook.result.current.importUndo).toBeNull();
    expect(hook.result.current.importedHere).not.toBeNull();
  });
});

describe("ImportedBanner", () => {
  it("offers 復原這次匯入 beside the suggestions while the import can be undone", async () => {
    const { wrapper } = providers();
    const onUndo = vi.fn();
    render(<ImportedBanner lineId="rust" messageCount={4} panelOpen={false} narrow={false} onOpen={() => undefined} onClose={() => undefined} onUndo={onUndo} undoLabel="復原這次匯入" />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "復原這次匯入" }));
    expect(onUndo).toHaveBeenCalledOnce();
    cleanup();
    render(<ImportedBanner lineId="rust" messageCount={4} panelOpen={false} narrow={false} onOpen={() => undefined} onClose={() => undefined} />, { wrapper });
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "復原這次匯入" })).toBeNull();
  });
});
