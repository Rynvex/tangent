// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigation, useShownLineInAddress } from "./navigation";

function go(url: string) {
  window.history.replaceState(null, "", url);
}
const search = () => window.location.search;

/** The history entries this test added, by pushState calls. */
let push: ReturnType<typeof vi.spyOn>;
let replace: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  go("/");
  push = vi.spyOn(window.history, "pushState");
  replace = vi.spyOn(window.history, "replaceState");
});
afterEach(() => vi.restoreAllMocks());

const open = (initial: { line: string | null; message: string | null } = { line: null, message: null }) => renderHook(() => useNavigation(initial));

describe("useNavigation", () => {
  it("starts from the address and writes no history entry", () => {
    go("/?line=okr&m=okr-m2");
    push.mockClear();
    replace.mockClear();
    const { result } = open({ line: "okr", message: "okr-m2" });
    expect(result.current.current).toBe("okr");
    expect(result.current.focus?.messageId).toBe("okr-m2");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("pushes an entry when the line changes", () => {
    const { result } = open();
    act(() => result.current.navigate("nas-b1"));
    expect(push).toHaveBeenCalledTimes(1);
    expect(search()).toBe("?line=nas-b1");
    expect(result.current.current).toBe("nas-b1");
    expect(result.current.focus).toBeNull();
  });

  it("replaces the entry when only the message changes", () => {
    go("/?line=nas&lang=zh-TW");
    const { result } = open({ line: "nas", message: null });
    push.mockClear();
    replace.mockClear();
    act(() => result.current.navigate("nas", "nas-m5"));
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(search()).toBe("?line=nas&lang=zh-TW&m=nas-m5");
    expect(result.current.focus?.messageId).toBe("nas-m5");
  });

  it("pushes the line and carries the message to the new line", () => {
    const { result } = open();
    act(() => result.current.navigate("nas-b1", "nas-b1-3"));
    expect(push).toHaveBeenCalledTimes(1);
    expect(search()).toBe("?line=nas-b1&m=nas-b1-3");
  });

  it("writes nothing when the address already says so", () => {
    go("/?line=nas&m=nas-m5");
    const { result } = open({ line: "nas", message: "nas-m5" });
    push.mockClear();
    replace.mockClear();
    act(() => result.current.navigate("nas", "nas-m5"));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("asks for the same message again each time (the focus counter moves)", () => {
    const { result } = open({ line: "nas", message: null });
    act(() => result.current.navigate("nas", "nas-m5"));
    const first = result.current.focus;
    act(() => result.current.navigate("nas", "nas-m5"));
    expect(result.current.focus?.n).toBeGreaterThan(first?.n ?? 0);
  });

  it("keeps the other parameters on every write", () => {
    go("/?frame=embed&focus=1");
    const { result } = open();
    act(() => result.current.navigate("okr", "okr-m1"));
    expect(search()).toBe("?frame=embed&focus=1&line=okr&m=okr-m1");
  });

  it("replace() swaps the line without a new entry, and drops the message", () => {
    go("/?line=gone&m=gone-m1");
    const { result } = open({ line: "gone", message: "gone-m1" });
    push.mockClear();
    act(() => result.current.replace("nas"));
    expect(push).not.toHaveBeenCalled();
    expect(search()).toBe("?line=nas");
    expect(result.current.current).toBe("nas");
    expect(result.current.focus).toBeNull();
  });

  it("clear() goes back to the default without a new entry", () => {
    go("/?line=gone&theme=dark");
    const { result } = open({ line: "gone", message: null });
    push.mockClear();
    act(() => result.current.clear());
    expect(push).not.toHaveBeenCalled();
    expect(search()).toBe("?theme=dark");
    expect(result.current.current).toBeNull();
  });

  it("follows back and forward without writing history itself", async () => {
    const { result } = open();
    act(() => result.current.navigate("nas-b1", "nas-b1-3"));
    act(() => result.current.navigate("nas-b2"));
    push.mockClear();
    replace.mockClear();

    act(() => window.history.back());
    await waitFor(() => expect(result.current.current).toBe("nas-b1"));
    expect(result.current.focus?.messageId).toBe("nas-b1-3");

    act(() => window.history.back());
    await waitFor(() => expect(result.current.current).toBeNull());
    expect(result.current.focus).toBeNull();

    act(() => window.history.forward());
    await waitFor(() => expect(result.current.current).toBe("nas-b1"));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stops listening for popstate when it unmounts", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = open();
    unmount();
    expect(remove).toHaveBeenCalledWith("popstate", expect.any(Function));
  });
});

describe("useShownLineInAddress", () => {
  it("writes the line shown by default into the address, replacing the entry", () => {
    go("/?frame=app");
    push.mockClear();
    renderHook(() => useShownLineInAddress("okr"));
    expect(push).not.toHaveBeenCalled();
    expect(search()).toBe("?frame=app&line=okr");
  });

  it("leaves an address that already names the line (and its message) alone", () => {
    go("/?line=okr&m=okr-m2");
    replace.mockClear();
    renderHook(() => useShownLineInAddress("okr"));
    expect(replace).not.toHaveBeenCalled();
    expect(search()).toBe("?line=okr&m=okr-m2");
  });

  it("does nothing while no line is shown", () => {
    go("/?line=okr");
    replace.mockClear();
    renderHook(() => useShownLineInAddress(null));
    expect(replace).not.toHaveBeenCalled();
  });
});
