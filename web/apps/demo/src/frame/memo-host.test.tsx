// @vitest-environment jsdom
import { DEFAULT_MEMO_LIMITS } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemoSaver, type MemoSaverOptions } from "./memo-host";

afterEach(cleanup);

function setup(options: Partial<MemoSaverOptions> = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  const create = vi.spyOn(client, "createMemo");
  const toast = vi.fn();
  const onSaved = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        {children}
      </TangentProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useMemoSaver({ rootLineId: NAS_ROOT_ID, lineId: "nas-b1", enabled: true, toast, onSaved, ...options }), { wrapper });
  return { result, create, toast, onSaved };
}

describe("useMemoSaver (記成備忘 in normal mode, F10)", () => {
  it("writes the memo on the line on screen, says so and lets the frame show it", async () => {
    const { result, create, toast, onSaved } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current!("  my own words  ");
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, { lineId: "nas-b1", text: "my own words" });
    expect(toast).toHaveBeenCalledWith("Saved as a memo (not sent to the AI).");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("cuts a long text to the memo limit, cleanly", async () => {
    const { result, create } = setup();
    await act(async () => {
      await result.current!("字".repeat(DEFAULT_MEMO_LIMITS.maxRunes + 50));
    });
    const text = create.mock.calls[0]![1].text;
    expect(Array.from(text)).toHaveLength(DEFAULT_MEMO_LIMITS.maxRunes);
    expect(text.endsWith("…")).toBe(true);
  });

  it("says why when refused, never rejects, and does not switch the panel", async () => {
    const { result, create, toast, onSaved } = setup();
    create.mockRejectedValueOnce(new Error("offline"));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current!("a thought");
    });
    expect(ok).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Not saved as a memo: /));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("writes nothing for blank text, and is absent while memos are off or the user only reads", async () => {
    const { result, create } = setup();
    await act(async () => {
      expect(await result.current!("   ")).toBe(false);
    });
    expect(create).not.toHaveBeenCalled();
    expect(setup({ enabled: false }).result.current).toBeUndefined();
    expect(setup({ lineId: null }).result.current).toBeUndefined();
  });
});
