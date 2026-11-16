import { normalizeBranchView, normalizeLeaf, normalizeSuggestion, type BranchList, type TangentEvent } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { tangentKeys } from "../query-keys";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useDiscardBranch } from "./branch-mutations";
import { applyEvent, type SyncTarget } from "./event-sync";
import { createLiveStore } from "./live-store";
import { useCreateSeed } from "./park-hooks";
import {
  useAcceptSuggestion,
  useDismissSuggestion,
  useDropSeed,
  useExpandSeed,
  useLeaf,
  useNoteSeed,
  usePutLeaf,
  useSeeds,
  useStartLeafDraft,
  useSpinoff,
  useSuggestions,
} from "./p1-hooks";
import { useBranches, useLine, useMessages } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 5 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("leaf hooks (B1)", () => {
  it("reads a leaf and confirms an edit; the outline's summary follows at once", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ leaf: useLeaf("nas-b5"), put: usePutLeaf("nas-b5"), outline: useBranches(NAS_ROOT_ID, true) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.leaf.isSuccess && result.current.outline.isSuccess).toBe(true));
    expect(result.current.leaf.data?.leaf?.line).toBe("只能接一顆碟、沒有 ECC");
    await act(async () => {
      await result.current.put.mutateAsync({ kind: "dead_end", line: "只能接一顆碟" });
    });
    await waitFor(() => expect(result.current.leaf.data?.leaf?.line).toBe("只能接一顆碟"));
    // Written into the outline from the result, without a refetch.
    expect(result.current.outline.data?.branches.find((branch) => branch.lineId === "nas-b5")?.leaf?.line).toBe("只能接一顆碟");
    expect(result.current.outline.isFetching).toBe(false);
  });

  it("starts a draft; leaf.changed (through the events) brings it", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ leaf: useLeaf("nas-b4"), draft: useStartLeafDraft("nas-b4") }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.leaf.isSuccess).toBe(true));
    const job = await act(async () => result.current.draft.mutateAsync());
    expect(job.kind).toBe("leaf_draft");
  });

  it("is disabled while the leaf feature is off (enabled = false)", () => {
    const client = tracked();
    const { result } = renderHook(() => useLeaf("nas-b5", false), { wrapper: tangentWrapper(client) });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("sends a discard reason as the leaf", async () => {
    const client = tracked();
    const { result } = renderHook(() => useDiscardBranch("nas-b3"), { wrapper: tangentWrapper(client) });
    const discarded = await act(async () => result.current.mutateAsync({ leaf: { line: "價格不划算" } }));
    expect(discarded.branch.leaf).toEqual({ kind: "dead_end", line: "價格不划算", status: "confirmed" });
  });
});

describe("seed hooks (B3)", () => {
  it("parks a thought: the list and the main line's count reload", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ seeds: useSeeds(NAS_ROOT_ID), line: useLine(NAS_ROOT_ID), create: useCreateSeed(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.seeds.isSuccess && result.current.line.isSuccess).toBe(true));
    expect(result.current.seeds.data?.seeds).toHaveLength(3);
    await act(async () => {
      await result.current.create.mutateAsync({ text: "要不要買 UPS？" });
    });
    await waitFor(() => expect(result.current.seeds.data?.seeds).toHaveLength(4));
    await waitFor(() => expect(result.current.line.data?.openSeeds).toBe(4));
  });

  it("expands, notes and drops seeds", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ seeds: useSeeds(NAS_ROOT_ID), expand: useExpandSeed(NAS_ROOT_ID), note: useNoteSeed(NAS_ROOT_ID), drop: useDropSeed(NAS_ROOT_ID) }), {
      wrapper: tangentWrapper(client, queryClient),
    });
    await waitFor(() => expect(result.current.seeds.isSuccess).toBe(true));
    const expanded = await act(async () => result.current.expand.mutateAsync({ seedId: "nas-s1", input: { purpose: "UPS 要買哪一台" } }));
    expect(expanded.branch.origin).toBe("seed");
    expect(queryClient.getQueryData(tangentKeys({ baseUrl: "mock:" }).lineView(expanded.line.id))).toBeTruthy();
    const noted = await act(async () => result.current.note.mutateAsync({ seedId: "nas-s2" }));
    expect(noted.note.section).toBe("to_confirm");
    await act(async () => {
      await result.current.drop.mutateAsync({ seedId: "nas-s3" });
    });
    await waitFor(() => expect(result.current.seeds.data?.seeds).toHaveLength(0));
  });
});

