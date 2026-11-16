// @vitest-environment jsdom
import { normalizeLine, TangentError, type TangentClient, type TangentEvent } from "@tangent/client";
import { createMockTangentClient } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextConversation, useConversationDeletion, type ConversationDeletionOptions } from "./delete-host";
import { expectedGone } from "./expected-gone";

/** F7: what the frame does when a tree is gone — here, elsewhere or found missing — once per tree. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

const NAS = normalizeLine({ id: "nas", title: "家用 NAS" });
const deleted = (rootLineId: string, lineIds = [rootLineId]) => ({ type: "line.deleted", tenant: "", lineId: rootLineId, rootLineId, data: { rootLineId, lineIds } }) as TangentEvent;

function setup(initial: Partial<ConversationDeletionOptions> = {}) {
  const client = createMockTangentClient({ latencyMs: 0 });
  mocks.push(client);
  const leave = vi.fn();
  const toast = vi.fn();
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        {children}
      </TangentProvider>
    </QueryClientProvider>
  );
  const hook = renderHook((options: ConversationDeletionOptions) => useConversationDeletion(options), {
    wrapper,
    initialProps: { selected: "nas-b2", rootId: "nas", lineError: null, leave, toast, ...initial },
  });
  return { hook, leave, toast };
}

describe("useConversationDeletion (F7)", () => {
  it("leaves the conversation on screen when another tab deletes it, and says so", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.onEvent(deleted("nas", ["nas", "nas-b2"])));
    expect(leave).toHaveBeenCalledTimes(1);
    expect([...leave.mock.calls[0]![0]]).toEqual(["nas", "nas-b2"]);
    expect(toast).toHaveBeenCalledWith("你正在看的對話已被刪除（在別的分頁或裝置上）。");
  });

  it("stays put when another conversation is deleted", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.onEvent(deleted("osaka")));
    expect(leave).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("after its own delete: leaves, names it once, and the event that follows changes nothing", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.request(NAS));
    expect(hook.result.current.dialog).toMatchObject({ open: true, line: { id: "nas" } });
    act(() => hook.result.current.dialog?.onDeleted({ rootLineId: "nas", lineIds: ["nas", "nas-b2"] }, NAS));
    expect(hook.result.current.dialog?.open).toBe(false);
    act(() => hook.result.current.onEvent(deleted("nas", ["nas", "nas-b2"])));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls).toEqual([["已刪除「家用 NAS」。"]]);
  });

  it("its own delete's event may come first: it counts as ours (closes the dialog, one toast)", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.request(NAS));
    act(() => hook.result.current.onEvent(deleted("nas", ["nas", "nas-b2"])));
    expect(hook.result.current.dialog?.open).toBe(false);
    act(() => hook.result.current.dialog?.onDeleted({ rootLineId: "nas", lineIds: ["nas", "nas-b2"] }, NAS));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls).toEqual([["已刪除「家用 NAS」。"]]);
  });

  it("deleting a conversation that is not on screen only names it", () => {
    const { hook, leave, toast } = setup({ selected: "osaka", rootId: "osaka" });
    act(() => hook.result.current.request(NAS));
    act(() => hook.result.current.dialog?.onDeleted({ rootLineId: "nas", lineIds: ["nas"] }, NAS));
    expect(leave).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已刪除「家用 NAS」。");
  });

  it("leaves a line found missing (line_not_found, e.g. after a reconnect missed the event), once", () => {
    const { hook, leave, toast } = setup();
    const missing = new TangentError(404, "line nas-b2 not found", "line_not_found");
    hook.rerender({ selected: "nas-b2", rootId: "nas", lineError: missing, leave, toast });
    hook.rerender({ selected: "nas-b2", rootId: "nas", lineError: missing, leave, toast });
    expect(leave).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("你正在看的對話已被刪除（在別的分頁或裝置上）。");
  });

  it("moves focus on after a delete (the trigger may be gone) and back to the trigger after a cancel", () => {
    document.body.innerHTML = '<nav><button aria-current="page">osaka</button></nav>';
    const { hook } = setup();
    act(() => hook.result.current.request(NAS));
    act(() => hook.result.current.dialog?.onOpenChange(false));
    const finalFocus = () => (hook.result.current.dialog?.finalFocus as (type: "keyboard") => unknown)("keyboard");
    expect(finalFocus()).toBe(true);
    act(() => hook.result.current.request(NAS));
    act(() => hook.result.current.dialog?.onDeleted({ rootLineId: "nas", lineIds: ["nas"] }, NAS));
    expect(finalFocus()).toBe(document.querySelector("nav button"));
  });
});

describe("lines leaving a tree that stays (B23 / F18)", () => {
  /** `line.deleted` for some lines of `nas`: the envelope names the first of them, the data the main line that is left. */
  const linesDeleted = (lineIds: string[]) => ({ type: "line.deleted", tenant: "", lineId: lineIds[0], rootLineId: "nas", data: { rootLineId: "nas", lineIds } }) as TangentEvent;

  it("leaves the branch on screen when it was deleted or cleared elsewhere, and says the branch (not the conversation) is gone", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.onEvent(linesDeleted(["nas-b2", "nas-b2a"])));
    expect(leave).toHaveBeenCalledTimes(1);
    expect([...leave.mock.calls[0]![0]]).toEqual(["nas-b2", "nas-b2a"]);
    expect(toast).toHaveBeenCalledWith("你正在看的支線已經不在了（已刪除或已清除）。");
  });

  it("stays put when the lines that went are not the one on screen, and never treats it as the conversation going", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.onEvent(linesDeleted(["nas-b4"])));
    expect(leave).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    // The tree was not marked as handled: its real delete later still leaves it.
    act(() => hook.result.current.onEvent(deleted("nas", ["nas", "nas-b2"])));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("this page's own delete leaves the line quietly (its host says what happened)", () => {
    const { hook, leave, toast } = setup();
    act(() => hook.result.current.linesGone(["nas-b2"]));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    act(() => hook.result.current.linesGone(["nas-b4"]));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("a line this page is replacing (接著問) is expected to go: no leaving, no toast, for its event and for its failed read", () => {
    const { hook, leave, toast } = setup();
    expectedGone.add("nas-b2");
    try {
      act(() => hook.result.current.onEvent(linesDeleted(["nas-b2"])));
      const missing = new TangentError(404, "line nas-b2 not found", "line_not_found");
      hook.rerender({ selected: "nas-b2", rootId: "nas", lineError: missing, leave, toast });
      expect(leave).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
    } finally {
      expectedGone.delete("nas-b2");
    }
  });
});

describe("nextConversation (F7)", () => {
  const lines = ["a", "b", "c", "d"].map((id) => normalizeLine({ id, title: id }));
  it("takes the one after the deleted conversation, else the one before", () => {
    expect(nextConversation(lines, new Set(["b"]), "b")).toBe("c");
    expect(nextConversation(lines, new Set(["d"]), "d")).toBe("c");
  });
  it("skips lines that went too and falls back to the first left (an archived one was on screen)", () => {
    expect(nextConversation(lines, new Set(["b", "c"]), "b")).toBe("d");
    expect(nextConversation(lines, new Set(["x"]), "x")).toBe("a");
    expect(nextConversation([lines[0]!], new Set(["a"]), "a")).toBeNull();
  });
});
