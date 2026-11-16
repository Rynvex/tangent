// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageFocus } from "./focus";

function conversation(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = '<div data-message-id="m1"></div><div data-message-id="m2"></div>';
  const rows = [...root.querySelectorAll<HTMLElement>("[data-message-id]")];
  rows.forEach((row) => {
    row.scrollIntoView = vi.fn();
  });
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.useRealTimers());

describe("useMessageFocus", () => {
  it("jumps at once the first time and smoothly after that", () => {
    const root = conversation();
    const { rerender } = renderHook(({ focus }) => useMessageFocus({ current: root }, focus, true), { initialProps: { focus: { messageId: "m1", n: 1 } } });
    const [m1, m2] = [...root.querySelectorAll<HTMLElement>("[data-message-id]")];
    expect(m1!.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });

    rerender({ focus: { messageId: "m2", n: 2 } });
    expect(m2!.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("highlights the message for a moment", () => {
    const root = conversation();
    const ref = { current: root };
    const request = { messageId: "m1", n: 1 };
    const { result } = renderHook(() => useMessageFocus(ref, request, true));
    expect(result.current).toBe("m1");
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBeNull();
  });

  it("tells the caller it jumped, so the bottom-following scroller lets go", () => {
    const root = conversation();
    const ref = { current: root };
    const request = { messageId: "m2", n: 1 };
    const onJump = vi.fn();
    renderHook(() => useMessageFocus(ref, request, true, onJump));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("waits until the messages are ready", () => {
    const root = conversation();
    renderHook(() => useMessageFocus({ current: root }, { messageId: "m1", n: 1 }, false));
    expect(root.querySelector<HTMLElement>("[data-message-id]")!.scrollIntoView).not.toHaveBeenCalled();
  });
});
