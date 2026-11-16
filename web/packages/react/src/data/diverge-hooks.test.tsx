import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { useComparisons, useConverge, useDecide, useDiverge } from "./diverge-hooks";
import { useUpdateFold } from "./p3-hooks";
import { useBranches } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 5 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("diverge hooks (D3)", () => {
  it("diverges, compares, and decides; the comparisons and the outline follow", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => ({ outline: useBranches(NAS_ROOT_ID, true), comparisons: useComparisons(NAS_ROOT_ID), diverge: useDiverge(NAS_ROOT_ID), converge: useConverge(NAS_ROOT_ID), decide: useDecide(NAS_ROOT_ID) }),
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.comparisons.data?.comparisons).toEqual([]));
    const anchor = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.role === "assistant" && message.kind === "chat").at(-1)!;
    await act(async () => {
      await result.current.diverge.mutateAsync({ anchorMessageId: anchor.id, count: 2 });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const options = (await client.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge").map((branch) => branch.lineId);
    let id = "";
    await act(async () => {
      id = (await result.current.converge.mutateAsync({ lineIds: options })).comparison.id;
    });
    await waitFor(() => expect(result.current.comparisons.data?.comparisons.map((item) => item.id)).toEqual([id]));
    await waitFor(async () => expect((await client.getComparison(id)).comparison.status).toBe("ready"));
    await act(async () => {
      await result.current.decide.mutateAsync({ comparisonId: id, input: { lineId: options[0]! } });
    });
    await waitFor(() => expect(result.current.comparisons.data?.comparisons[0]?.status).toBe("decided"));
    await waitFor(() => expect(result.current.outline.data?.branches.find((branch) => branch.lineId === options[1])?.status).toBe("discarded"));
  });
});

describe("fold summary edits (D4)", () => {
  it("writes the user's summary", async () => {
    const client = tracked();
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
    const made = await client.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "AI's" });
    const { result } = renderHook(() => useUpdateFold(NAS_ROOT_ID), { wrapper: tangentWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ foldId: made.fold.id, summary: "Mine" });
    });
    expect((await client.listFolds(NAS_ROOT_ID)).folds[0]).toMatchObject({ summary: "Mine", aiDrafted: false });
  });
});