describe("suggestion hooks (B5)", () => {
  it("lists, accepts and dismisses", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ list: useSuggestions(NAS_ROOT_ID), accept: useAcceptSuggestion(NAS_ROOT_ID), dismiss: useDismissSuggestion(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.list.data?.suggestions).toHaveLength(1));
    const accepted = await act(async () => result.current.accept.mutateAsync({ suggestionId: "nas-g1" }));
    expect(accepted.suggestion.status).toBe("accepted");
    await waitFor(() => expect(result.current.list.data?.suggestions).toHaveLength(0));
    await expect(act(async () => result.current.dismiss.mutateAsync({ suggestionId: "nas-g1" }))).rejects.toMatchObject({ code: "suggestion_not_open" });
  });
});

describe("spinoff without the event stream (R7 D2)", () => {
  it("a fresh spinoff from a branch reloads that branch, so its 「已獨立 →」 marker shows", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ messages: useMessages("nas-b3"), spin: useSpinoff("nas-b3", NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await act(async () => {
      await result.current.spin.mutateAsync({ mode: "fresh", atMessageId: "nas-b3-5" });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.some((message) => message.meta.spunOffTo)).toBe(true));
  });

  it("detaching a branch under a branch reloads the parent branch that holds the marker", async () => {
    const client = tracked();
    const deep = await client.createBranch("nas-b3", { anchorMessageId: "nas-b3-5", purpose: "SMR models", kind: "investigate" });
    const { result } = renderHook(() => ({ messages: useMessages("nas-b3"), spin: useSpinoff(deep.line.id, NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await act(async () => {
      await result.current.spin.mutateAsync({ mode: "detach" });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.some((message) => message.meta.spunOffTo?.lineId === deep.line.id)).toBe(true));
  });
});

describe("events → cache (B8)", () => {
  const keys = tangentKeys({ baseUrl: "/api" });
  const event = (type: string, data: unknown, lineId: string, rootLineId: string) => ({ type, tenant: "", lineId, rootLineId, data }) as TangentEvent;
  const target = (): SyncTarget => ({ queryClient: new QueryClient(), keys, live: createLiveStore() });

  it("leaf.changed writes the leaf and the outline's and the detail's summary in place", () => {
    const t = target();
    t.queryClient.setQueryData<BranchList>(keys.branches("root", true), { branches: [normalizeBranchView({ lineId: "b1", rootLineId: "root" })] });
    t.queryClient.setQueryData(keys.branch("b1"), { branch: normalizeBranchView({ lineId: "b1" }) });
    const leaf = normalizeLeaf({ lineId: "b1", rootLineId: "root", kind: "answer", line: "Monthly", status: "draft", aiDrafted: true });
    applyEvent(t, event("leaf.changed", { lineId: "b1", rootLineId: "root", leaf }, "b1", "root"));
    expect(t.queryClient.getQueryData(keys.leaf("b1"))).toEqual({ leaf });
    expect(t.queryClient.getQueryData<BranchList>(keys.branches("root", true))?.branches[0]?.leaf).toEqual({ kind: "answer", line: "Monthly", status: "draft" });
    expect(t.queryClient.getQueryData<{ branch: { leaf: unknown } }>(keys.branch("b1"))?.branch.leaf).toEqual({ kind: "answer", line: "Monthly", status: "draft" });
    applyEvent(t, event("leaf.changed", { lineId: "b1", rootLineId: "root", leaf: null }, "b1", "root"));
    expect(t.queryClient.getQueryData<BranchList>(keys.branches("root", true))?.branches[0]?.leaf).toBeNull();
  });

  it("seeds.changed and suggestion.changed reload the tree's lists", () => {
    const t = target();
    t.queryClient.setQueryData(keys.seeds("root"), { rootLineId: "root", seeds: [] });
    t.queryClient.setQueryData(keys.suggestions("root"), { rootLineId: "root", suggestions: [] });
    applyEvent(t, event("seeds.changed", { rootLineId: "root" }, "root", "root"));
    applyEvent(t, event("suggestion.changed", { rootLineId: "root", suggestion: normalizeSuggestion({ id: "g", rootLineId: "root" }) }, "root", "root"));
    expect(t.queryClient.getQueryState(keys.seeds("root"))?.isInvalidated).toBe(true);
    expect(t.queryClient.getQueryState(keys.suggestions("root"))?.isInvalidated).toBe(true);
  });
});
